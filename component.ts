import { statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	type Focusable,
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatSessionOrigin, type ProjectTodo } from "./store";

export type DialogResult =
	| { action: "edit"; thought: ProjectTodo }
	| { action: "move"; thought: ProjectTodo }
	| undefined;

export interface TodoManagerOptions {
	theme: Theme;
	cwd: string;
	requestRender: () => void;
	getThoughts: () => ProjectTodo[];
	currentSessionId: string;
	getUndoLabel: () => string | undefined;
	addThought: (text: string) => boolean;
	captureEditorThought: () => boolean;
	copyThought: (thought: ProjectTodo) => void;
	removeThought: (thought: ProjectTodo, reason: "delete" | "move") => boolean;
	toggleThought: (thought: ProjectTodo) => boolean;
	toggleFocus: (thought: ProjectTodo) => boolean;
	getFocusedId: () => number | undefined;
	undoLast: () => void;
	clearCompleted: () => boolean;
	shortcut?: KeyId;
	/** Clock for ages and headings; tests pin it. */
	now?: () => Date;
	done: (result: DialogResult) => void;
}

export const MIND_QUEUE_SHORTCUT = Key.ctrlShift("m");

function formatShortcut(shortcut: KeyId): string {
	return shortcut
		.split("+")
		.map((part) =>
			part.length === 1
				? part.toUpperCase()
				: part.charAt(0).toUpperCase() + part.slice(1),
		)
		.join("+");
}

export function formatMindQueueStatus(openCount: number): string | undefined {
	return openCount > 0 ? String(openCount) : undefined;
}

