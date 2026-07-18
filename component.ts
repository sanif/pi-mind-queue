import { statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	formatSessionOrigin,
	orderTodosBySession,
	type ProjectTodo,
} from "./store";

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
	removeThought: (thought: ProjectTodo, reason: "delete" | "move") => boolean;
	toggleThought: (thought: ProjectTodo) => boolean;
	undoLast: () => void;
	done: (result: DialogResult) => void;
}

export const MIND_QUEUE_SHORTCUT = Key.ctrlShift("m");

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

function snapshot(thought: ProjectTodo): ProjectTodo {
	return { ...thought, createdIn: { ...thought.createdIn } };
}

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
	private mode: "list" | "add" | "view" = "list";
	private viewScroll = 0;
	private input = new Input();
	private addPasteBuffer: string | undefined;

	constructor(private readonly options: TodoManagerOptions) {
		this.configureInput();
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
	}

	private thoughts(): ProjectTodo[] {
		return orderTodosBySession(
			this.options.getThoughts(),
			this.options.currentSessionId,
		);
	}

	private clampSelection(): void {
		this.selected = Math.max(
			0,
			Math.min(this.selected, this.thoughts().length - 1),
		);
	}

	private visibleListWindow(
		thoughts: ProjectTodo[],
		maxRows: number,
	): { start: number; end: number } {
		let start = this.selected;
		let end = this.selected + 1;
		let contentRows = 2;

		while (true) {
			const candidates: Array<{
				side: "left" | "right";
				totalRows: number;
				contentRows: number;
			}> = [];
			if (start > 0) {
				const previous = thoughts[start - 1];
				const first = thoughts[start];
				if (previous && first) {
					const addedRows =
						1 + (previous.createdIn.id === first.createdIn.id ? 0 : 1);
					const nextContentRows = contentRows + addedRows;
					const totalRows =
						nextContentRows +
						(start - 1 > 0 ? 1 : 0) +
						(end < thoughts.length ? 1 : 0);
					if (totalRows <= maxRows) {
						candidates.push({
							side: "left",
							totalRows,
							contentRows: nextContentRows,
						});
					}
				}
			}
			if (end < thoughts.length) {
				const previous = thoughts[end - 1];
				const next = thoughts[end];
				if (previous && next) {
					const addedRows =
						1 + (previous.createdIn.id === next.createdIn.id ? 0 : 1);
					const nextContentRows = contentRows + addedRows;
					const totalRows =
						nextContentRows +
						(start > 0 ? 1 : 0) +
						(end + 1 < thoughts.length ? 1 : 0);
					if (totalRows <= maxRows) {
						candidates.push({
							side: "right",
							totalRows,
							contentRows: nextContentRows,
						});
					}
				}
			}
			if (candidates.length === 0) break;

			candidates.sort((left, right) => {
				if (left.totalRows !== right.totalRows)
					return left.totalRows - right.totalRows;
				const leftSpan = this.selected - start;
				const rightSpan = end - this.selected - 1;
				if (left.side === right.side) return 0;
				return left.side === "left"
					? leftSpan - rightSpan
					: rightSpan - leftSpan;
			});
			const chosen = candidates[0];
			if (!chosen) break;
			contentRows = chosen.contentRows;
			if (chosen.side === "left") start -= 1;
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

	private handleListInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, MIND_QUEUE_SHORTCUT)
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

		const thoughts = this.thoughts();
		const selected = thoughts[this.selected];
		if (!selected) return;

		if (data === "v" || data === "V") {
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
		if (this.mode === "view") {
			this.handleViewInput(data);
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
		const openCount = thoughts.filter((thought) => !thought.done).length;
		const doneCount = thoughts.length - openCount;
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
		lines.push(
			row(
				` ${this.options.theme.bg("selectedBg", this.options.theme.fg("accent", ` ${modeLabel} `))}  ${this.options.theme.fg("dim", `${thoughts.length} thought${thoughts.length === 1 ? "" : "s"} · ${folderName} · saved automatically`)}`,
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
		} else if (this.mode === "view") {
			const thought = thoughts[this.selected];
			lines.push(
				row(
					` ${this.options.theme.fg("accent", this.options.theme.bold("Thought details"))}`,
				),
			);
			if (thought) {
				lines.push(
					row(
						` ${this.options.theme.fg("dim", `Created in ${formatSessionOrigin(thought.createdIn, this.options.currentSessionId)}`)}`,
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
		} else if (thoughts.length === 0) {
			lines.push(row());
			lines.push(
				row(` ${this.options.theme.fg("muted", "◇ Nothing queued yet")}`),
			);
			lines.push(
				row(
					` ${hint("A", "capture your first thought")} · ${this.options.theme.fg("dim", "it will persist across sessions")}`,
				),
			);
		} else {
			const { start, end } = this.visibleListWindow(thoughts, 14);
			if (start > 0)
				lines.push(row(` ${this.options.theme.fg("dim", `↑ ${start} more`)}`));
			let renderedSessionId: string | undefined;
			for (let index = start; index < end; index++) {
				const thought = thoughts[index];
				if (!thought) continue;
				if (thought.createdIn.id !== renderedSessionId) {
					renderedSessionId = thought.createdIn.id;
					lines.push(
						row(
							` ${this.options.theme.fg("dim", "─")} ${this.options.theme.fg("muted", `Session · ${formatSessionOrigin(thought.createdIn, this.options.currentSessionId)}`)}`,
						),
					);
				}
				const active = index === this.selected;
				const pointer = active ? this.options.theme.fg("accent", "›") : " ";
				const marker = thought.done
					? this.options.theme.fg("success", "✓")
					: this.options.theme.fg("dim", "○");
				const safeText = sanitizeThoughtForDisplay(thought.text);
				const label = thought.done
					? this.options.theme.fg(
							"muted",
							this.options.theme.strikethrough(safeText),
						)
					: this.options.theme.fg(active ? "accent" : "text", safeText);
				lines.push(row(` ${pointer} ${marker} ${label}`, active));
			}
			if (end < thoughts.length) {
				lines.push(
					row(
						` ${this.options.theme.fg("dim", `↓ ${thoughts.length - end} more`)}`,
					),
				);
			}
		}

		lines.push(divider());
		if (this.mode === "list") {
			lines.push(
				row(
					` ${hint("A", "add")} · ${hint("E", "edit")} · ${hint("V", "view full")} · ${hint("Enter", "move to editor")}`,
				),
			);
			lines.push(
				row(
					` ${hint("↑↓/jk", "select")} · ${hint("X/Space", "done")} · ${hint("D/Delete", "remove")} · ${hint("U", "undo")}`,
				),
			);
			lines.push(
				row(
					` ${hint("Ctrl+Shift+M", "close")} · ${hint("Esc", "close")} · ${this.options.theme.fg("dim", "/mind")}`,
				),
			);
			const undoLabel = this.options.getUndoLabel();
			if (undoLabel) {
				lines.push(
					row(
						` ${this.options.theme.fg("warning", `Undo available: ${undoLabel}`)}`,
					),
				);
			}
		}
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}
}
