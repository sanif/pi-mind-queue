import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	formatMindQueueStatus,
	MIND_QUEUE_SHORTCUT,
	sanitizeThoughtForEditor,
	TodoManagerComponent,
	type DialogResult,
} from "./component";
import { collectLegacyTodos, collectSessionOrigins, type SessionCatalog } from "./migration";
import {
	cloneTodos,
	cloneUndo,
	MindQueueStore,
	mutateThoughtIfCurrent,
	normalizeSessionLabel,
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
		createdAt: ctx.sessionManager.getHeader()?.timestamp ?? new Date().toISOString(),
		persisted: ctx.sessionManager.getSessionFile() !== undefined,
	};
}

class UndoUnavailableError extends Error {}
class MutationUnavailableError extends Error {}

export default function mindQueue(pi: ExtensionAPI) {
	const sessionCatalog: SessionCatalog = {
		listAll: (sessionDir) => sessionDir ? SessionManager.listAll(sessionDir) : SessionManager.listAll(),
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

	const applyState = (nextState: ProjectQueueState, ctx: ExtensionContext): void => {
		state = nextState;
		updateStatus(ctx);
	};

	const updateOriginMetadata = (
		draft: ProjectQueueState,
		origins: ReadonlyMap<string, SessionOrigin>,
	): void => {
		const updateTodo = (todo: ProjectTodo): void => {
			todo.createdIn.name = normalizeSessionLabel(todo.createdIn.name);
			todo.createdIn.description = normalizeSessionLabel(todo.createdIn.description);
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
		const nextStore = new MindQueueStore(projectRoot, getAgentDir());
		const imported = existsSync(nextStore.filePath)
			? []
			: await collectLegacyTodos(projectRoot, sessionCatalog, ctx.sessionManager.getSessionDir());
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
				const originsById = new Map(origins.map((origin) => [origin.id, origin]));
				initializedState = nextStore.update((draft) => {
					updateOriginMetadata(draft, originsById);
					draft.sessionLabelsVersion = 2;
				});
			} catch (error) {
				ctx.ui.notify(`Mind Queue could not enrich old session labels: ${(error as Error).message}`, "warning");
			}
		}
		applyState(initializedState, ctx);

		if (result.importedCount > 0) {
			const sessionCount = new Set(result.state.todos.map((todo) => todo.createdIn.id)).size;
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
			ctx.ui.notify(`Mind Queue could not open its project store: ${(error as Error).message}`, "error");
			return false;
		}
	};

	const refresh = (ctx: ExtensionContext): boolean => {
		if (!store) return false;
		try {
			applyState(store.load(), ctx);
			return true;
		} catch (error) {
			ctx.ui.notify(`Mind Queue could not read its project store: ${(error as Error).message}`, "error");
			return false;
		}
	};

	const syncCurrentOrigin = (ctx: ExtensionContext): void => {
		const latest = sessionOrigin(ctx);
		const changed =
			latest.name !== currentOrigin?.name ||
			latest.description !== currentOrigin?.description;
		currentOrigin = latest;
		if (!changed || !store || !state?.todos.some((todo) => todo.createdIn.id === latest.id)) return;
		try {
			const nextState = store.update((draft) => {
				updateOriginMetadata(draft, new Map([[latest.id, latest]]));
			});
			applyState(nextState, ctx);
		} catch (error) {
			ctx.ui.notify(`Mind Queue could not refresh this session label: ${(error as Error).message}`, "warning");
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
				if (!change(draft, origin)) throw new MutationUnavailableError("Thought changed in another session");
				draft.undo = undo;
			});
			applyState(nextState, ctx);
			return true;
		} catch (error) {
			if (error instanceof MutationUnavailableError) {
				ctx.ui.notify(`${error.message}; queue refreshed`, "info");
			} else {
				ctx.ui.notify(`Mind Queue could not save: ${(error as Error).message}`, "error");
			}
			refresh(ctx);
			return false;
		}
	};

	const getUndoLabel = (): string | undefined => {
		if (!state?.undo || state.undo.actorSessionId !== currentOrigin?.id) return undefined;
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
			ctx.ui.notify(`Mind Queue could not undo: ${(error as Error).message}`, "error");
			refresh(ctx);
			return false;
		}

		let editorRestored = false;
		if (previous?.editorInsertion) {
			const { position, text } = previous.editorInsertion;
			const editorText = ctx.ui.getEditorText();
			if (editorText.slice(position, position + text.length) === text) {
				ctx.ui.setEditorText(editorText.slice(0, position) + editorText.slice(position + text.length));
				editorRestored = true;
			}
		}

		if (previous) {
			const suffix = previous.label === "move" && !editorRestored
				? "; editor changed, so its text was left untouched"
				: "";
			ctx.ui.notify(`Undid ${previous.label}${suffix}`, "info");
		}
		return true;
	};

	const moveToEditor = (ctx: ExtensionContext, text: string): void => {
		if (!store || !state?.undo || state.undo.actorSessionId !== currentOrigin?.id) return;
		const operationId = state.undo.operationId;
		const safeText = sanitizeThoughtForEditor(text);
		const before = ctx.ui.getEditorText();
		ctx.ui.pasteToEditor(safeText);
		const after = ctx.ui.getEditorText();
		let insertion: { position: number; text: string } | undefined;

		for (let position = 0; position <= before.length; position++) {
			if (after === before.slice(0, position) + safeText + before.slice(position)) {
				insertion = { position, text: safeText };
				break;
			}
		}

		if (insertion) {
			try {
				const nextState = store.update((draft) => {
					if (draft.undo?.operationId === operationId && draft.undo.actorSessionId === currentOrigin?.id) {
						draft.undo.editorInsertion = insertion;
					}
				});
				applyState(nextState, ctx);
			} catch (error) {
				ctx.ui.notify(`Thought moved, but Mind Queue could not save undo details: ${(error as Error).message}`, "warning");
			}
		}
		ctx.ui.notify("Thought moved to the editor cursor · reopen Mind Queue and press U to undo", "info");
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
						requestRender: () => tui.requestRender(),
						getThoughts: () => state?.todos ?? [],
						currentSessionId: origin.id,
						getUndoLabel,
						addThought: (text) => mutate(ctx, "add", (draft, createdIn) => {
							draft.todos.push({
								id: draft.nextId++,
								text,
								done: false,
								createdAt: new Date().toISOString(),
								createdIn,
							});
							return true;
						}),
						removeThought: (thought, reason) => mutate(ctx, reason, (draft) =>
							mutateThoughtIfCurrent(draft, thought, (_current, index) => {
								draft.todos.splice(index, 1);
							}),
						),
						toggleThought: (thought) => mutate(
							ctx,
							thought.done ? "mark open" : "mark done",
							(draft) => mutateThoughtIfCurrent(draft, thought, (current) => {
								current.done = !thought.done;
							}),
						),
						undoLast: () => undoLast(ctx),
						done,
					}),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: 72,
						minWidth: 44,
						maxHeight: "85%",
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

	pi.registerShortcut(MIND_QUEUE_SHORTCUT, {
		description: "Open Mind Queue",
		handler: showTodos,
	});

	pi.registerCommand("mind", {
		description: "Open the project-wide thought queue, grouped by creation session",
		handler: async (_args, ctx) => showTodos(ctx),
	});

	pi.registerCommand("mind-undo", {
		description: "Undo this session's latest Mind Queue change",
		handler: async (_args, ctx) => {
			if (!(await ensureInitialized(ctx))) return;
			currentContext = ctx;
			refresh(ctx);
			undoLast(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await initialize(ctx);
		} catch (error) {
			store = undefined;
			state = undefined;
			currentOrigin = undefined;
			ctx.ui.notify(`Mind Queue could not initialize: ${(error as Error).message}`, "error");
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
					if (todo.createdIn.id === currentOrigin?.id) todo.createdIn.name = name;
				};
				draft.todos.forEach(updateOrigin);
				draft.undo?.todos.forEach(updateOrigin);
			});
			applyState(nextState, ctx);
		} catch (error) {
			ctx.ui.notify(`Mind Queue could not update the session label: ${(error as Error).message}`, "warning");
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
