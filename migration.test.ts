import { describe, expect, test } from "bun:test";
import {
	collectLegacyTodos,
	collectSessionOrigins,
	type SessionCatalog,
	type SessionInfoLike,
} from "./migration";

const projectRoot = "/workspace/project";

function session(path: string, id: string): SessionInfoLike {
	return {
		path,
		id,
		cwd: projectRoot,
		name: `Session ${id}`,
		firstMessage: `First prompt for ${id}`,
		created: new Date("2026-07-13T10:00:00.000Z"),
	};
}

describe("legacy session catalog migration", () => {
	test("stores only a bounded display label from the first prompt", async () => {
		const source = session("/sessions/private.jsonl", "private-id");
		source.name = undefined;
		source.firstMessage = `Investigate login redirects ${"private detail ".repeat(20)}`;
		const catalog: SessionCatalog = {
			async listAll() {
				return [source];
			},
			open() {
				return { getBranch: () => [] };
			},
		};

		const origins = await collectSessionOrigins(projectRoot, catalog);

		expect(origins[0]?.description?.length).toBeLessThanOrEqual(46);
		expect(origins[0]?.description).not.toContain("private detail private detail");
	});

	test("includes queues from the configured custom session directory", async () => {
		const calls: Array<string | undefined> = [];
		const defaultSession = session("/default/session.jsonl", "default-id");
		const customSession = session("/custom/session.jsonl", "custom-id");
		const catalog: SessionCatalog = {
			async listAll(directory) {
				calls.push(directory);
				return directory ? [customSession] : [defaultSession];
			},
			open(path) {
				return {
					getBranch: () => path === customSession.path
						? [{
							type: "custom",
							id: "custom-entry",
							timestamp: "2026-07-13T10:05:00.000Z",
							customType: "mind-queue-state",
							data: {
								version: 2,
								nextId: 2,
								todos: [{ id: 1, text: "From custom sessions", done: false }],
							},
						}]
						: [],
				};
			},
		};

		const imported = await collectLegacyTodos(projectRoot, catalog, "/custom");

		expect(calls).toEqual([undefined, "/custom"]);
		expect(imported.map((todo) => todo.text)).toEqual(["From custom sessions"]);
		expect(imported[0]?.createdIn).toMatchObject({
			id: "custom-id",
			description: "First prompt for custom-id",
		});
	});

	test("deduplicates a session returned by both default and custom catalogs", async () => {
		const shared = session("/shared/session.jsonl", "shared-id");
		let opens = 0;
		const catalog: SessionCatalog = {
			async listAll() {
				return [shared];
			},
			open() {
				opens += 1;
				return { getBranch: () => [] };
			},
		};

		await collectLegacyTodos(projectRoot, catalog, "/custom");

		expect(opens).toBe(1);
	});

	test("aborts when a listed session disappears instead of marking migration complete", async () => {
		const missing = session("/sessions/missing.jsonl", "missing-id");
		const catalog: SessionCatalog = {
			async listAll() {
				return [missing];
			},
			open() {
				const error = new Error("session disappeared") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			},
		};

		await expect(collectLegacyTodos(projectRoot, catalog)).rejects.toThrow(
			"Could not migrate Mind Queue session /sessions/missing.jsonl: session disappeared",
		);
	});

	test("aborts instead of marking a partial migration complete when a session cannot be opened", async () => {
		const broken = session("/sessions/broken.jsonl", "broken-id");
		const catalog: SessionCatalog = {
			async listAll() {
				return [broken];
			},
			open() {
				throw new Error("corrupt session");
			},
		};

		await expect(collectLegacyTodos(projectRoot, catalog)).rejects.toThrow(
			"Could not migrate Mind Queue session /sessions/broken.jsonl: corrupt session",
		);
	});
});
