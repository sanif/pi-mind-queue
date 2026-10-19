import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	formatMindQueueStatus,
	formatThoughtAge,
	staleThoughtReminder,
	thoughtAgeGroup,
	TodoManagerComponent,
	type DialogResult,
	type TodoManagerOptions,
} from "./component";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ProjectTodo, SessionOrigin } from "./store";

const passthroughTheme = new Proxy(
	{},
	{
		get: () => (_colorOrText: string, text?: string) => text ?? _colorOrText,
	},
) as Theme;

const selectionTheme = new Proxy(
	{},
	{
		get: (_target, property) => {
			if (property === "bg") {
				return (color: string, text: string) => {
					if (color === "selectedBg") return `<selected>${text}</selected>`;
					return text;
				};
			}
			return (_colorOrText: string, text?: string) => text ?? _colorOrText;
		},
	},
) as Theme;

const currentSession: SessionOrigin = {
	id: "bbbbbbbb-current",
	name: "Current work",
	createdAt: "2026-07-14T08:00:00.000Z",
	persisted: true,
};

function thought(
	id: number,
	text: string,
	createdIn: SessionOrigin = currentSession,
): ProjectTodo {
	return {
		id,
		text,
		done: false,
		createdAt: createdIn.createdAt,
		createdIn,
	};
}

function createComponent(
	text: string,
	suppliedThoughts?: ProjectTodo[],
	overrides: Partial<TodoManagerOptions> = {},
) {
	const thoughts = suppliedThoughts ?? [thought(1, text)];
	let result: DialogResult;
	const options: TodoManagerOptions = {
		theme: passthroughTheme,
		cwd: process.cwd(),
		requestRender: () => {},
		getThoughts: () => thoughts,
		currentSessionId: currentSession.id,
		getUndoLabel: () => undefined,
		addThought: () => true,
		captureEditorThought: () => true,
		copyThought: () => {},
		removeThought: () => true,
		toggleThought: () => true,
		toggleFocus: () => true,
		getFocusedId: () => undefined,
		undoLast: () => {},
		clearCompleted: () => true,
		done: (next) => {
			result = next;
		},
		...overrides,
	};
	const component = new TodoManagerComponent(options);
	return { component, result: () => result };
}

