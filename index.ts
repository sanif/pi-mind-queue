import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
	formatMindQueueStatus,
	MIND_QUEUE_SHORTCUT,
	sanitizeThoughtForEditor,
	TodoManagerComponent,
	type DialogResult,
} from "./component";
import {
	collectLegacyTodos,
	collectSessionOrigins,
	type SessionCatalog,
} from "./migration";
import {
	cloneTodos,
	cloneUndo,
	formatSessionOrigin,
	MindQueueStore,
	mutateThoughtIfCurrent,
	normalizeSessionLabel,
	orderTodosBySession,
	resolveProjectRoot,
	type ProjectQueueState,
	type ProjectTodo,
	type ProjectUndoState,
	type SessionOrigin,
} from "./store";

export { TodoManagerComponent } from "./component";

function firstUserPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		if (typeof entry.message.content === "string") {
			return normalizeSessionLabel(entry.message.content);
		}
		const text: string[] = [];
		for (const block of entry.message.content) {
			if (block.type === "text") text.push(block.text);
		}
		return normalizeSessionLabel(text.join("\n"));
	}
	return undefined;
}

function sessionOrigin(ctx: ExtensionContext): SessionOrigin {
	return {
		id: ctx.sessionManager.getSessionId(),
		name: normalizeSessionLabel(ctx.sessionManager.getSessionName()),
		description: firstUserPrompt(ctx),
		createdAt:
			ctx.sessionManager.getHeader()?.timestamp ?? new Date().toISOString(),
		persisted: ctx.sessionManager.getSessionFile() !== undefined,
	};
}

class UndoUnavailableError extends Error {}
class MutationUnavailableError extends Error {}

export interface MindQueueOptions {
	agentDir?: string;
	shortcut?: KeyId;
}

interface MindQueueConfig {
	shortcut?: unknown;
}

const SHORTCUT_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SHORTCUT_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
	..."`-=[]\\;',./!@#$%^&*()_|~{}:<>?",
]);

function isShortcut(value: string): value is KeyId {
	const parts = value.toLowerCase().split("+");
	const key = parts.pop();
	if (!key || !SHORTCUT_KEYS.has(key)) return false;
	const modifiers = new Set(parts);
	return (
		modifiers.size === parts.length &&
		parts.every((part) => SHORTCUT_MODIFIERS.has(part))
	);
}

