import {
	extractLegacyTodos,
	normalizeSessionLabel,
	resolveProjectRoot,
	type ImportedTodo,
	type LegacyStateEntry,
	type SessionOrigin,
} from "./store";

const ENTRY_TYPE = "mind-queue-state";
const LEGACY_ENTRY_TYPE = "session-todos-state";

export interface SessionInfoLike {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	firstMessage?: string;
	created: Date;
}

export interface SessionEntryLike {
	type: string;
	id: string;
	timestamp: string;
	customType?: string;
	data?: unknown;
}

export interface SessionCatalog {
	listAll(sessionDir?: string): Promise<SessionInfoLike[]>;
	open(path: string): { getBranch(): SessionEntryLike[] };
}

async function listProjectSessions(
	projectRoot: string,
	catalog: SessionCatalog,
	configuredSessionDir?: string,
): Promise<SessionInfoLike[]> {
	const defaultSessions = await catalog.listAll();
	const configuredSessions = configuredSessionDir
		? await catalog.listAll(configuredSessionDir)
		: [];
	const sessionsByPath = new Map<string, SessionInfoLike>();
	for (const session of [...defaultSessions, ...configuredSessions]) {
		sessionsByPath.set(session.path, session);
	}
	return [...sessionsByPath.values()]
		.filter((session) => session.cwd && resolveProjectRoot(session.cwd) === projectRoot)
		.sort((left, right) => left.created.getTime() - right.created.getTime());
}

export async function collectSessionOrigins(
	projectRoot: string,
	catalog: SessionCatalog,
	configuredSessionDir?: string,
): Promise<SessionOrigin[]> {
	const sessions = await listProjectSessions(projectRoot, catalog, configuredSessionDir);
	return sessions.map((session) => ({
		id: session.id,
		name: normalizeSessionLabel(session.name),
		description: normalizeSessionLabel(session.firstMessage),
		createdAt: session.created.toISOString(),
		persisted: true,
	}));
}

/**
 * Read legacy session-local snapshots from both Pi's default catalog and the
 * active custom --session-dir (when one is configured).
 */
export async function collectLegacyTodos(
	projectRoot: string,
	catalog: SessionCatalog,
	configuredSessionDir?: string,
): Promise<ImportedTodo[]> {
	const projectSessions = await listProjectSessions(projectRoot, catalog, configuredSessionDir);
	const imported: ImportedTodo[] = [];

	for (const session of projectSessions) {
		let branch: SessionEntryLike[];
		try {
			branch = catalog.open(session.path).getBranch();
		} catch (error) {
			throw new Error(
				`Could not migrate Mind Queue session ${session.path}: ${(error as Error).message}`,
				{ cause: error },
			);
		}

		const entries: LegacyStateEntry[] = [];
		for (const entry of branch) {
			if (
				entry.type !== "custom" ||
				(entry.customType !== ENTRY_TYPE && entry.customType !== LEGACY_ENTRY_TYPE)
			) continue;
			entries.push({ id: entry.id, timestamp: entry.timestamp, data: entry.data });
		}
		if (entries.length === 0) continue;

		imported.push(...extractLegacyTodos({
			id: session.id,
			name: normalizeSessionLabel(session.name),
			description: normalizeSessionLabel(session.firstMessage),
			createdAt: session.created.toISOString(),
			persisted: true,
		}, entries));
	}

	return imported;
}