describe("Mind Queue full thought view", () => {
	test("V opens the selected thought and wraps its complete text", () => {
		const text =
			"Beginning of a long thought that cannot fit on one queue row, but its ending must remain visible.";
		const { component } = createComponent(text);

		component.handleInput("v");
		const rendered = component.render(34).join("\n");

		expect(rendered).toContain("Thought details");
		expect(rendered).toContain("Beginning of a long");
		expect(rendered).toContain("remain visible.");
		expect(rendered).not.toContain("Beginning of a long thought…");
	});

	test("long full thoughts can be scrolled through to the end", () => {
		const text = Array.from(
			{ length: 20 },
			(_, index) => `Thought line ${index + 1}`,
		).join("\n");
		const { component } = createComponent(text);

		component.handleInput("v");
		for (let index = 0; index < 20; index++) component.handleInput("j");
		const rendered = component.render(50).join("\n");

		expect(rendered).toContain("Thought line 20");
		expect(rendered).toContain("of 20");
	});

	test("Escape returns from the full thought to the queue instead of closing it", () => {
		const { component, result } = createComponent(
			"A thought worth reading in full",
		);

		component.handleInput("v");
		component.handleInput("\u001b");

		expect(result()).toBeUndefined();
		expect(component.render(72).join("\n")).toContain("? all keys");
	});

	test("uses the configured shortcut to close the queue and in its hint", () => {
		let closed = false;
		const { component } = createComponent("A configurable thought", undefined, {
			shortcut: "q",
			done: () => {
				closed = true;
			},
		});

		component.handleInput("?");
		expect(component.render(60).join("\n")).toMatch(/Q\s+close/);
		component.handleInput("q");

		expect(closed).toBe(true);
	});

	test("groups thoughts by age, newest first, with a count per heading", () => {
		const now = new Date(2026, 9, 15, 12, 0);
		const at = (daysAgo: number) =>
			new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
		const { component } = createComponent(
			"ignored",
			[
				{ ...thought(1, "From last quarter"), createdAt: at(90) },
				{ ...thought(2, "From two weeks ago"), createdAt: at(15) },
				{ ...thought(3, "From this morning"), createdAt: at(0.1) },
				{ ...thought(4, "Also older"), createdAt: at(60) },
			],
			{ cwd: "/work/example-project", now: () => now },
		);

		const rendered = component.render(88).join("\n");

		expect(rendered).toContain("4 open · 0 done");
		expect(rendered).toContain(
			"4 thoughts · example-project · saved automatically",
		);
		expect(rendered).toContain("─ Today · 1");
		expect(rendered).toContain("─ Last 30 days · 1");
		expect(rendered).toContain("─ Older · 2");
		expect(rendered).not.toContain("Session ·");
		const order = ["From this morning", "From two weeks ago", "Also older", "From last quarter"]
			.map((text) => rendered.indexOf(text));
		expect(order).toEqual([...order].sort((left, right) => left - right));
	});

	test("shows queue counts and highlights the selected thought", () => {
		const completed = { ...thought(2, "Finished thought"), done: true };
		const { component } = createComponent(
			"ignored",
			[thought(1, "Selected thought"), completed],
			{ theme: selectionTheme },
		);

		const lines = component.render(72);
		const selectedLine = lines.find((line) =>
			line.includes("Selected thought"),
		);

		expect(lines.join("\n")).toContain("1 open · 1 done");
		expect(selectedLine).toContain("<selected>");
	});

	test("the full-thought view identifies the session where the thought was created", () => {
		const { component } = createComponent("A sourced thought");

		component.handleInput("v");
		const rendered = component.render(72).join("\n");

		expect(rendered).toContain("Created in Current work · #bbbbbbbb · current");
	});

	test("names an unnamed session by its first user prompt in the detail view", () => {
		const unnamedSession: SessionOrigin = {
			id: "aaaaaaaa-unnamed",
			description: "Investigate why login redirects are failing",
			createdAt: "2026-07-13T08:00:00.000Z",
			persisted: true,
		};
		const { component } = createComponent("ignored", [
			thought(1, "A thought from that investigation", unnamedSession),
		]);

		component.handleInput("v");
		const rendered = component.render(88).join("\n");

		expect(rendered).toContain(
			"Created in Investigate why login redirects are failing · #aaaaaaaa",
		);
	});

	test("keeps the selected thought visible within a short overlay when many sessions are shown", () => {
		const thoughts = Array.from({ length: 10 }, (_, index) => {
			const source: SessionOrigin = {
				id: `${String(index).padStart(8, "0")}-session`,
				name: `Session ${index + 1}`,
				createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
				persisted: true,
			};
			return thought(index + 1, `Thought ${index + 1}`, source);
		});
		const { component } = createComponent("ignored", thoughts);
		for (let index = 0; index < 9; index++) component.handleInput("j");

		const lines = component.render(72);
		const selectedLine = lines.findIndex(
			(line) => line.includes("›") && line.includes("Thought 1"),
		);

		expect(selectedLine).toBeGreaterThanOrEqual(0);
		expect(lines.length).toBeLessThanOrEqual(24);
	});

	test("strips complete terminal control sequences from thought rendering", () => {
		const { component } = createComponent("Safe\u001b]0;owned\u0007 text");

		const listView = component.render(72).join("\n");
		component.handleInput("v");
		const fullView = component.render(72).join("\n");

		for (const rendered of [listView, fullView]) {
			expect(rendered).not.toContain("\u001b");
			expect(rendered).not.toContain("\u0007");
			expect(rendered).not.toContain("owned");
		}
	});

	test("passes raw multiline text to the multiline editor action", () => {
		const original = "First line\nSecond line";
		const { component, result } = createComponent(original);

		component.handleInput("e");

		expect(result()).toMatchObject({
			action: "edit",
			thought: { text: original },
		});
	});

	test("accepts uppercase X for toggling a thought", () => {
		let toggles = 0;
		const { component } = createComponent("Toggle me", undefined, {
			toggleThought: () => {
				toggles += 1;
				return true;
			},
		});

		component.handleInput("X");

		expect(toggles).toBe(1);
	});

	test("P saves the current editor draft through the option", () => {
		let captures = 0;
		const { component } = createComponent("ignored", [], {
			captureEditorThought: () => {
				captures += 1;
				return true;
			},
		});

		component.handleInput("P");

		expect(captures).toBe(1);
		component.handleInput("?");
		expect(component.render(88).join("\n")).toMatch(/P\s+save editor draft/);
	});

	test("Y copies the selected thought through the option", () => {
		let copied: ProjectTodo | undefined;
		const { component } = createComponent("Copy me", undefined, {
			copyThought: (thought) => {
				copied = thought;
			},
		});

		component.handleInput("Y");

		expect(copied).toMatchObject({ id: 1, text: "Copy me" });
		component.handleInput("?");
		expect(component.render(88).join("\n")).toMatch(/Y\s+copy/);
	});

	test("F toggles focus through the option", () => {
		let focusedId: number | undefined;
		const { component } = createComponent("Focus me", undefined, {
			toggleFocus: (candidate) => {
				focusedId = focusedId === candidate.id ? undefined : candidate.id;
				return true;
			},
			getFocusedId: () => focusedId,
		});

		component.handleInput("F");
		expect(focusedId).toBe(1);

		component.handleInput("f");
		expect(focusedId).toBeUndefined();
	});

	test("shows a focused open thought with the focus marker", () => {
		const { component } = createComponent("Pinned thought", undefined, {
			getFocusedId: () => 1,
		});

		const rendered = component.render(72).join("\n");

		expect(rendered).toContain("◆");
		expect(rendered).toContain("Pinned thought");
	});

	test("shows focus in the detail view", () => {
		const { component } = createComponent("Pinned thought", undefined, {
			getFocusedId: () => 1,
		});

		component.handleInput("V");
		const detail = component.render(72).join("\n");

		expect(detail).toContain("◆ Focused");
	});

	test("keeps the queue open when moving a thought cannot be persisted", () => {
		const { component, result } = createComponent("Do not lose me", undefined, {
			removeThought: () => false,
		});

		component.handleInput("\r");

		expect(result()).toBeUndefined();
		expect(component.render(72).join("\n")).toContain("Do not lose me");
	});
});