function readConfiguredShortcut(agentDir: string): KeyId | undefined {
	const configPath = join(agentDir, "extensions", "mind-queue.json");
	if (!existsSync(configPath)) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(`Mind Queue could not read ${configPath}`, {
			cause: error,
		});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Mind Queue config in ${configPath} must be a JSON object`);
	}

	const config = parsed as MindQueueConfig;
	if (config.shortcut === undefined) return undefined;
	const shortcut =
		typeof config.shortcut === "string" ? config.shortcut.trim() : undefined;
	if (!shortcut || !isShortcut(shortcut)) {
		throw new Error(
			`Mind Queue shortcut in ${configPath} is not a valid Pi key combination`,
		);
	}
	return shortcut;
}

type MindQueueFilter = "open" | "done" | "all";
type MindQueueStatus = "open" | "done";

interface MindQueueToolItem {
	id: number;
	text: string;
	status: MindQueueStatus;
	revision: string;
	createdAt: string;
	createdIn: string;
}

interface MindQueueToolDetails {
	action: "list" | "add" | "set_status" | "remove";
	filter?: MindQueueFilter;
	items: MindQueueToolItem[];
	matchedCount: number;
	openCount: number;
	totalCount: number;
}

const MIND_QUEUE_TOOL_ITEM_LIMIT = 50;
const MIND_QUEUE_TOOL_TEXT_LIMIT = 500;
const MIND_QUEUE_CLEANUP_PROMPT = `Review my open Mind Queue for thoughts that may already be completed or stale. First use mind_queue list with the open filter. Inspect relevant git history and current project files or features for evidence. Present only likely completed or stale thoughts with concise evidence, then ask me which specific IDs to remove. Do not call mind_queue remove until I explicitly confirm the IDs in a later message. If none look stale, tell me that instead.`;
const MindQueueToolParameters = Type.Object({
	action: StringEnum(["list", "add", "set_status", "remove"] as const),
	filter: Type.Optional(StringEnum(["open", "done", "all"] as const)),
	text: Type.Optional(
		Type.String({ description: "Thought text; required for add" }),
	),
	id: Type.Optional(
		Type.Number({
			description:
				"Thought ID; optional exact lookup for list and required for set_status",
		}),
	),
	status: Type.Optional(StringEnum(["open", "done"] as const)),
	revision: Type.Optional(
		Type.String({
			description:
				"Revision returned by list; required for concurrency-safe set_status or remove",
		}),
	),
	confirmed: Type.Optional(
		Type.Boolean({
			description:
				"Must be true for remove, only after the user explicitly confirms the thought ID",
		}),
	),
});

function thoughtRevision(thought: ProjectTodo): string {
	return createHash("sha256")
		.update(`${thought.id}\0${thought.done ? "done" : "open"}\0${thought.text}`)
		.digest("hex")
		.slice(0, 12);
}

function toolThoughtText(text: string): string {
	const cleaned = sanitizeThoughtForEditor(text).replace(/\s+/g, " ").trim();
	return cleaned.length > MIND_QUEUE_TOOL_TEXT_LIMIT
		? `${cleaned.slice(0, MIND_QUEUE_TOOL_TEXT_LIMIT - 1).trimEnd()}…`
		: cleaned;
}

function toolItem(
	thought: ProjectTodo,
	currentSessionId?: string,
): MindQueueToolItem {
	return {
		id: thought.id,
		text: toolThoughtText(thought.text),
		status: thought.done ? "done" : "open",
		revision: thoughtRevision(thought),
		createdAt: thought.createdAt,
		createdIn: formatSessionOrigin(thought.createdIn, currentSessionId),
	};
}

function toolCounts(state: ProjectQueueState): {
	openCount: number;
	totalCount: number;
} {
	return {
		openCount: state.todos.filter((thought) => !thought.done).length,
		totalCount: state.todos.length,
	};
}

function listToolResult(
	state: ProjectQueueState,
	currentSessionId: string,
	filter: MindQueueFilter,
	id?: number,
) {
	let matches: ProjectTodo[];
	if (id !== undefined) {
		matches = state.todos.filter((thought) => thought.id === id);
	} else {
		matches = orderTodosBySession(state.todos, currentSessionId).filter(
			(thought) => {
				if (filter === "all") return true;
				return filter === "done" ? thought.done : !thought.done;
			},
		);
	}
	const items = matches
		.slice(0, MIND_QUEUE_TOOL_ITEM_LIMIT)
		.map((thought) => toolItem(thought, currentSessionId));
	const remaining = matches.length - items.length;
	let content: string;
	if (items.length === 0) {
		if (id !== undefined) {
			content = `Mind Queue thought #${id} was not found.`;
		} else {
			const qualifier = filter === "all" ? "" : `${filter} `;
			content = `No ${qualifier}thoughts in Mind Queue.`;
		}
	} else {
		const lines = items.map(
			(item) =>
				`[${item.status}] #${item.id} rev:${item.revision} ${item.text}`,
		);
		if (remaining > 0) lines.push(`…and ${remaining} more matching thoughts.`);
		content = lines.join("\n");
	}
	return {
		content: [{ type: "text" as const, text: content }],
		details: {
			action: "list",
			...(id === undefined ? { filter } : {}),
			items,
			matchedCount: matches.length,
			...toolCounts(state),
		} satisfies MindQueueToolDetails,
	};
}

