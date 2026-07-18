import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	formatMindQueueStatus,
	TodoManagerComponent,
	type DialogResult,
	type TodoManagerOptions,
} from "./component";
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
		removeThought: () => true,
		toggleThought: () => true,
		undoLast: () => {},
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
		expect(component.render(50).join("\n")).toContain("V view full");
	});

	test("uses the configured shortcut to close the queue and in its hint", () => {
		let closed = false;
		const { component } = createComponent("A configurable thought", undefined, {
			shortcut: "q",
			done: () => {
				closed = true;
			},
		});

		expect(component.render(50).join("\n")).toContain("Q close");
		component.handleInput("q");

		expect(closed).toBe(true);
	});

	test("groups project thoughts by their creation session and puts the current session first", () => {
		const earlierSession: SessionOrigin = {
			id: "aaaaaaaa-earlier",
			name: "Earlier work",
			createdAt: "2026-07-13T08:00:00.000Z",
			persisted: true,
		};
		const { component } = createComponent(
			"ignored",
			[
				thought(1, "Thought from yesterday", earlierSession),
				thought(2, "Thought from here", currentSession),
			],
			{ cwd: "/work/example-project" },
		);

		const rendered = component.render(88).join("\n");

		expect(rendered).toContain("2 open · 0 done");
		expect(rendered).toContain(
			"2 thoughts · example-project · saved automatically",
		);
		expect(rendered).toContain("Session · Current work · #bbbbbbbb · current");
		expect(rendered).toContain("Session · Earlier work · #aaaaaaaa");
		expect(rendered.indexOf("Current work")).toBeLessThan(
			rendered.indexOf("Earlier work"),
		);
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

	test("uses the first user prompt as the main label for an unnamed session", () => {
		const unnamedSession: SessionOrigin = {
			id: "aaaaaaaa-unnamed",
			description: "Investigate why login redirects are failing",
			createdAt: "2026-07-13T08:00:00.000Z",
			persisted: true,
		};
		const { component } = createComponent("ignored", [
			thought(1, "A thought from that investigation", unnamedSession),
		]);

		const rendered = component.render(72).join("\n");

		expect(rendered).toContain(
			"Session · Investigate why login redirects are failing · #aaaaaaaa",
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

describe("Mind Queue status", () => {
	test("shows only the count because the status bar already prefixes mind-queue", () => {
		expect(formatMindQueueStatus(7)).toBe("7");
		expect(formatMindQueueStatus(0)).toBeUndefined();
	});
});
