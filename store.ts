import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

export interface SessionOrigin {
	id: string;
	name?: string;
	description?: string;
	createdAt: string;
	persisted: boolean;
}

export interface ProjectTodo {
	id: number;
	text: string;
	done: boolean;
	createdAt: string;
	createdIn: SessionOrigin;
	legacyKey?: string;
}

export interface ImportedTodo {
	text: string;
	done: boolean;
	createdAt: string;
	createdIn: SessionOrigin;
	legacyKey: string;
}

export interface EditorInsertion {
	position: number;
	text: string;
}

export interface ProjectUndoState {
	operationId: string;
	actorSessionId: string;
	label: string;
	nextId: number;
	todos: ProjectTodo[];
	editorInsertion?: EditorInsertion;
}

export interface ProjectQueueState {
	version: 1;
	projectPath: string;
	nextId: number;
	todos: ProjectTodo[];
	undo?: ProjectUndoState;
	sessionLabelsVersion?: 1 | 2;
	legacyMigration: {
		version: 1;
		completedAt: string;
		importedKeys: string[];
	};
	updatedAt: string;
}

export interface LegacyStateEntry {
	id: string;
	timestamp: string;
	data: unknown;
}

export interface InitializeResult {
	state: ProjectQueueState;
	created: boolean;
	importedCount: number;
}

export interface MindQueueStoreOptions {
	lockTimeoutMs?: number;
	lockRetryMs?: number;
}

interface ResolvedStoreOptions {
	lockTimeoutMs: number;
	lockRetryMs: number;
}

interface HeldLock {
	descriptor: number;
}

interface LockCommand {
	path: string;
	kind: "lockf" | "flock";
}

interface LegacyTodo {
	id: number;
	text: string;
	done: boolean;
}

interface LegacyPersistedState {
	version: 1 | 2;
	nextId: number;
	todos: LegacyTodo[];
}

const STORE_VERSION = 1;
const DEFAULT_STORE_OPTIONS: ResolvedStoreOptions = {
	lockTimeoutMs: 2_000,
	lockRetryMs: 15,
};
function detectLockCommand(): LockCommand | undefined {
	if (process.platform === "darwin" && existsSync("/usr/bin/lockf")) {
		return { path: "/usr/bin/lockf", kind: "lockf" };
	}
	const flock = ["/usr/bin/flock", "/bin/flock", "/usr/local/bin/flock"]
		.find((path) => existsSync(path));
	return flock ? { path: flock, kind: "flock" } : undefined;
}

const LOCK_COMMAND = detectLockCommand();
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function cloneOrigin(origin: SessionOrigin): SessionOrigin {
	return { ...origin };
}

export function cloneTodos(todos: ProjectTodo[]): ProjectTodo[] {
	return todos.map((todo) => ({ ...todo, createdIn: cloneOrigin(todo.createdIn) }));
}

export function cloneUndo(undo: ProjectUndoState | undefined): ProjectUndoState | undefined {
	if (!undo) return undefined;
	return {
		...undo,
		todos: cloneTodos(undo.todos),
		editorInsertion: undo.editorInsertion ? { ...undo.editorInsertion } : undefined,
	};
}

export function mutateThoughtIfCurrent(
	state: ProjectQueueState,
	expected: ProjectTodo,
	mutation: (thought: ProjectTodo, index: number) => void,
): boolean {
	const index = state.todos.findIndex((thought) => thought.id === expected.id);
	const current = state.todos[index];
	if (
		!current ||
		current.text !== expected.text ||
		current.done !== expected.done
	) return false;
	mutation(current, index);
	return true;
}

function cloneState(state: ProjectQueueState): ProjectQueueState {
	return {
		...state,
		todos: cloneTodos(state.todos),
		undo: cloneUndo(state.undo),
		legacyMigration: {
			...state.legacyMigration,
			importedKeys: [...state.legacyMigration.importedKeys],
		},
	};
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	let existing = absolute;
	const missingParts: string[] = [];

	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return absolute;
		missingParts.unshift(basename(existing));
		existing = parent;
	}

	try {
		return join(realpathSync.native(existing), ...missingParts);
	} catch {
		return absolute;
	}
}

/** Resolve nested working directories to one Git project when possible. */
export function resolveProjectRoot(cwd: string): string {
	const canonicalCwd = canonicalPath(cwd);
	let candidate = canonicalCwd;

	while (true) {
		if (existsSync(join(candidate, ".git"))) return candidate;
		const parent = dirname(candidate);
		if (parent === candidate) return canonicalCwd;
		candidate = parent;
	}
}

