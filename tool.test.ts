import { afterEach, describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mindQueue from "./index";
import { MindQueueStore } from "./store";

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

interface CapturedCommand {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface CapturedTool {
	name: string;
	promptGuidelines?: string[];
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<ToolResult>;
}

interface ToolDetails {
	items: Array<{
		id: number;
		text: string;
		status: "open" | "done";
		revision: string;
	}>;
	matchedCount: number;
	openCount: number;
	totalCount: number;
}

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function setupTool(onSetStatus: () => void = () => {}, isIdle = true) {
	const root = mkdtempSync(join(tmpdir(), "mind-queue-tool-"));
	tempDirectories.push(root);
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(project, { recursive: true });
	const store = new MindQueueStore(project, agentDir);
	store.initialize();

	let captured: CapturedTool | undefined;
	let mindCommand: CapturedCommand | undefined;
	const sentMessages: Array<{
		content: string;
		deliverAs?: "steer" | "followUp";
	}> = [];
	const pi = {
		registerTool(tool: unknown) {
			if ((tool as { name?: string }).name === "mind_queue") {
				captured = tool as CapturedTool;
			}
		},
		registerShortcut() {},
		registerCommand(name: string, command: unknown) {
			if (name === "mind") {
				mindCommand = command as CapturedCommand;
			}
		},
		sendUserMessage(
			content: string,
			options?: { deliverAs?: "steer" | "followUp" },
		) {
			sentMessages.push({ content, deliverAs: options?.deliverAs });
		},
		on() {},
	} as unknown as ExtensionAPI;
	mindQueue(pi, { agentDir });
	if (!captured) throw new Error("Mind Queue did not register its agent tool");

	const notifications: string[] = [];
	const ctx = {
		cwd: project,
		isIdle: () => isIdle,
		mode: "print",
		hasUI: false,
		sessionManager: {
			getSessionId: () => "current-session",
			getSessionName: () => "Tool test",
			getHeader: () => ({ timestamp: "2026-07-16T10:00:00.000Z" }),
			getSessionFile: () => join(root, "session.jsonl"),
			getSessionDir: () => undefined,
			getEntries: () => [],
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
			},
			setStatus: onSetStatus,
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;

	if (!mindCommand) {
		throw new Error("Mind Queue did not register its main command");
	}
	return {
		tool: captured,
		mindCommand,
		ctx: ctx as unknown as ExtensionCommandContext,
		store,
		notifications,
		sentMessages,
	};
}

async function callTool(
	tool: CapturedTool,
	ctx: ExtensionContext,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolResult> {
	return tool.execute("tool-call", params, signal, undefined, ctx);
}

function details(result: ToolResult): ToolDetails {
	return result.details as ToolDetails;
}

describe("Mind Queue agent tool", () => {
	test("lists, adds, and updates thoughts only through explicit actions", async () => {
		const { tool, ctx, store } = setupTool();
		expect(tool.promptGuidelines?.join(" ")).toContain("explicitly asks");

		const empty = await callTool(tool, ctx, { action: "list" });
		expect(empty.content[0]?.text).toContain("No open thoughts");

		const added = await callTool(tool, ctx, {
			action: "add",
			text: "Review the authentication flow",
		});
		expect(details(added).items[0]).toMatchObject({
			id: 1,
			text: "Review the authentication flow",
			status: "open",
		});

		const listed = await callTool(tool, ctx, {
			action: "list",
			filter: "all",
		});
		const listedThought = details(listed).items[0];
		expect(listed.content[0]?.text).toContain("[open] #1 rev:");
		expect(listedThought?.revision).toHaveLength(12);

		const updated = await callTool(tool, ctx, {
			action: "set_status",
			id: listedThought?.id,
			status: "done",
			revision: listedThought?.revision,
		});
		expect(details(updated).items[0]?.status).toBe("done");
		expect(store.load().todos[0]?.done).toBe(true);

		const done = await callTool(tool, ctx, {
			action: "list",
			filter: "done",
		});
		expect(details(done).matchedCount).toBe(1);
		expect(details(done).openCount).toBe(0);
	});

	test("removes only a revision-checked thought with explicit confirmation", async () => {
		const { tool, ctx, store } = setupTool();
		expect(tool.promptGuidelines?.join(" ")).toContain("explicitly confirms");
		await callTool(tool, ctx, {
			action: "add",
			text: "Stale cleanup candidate",
		});
		const listed = await callTool(tool, ctx, {
			action: "list",
			filter: "all",
		});
		const snapshot = details(listed).items[0];

		let unconfirmed: unknown;
		try {
			await callTool(tool, ctx, {
				action: "remove",
				id: snapshot?.id,
				revision: snapshot?.revision,
			});
		} catch (error) {
			unconfirmed = error;
		}
		if (!(unconfirmed instanceof Error)) {
			throw new Error("Mind Queue removed an unconfirmed thought");
		}
		expect(unconfirmed.message).toContain("explicit user confirmation");
		expect(store.load().todos).toHaveLength(1);

		const removed = await callTool(tool, ctx, {
			action: "remove",
			id: snapshot?.id,
			revision: snapshot?.revision,
			confirmed: true,
		});
		expect(removed.content[0]?.text).toContain("Removed Mind Queue thought #1");
		expect(store.load().todos).toHaveLength(0);
		expect(store.load().undo?.label).toBe("remove stale");
	});

	test("starts cleanup review through a subcommand and queues it behind an active turn", async () => {
		const idle = setupTool();
		await idle.mindCommand.handler("cleanup", idle.ctx);
		expect(idle.sentMessages[0]?.content).toContain("git history");
		expect(idle.sentMessages[0]?.content).toContain(
			"ask me which specific IDs",
		);
		expect(idle.sentMessages[0]?.content).toContain(
			"Do not call mind_queue remove",
		);
		expect(idle.sentMessages[0]?.deliverAs).toBeUndefined();

		const busy = setupTool(undefined, false);
		await busy.mindCommand.handler("cleanup", busy.ctx);
		expect(busy.sentMessages[0]?.deliverAs).toBe("followUp");
	});

	test("undoes the latest mutation through the mind subcommand", async () => {
		const { tool, mindCommand, ctx, store } = setupTool();
		await callTool(tool, ctx, {
			action: "add",
			text: "Undo this thought",
		});
		expect(store.load().todos).toHaveLength(1);

		await mindCommand.handler("undo", ctx);
		expect(store.load().todos).toHaveLength(0);
	});

	test("supports exact lookup beyond the bounded default list", async () => {
		const { tool, ctx, store } = setupTool();
		store.update((state) => {
			for (let id = 1; id <= 51; id++) {
				state.todos.push({
					id: state.nextId++,
					text: `Thought ${id}`,
					done: false,
					createdAt: "2026-07-16T10:00:00.000Z",
					createdIn: {
						id: "another-session",
						name: "Another session",
						createdAt: "2026-07-16T10:00:00.000Z",
						persisted: true,
					},
				});
			}
		});

		const bounded = await callTool(tool, ctx, {
			action: "list",
			filter: "all",
		});
		expect(details(bounded).items).toHaveLength(50);
		expect(bounded.content[0]?.text).toContain("…and 1 more");

		const exact = await callTool(tool, ctx, { action: "list", id: 51 });
		expect(details(exact).items[0]).toMatchObject({
			id: 51,
			text: "Thought 51",
		});
	});

	test("stops before mutation when cancellation arrives during initialization", async () => {
		const controller = new AbortController();
		const { tool, ctx, store } = setupTool(() => controller.abort());

		let rejection: unknown;
		try {
			await callTool(
				tool,
				ctx,
				{ action: "add", text: "Do not add this" },
				controller.signal,
			);
		} catch (error) {
			rejection = error;
		}
		if (!(rejection instanceof Error)) {
			throw new Error("Mind Queue ignored cancellation");
		}
		expect(rejection.message).toContain("cancelled");
		expect(store.load().todos).toHaveLength(0);
	});

	test("rejects a stale status update after another session edits the thought", async () => {
		const { tool, ctx, store } = setupTool();
		await callTool(tool, ctx, {
			action: "add",
			text: "Original thought",
		});
		const listed = await callTool(tool, ctx, {
			action: "list",
			filter: "all",
		});
		const snapshot = details(listed).items[0];

		store.update((state) => {
			const thought = state.todos[0];
			if (thought) thought.text = "Edited elsewhere";
		});

		let rejection: unknown;
		try {
			await callTool(tool, ctx, {
				action: "set_status",
				id: snapshot?.id,
				status: "done",
				revision: snapshot?.revision,
			});
		} catch (error) {
			rejection = error;
		}
		if (!(rejection instanceof Error)) {
			throw new Error("Mind Queue accepted a stale status update");
		}
		expect(rejection.message).toContain("call list again");
		expect(store.load().todos[0]).toMatchObject({
			text: "Edited elsewhere",
			done: false,
		});
	});
});
