import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	MindQueueStore,
	assertProjectState,
	extractLegacyTodos,
	getProjectStorePath,
	mutateThoughtIfCurrent,
	type ProjectQueueState,
	type SessionOrigin,
} from "./store";

const tempDirs: string[] = [];
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const flockPath = ["/usr/bin/flock", "/bin/flock", "/usr/local/bin/flock"].find(
	(path) => existsSync(path),
);
const lockUtility = existsSync("/usr/bin/lockf")
	? { path: "/usr/bin/lockf", kind: "lockf" as const }
	: flockPath
		? { path: flockPath, kind: "flock" as const }
		: undefined;

function spawnLockHolder(lockPath: string, readyPath: string) {
	if (!lockUtility) return undefined;
	const script = 'umask 077; : > "$READY"; sleep 5';
	const args =
		lockUtility.kind === "lockf"
			? ["-k", lockPath, "/bin/sh", "-c", script]
			: ["-x", lockPath, "/bin/sh", "-c", script];
	return spawn(lockUtility.path, args, {
		env: { ...process.env, READY: readyPath },
		stdio: "ignore",
	});
}

function probeLock(lockPath: string) {
	if (!lockUtility) return undefined;
	const args =
		lockUtility.kind === "lockf"
			? ["-t", "0", "-k", lockPath, "/usr/bin/true"]
			: ["-n", lockPath, "/usr/bin/true"];
	return spawnSync(lockUtility.path, args, { stdio: "ignore" });
}