export function getProjectStorePath(projectPath: string, agentDir: string): string {
	const canonicalProject = canonicalPath(projectPath);
	const hash = createHash("sha256").update(canonicalProject).digest("hex").slice(0, 24);
	const slug = (basename(canonicalProject) || "project")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "project";
	return join(canonicalPath(agentDir), "state", "mind-queue", `${slug}-${hash}.json`);
}

function isSessionOrigin(value: unknown): value is SessionOrigin {
	if (!value || typeof value !== "object") return false;
	const origin = value as Partial<SessionOrigin>;
	return (
		typeof origin.id === "string" &&
		origin.id.length > 0 &&
		(origin.name === undefined || typeof origin.name === "string") &&
		(origin.description === undefined || typeof origin.description === "string") &&
		typeof origin.createdAt === "string" &&
		typeof origin.persisted === "boolean"
	);
}

function isProjectTodo(value: unknown): value is ProjectTodo {
	if (!value || typeof value !== "object") return false;
	const todo = value as Partial<ProjectTodo>;
	return (
		Number.isInteger(todo.id) &&
		(todo.id ?? 0) > 0 &&
		typeof todo.text === "string" &&
		typeof todo.done === "boolean" &&
		typeof todo.createdAt === "string" &&
		isSessionOrigin(todo.createdIn) &&
		(todo.legacyKey === undefined || typeof todo.legacyKey === "string")
	);
}

function isProjectTodoArray(value: unknown): value is ProjectTodo[] {
	return Array.isArray(value) && value.every(isProjectTodo);
}

function isEditorInsertion(value: unknown): value is EditorInsertion {
	if (!value || typeof value !== "object") return false;
	const insertion = value as Partial<EditorInsertion>;
	return Number.isInteger(insertion.position) && (insertion.position ?? -1) >= 0 && typeof insertion.text === "string";
}

function isProjectUndo(value: unknown): value is ProjectUndoState {
	if (!value || typeof value !== "object") return false;
	const undo = value as Partial<ProjectUndoState>;
	return (
		typeof undo.operationId === "string" &&
		undo.operationId.length > 0 &&
		typeof undo.actorSessionId === "string" &&
		undo.actorSessionId.length > 0 &&
		typeof undo.label === "string" &&
		Number.isInteger(undo.nextId) &&
		(undo.nextId ?? 0) > 0 &&
		isProjectTodoArray(undo.todos) &&
		(undo.editorInsertion === undefined || isEditorInsertion(undo.editorInsertion))
	);
}

function assertProjectState(value: unknown, expectedProjectPath: string): asserts value is ProjectQueueState {
	if (!value || typeof value !== "object") throw new Error("Mind Queue store is not a JSON object");
	const state = value as Partial<ProjectQueueState>;
	const migration = state.legacyMigration;
	let maxId = 0;
	if (Array.isArray(state.todos)) {
		for (const todo of state.todos) {
			if (isProjectTodo(todo)) maxId = Math.max(maxId, todo.id);
		}
	}

	if (state.version !== STORE_VERSION) throw new Error(`Unsupported Mind Queue store version: ${String(state.version)}`);
	if (state.projectPath !== expectedProjectPath) throw new Error("Mind Queue store belongs to a different project");
	if (!Number.isInteger(state.nextId) || (state.nextId ?? 0) <= maxId) throw new Error("Mind Queue store has an invalid nextId");
	if (!isProjectTodoArray(state.todos)) throw new Error("Mind Queue store has invalid thoughts");
	if (state.undo !== undefined && !isProjectUndo(state.undo)) throw new Error("Mind Queue store has invalid undo state");
	if (
		state.sessionLabelsVersion !== undefined &&
		state.sessionLabelsVersion !== 1 &&
		state.sessionLabelsVersion !== 2
	) {
		throw new Error("Mind Queue store has an invalid session-label version");
	}
	if (
		!migration ||
		migration.version !== 1 ||
		typeof migration.completedAt !== "string" ||
		!Array.isArray(migration.importedKeys) ||
		!migration.importedKeys.every((key) => typeof key === "string")
	) throw new Error("Mind Queue store has invalid migration metadata");
	if (typeof state.updatedAt !== "string") throw new Error("Mind Queue store has an invalid update time");
}

function ensurePrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

/**
 * Ask the platform lock utility to lock an inherited file descriptor. BSD
 * advisory locks belong to the shared open-file description, so the lock
 * remains held directly by Pi after the short helper command exits. Closing
 * this descriptor (including on a crash) releases it in the kernel.
 */
function acquireKernelLock(
	lockPath: string,
	options: ResolvedStoreOptions,
	command: LockCommand,
): HeldLock {
	const descriptor = openSync(lockPath, "a", 0o600);
	chmodSync(lockPath, 0o600);
	const deadline = Date.now() + options.lockTimeoutMs;

	while (true) {
		const commandArgs = command.kind === "lockf" ? ["-t", "0", "3"] : ["-n", "3"];
		const result = spawnSync(command.path, commandArgs, {
			stdio: ["ignore", "ignore", "ignore", descriptor],
		});
		if (result.error) {
			closeSync(descriptor);
			throw result.error;
		}
		if (result.status === 0) return { descriptor };
		if (Date.now() >= deadline) {
			closeSync(descriptor);
			throw new Error(`Timed out waiting for Mind Queue store lock: ${lockPath}`);
		}
		sleepSync(options.lockRetryMs);
	}
}

function acquireLock(lockPath: string, options: ResolvedStoreOptions): HeldLock {
	if (!LOCK_COMMAND) {
		throw new Error(
			"Mind Queue requires lockf on macOS or flock on Linux for safe project storage",
		);
	}
	return acquireKernelLock(lockPath, options, LOCK_COMMAND);
}

function releaseLock(lock: HeldLock): void {
	closeSync(lock.descriptor);
}

function withLock<T>(filePath: string, options: ResolvedStoreOptions, operation: () => T): T {
	ensurePrivateDirectory(dirname(filePath));
	const lockPath = `${filePath}.lock`;
	const lock = acquireLock(lockPath, options);
	try {
		return operation();
	} finally {
		releaseLock(lock);
	}
}

function syncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		fsyncSync(descriptor);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EISDIR") throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function writeStateAtomic(filePath: string, state: ProjectQueueState): void {
	const directory = dirname(filePath);
	ensurePrivateDirectory(directory);
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		const descriptor = openSync(temporaryPath, "r");
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporaryPath, filePath);
		chmodSync(filePath, 0o600);
		syncDirectory(directory);
	} finally {
		try {
			unlinkSync(temporaryPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function readState(filePath: string, projectPath: string): ProjectQueueState {
	let parsed: unknown;
	try {
		ensurePrivateDirectory(dirname(filePath));
		chmodSync(filePath, 0o600);
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(`Could not read Mind Queue store ${filePath}: ${(error as Error).message}`);
	}
	assertProjectState(parsed, projectPath);
	return cloneState(parsed);
}

export class MindQueueStore {
	readonly projectPath: string;
	readonly filePath: string;
	private readonly options: ResolvedStoreOptions;

	constructor(projectPath: string, agentDir: string, options: MindQueueStoreOptions = {}) {
		this.projectPath = canonicalPath(projectPath);
		this.filePath = getProjectStorePath(this.projectPath, agentDir);
		this.options = {
			lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_STORE_OPTIONS.lockTimeoutMs,
			lockRetryMs: options.lockRetryMs ?? DEFAULT_STORE_OPTIONS.lockRetryMs,
		};
	}

	initialize(importedTodos: ImportedTodo[] = []): InitializeResult {
		return withLock(this.filePath, this.options, () => {
			if (existsSync(this.filePath)) {
				return { state: readState(this.filePath, this.projectPath), created: false, importedCount: 0 };
			}

			const now = new Date().toISOString();
			const seenKeys = new Set<string>();
			const todos: ProjectTodo[] = [];
			let nextId = 1;

			for (const imported of importedTodos) {
				if (seenKeys.has(imported.legacyKey)) continue;
				seenKeys.add(imported.legacyKey);
				todos.push({
					id: nextId++,
					text: imported.text,
					done: imported.done,
					createdAt: imported.createdAt,
					createdIn: cloneOrigin(imported.createdIn),
					legacyKey: imported.legacyKey,
				});
			}

			const state: ProjectQueueState = {
				version: STORE_VERSION,
				projectPath: this.projectPath,
				nextId,
				todos,
				sessionLabelsVersion: 2,
				legacyMigration: {
					version: 1,
					completedAt: now,
					importedKeys: [...seenKeys],
				},
				updatedAt: now,
			};
			writeStateAtomic(this.filePath, state);
			return { state: cloneState(state), created: true, importedCount: todos.length };
		});
	}

	load(): ProjectQueueState {
		return readState(this.filePath, this.projectPath);
	}

	update(mutator: (state: ProjectQueueState) => void): ProjectQueueState {
		return withLock(this.filePath, this.options, () => {
			const state = readState(this.filePath, this.projectPath);
			mutator(state);
			state.updatedAt = new Date().toISOString();
			assertProjectState(state, this.projectPath);
			writeStateAtomic(this.filePath, state);
			return cloneState(state);
		});
	}
}

function isLegacyTodoArray(value: unknown): value is LegacyTodo[] {
	if (!Array.isArray(value)) return false;
	return value.every((todo) => {
		if (todo === null || typeof todo !== "object") return false;
		const candidate = todo as Partial<LegacyTodo>;
		return (
			Number.isInteger(candidate.id) &&
			(candidate.id ?? 0) > 0 &&
			typeof candidate.text === "string" &&
			typeof candidate.done === "boolean"
		);
	});
}

function isLegacyPersistedState(value: unknown): value is LegacyPersistedState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<LegacyPersistedState>;
	return (
		(state.version === 1 || state.version === 2) &&
		Number.isInteger(state.nextId) &&
		(state.nextId ?? 0) > 0 &&
		isLegacyTodoArray(state.todos)
	);
}

/** Convert the final visible legacy queue from one session into project-store imports. */
export function extractLegacyTodos(origin: SessionOrigin, entries: LegacyStateEntry[]): ImportedTodo[] {
	const validEntries = entries.filter((entry) => isLegacyPersistedState(entry.data));
	const latest = validEntries.at(-1);
	if (!latest || !isLegacyPersistedState(latest.data)) return [];

	const firstSeenAt = new Map<number, string>();
	for (const entry of validEntries) {
		if (!isLegacyPersistedState(entry.data)) continue;
		for (const todo of entry.data.todos) {
			if (!firstSeenAt.has(todo.id)) firstSeenAt.set(todo.id, entry.timestamp);
		}
	}

	return latest.data.todos.map((todo) => ({
		text: todo.text,
		done: todo.done,
		createdAt: firstSeenAt.get(todo.id) ?? latest.timestamp,
		createdIn: cloneOrigin(origin),
		legacyKey: `${origin.id}:${todo.id}`,
	}));
}

export function normalizeSessionLabel(value: string | undefined): string | undefined {
	const cleaned = value
		? stripVTControlCharacters(value)
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
		: "";
	if (!cleaned) return undefined;
	return cleaned.length > 46 ? `${cleaned.slice(0, 45).trimEnd()}…` : cleaned;
}

function fallbackSessionDate(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "unnamed session";
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatSessionOrigin(origin: SessionOrigin, currentSessionId?: string): string {
	const label = normalizeSessionLabel(origin.name)
		?? normalizeSessionLabel(origin.description)
		?? fallbackSessionDate(origin.createdAt);
	const shortId = origin.id.slice(0, 8) || "unknown";
	const ephemeral = origin.persisted ? "" : " · ephemeral";
	const current = origin.id === currentSessionId ? " · current" : "";
	return `${label} · #${shortId}${ephemeral}${current}`;
}

export function orderTodosBySession(todos: ProjectTodo[], currentSessionId?: string): ProjectTodo[] {
	const groups = new Map<string, { origin: SessionOrigin; todos: ProjectTodo[]; firstIndex: number }>();
	todos.forEach((todo, index) => {
		const existing = groups.get(todo.createdIn.id);
		if (existing) existing.todos.push(todo);
		else groups.set(todo.createdIn.id, { origin: todo.createdIn, todos: [todo], firstIndex: index });
	});

	return [...groups.values()]
		.sort((left, right) => {
			const leftCurrent = left.origin.id === currentSessionId ? 1 : 0;
			const rightCurrent = right.origin.id === currentSessionId ? 1 : 0;
			if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
			const byCreated = right.origin.createdAt.localeCompare(left.origin.createdAt);
			return byCreated || left.firstIndex - right.firstIndex;
		})
		.flatMap((group) => group.todos);
}