export function sanitizeThoughtForEditor(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function sanitizeThoughtForDisplay(text: string): string {
	return sanitizeThoughtForEditor(text).replace(/\n+/g, " ↵ ");
}

/** Format a thought's creation time as a compact relative age. */
export function formatThoughtAge(
	createdAt: string,
	now: Date = new Date(),
): string {
	const created = new Date(createdAt).getTime();
	if (Number.isNaN(created)) return "";
	const seconds = Math.max(0, Math.floor((now.getTime() - created) / 1000));
	if (seconds < 90) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	const weeks = Math.floor(days / 7);
	if (weeks < 5) return `${weeks}w`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo`;
	return `${Math.floor(days / 365)}y`;
}

/** Open thoughts at least this old show an amber age and count as stale. */
export const STALE_THOUGHT_DAYS = 14;
/** Open thoughts at least this old show a red age. */
export const VERY_STALE_THOUGHT_DAYS = 30;
const DAY_MS = 86_400_000;

/** Whole days since a thought was created, or undefined for a bad date. */
export function thoughtAgeDays(
	createdAt: string,
	now: Date = new Date(),
): number | undefined {
	const created = new Date(createdAt).getTime();
	if (Number.isNaN(created)) return undefined;
	return Math.max(0, Math.floor((now.getTime() - created) / DAY_MS));
}

/** Queue heading for a thought, by local calendar day. */
export function thoughtAgeGroup(
	createdAt: string,
	now: Date = new Date(),
): string {
	const created = new Date(createdAt).getTime();
	if (Number.isNaN(created)) return "Undated";
	const today = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
	).getTime();
	if (created >= today) return "Today";
	if (created >= today - DAY_MS) return "Yesterday";
	if (created >= today - 6 * DAY_MS) return "Last 7 days";
	if (created >= today - 29 * DAY_MS) return "Last 30 days";
	return "Older";
}

/** Startup reminder text when open thoughts have gone stale, else undefined. */
export function staleThoughtReminder(
	thoughts: readonly ProjectTodo[],
	now: Date = new Date(),
): string | undefined {
	const ages = thoughts
		.filter((thought) => !thought.done)
		.map((thought) => thoughtAgeDays(thought.createdAt, now))
		.filter((days): days is number => days !== undefined)
		.filter((days) => days >= STALE_THOUGHT_DAYS);
	if (ages.length === 0) return undefined;
	const count =
		ages.length === 1 ? "1 open thought is" : `${ages.length} open thoughts are`;
	return `Mind Queue: ${count} over 2 weeks old (oldest ${Math.max(...ages)}d) · /mind cleanup to review`;
}

/** Remind at most once per interval per project. */
export const STALE_REMINDER_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** Format a thought's creation time as a phrase for the detail view. */
export function formatThoughtAgeLong(
	createdAt: string,
	now: Date = new Date(),
): string {
	const age = formatThoughtAge(createdAt, now);
	if (!age) return "";
	return age === "now" ? "just now" : `${age} ago`;
}

function snapshot(thought: ProjectTodo): ProjectTodo {
	return { ...thought, createdIn: { ...thought.createdIn } };
}

/** Width of a row's ` › ○ ` lead. */
const ROW_PREFIX_WIDTH = 5;
/** Lines the selected thought may wrap onto in the list. */
const MAX_EXPANDED_LINES = 3;

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

function startsPathEscape(
	character: string,
	quote: "'" | '"' | undefined,
	preserveBackslashes: boolean,
): boolean {
	return character === "\\" && quote !== "'" && !preserveBackslashes;
}

function isPathQuote(character: string): character is "'" | '"' {
	return character === "'" || character === '"';
}

function isPathSeparator(
	character: string,
	quote: "'" | '"' | undefined,
): boolean {
	return quote === undefined && /\s/.test(character);
}

function splitDroppedPathTokens(text: string): string[] | undefined {
	const trimmed = text.trim();
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const preserveBackslashes = /(?:^|\s)["']?[a-z]:\\/i.test(trimmed);

	for (const character of trimmed) {
		if (escaped) {
			token += character;
			escaped = false;
			continue;
		}
		if (startsPathEscape(character, quote, preserveBackslashes)) {
			escaped = true;
			continue;
		}
		if (isPathQuote(character)) {
			if (quote === character) quote = undefined;
			else if (!quote) quote = character;
			else token += character;
			continue;
		}
		if (isPathSeparator(character, quote)) {
			if (token) tokens.push(token);
			token = "";
			continue;
		}
		token += character;
	}

	if (escaped || quote) return undefined;
	if (token) tokens.push(token);
	return tokens.length > 0 ? tokens : undefined;
}

function droppedPath(token: string, cwd: string): string | undefined {
	let path = token.startsWith("@") ? token.slice(1) : token;
	if (!path || /[\u0000-\u001f\u007f]/.test(path)) return undefined;

	try {
		if (path.startsWith("file://")) path = fileURLToPath(path);
		else if (!isAbsolute(path)) path = resolve(cwd, path);
		if (!statSync(path).isFile()) return undefined;
		return path;
	} catch {
		return undefined;
	}
}

function formatFileReference(path: string): string {
	if (!/\s/.test(path)) return `@${path}`;
	return `@"${path.replaceAll('"', '\\"')}"`;
}

function formatDroppedFileReferences(
	text: string,
	cwd: string,
): string | undefined {
	const tokens = splitDroppedPathTokens(text);
	if (!tokens) return undefined;
	const paths: string[] = [];
	for (const token of tokens) {
		const path = droppedPath(token, cwd);
		if (!path) return undefined;
		paths.push(path);
	}
	return paths.map(formatFileReference).join(" ");
}

export class TodoManagerComponent implements Focusable {
	private _focused = false;
	private selected = 0;
	private mode: "list" | "add" | "view" | "filter" | "help" = "list";
	private showDone = false;
	private viewScroll = 0;
	private input = new Input();
	private filterInput = new Input();
	private filterText = "";
	private addPasteBuffer: string | undefined;

	constructor(private readonly options: TodoManagerOptions) {
		this.configureInput();
		this.configureFilterInput();
	}

	private configureFilterInput(): void {
		this.filterInput.onSubmit = () => this.leaveFilterMode(true);
		this.filterInput.onEscape = () => this.leaveFilterMode(false);
	}

	private leaveFilterMode(keepFilter: boolean): void {
		if (!keepFilter) {
			this.filterText = "";
			this.filterInput = new Input();
			this.configureFilterInput();
		}
		this.mode = "list";
		this.clampSelection();
		this.syncInputFocus();
		this.options.requestRender();
	}

	private configureInput(): void {
		this.input.onSubmit = (value) => {
			const text = value.trim();
			if (!text || !this.options.addThought(text)) return;
			this.resetInput();
			const newestId = this.options.getThoughts().at(-1)?.id;
			this.selected = Math.max(
				0,
				this.thoughts().findIndex((thought) => thought.id === newestId),
			);
			this.options.requestRender();
		};
		this.input.onEscape = () => this.leaveInputMode();
	}

	private resetInput(): void {
		this.input = new Input();
		this.configureInput();
		this.syncInputFocus();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncInputFocus();
	}

	private syncInputFocus(): void {
		this.input.focused = this._focused && this.mode === "add";
		this.filterInput.focused = this._focused && this.mode === "filter";
	}

	private now(): Date {
		return this.options.now?.() ?? new Date();
	}

	/** Every thought matching the filter, newest first. */
	private matching(): ProjectTodo[] {
		const created = (thought: ProjectTodo): number =>
			Date.parse(thought.createdAt) || 0;
		const ordered = [...this.options.getThoughts()].sort(
			(left, right) => created(right) - created(left) || right.id - left.id,
		);
		const query = this.filterText.trim().toLowerCase();
		if (!query) return ordered;
		return ordered.filter((thought) =>
			thought.text.toLowerCase().includes(query),
		);
	}

	/** Selectable rows: open thoughts, then done ones only when shown. */
	private thoughts(): ProjectTodo[] {
		const matching = this.matching();
		const open = matching.filter((thought) => !thought.done);
		if (!this.showDone) return open;
		return [...open, ...matching.filter((thought) => thought.done)];
	}

	private hiddenDoneCount(): number {
		if (this.showDone) return 0;
		return this.matching().filter((thought) => thought.done).length;
	}

	private groupLabel(thought: ProjectTodo): string {
		return thought.done ? "Done" : thoughtAgeGroup(thought.createdAt, this.now());
	}

	private toggleShowDone(): void {
		const selectedId = this.thoughts()[this.selected]?.id;
		this.showDone = !this.showDone;
		const index = this.thoughts().findIndex(
			(thought) => thought.id === selectedId,
		);
		this.selected = Math.max(0, index);
		this.clampSelection();
		this.options.requestRender();
	}

	private clampSelection(): void {
		this.selected = Math.max(
			0,
			Math.min(this.selected, this.thoughts().length - 1),
		);
	}

	/**
	 * Widest slice around the selection that fits `maxRows`, counting group
	 * headings, the expanded selected row, and the "more" markers.
	 */
	private visibleListWindow(
		thoughts: ProjectTodo[],
		maxRows: number,
		innerWidth: number,
	): { start: number; end: number } {
		const groups = thoughts.map((thought) => this.groupLabel(thought));
		const height = (index: number): number => {
			const thought = thoughts[index];
			if (!thought || index !== this.selected) return 1;
			return this.labelLines(thought, this.labelWidth(thought, innerWidth), true)
				.length;
		};
		const rows = (start: number, end: number): number => {
			let total = (start > 0 ? 1 : 0) + (end < thoughts.length ? 1 : 0);
			for (let index = start; index < end; index++) {
				total += height(index);
				if (index === start || groups[index] !== groups[index - 1]) total += 1;
			}
			return total;
		};

		let start = this.selected;
		let end = this.selected + 1;
		while (true) {
			const left =
				start > 0 && rows(start - 1, end) <= maxRows
					? rows(start - 1, end)
					: undefined;
			const right =
				end < thoughts.length && rows(start, end + 1) <= maxRows
					? rows(start, end + 1)
					: undefined;
			if (left === undefined && right === undefined) break;
			// Prefer the cheaper side; on a tie, grow the shorter side.
			const growLeft =
				right === undefined ||
				(left !== undefined &&
					(left < right ||
						(left === right &&
							this.selected - start <= end - this.selected - 1)));
			if (growLeft) start -= 1;
			else end += 1;
		}

		return { start, end };
	}

	private leaveInputMode(): void {
		this.mode = "list";
		this.addPasteBuffer = undefined;
		this.resetInput();
		this.options.requestRender();
	}

	private insertAddPaste(text: string): void {
		const references = formatDroppedFileReferences(text, this.options.cwd);
		let pastedText = text;
		if (references) {
			const hasText = this.input.getValue().length > 0;
			const endsWithSpace = /\s$/.test(this.input.getValue());
			const prefix = hasText && !endsWithSpace ? " " : "";
			pastedText = `${prefix}${references} `;
		}
		this.input.handleInput(
			`${BRACKETED_PASTE_START}${pastedText}${BRACKETED_PASTE_END}`,
		);
	}

	private handleAddInput(data: string): void {
		let remaining = data;
		while (remaining) {
			if (this.addPasteBuffer !== undefined) {
				const end = remaining.indexOf(BRACKETED_PASTE_END);
				if (end === -1) {
					this.addPasteBuffer += remaining;
					return;
				}
				this.addPasteBuffer += remaining.slice(0, end);
				this.insertAddPaste(this.addPasteBuffer);
				this.addPasteBuffer = undefined;
				remaining = remaining.slice(end + BRACKETED_PASTE_END.length);
				continue;
			}

			const start = remaining.indexOf(BRACKETED_PASTE_START);
			if (start === -1) {
				this.input.handleInput(remaining);
				return;
			}
			if (start > 0) this.input.handleInput(remaining.slice(0, start));
			this.addPasteBuffer = "";
			remaining = remaining.slice(start + BRACKETED_PASTE_START.length);
		}
	}

	/** Plain `#id · age` text, as wide as the styled version. */
	private thoughtMeta(thought: ProjectTodo): string {
		const age = formatThoughtAge(thought.createdAt, this.now());
		return age ? `#${thought.id} · ${age}` : `#${thought.id}`;
	}

	/** Width left for the text after the marker prefix and the meta. */
	private labelWidth(thought: ProjectTodo, innerWidth: number): number {
		return Math.max(
			1,
			innerWidth - ROW_PREFIX_WIDTH - visibleWidth(this.thoughtMeta(thought)) - 1,
		);
	}

	/** One truncated line, or up to three wrapped lines for the selection. */
	private labelLines(
		thought: ProjectTodo,
		labelWidth: number,
		expanded: boolean,
	): string[] {
		const text = sanitizeThoughtForDisplay(thought.text);
		if (!expanded) return [truncateToWidth(text, labelWidth, "…")];
		const wrapped = wrapTextWithAnsi(text, labelWidth);
		if (wrapped.length <= MAX_EXPANDED_LINES) return wrapped;
		const kept = wrapped.slice(0, MAX_EXPANDED_LINES);
		const rest = wrapped.slice(MAX_EXPANDED_LINES - 1).join(" ");
		kept[MAX_EXPANDED_LINES - 1] = truncateToWidth(rest, labelWidth, "…");
		return kept;
	}

	private renderThoughtRow(
		thought: ProjectTodo,
		active: boolean,
		innerWidth: number,
		row: (text: string, highlighted?: boolean) => string,
		expand: boolean,
	): string[] {
		const theme = this.options.theme;
		const pointer = active ? theme.fg("accent", "›") : " ";
		let marker: string;
		if (thought.done) {
			marker = theme.fg("success", "✓");
		} else if (thought.id === this.options.getFocusedId()) {
			marker = theme.fg("accent", "◆");
		} else {
			marker = theme.fg("dim", "○");
		}
		const style = (text: string): string =>
			thought.done
				? theme.fg("muted", theme.strikethrough(text))
				: theme.fg(active ? "accent" : "text", text);

		// Stale open thoughts get a warmer age so they stand out.
		const meta = this.thoughtMeta(thought);
		const days = thoughtAgeDays(thought.createdAt, this.now()) ?? 0;
		let ageColor: "dim" | "warning" | "error" = "dim";
		if (!thought.done && days >= VERY_STALE_THOUGHT_DAYS) ageColor = "error";
		else if (!thought.done && days >= STALE_THOUGHT_DAYS) ageColor = "warning";
		const [id = meta, age] = meta.split(" · ");
		const styledMeta = age
			? `${theme.fg("dim", `${id} · `)}${theme.fg(ageColor, age)}`
			: theme.fg("dim", id);

		const lines = this.labelLines(
			thought,
			this.labelWidth(thought, innerWidth),
			active && expand,
		);
		return lines.map((line, index) => {
			const first = index === 0;
			const lead = first
				? ` ${pointer} ${marker} `
				: " ".repeat(ROW_PREFIX_WIDTH);
			const tailWidth = first ? visibleWidth(meta) : 0;
			const gap = " ".repeat(
				Math.max(
					first ? 1 : 0,
					innerWidth - ROW_PREFIX_WIDTH - visibleWidth(line) - tailWidth,
				),
			);
			return row(
				`${lead}${style(line)}${gap}${first ? styledMeta : ""}`,
				active,
			);
		});
	}

	private handleFilterInput(data: string): void {
		if (matchesKey(data, Key.tab)) {
			this.leaveFilterMode(true);
			return;
		}
		this.filterInput.handleInput(data);
		const nextQuery = this.filterInput.getValue();
		if (nextQuery !== this.filterText) {
			this.filterText = nextQuery;
			this.selected = 0;
		}
		this.options.requestRender();
	}

	private handleViewInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.tab) ||
			data === "v" ||
			data === "V"
		) {
			this.mode = "list";
			this.viewScroll = 0;
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.viewScroll = Math.max(0, this.viewScroll - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.viewScroll += 1;
		}
		this.options.requestRender();
	}

	private handleHelpInput(data: string): void {
		if (matchesKey(data, this.options.shortcut ?? MIND_QUEUE_SHORTCUT)) {
			this.options.done(undefined);
			return;
		}
		if (
			data === "?" ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.tab) ||
			data === "q"
		) {
			this.mode = "list";
			this.options.requestRender();
		}
	}

	private handleListInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, this.options.shortcut ?? MIND_QUEUE_SHORTCUT)
		) {
			this.options.done(undefined);
			return;
		}
		if (data === "a" || data === "A") {
			this.mode = "add";
			this.resetInput();
			this.options.requestRender();
			return;
		}
		if (data === "/") {
			this.mode = "filter";
			this.syncInputFocus();
			this.options.requestRender();
			return;
		}
		if (data === "?") {
			this.mode = "help";
			this.options.requestRender();
			return;
		}
		if (data === "h" || data === "H") {
			this.toggleShowDone();
			return;
		}
		if (data === "c" || data === "C") {
			if (this.options.clearCompleted()) this.clampSelection();
			this.options.requestRender();
			return;
		}
		if (data === "p" || data === "P") {
			if (this.options.captureEditorThought()) {
				const newestId = this.options.getThoughts().at(-1)?.id;
				this.selected = Math.max(
					0,
					this.thoughts().findIndex((thought) => thought.id === newestId),
				);
			}
			this.options.requestRender();
			return;
		}

		const thoughts = this.thoughts();
		const selected = thoughts[this.selected];
		if (!selected) return;

		if (data === "y" || data === "Y") {
			this.options.copyThought(selected);
		} else if (data === "v" || data === "V") {
			this.mode = "view";
			this.viewScroll = 0;
		} else if ((data === "u" || data === "U") && this.options.getUndoLabel()) {
			this.options.undoLast();
			this.clampSelection();
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selected = Math.min(thoughts.length - 1, this.selected + 1);
		} else if (matchesKey(data, Key.enter)) {
			if (!this.options.removeThought(selected, "move")) {
				this.options.requestRender();
				return;
			}
			this.options.done({ action: "move", thought: snapshot(selected) });
			return;
		} else if (data === "e" || data === "E") {
			this.options.done({ action: "edit", thought: snapshot(selected) });
			return;
		} else if (data === "d" || data === "D" || matchesKey(data, Key.delete)) {
			if (this.options.removeThought(selected, "delete")) this.clampSelection();
		} else if (data === "f" || data === "F") {
			this.options.toggleFocus(selected);
		} else if (data === "x" || data === "X" || matchesKey(data, Key.space)) {
			this.options.toggleThought(selected);
		}

		this.options.requestRender();
	}

	handleInput(data: string): void {
		if (this.mode === "add") {
			if (matchesKey(data, Key.tab)) this.leaveInputMode();
			else {
				this.handleAddInput(data);
				this.options.requestRender();
			}
			return;
		}
		if (this.mode === "filter") {
			this.handleFilterInput(data);
			return;
		}
		if (this.mode === "view") {
			this.handleViewInput(data);
			return;
		}
		if (this.mode === "help") {
			this.handleHelpInput(data);
			return;
		}
		this.handleListInput(data);
	}

	render(width: number): string[] {
		if (width <= 2)
			return width > 0 ? [truncateToWidth("Mind", width, "")] : [];

		const innerWidth = width - 2;
		const lines: string[] = [];
		const thoughts = this.thoughts();
		// Counts include done thoughts even while they are hidden.
		const counted = this.matching();
		const openCount = counted.filter((thought) => !thought.done).length;
		const doneCount = counted.length - openCount;
		const folderName = basename(this.options.cwd) || this.options.cwd;
		this.clampSelection();

		const borderColor = this.mode === "list" ? "border" : "borderAccent";
		const border = (text: string): string =>
			this.options.theme.fg(borderColor, text);
		const fit = (text: string): string => {
			const truncated = truncateToWidth(text, innerWidth, "…");
			return (
				truncated +
				" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))
			);
		};
		const row = (text = "", highlighted = false): string => {
			const content = fit(text);
			return (
				border("│") +
				(highlighted ? this.options.theme.bg("selectedBg", content) : content) +
				border("│")
			);
		};
		const hint = (key: string, label: string): string =>
			`${this.options.theme.fg("accent", key)} ${this.options.theme.fg("dim", label)}`;
		const divider = (): string => border(`├${"─".repeat(innerWidth)}┤`);
		const modeLabel = {
			add: "NEW",
			view: "DETAIL",
			list: "QUEUE",
			filter: "FILTER",
			help: "KEYS",
		}[this.mode];
		const title = ` ${this.options.theme.fg("accent", this.options.theme.bold("◆ Mind Queue"))}`;
		const counts = this.options.theme.fg(
			"dim",
			`${openCount} open · ${doneCount} done`,
		);
		const titleGap = " ".repeat(
			Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(counts)),
		);

		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
		lines.push(row(`${title}${titleGap}${counts}`));
		const totalThoughts = this.options.getThoughts().length;
		const filterQuery = sanitizeThoughtForDisplay(this.filterText.trim());
		const countLabel = filterQuery
			? `${thoughts.length} of ${totalThoughts} thought${totalThoughts === 1 ? "" : "s"} · filter: "${filterQuery}"`
			: `${thoughts.length} thought${thoughts.length === 1 ? "" : "s"}`;
		lines.push(
			row(
				` ${this.options.theme.bg("selectedBg", this.options.theme.fg("accent", ` ${modeLabel} `))}  ${this.options.theme.fg("dim", `${countLabel} · ${folderName} · saved automatically`)}`,
			),
		);
		lines.push(divider());

		if (this.mode === "add") {
			lines.push(
				row(
					` ${this.options.theme.fg("accent", this.options.theme.bold("Capture a thought"))}`,
				),
			);
			lines.push(
				row(
					` ${this.options.theme.fg("muted", "Type below or drop files/images into the field")}`,
				),
			);
			lines.push(row());
			const inputLine = this.input.render(Math.max(1, innerWidth - 3))[0] ?? "";
			lines.push(row(` ${inputLine}`, true));
			lines.push(
				row(
					` ${this.options.theme.fg("dim", "Dropped files stay local and are saved as @path references")}`,
				),
			);
			lines.push(
				row(` ${hint("Enter", "add another")} · ${hint("Tab/Esc", "back")}`),
			);
		} else if (this.mode === "filter") {
			lines.push(
				row(
					` ${this.options.theme.fg("accent", this.options.theme.bold("Filter thoughts"))}`,
				),
			);
			lines.push(
				row(
					` ${this.options.theme.fg("muted", "Type to match thought text; the list updates live")}`,
				),
			);
			lines.push(row());
			const inputLine =
				this.filterInput.render(Math.max(1, innerWidth - 3))[0] ?? "";
			lines.push(row(` ${inputLine}`, true));
			lines.push(
				row(
					` ${this.options.theme.fg("dim", `${thoughts.length} of ${totalThoughts} thought${totalThoughts === 1 ? "" : "s"} match`)}`,
				),
			);
			const maxMatches = 8;
			for (
				let index = 0;
				index < Math.min(thoughts.length, maxMatches);
				index++
			) {
				const match = thoughts[index];
				if (match)
					lines.push(
						...this.renderThoughtRow(
							match,
							index === this.selected,
							innerWidth,
							row,
							false,
						),
					);
			}
			if (thoughts.length > maxMatches) {
				lines.push(
					row(
						` ${this.options.theme.fg("dim", `↓ ${thoughts.length - maxMatches} more matches`)}`,
					),
				);
			}
			lines.push(
				row(
					` ${hint("Enter/Tab", "apply")} · ${hint("Esc", "clear and back")}`,
				),
			);
		} else if (this.mode === "view") {
			const thought = thoughts[this.selected];
			lines.push(
				row(
					` ${this.options.theme.fg("accent", this.options.theme.bold("Thought details"))}`,
				),
			);
			if (thought) {
				const status = thought.done
					? this.options.theme.fg("success", "✓ Done")
					: this.options.theme.fg("accent", "○ Open");
				const focusStatus =
					thought.id === this.options.getFocusedId()
						? ` ${this.options.theme.fg("dim", "·")} ${this.options.theme.fg("accent", "◆ Focused")}`
						: "";
				lines.push(
					row(
						` ${this.options.theme.fg("accent", this.options.theme.bold(`#${thought.id}`))} ${this.options.theme.fg("dim", "·")} ${status}${focusStatus}`,
					),
				);
				const age = formatThoughtAgeLong(thought.createdAt);
				lines.push(
					row(
						` ${this.options.theme.fg("dim", `Created in ${formatSessionOrigin(thought.createdIn, this.options.currentSessionId)}${age ? ` · ${age}` : ""}`)}`,
					),
				);
				lines.push(row());
				const wrapped = wrapTextWithAnsi(
					sanitizeThoughtForEditor(thought.text),
					Math.max(1, innerWidth - 2),
				);
				const maxVisible = 16;
				const maxScroll = Math.max(0, wrapped.length - maxVisible);
				this.viewScroll = Math.min(this.viewScroll, maxScroll);
				const visible = wrapped.slice(
					this.viewScroll,
					this.viewScroll + maxVisible,
				);
				for (const text of visible) {
					lines.push(row(` ${this.options.theme.fg("text", text)}`));
				}
				if (wrapped.length > maxVisible) {
					const from = this.viewScroll + 1;
					const to = this.viewScroll + visible.length;
					lines.push(
						row(
							` ${this.options.theme.fg("dim", `Lines ${from}–${to} of ${wrapped.length}`)}`,
						),
					);
				}
			}
			lines.push(row());
			lines.push(
				row(
					` ${hint("↑↓/jk", "scroll")} · ${hint("V/Tab/Esc", "back to queue")}`,
				),
			);
		} else if (this.mode === "help") {
			const keys: Array<[string, string]> = [
				["A", "add a thought, or drop files/images"],
				["/", "filter by text"],
				["↑↓/jk", "select"],
				["Enter", "move to Pi's editor"],
				["E", "edit in Pi's editor"],
				["V", "view full thought"],
				["Y", "copy"],
				["P", "save editor draft"],
				["X/Space", "mark done or open"],
				["F", "focus in the status bar"],
				["H", "show or hide done thoughts"],
				["C", "clear done thoughts"],
				["D", "remove"],
				["U", "undo the latest change"],
				[formatShortcut(this.options.shortcut ?? MIND_QUEUE_SHORTCUT), "close"],
			];
			const keyWidth = Math.max(...keys.map(([key]) => visibleWidth(key)));
			for (const [key, label] of keys) {
				const padding = " ".repeat(keyWidth - visibleWidth(key));
				lines.push(row(` ${hint(`${key}${padding}`, label)}`));
			}
			lines.push(row());
			lines.push(
				row(
					` ${this.options.theme.fg("dim", "/mind <thought> · /mind cleanup · /mind focus <id>")}`,
				),
			);
		} else if (thoughts.length === 0) {
			const hiddenDone = this.hiddenDoneCount();
			lines.push(row());
			if (filterQuery) {
				lines.push(
					row(
						` ${this.options.theme.fg("muted", `◇ No thoughts match "${filterQuery}"`)}`,
					),
				);
				lines.push(
					row(
						` ${hint("/", "edit the filter")} · ${this.options.theme.fg("dim", "Esc inside the filter clears it")}`,
					),
				);
			} else if (hiddenDone > 0) {
				lines.push(
					row(
						` ${this.options.theme.fg("muted", `◇ No open thoughts · ${hiddenDone} done hidden`)}`,
					),
				);
				lines.push(
					row(` ${hint("H", "show done")} · ${hint("A", "add a thought")}`),
				);
			} else {
				lines.push(
					row(` ${this.options.theme.fg("muted", "◇ Nothing queued yet")}`),
				);
				lines.push(
					row(
						` ${hint("A", "capture your first thought")} · ${this.options.theme.fg("dim", "it will persist across sessions")}`,
					),
				);
			}
		} else {
			const { start, end } = this.visibleListWindow(thoughts, 14, innerWidth);
			const groupSizes = new Map<string, number>();
			for (const thought of thoughts) {
				const group = this.groupLabel(thought);
				groupSizes.set(group, (groupSizes.get(group) ?? 0) + 1);
			}
			if (start > 0)
				lines.push(row(` ${this.options.theme.fg("dim", `↑ ${start} more`)}`));
			let renderedGroup: string | undefined;
			for (let index = start; index < end; index++) {
				const thought = thoughts[index];
				if (!thought) continue;
				const group = this.groupLabel(thought);
				if (group !== renderedGroup) {
					renderedGroup = group;
					// The Done heading carries its own toggle; the footer stays one line.
					const toggle = thought.done ? ` · ${hint("H", "hide")}` : "";
					lines.push(
						row(
							` ${this.options.theme.fg("dim", "─")} ${this.options.theme.fg("muted", `${group} · ${groupSizes.get(group) ?? 0}`)}${toggle}`,
						),
					);
				}
				lines.push(
					...this.renderThoughtRow(
						thought,
						index === this.selected,
						innerWidth,
						row,
						true,
					),
				);
			}
			if (end < thoughts.length) {
				lines.push(
					row(
						` ${this.options.theme.fg("dim", `↓ ${thoughts.length - end} more`)}`,
					),
				);
			}
			const hiddenDone = this.hiddenDoneCount();
			if (hiddenDone > 0) {
				lines.push(
					row(
						` ${this.options.theme.fg("success", "✓")} ${this.options.theme.fg("dim", `${hiddenDone} done hidden ·`)} ${hint("H", "show")}`,
					),
				);
			}
		}

		lines.push(divider());
		if (this.mode === "help") {
			lines.push(row(` ${hint("?/Esc", "back to queue")}`));
		} else if (this.mode === "list") {
			lines.push(
				row(
					` ${hint("A", "add")} · ${hint("X", "done")} · ${hint("Enter", "move")} · ${hint("V", "view")} · ${hint("/", "filter")} · ${hint("?", "all keys")}`,
				),
			);
			if (filterQuery) {
				lines.push(
					row(
						` ${this.options.theme.fg("dim", `Filtering by "${filterQuery}" · press / then Esc to clear`)}`,
					),
				);
			}
			const undoLabel = this.options.getUndoLabel();
			if (undoLabel) {
				lines.push(
					row(
						` ${this.options.theme.fg("warning", "U")} ${this.options.theme.fg("warning", `undo ${undoLabel}`)}`,
					),
				);
			}
		}
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
		this.filterInput.invalidate();
	}
}