function waitForFile(path: string, timeoutMs = 1_000): void {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${path}`);
		Atomics.wait(waitBuffer, 0, 0, 5);
	}
}

function makeTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "mind-queue-test-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

const origin: SessionOrigin = {
	id: "session-alpha-1234",
	name: "Auth cleanup",
	createdAt: "2026-07-13T10:00:00.000Z",
	persisted: true,
};

describe("MindQueueStore", () => {
	test("persists one durable queue per project outside the repository", () => {
		const root = makeTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "workspace", "project-a");
		mkdirSync(projectDir, { recursive: true });

		const store = new MindQueueStore(projectDir, agentDir);
		const initialized = store.initialize([
			{
				text: "Remember the cross-session idea",
				done: false,
				createdAt: "2026-07-13T10:05:00.000Z",
				createdIn: origin,
				legacyKey: "session-alpha-1234:1",
			},
		]);

		expect(initialized.importedCount).toBe(1);
		expect(store.filePath).toBe(getProjectStorePath(projectDir, agentDir));
		expect(store.filePath).toContain(join("state", "mind-queue"));
		expect(store.filePath.startsWith(projectDir)).toBe(false);

		store.update((state) => {
			state.todos.push({
				id: state.nextId++,
				text: "Added from a later session",
				done: false,
				createdAt: "2026-07-14T08:00:00.000Z",
				createdIn: {
					id: "session-beta-5678",
					createdAt: "2026-07-14T07:55:00.000Z",
					persisted: true,
				},
			});
		});

		const reopened = new MindQueueStore(projectDir, agentDir).load();
		expect(reopened.todos.map((todo) => todo.text)).toEqual([
			"Remember the cross-session idea",
			"Added from a later session",
		]);
		expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
	});

	test("uses a different durable file for a different project", () => {
		const root = makeTempDir();
		const agentDir = join(root, "agent");
		const first = join(root, "project-a");
		const second = join(root, "project-b");
		mkdirSync(first);
		mkdirSync(second);

		expect(getProjectStorePath(first, agentDir)).not.toBe(
			getProjectStorePath(second, agentDir),
		);
	});

	test("repairs an existing store file to private permissions when loading it", () => {
		const root = makeTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(projectDir);
		const store = new MindQueueStore(projectDir, agentDir);
		store.initialize();
		chmodSync(store.filePath, 0o644);

		store.load();

		expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
	});

	test("waits rather than entering while another process holds the store lock", () => {
		if (!lockUtility) return;
		const root = makeTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(projectDir);
		const store = new MindQueueStore(projectDir, agentDir, {
			lockTimeoutMs: 50,
			lockRetryMs: 5,
		});
		mkdirSync(dirname(store.filePath), { recursive: true });
		const lockPath = `${store.filePath}.lock`;
		const readyPath = `${lockPath}.test-ready`;
		const holder = spawnLockHolder(lockPath, readyPath);
		if (!holder) return;

		try {
			waitForFile(readyPath);
			expect(() => store.initialize()).toThrow(
				"Timed out waiting for Mind Queue store lock",
			);
			expect(existsSync(lockPath)).toBe(true);
		} finally {
			holder.kill("SIGTERM");
			rmSync(readyPath, { force: true });
		}
	});

	test("holds the kernel lock in the Pi process after the acquisition command exits", () => {
		if (!lockUtility) return;
		const root = makeTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(projectDir);
		const store = new MindQueueStore(projectDir, agentDir);
		store.initialize();
		const lockPath = `${store.filePath}.lock`;

		store.update(() => {
			expect(probeLock(lockPath)?.status).not.toBe(0);
		});

		expect(probeLock(lockPath)?.status).toBe(0);
	});

	test("rejects a stale thought snapshot instead of overwriting a concurrent edit", () => {
		const root = makeTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(projectDir);
		const first = new MindQueueStore(projectDir, agentDir);
		const second = new MindQueueStore(projectDir, agentDir);
		first.initialize();
		first.update((state) => {
			state.todos.push({
				id: state.nextId++,
				text: "Original",
				done: false,
				createdAt: origin.createdAt,
				createdIn: origin,
			});
		});
		const expected = first.load().todos[0]!;
		second.update((state) => {
			state.todos[0]!.text = "Changed elsewhere";
		});

		let applied = true;
		first.update((state) => {
			applied = mutateThoughtIfCurrent(state, expected, (thought) => {
				thought.text = "My stale edit";
			});
		});

		expect(applied).toBe(false);
		expect(first.load().todos[0]?.text).toBe("Changed elsewhere");
	});

	test("initialization is idempotent and does not import legacy thoughts twice", () => {
		const root = makeTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(projectDir);
		const imported = [
			{
				text: "Only once",
				done: false,
				createdAt: "2026-07-13T10:05:00.000Z",
				createdIn: origin,
				legacyKey: "session-alpha-1234:1",
			},
		];

		const first = new MindQueueStore(projectDir, agentDir).initialize(imported);
		const second = new MindQueueStore(projectDir, agentDir).initialize(
			imported,
		);

		expect(first.importedCount).toBe(1);
		expect(second.importedCount).toBe(0);
		expect(second.state.todos).toHaveLength(1);
	});

	test("persists the focused thought id in state and undo snapshots", () => {
		const root = makeTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(projectDir);
		const store = new MindQueueStore(projectDir, agentDir);
		store.initialize([
			{
				text: "Focusable thought",
				done: false,
				createdAt: "2026-07-13T10:05:00.000Z",
				createdIn: origin,
				legacyKey: "session-alpha-1234:1",
			},
		]);

		store.update((state) => {
			state.focusedId = 1;
			state.undo = {
				operationId: "operation-focus",
				actorSessionId: origin.id,
				label: "focus",
				nextId: state.nextId,
				todos: state.todos,
				focusedId: 1,
			};
		});

		const loaded = store.load();
		expect(loaded.focusedId).toBe(1);
		expect(loaded.undo?.focusedId).toBe(1);
	});

	test("rejects invalid focused thought ids", () => {
		const projectPath = "/project";
		const valid: ProjectQueueState = {
			version: 1,
			projectPath,
			nextId: 2,
			todos: [
				{
					id: 1,
					text: "Focusable thought",
					done: false,
					createdAt: "2026-07-13T10:05:00.000Z",
					createdIn: origin,
				},
			],
			legacyMigration: {
				version: 1,
				completedAt: "2026-07-13T10:05:00.000Z",
				importedKeys: [],
			},
			updatedAt: "2026-07-13T10:05:00.000Z",
		};

		assertProjectState({ ...valid, focusedId: 1 }, projectPath);
		for (const focusedId of [1.5, 0]) {
			expect(() =>
				assertProjectState({ ...valid, focusedId }, projectPath),
			).toThrow("invalid focused thought");
			expect(() =>
				assertProjectState(
					{
						...valid,
						undo: {
							operationId: "operation-focus",
							actorSessionId: origin.id,
							label: "focus",
							nextId: valid.nextId,
							todos: valid.todos,
							focusedId,
						},
					},
					projectPath,
				),
			).toThrow("invalid undo state");
		}
	});
});

describe("legacy session migration", () => {
	test("imports only the latest visible queue while retaining creation time and session provenance", () => {
		const imported = extractLegacyTodos(origin, [
			{
				id: "entry-one",
				timestamp: "2026-07-13T10:05:00.000Z",
				data: {
					version: 1,
					nextId: 2,
					todos: [{ id: 1, text: "Original wording", done: false }],
				},
			},
			{
				id: "entry-two",
				timestamp: "2026-07-13T10:10:00.000Z",
				data: {
					version: 2,
					nextId: 3,
					todos: [
						{ id: 1, text: "Edited wording", done: true },
						{ id: 2, text: "Second thought", done: false },
					],
				},
			},
		]);

		expect(imported).toEqual([
			{
				text: "Edited wording",
				done: true,
				createdAt: "2026-07-13T10:05:00.000Z",
				createdIn: origin,
				legacyKey: "session-alpha-1234:1",
			},
			{
				text: "Second thought",
				done: false,
				createdAt: "2026-07-13T10:10:00.000Z",
				createdIn: origin,
				legacyKey: "session-alpha-1234:2",
			},
		]);
	});

	test("does not resurrect thoughts when the latest legacy snapshot is empty", () => {
		const imported = extractLegacyTodos(origin, [
			{
				id: "entry-one",
				timestamp: "2026-07-13T10:05:00.000Z",
				data: {
					version: 1,
					nextId: 2,
					todos: [{ id: 1, text: "Removed", done: false }],
				},
			},
			{
				id: "entry-two",
				timestamp: "2026-07-13T10:10:00.000Z",
				data: { version: 2, nextId: 2, todos: [] },
			},
		]);

		expect(imported).toEqual([]);
	});
});