describe("Mind Queue add attachments", () => {
	test("turns dropped files and images into local path references", () => {
		const directory = mkdtempSync(join(tmpdir(), "mind-queue-drop-"));
		try {
			const imagePath = join(directory, "screen shot.png");
			const filePath = join(directory, "notes.txt");
			writeFileSync(imagePath, "image");
			writeFileSync(filePath, "notes");
			let addedText: string | undefined;
			const { component } = createComponent("ignored", [], {
				cwd: directory,
				addThought: (text) => {
					addedText = text;
					return true;
				},
			});

			component.handleInput("a");
			const addView = component.render(72).join("\n");
			expect(addView).toContain("drop files/images");
			expect(addView).toContain("@path references");

			component.handleInput("Review ");
			const escapedImagePath = imagePath.replaceAll(" ", "\\ ");
			const dropped = `${escapedImagePath} ${pathToFileURL(filePath).href}`;
			const splitAt = Math.floor(dropped.length / 2);
			component.handleInput(`\u001b[200~${dropped.slice(0, splitAt)}`);
			component.handleInput(`${dropped.slice(splitAt)}\u001b[201~`);
			component.handleInput("\r");

			expect(addedText).toBe(`Review @"${imagePath}" @${filePath}`);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("keeps ordinary pasted text unchanged", () => {
		let addedText: string | undefined;
		const { component } = createComponent("ignored", [], {
			addThought: (text) => {
				addedText = text;
				return true;
			},
		});

		component.handleInput("a");
		component.handleInput("\u001b[200~plain pasted note\u001b[201~");
		component.handleInput("\r");

		expect(addedText).toBe("plain pasted note");
	});
});

describe("Mind Queue filter", () => {
	test("narrows the queue live as the query is typed", () => {
		const { component } = createComponent("ignored", [
			thought(1, "Fix the flaky login test"),
			thought(2, "Refactor the store"),
		]);

		component.handleInput("/");
		component.handleInput("flaky");
		const rendered = component.render(72).join("\n");

		expect(rendered).toContain("FILTER");
		expect(rendered).toContain("Fix the flaky login test");
		expect(rendered).not.toContain("Refactor the store");
		expect(rendered).toContain("1 of 2 thoughts match");
	});

	test("Enter applies the filter and Escape inside the filter clears it", () => {
		const { component } = createComponent("ignored", [
			thought(1, "Fix the flaky login test"),
			thought(2, "Refactor the store"),
		]);

		component.handleInput("/");
		component.handleInput("flaky");
		component.handleInput("\r");

		let rendered = component.render(72).join("\n");
		expect(rendered).toContain('filter: "flaky"');
		expect(rendered).not.toContain("Refactor the store");

		component.handleInput("/");
		component.handleInput("\u001b");

		rendered = component.render(72).join("\n");
		expect(rendered).toContain("Refactor the store");
		expect(rendered).not.toContain('filter: "flaky"');
	});

	test("keeps the applied filter editable and shows an empty-match state", () => {
		const { component } = createComponent("ignored", [
			thought(1, "Fix the flaky login test"),
		]);

		component.handleInput("/");
		component.handleInput("missing");
		component.handleInput("\r");

		const rendered = component.render(72).join("\n");
		expect(rendered).toContain('◇ No thoughts match "missing"');
		expect(rendered).toContain("press / then Esc to clear");
	});

	test("moves and acts within the filtered thoughts only", () => {
		const removed: number[] = [];
		const { component } = createComponent(
			"ignored",
			[
				thought(1, "Alpha cleanup"),
				thought(2, "Beta cleanup"),
				thought(3, "Unrelated note"),
			],
			{
				removeThought: (candidate) => {
					removed.push(candidate.id);
					return true;
				},
			},
		);

		component.handleInput("/");
		component.handleInput("cleanup");
		component.handleInput("\r");
		component.handleInput("j");
		component.handleInput("d");

		// Newest first: Beta (#2), then Alpha (#1); the unrelated #3 is skipped.
		expect(removed).toEqual([1]);
	});
});

describe("Mind Queue clear completed", () => {
	test("C clears completed thoughts through the option", () => {
		let cleared = 0;
		const completed = { ...thought(2, "Finished thought"), done: true };
		const { component } = createComponent(
			"ignored",
			[thought(1, "Still open"), completed],
			{
				clearCompleted: () => {
					cleared += 1;
					return true;
				},
			},
		);

		component.handleInput("c");

		expect(cleared).toBe(1);
	});
});

describe("Mind Queue thought age", () => {
	test("formats compact relative ages", () => {
		const now = new Date("2026-07-20T12:00:00.000Z");
		expect(formatThoughtAge("2026-07-20T11:59:40.000Z", now)).toBe("now");
		expect(formatThoughtAge("2026-07-20T11:45:00.000Z", now)).toBe("15m");
		expect(formatThoughtAge("2026-07-20T09:00:00.000Z", now)).toBe("3h");
		expect(formatThoughtAge("2026-07-17T12:00:00.000Z", now)).toBe("3d");
		expect(formatThoughtAge("2026-07-06T12:00:00.000Z", now)).toBe("2w");
		expect(formatThoughtAge("2026-04-19T12:00:00.000Z", now)).toBe("3mo");
		expect(formatThoughtAge("2024-07-19T12:00:00.000Z", now)).toBe("2y");
		expect(formatThoughtAge("not-a-date", now)).toBe("");
	});

	test("shows the compact age in the queue and the long age in the detail view", () => {
		const { component } = createComponent("A thought with an age");

		const list = component.render(72).join("\n");
		expect(list).toMatch(/· (now|\d+(?:m|h|d|w|mo|y))/);

		component.handleInput("v");
		const detail = component.render(72).join("\n");
		expect(detail).toContain(
			"Created in Current work · #bbbbbbbb · current · ",
		);
		expect(detail).toMatch(/(just now|\d+(?:m|h|d|w|mo|y) ago)/);
	});

	test("right-aligns the thought id and age so they survive long texts", () => {
		const longText = "A very long thought that keeps going ".repeat(10);
		const { component } = createComponent("ignored", [
			thought(1, `Other ${longText}`),
			thought(2, longText),
		]);

		const lines = component.render(50);
		const selected = lines.findIndex((line) => line.includes("›"));
		const other = lines.find((line) => line.includes("Other"));
		if (selected < 0 || !other) throw new Error("Queue rows did not render");

		expect(lines[selected]).toMatch(/#2 · (now|\d+(?:m|h|d|w|mo|y))│$/);
		expect(other).toContain("…");
		expect(other).toMatch(/#1 · (now|\d+(?:m|h|d|w|mo|y))│$/);
	});

	test("shows the thought id and open status at the top of the detail view", () => {
		const { component } = createComponent("Check its status");

		component.handleInput("v");
		const detail = component.render(72).join("\n");

		expect(detail).toContain("#1");
		expect(detail).toContain("○ Open");
	});

	test("shows a done status in the detail view for completed thoughts", () => {
		const completed = { ...thought(3, "Finished thought"), done: true };
		const { component } = createComponent("ignored", [completed]);

		component.handleInput("h");
		component.handleInput("v");
		const detail = component.render(72).join("\n");

		expect(detail).toContain("#3");
		expect(detail).toContain("✓ Done");
	});
});

describe("Mind Queue list layout", () => {
	const longText = (label: string) =>
		`${label} ${"word ".repeat(60)}ending`;

	test("wraps only the selected thought, up to three lines", () => {
		const { component } = createComponent("ignored", [
			thought(1, longText("Unselected")),
			thought(2, longText("Selected")),
		]);

		const lines = component.render(60);
		const first = lines.findIndex((line) => line.includes("›"));
		const block = lines.slice(first, first + 3);

		expect(block[0]).toContain("Selected word");
		expect(block[1]).toMatch(/^│\s{5}word/);
		expect(block[2]).toContain("…");
		expect(lines[first + 3]).toContain("Unselected");
		expect(lines.filter((line) => line.includes("Unselected"))).toHaveLength(1);
		for (const line of lines) expect(visibleWidth(line)).toBe(60);
	});

	test("short selected thoughts stay on one line", () => {
		const { component } = createComponent("Short and sweet");

		const lines = component.render(72);
		const first = lines.findIndex((line) => line.includes("›"));

		expect(lines[first + 1]).not.toMatch(/^│\s{5}\S/);
	});

	test("hides done thoughts behind a row that H toggles", () => {
		const done = { ...thought(2, "Finished thought"), done: true };
		const { component } = createComponent("ignored", [
			thought(1, "Still open"),
			done,
		]);

		let rendered = component.render(72).join("\n");
		expect(rendered).toContain("1 open · 1 done");
		expect(rendered).not.toContain("Finished thought");
		expect(rendered).toContain("1 done hidden · H show");

		component.handleInput("H");
		rendered = component.render(72).join("\n");
		expect(rendered).toContain("─ Done · 1 · H hide");
		expect(rendered).toContain("Finished thought");
		expect(rendered.indexOf("Still open")).toBeLessThan(
			rendered.indexOf("Finished thought"),
		);

		component.handleInput("h");
		expect(component.render(72).join("\n")).not.toContain("Finished thought");
	});

	test("keeps the selected thought when done thoughts are shown or hidden", () => {
		const toggled: number[] = [];
		const done = { ...thought(1, "Finished thought"), done: true };
		const { component } = createComponent(
			"ignored",
			[done, thought(2, "Open one"), thought(3, "Open two")],
			{
				toggleThought: (candidate) => {
					toggled.push(candidate.id);
					return true;
				},
			},
		);

		component.handleInput("j");
		component.handleInput("H");
		component.handleInput("x");

		expect(toggled).toEqual([2]);
	});

	test("shows an all-done state with a way to reveal them", () => {
		const { component } = createComponent("ignored", [
			{ ...thought(1, "Finished thought"), done: true },
		]);

		const rendered = component.render(72).join("\n");

		expect(rendered).toContain("No open thoughts · 1 done hidden");
		expect(rendered).toContain("H show done");
		component.handleInput("H");
		expect(component.render(72).join("\n")).toContain("Finished thought");
	});

	test("keeps the footer to one line and lists every key behind ?", () => {
		const { component, result } = createComponent("A thought");

		const list = component.render(80);
		const dividers = list
			.map((line, index) => (line.startsWith("├") ? index : -1))
			.filter((index) => index >= 0);
		const footerStart = dividers.at(-1) ?? -1;
		expect(list.slice(footerStart + 1, -1)).toHaveLength(1);
		expect(list.join("\n")).toContain("? all keys");
		expect(list.join("\n")).not.toContain("remove");

		component.handleInput("?");
		const help = component.render(80).join("\n");
		for (const label of ["remove", "focus in the status bar", "clear done", "undo the latest change", "show or hide done"])
			expect(help).toContain(label);
		expect(help).toContain("KEYS");

		component.handleInput("\u001b");
		expect(result()).toBeUndefined();
		expect(component.render(80).join("\n")).toContain("? all keys");
	});

	test("colors the age of stale open thoughts only", () => {
		const now = new Date(2026, 9, 15, 12, 0);
		const at = (daysAgo: number) =>
			new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
		// Zero-width color codes, so the theme does not change the layout.
		const codes: Record<string, number> = { dim: 90, warning: 33, error: 31 };
		const colorTheme = new Proxy(
			{},
			{
				get: (_target, property) => {
					if (property === "fg")
						return (color: string, text: string) =>
							`\u001b[${codes[color] ?? 37}m${text}\u001b[39m`;
					return (_colorOrText: string, text?: string) => text ?? _colorOrText;
				},
			},
		) as Theme;
		const { component } = createComponent(
			"ignored",
			[
				{ ...thought(1, "Fresh"), createdAt: at(2) },
				{ ...thought(2, "Aging"), createdAt: at(20) },
				{ ...thought(3, "Ancient"), createdAt: at(45) },
				{ ...thought(4, "Old but done"), createdAt: at(45), done: true },
			],
			{ theme: colorTheme, now: () => now },
		);

		component.handleInput("H");
		const rendered = component.render(100).join("\n");

		expect(rendered).toContain("\u001b[90m2d");
		expect(rendered).toContain("\u001b[33m2w");
		expect(rendered).toContain("\u001b[31m1mo");
		expect(rendered).toContain("#4 · \u001b[39m\u001b[90m1mo");
	});
});

describe("Mind Queue age helpers", () => {
	const now = new Date(2026, 9, 15, 12, 0);
	const at = (daysAgo: number) =>
		new Date(now.getTime() - daysAgo * 86_400_000).toISOString();

	test("groups by local calendar day", () => {
		expect(thoughtAgeGroup(at(0.2), now)).toBe("Today");
		expect(thoughtAgeGroup(at(1), now)).toBe("Yesterday");
		expect(thoughtAgeGroup(at(5), now)).toBe("Last 7 days");
		expect(thoughtAgeGroup(at(20), now)).toBe("Last 30 days");
		expect(thoughtAgeGroup(at(40), now)).toBe("Older");
		expect(thoughtAgeGroup("nope", now)).toBe("Undated");
	});

	test("reminds only about open thoughts at least two weeks old", () => {
		const open = (id: number, days: number) => ({
			...thought(id, `T${id}`),
			createdAt: at(days),
		});

		expect(staleThoughtReminder([open(1, 3)], now)).toBeUndefined();
		expect(
			staleThoughtReminder([{ ...open(1, 40), done: true }], now),
		).toBeUndefined();
		expect(staleThoughtReminder([open(1, 3), open(2, 21), open(3, 91)], now)).toBe(
			"Mind Queue: 2 open thoughts are over 2 weeks old (oldest 91d) · /mind cleanup to review",
		);
		expect(staleThoughtReminder([open(1, 14)], now)).toContain("1 open thought is");
	});
});

describe("Mind Queue status", () => {
	test("shows only the count because the status bar already prefixes mind-queue", () => {
		expect(formatMindQueueStatus(7)).toBe("7");
		expect(formatMindQueueStatus(0)).toBeUndefined();
	});
});