function revisionCheckedThought(
	state: ProjectQueueState,
	id: number | undefined,
	revision: string | undefined,
	action: "set_status" | "remove",
): ProjectTodo {
	if (id === undefined || revision === undefined) {
		throw new Error(`Mind Queue ${action} requires id and revision from list`);
	}
	const thought = state.todos.find((candidate) => candidate.id === id);
	if (!thought) throw new Error(`Mind Queue thought #${id} was not found`);
	if (thoughtRevision(thought) !== revision) {
		throw new Error(
			"Mind Queue thought changed; call list again before updating it",
		);
	}
	return thought;
}

function mutationToolResult(options: {
	action: "add" | "set_status" | "remove";
	state: ProjectQueueState;
	thought: ProjectTodo;
	currentSessionId: string;
	message: string;
}) {
	return {
		content: [{ type: "text" as const, text: options.message }],
		details: {
			action: options.action,
			items: [toolItem(options.thought, options.currentSessionId)],
			matchedCount: 1,
			...toolCounts(options.state),
		} satisfies MindQueueToolDetails,
	};
}

export default function mindQueue(
	pi: ExtensionAPI,
	options: MindQueueOptions = {},
) {
	const agentDir = options.agentDir ?? getAgentDir();
	const shortcut =
		options.shortcut ?? readConfiguredShortcut(agentDir) ?? MIND_QUEUE_SHORTCUT;
	const sessionCatalog: SessionCatalog = {
		listAll: (sessionDir) =>
			sessionDir
				? SessionManager.listAll(sessionDir)
				: SessionManager.listAll(),
		open: (path) => SessionManager.open(path),
	};
	let store: MindQueueStore | undefined;
	let state: ProjectQueueState | undefined;
	let currentOrigin: SessionOrigin | undefined;
	let currentContext: ExtensionContext | undefined;

	const updateStatus = (ctx: ExtensionContext): void => {
		const open = state?.todos.filter((todo) => !todo.done).length ?? 0;
		const status = formatMindQueueStatus(open);
		ctx.ui.setStatus(
			"mind-queue",
			status ? ctx.ui.theme.fg("accent", status) : undefined,
		);
	};

	const applyState = (
		nextState: ProjectQueueState,
		ctx: ExtensionContext,
	): void => {
		state = nextState;
		updateStatus(ctx);
	};

	const updateOriginMetadata = (
		draft: ProjectQueueState,
		origins: ReadonlyMap<string, SessionOrigin>,
	): void => {
		const updateTodo = (todo: ProjectTodo): void => {
			todo.createdIn.name = normalizeSessionLabel(todo.createdIn.name);
			todo.createdIn.description = normalizeSessionLabel(
				todo.createdIn.description,
			);
			const origin = origins.get(todo.createdIn.id);
			if (!origin) return;
			todo.createdIn.name = normalizeSessionLabel(origin.name);
			todo.createdIn.description = normalizeSessionLabel(origin.description);
		};
		draft.todos.forEach(updateTodo);
		draft.undo?.todos.forEach(updateTodo);
	};

	const initialize = async (ctx: ExtensionContext): Promise<void> => {
		currentContext = ctx;
		currentOrigin = sessionOrigin(ctx);
		const projectRoot = resolveProjectRoot(ctx.cwd);
		const nextStore = new MindQueueStore(projectRoot, agentDir);
		const imported = existsSync(nextStore.filePath)
			? []
			: await collectLegacyTodos(
					projectRoot,
					sessionCatalog,
					ctx.sessionManager.getSessionDir(),
				);
		const result = nextStore.initialize(imported);
		store = nextStore;
		let initializedState = result.state;
		if (initializedState.sessionLabelsVersion !== 2) {
			try {
				const origins = await collectSessionOrigins(
					projectRoot,
					sessionCatalog,
					ctx.sessionManager.getSessionDir(),
				);
				const originsById = new Map(
					origins.map((origin) => [origin.id, origin]),
				);
				initializedState = nextStore.update((draft) => {
					updateOriginMetadata(draft, originsById);
					draft.sessionLabelsVersion = 2;
				});
			} catch (error) {
				ctx.ui.notify(
					`Mind Queue could not enrich old session labels: ${(error as Error).message}`,
					"warning",
				);
			}
		}
		applyState(initializedState, ctx);

		if (result.importedCount > 0) {
			const sessionCount = new Set(
				result.state.todos.map((todo) => todo.createdIn.id),
			).size;
			ctx.ui.notify(
				`Mind Queue migrated ${result.importedCount} thought${result.importedCount === 1 ? "" : "s"} from ${sessionCount} session${sessionCount === 1 ? "" : "s"}`,
				"info",
			);
		}
	};

	const ensureInitialized = async (ctx: ExtensionContext): Promise<boolean> => {
		if (store && state && currentOrigin) return true;
		try {
			await initialize(ctx);
			return true;
		} catch (error) {
			ctx.ui.notify(
				`Mind Queue could not open its project store: ${(error as Error).message}`,
				"error",
			);
			return false;
		}
	};

	const refresh = (ctx: ExtensionContext): boolean => {
		if (!store) return false;
		try {
			applyState(store.load(), ctx);
			return true;
		} catch (error) {
			ctx.ui.notify(
				`Mind Queue could not read its project store: ${(error as Error).message}`,
				"error",
			);
			return false;
		}
	};

	const syncCurrentOrigin = (ctx: ExtensionContext): void => {
		const latest = sessionOrigin(ctx);
		const changed =
			latest.name !== currentOrigin?.name ||
			latest.description !== currentOrigin?.description;
		currentOrigin = latest;
		if (
			!changed ||
			!store ||
			!state?.todos.some((todo) => todo.createdIn.id === latest.id)
		)
			return;
		try {
			const nextState = store.update((draft) => {
				updateOriginMetadata(draft, new Map([[latest.id, latest]]));
			});
			applyState(nextState, ctx);
		} catch (error) {
			ctx.ui.notify(
				`Mind Queue could not refresh this session label: ${(error as Error).message}`,
				"warning",
			);
		}
	};

	const mutate = (
		ctx: ExtensionContext,
		label: string,
		change: (draft: ProjectQueueState, origin: SessionOrigin) => boolean,
	): boolean => {
		if (!store || !currentOrigin) return false;
		try {
			const origin = { ...currentOrigin };
			const nextState = store.update((draft) => {
				const undo: ProjectUndoState = {
					operationId: randomUUID(),
					actorSessionId: origin.id,
					label,
					nextId: draft.nextId,
					todos: cloneTodos(draft.todos),
				};
				if (!change(draft, origin))
					throw new MutationUnavailableError(
						"Thought changed in another session",
					);
				draft.undo = undo;
			});
			applyState(nextState, ctx);
			return true;
		} catch (error) {
			if (error instanceof MutationUnavailableError) {
				ctx.ui.notify(`${error.message}; queue refreshed`, "info");
			} else {
				ctx.ui.notify(
					`Mind Queue could not save: ${(error as Error).message}`,
					"error",
				);
			}
			refresh(ctx);
			return false;
		}
	};

	const addThought = (
		ctx: ExtensionContext,
		text: string,
	): ProjectTodo | undefined => {
		let added: ProjectTodo | undefined;
		const saved = mutate(ctx, "add", (draft, createdIn) => {
			added = {
				id: draft.nextId++,
				text,
				done: false,
				createdAt: new Date().toISOString(),
				createdIn,
			};
			draft.todos.push(added);
			return true;
		});
		return saved ? added : undefined;
	};

	const getUndoLabel = (): string | undefined => {
		if (!state?.undo || state.undo.actorSessionId !== currentOrigin?.id)
			return undefined;
		return state.undo.label;
	};

	const undoLast = (ctx: ExtensionContext): boolean => {
		if (!store || !currentOrigin) return false;
		let previous: ProjectUndoState | undefined;
		try {
			const nextState = store.update((draft) => {
				if (!draft.undo || draft.undo.actorSessionId !== currentOrigin?.id) {
					throw new UndoUnavailableError("Nothing to undo in this session");
				}
				previous = cloneUndo(draft.undo);
				draft.todos = cloneTodos(draft.undo.todos);
				draft.nextId = draft.undo.nextId;
				draft.undo = undefined;
			});
			applyState(nextState, ctx);
		} catch (error) {
			if (error instanceof UndoUnavailableError) {
				ctx.ui.notify(error.message, "info");
				refresh(ctx);
				return false;
			}
			ctx.ui.notify(
				`Mind Queue could not undo: ${(error as Error).message}`,
				"error",
			);
			refresh(ctx);
			return false;
		}

		let editorRestored = false;
		if (previous?.editorInsertion) {
			const { position, text } = previous.editorInsertion;
			const editorText = ctx.ui.getEditorText();
			if (editorText.slice(position, position + text.length) === text) {
				ctx.ui.setEditorText(
					editorText.slice(0, position) +
						editorText.slice(position + text.length),
				);
				editorRestored = true;
			}
		}

		if (previous) {
			const suffix =
				previous.label === "move" && !editorRestored
					? "; editor changed, so its text was left untouched"
					: "";
			ctx.ui.notify(`Undid ${previous.label}${suffix}`, "info");
		}
		return true;
	};

	const moveToEditor = (ctx: ExtensionContext, text: string): void => {
		if (
			!store ||
			!state?.undo ||
			state.undo.actorSessionId !== currentOrigin?.id
		)
			return;
		const operationId = state.undo.operationId;
		const safeText = sanitizeThoughtForEditor(text);
		const before = ctx.ui.getEditorText();
		ctx.ui.pasteToEditor(safeText);
		const after = ctx.ui.getEditorText();
		let insertion: { position: number; text: string } | undefined;

		for (let position = 0; position <= before.length; position++) {
			if (
				after ===
				before.slice(0, position) + safeText + before.slice(position)
			) {
				insertion = { position, text: safeText };
				break;
			}
		}

		if (insertion) {
			try {
				const nextState = store.update((draft) => {
					if (
						draft.undo?.operationId === operationId &&
						draft.undo.actorSessionId === currentOrigin?.id
					) {
						draft.undo.editorInsertion = insertion;
					}
				});
				applyState(nextState, ctx);
			} catch (error) {
				ctx.ui.notify(
					`Thought moved, but Mind Queue could not save undo details: ${(error as Error).message}`,
					"warning",
				);
			}
		}
		ctx.ui.notify(
			"Thought moved to the editor cursor · reopen Mind Queue and press U to undo",
			"info",
		);
	};

	const showTodos = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Mind Queue requires interactive mode", "error");
			return;
		}
		if (!(await ensureInitialized(ctx)) || !refresh(ctx)) return;
		syncCurrentOrigin(ctx);
		const origin = currentOrigin;
		if (!origin) return;

		currentContext = ctx;
		while (true) {
			const result = await ctx.ui.custom<DialogResult>(
				(tui, theme, _keybindings, done) =>
					new TodoManagerComponent({
						theme,
						cwd: ctx.cwd,
						requestRender: () => tui.requestRender(),
						getThoughts: () => state?.todos ?? [],
						currentSessionId: origin.id,
						getUndoLabel,
						addThought: (text) => addThought(ctx, text) !== undefined,
						removeThought: (thought, reason) =>
							mutate(ctx, reason, (draft) =>
								mutateThoughtIfCurrent(draft, thought, (_current, index) => {
									draft.todos.splice(index, 1);
								}),
							),
						toggleThought: (thought) =>
							mutate(ctx, thought.done ? "mark open" : "mark done", (draft) =>
								mutateThoughtIfCurrent(draft, thought, (current) => {
									current.done = !thought.done;
								}),
							),
						undoLast: () => undoLast(ctx),
						shortcut,
						done,
					}),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: 88,
						minWidth: 56,
						maxHeight: "90%",
						margin: 1,
					},
				},
			);

			if (!result) return;
			if (result.action === "move") {
				moveToEditor(ctx, result.thought.text);
				return;
			}

			const edited = await ctx.ui.editor(
				"Edit Mind Queue thought",
				sanitizeThoughtForEditor(result.thought.text),
			);
			if (edited === undefined) continue;
			const text = edited.trim();
			if (!text) {
				ctx.ui.notify("A thought cannot be empty", "warning");
				continue;
			}
			if (text === result.thought.text) continue;
			mutate(ctx, "edit", (draft) =>
				mutateThoughtIfCurrent(draft, result.thought, (current) => {
					current.text = text;
				}),
			);
		}
	};

	pi.registerTool({
		name: "mind_queue",
		label: "Mind Queue",
		description:
			"List, add, change status, or remove a confirmed stale project Mind Queue thought. Use only when the user explicitly asks to inspect, save, or update Mind Queue. For set_status or remove, call list first and pass the returned ID and revision. Remove also requires confirmed=true after the user confirms that specific ID. List accepts an optional ID for exact lookup and otherwise returns at most 50 matching thoughts.",
		promptSnippet:
			"List, add, update, or remove confirmed stale project thoughts",
		promptGuidelines: [
			"Use mind_queue only when the user explicitly asks to save, inspect, or update Mind Queue thoughts; never capture ordinary conversation automatically.",
			"Use mind_queue remove only after the user explicitly confirms the specific thought ID in the current conversation.",
		],
		executionMode: "sequential",
		parameters: MindQueueToolParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Mind Queue action cancelled");
			if (!(await ensureInitialized(ctx)) || !refresh(ctx)) {
				throw new Error("Mind Queue could not load the project queue");
			}
			currentContext = ctx;
			syncCurrentOrigin(ctx);
			if (!state || !currentOrigin) {
				throw new Error("Mind Queue is not initialized");
			}
			if (signal?.aborted) throw new Error("Mind Queue action cancelled");

			if (params.action === "list") {
				return listToolResult(
					state,
					currentOrigin.id,
					params.filter ?? "open",
					params.id,
				);
			}

			if (params.action === "add") {
				const text = params.text?.trim();
				if (!text) throw new Error("Mind Queue add requires non-empty text");
				const added = addThought(ctx, text);
				if (!added) throw new Error("Mind Queue could not add the thought");
				const item = toolItem(added, currentOrigin.id);
				return mutationToolResult({
					action: "add",
					state,
					thought: added,
					currentSessionId: currentOrigin.id,
					message: `Added Mind Queue thought #${item.id}: ${item.text}`,
				});
			}

			if (params.action === "remove") {
				if (params.confirmed !== true) {
					throw new Error(
						"Mind Queue remove requires explicit user confirmation for the specific thought ID",
					);
				}
				const thought = revisionCheckedThought(
					state,
					params.id,
					params.revision,
					"remove",
				);
				const expected = { ...thought, createdIn: { ...thought.createdIn } };
				const changed = mutate(ctx, "remove stale", (draft) =>
					mutateThoughtIfCurrent(draft, expected, (_current, index) => {
						draft.todos.splice(index, 1);
					}),
				);
				if (!changed) {
					throw new Error(
						"Mind Queue thought changed; call list again before removing it",
					);
				}
				return mutationToolResult({
					action: "remove",
					state,
					thought: expected,
					currentSessionId: currentOrigin.id,
					message: `Removed Mind Queue thought #${expected.id}: ${toolThoughtText(expected.text)}`,
				});
			}

			if (params.status === undefined) {
				throw new Error("Mind Queue set_status requires status");
			}
			const thought = revisionCheckedThought(
				state,
				params.id,
				params.revision,
				"set_status",
			);
			const targetDone = params.status === "done";
			if (thought.done !== targetDone) {
				const expected = { ...thought, createdIn: { ...thought.createdIn } };
				const changed = mutate(ctx, `mark ${params.status}`, (draft) =>
					mutateThoughtIfCurrent(draft, expected, (current) => {
						current.done = targetDone;
					}),
				);
				if (!changed) {
					throw new Error(
						"Mind Queue thought changed; call list again before updating it",
					);
				}
			}
			const updated = state.todos.find(
				(candidate) => candidate.id === params.id,
			);
			if (!updated)
				throw new Error(`Mind Queue thought #${params.id} was not found`);
			const item = toolItem(updated, currentOrigin.id);
			return mutationToolResult({
				action: "set_status",
				state,
				thought: updated,
				currentSessionId: currentOrigin.id,
				message: `Mind Queue thought #${item.id} is ${item.status}.`,
			});
		},
	});

	pi.registerShortcut(shortcut, {
		description: "Open Mind Queue",
		handler: showTodos,
	});

	const requestCleanup = (ctx: ExtensionContext): void => {
		if (ctx.isIdle()) {
			pi.sendUserMessage(MIND_QUEUE_CLEANUP_PROMPT);
			return;
		}
		pi.sendUserMessage(MIND_QUEUE_CLEANUP_PROMPT, {
			deliverAs: "followUp",
		});
	};

	const runUndo = async (ctx: ExtensionContext): Promise<void> => {
		if (!(await ensureInitialized(ctx))) return;
		currentContext = ctx;
		refresh(ctx);
		undoLast(ctx);
	};

	pi.registerCommand("mind", {
		description:
			"Open Mind Queue, add a thought, or run /mind cleanup or /mind undo",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				await showTodos(ctx);
				return;
			}

			const subcommand = text.toLowerCase();
			if (subcommand === "cleanup") {
				requestCleanup(ctx);
				return;
			}
			if (subcommand === "undo") {
				await runUndo(ctx);
				return;
			}

			if (!(await ensureInitialized(ctx)) || !refresh(ctx)) return;
			currentContext = ctx;
			syncCurrentOrigin(ctx);
			if (addThought(ctx, text)) ctx.ui.notify("Added to Mind Queue", "info");
		},
	});

	pi.registerCommand("mind-undo", {
		description: "Legacy alias for /mind undo",
		handler: (_args, ctx) => runUndo(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await initialize(ctx);
		} catch (error) {
			store = undefined;
			state = undefined;
			currentOrigin = undefined;
			ctx.ui.notify(
				`Mind Queue could not initialize: ${(error as Error).message}`,
				"error",
			);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		currentContext = ctx;
		if (refresh(ctx)) syncCurrentOrigin(ctx);
	});

	pi.on("session_info_changed", (event, ctx) => {
		if (!store || !currentOrigin) return;
		const name = normalizeSessionLabel(event.name);
		currentOrigin = { ...currentOrigin, name };
		try {
			const nextState = store.update((draft) => {
				const updateOrigin = (todo: ProjectTodo): void => {
					if (todo.createdIn.id === currentOrigin?.id)
						todo.createdIn.name = name;
				};
				draft.todos.forEach(updateOrigin);
				draft.undo?.todos.forEach(updateOrigin);
			});
			applyState(nextState, ctx);
		} catch (error) {
			ctx.ui.notify(
				`Mind Queue could not update the session label: ${(error as Error).message}`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", () => {
		if (currentContext) currentContext.ui.setStatus("mind-queue", undefined);
		store = undefined;
		state = undefined;
		currentOrigin = undefined;
		currentContext = undefined;
	});
}
