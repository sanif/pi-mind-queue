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

export class TodoManagerComponent implements Focusable {
	private _focused = false;
	private selected = 0;
	private mode: "list" | "add" | "view" = "list";
	private viewScroll = 0;
	private input = new Input();

	constructor(private readonly options: TodoManagerOptions) {
		this.configureInput();
	}

	private configureInput(): void {
		this.input.onSubmit = (value) => {
			const text = value.trim();
			if (!text || !this.options.addThought(text)) return;
			this.resetInput();
			const newestId = this.options.getThoughts().at(-1)?.id;
			this.selected = Math.max(0, this.thoughts().findIndex((thought) => thought.id === newestId));
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

	private selectedThought(): ProjectTodo | undefined {
		return this.thoughts()[this.selected];
	}

	private clampSelection(): void {
		this.selected = Math.max(0, Math.min(this.selected, this.thoughts().length - 1));
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
					const addedRows = 1 + (previous.createdIn.id === first.createdIn.id ? 0 : 1);
					const nextContentRows = contentRows + addedRows;
					const totalRows = nextContentRows + (start - 1 > 0 ? 1 : 0) + (end < thoughts.length ? 1 : 0);
					if (totalRows <= maxRows) {
						candidates.push({ side: "left", totalRows, contentRows: nextContentRows });
					}
				}
			}
			if (end < thoughts.length) {
				const previous = thoughts[end - 1];
				const next = thoughts[end];
				if (previous && next) {
					const addedRows = 1 + (previous.createdIn.id === next.createdIn.id ? 0 : 1);
					const nextContentRows = contentRows + addedRows;
					const totalRows = nextContentRows + (start > 0 ? 1 : 0) + (end + 1 < thoughts.length ? 1 : 0);
					if (totalRows <= maxRows) {
						candidates.push({ side: "right", totalRows, contentRows: nextContentRows });
					}
				}
			}
			if (candidates.length === 0) break;

			candidates.sort((left, right) => {
				if (left.totalRows !== right.totalRows) return left.totalRows - right.totalRows;
				const leftSpan = this.selected - start;
				const rightSpan = end - this.selected - 1;
				if (left.side === right.side) return 0;
				return left.side === "left" ? leftSpan - rightSpan : rightSpan - leftSpan;
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
		this.resetInput();
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
				this.input.handleInput(data);
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
		if (width <= 2) return width > 0 ? [truncateToWidth("Mind", width, "")] : [];

		const innerWidth = width - 2;
		const lines: string[] = [];
		const thoughts = this.thoughts();
		this.clampSelection();

		const fit = (text: string): string => {
			const truncated = truncateToWidth(text, innerWidth, "…");
			return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		};
		const row = (text = ""): string =>
			this.options.theme.fg("border", "│") + fit(text) + this.options.theme.fg("border", "│");

		lines.push(this.options.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
		lines.push(row(` ${this.options.theme.fg("accent", this.options.theme.bold("Mind Queue"))}`));
		lines.push(row(` ${this.options.theme.fg("dim", `${thoughts.length} thought${thoughts.length === 1 ? "" : "s"} · saved for this project`)}`));
		lines.push(row());

		if (this.mode === "add") {
			lines.push(row(` ${this.options.theme.fg("accent", "Capture thoughts one by one")}`));
			lines.push(row());
			const inputLine = this.input.render(Math.max(1, innerWidth - 4))[0] ?? "";
			lines.push(row(` > ${inputLine}`));
			lines.push(row());
			lines.push(row(` ${this.options.theme.fg("dim", "Enter add another · Tab/Esc return to list")}`));
		} else if (this.mode === "view") {
			const thought = thoughts[this.selected];
			lines.push(row(` ${this.options.theme.fg("accent", "Full thought")}`));
			if (thought) {
				lines.push(row(` ${this.options.theme.fg("dim", `Created in ${formatSessionOrigin(thought.createdIn, this.options.currentSessionId)}`)}`));
				lines.push(row());
				const wrapped = wrapTextWithAnsi(
					sanitizeThoughtForEditor(thought.text),
					Math.max(1, innerWidth - 2),
				);
				const maxVisible = 12;
				const maxScroll = Math.max(0, wrapped.length - maxVisible);
				this.viewScroll = Math.min(this.viewScroll, maxScroll);
				const visible = wrapped.slice(this.viewScroll, this.viewScroll + maxVisible);
				for (const text of visible) {
					lines.push(row(` ${this.options.theme.fg("text", text)}`));
				}
				if (wrapped.length > maxVisible) {
					const from = this.viewScroll + 1;
					const to = this.viewScroll + visible.length;
					lines.push(row(` ${this.options.theme.fg("dim", `Lines ${from}–${to} of ${wrapped.length}`)}`));
				}
			}
			lines.push(row());
			lines.push(row(` ${this.options.theme.fg("dim", "↑↓/jk scroll · V/Tab/Esc return to queue")}`));
		} else if (thoughts.length === 0) {
			lines.push(row(` ${this.options.theme.fg("muted", "Your project mind queue is empty.")}`));
			lines.push(row(` ${this.options.theme.fg("dim", "Press A to capture your first thought.")}`));
		} else {
			const { start, end } = this.visibleListWindow(thoughts, 10);
			if (start > 0) lines.push(row(` ${this.options.theme.fg("dim", `↑ ${start} more`)}`));
			let renderedSessionId: string | undefined;
			for (let index = start; index < end; index++) {
				const thought = thoughts[index];
				if (!thought) continue;
				if (thought.createdIn.id !== renderedSessionId) {
					renderedSessionId = thought.createdIn.id;
					lines.push(row(` ${this.options.theme.fg("muted", `Session · ${formatSessionOrigin(thought.createdIn, this.options.currentSessionId)}`)}`));
				}
				const active = index === this.selected;
				const pointer = active ? this.options.theme.fg("accent", "›") : " ";
				const marker = thought.done
					? this.options.theme.fg("success", "✓")
					: this.options.theme.fg("dim", "○");
				const safeText = sanitizeThoughtForDisplay(thought.text);
				const label = thought.done
					? this.options.theme.fg("muted", this.options.theme.strikethrough(safeText))
					: this.options.theme.fg(active ? "accent" : "text", safeText);
				lines.push(row(` ${pointer} ${marker} ${label}`));
			}
			if (end < thoughts.length) {
				lines.push(row(` ${this.options.theme.fg("dim", `↓ ${thoughts.length - end} more`)}`));
			}
		}

		lines.push(row());
		if (this.mode === "list") {
			lines.push(row(` ${this.options.theme.fg("dim", "A add · E edit · V view full · Enter move to editor")}`));
			lines.push(row(` ${this.options.theme.fg("dim", "↑↓/jk select · D/Delete remove · X/Space done · U undo")}`));
			lines.push(row(` ${this.options.theme.fg("dim", "Ctrl+Shift+M open/close · Esc close · /mind")}`));
			const undoLabel = this.options.getUndoLabel();
			if (undoLabel) {
				lines.push(row(` ${this.options.theme.fg("warning", `Undo available: ${undoLabel}`)}`));
			}
		}
		lines.push(this.options.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}
}
