import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mindQueue, { type MindQueueOptions } from "./index";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function registeredShortcut(
	agentDir: string,
	options: Omit<MindQueueOptions, "agentDir"> = {},
): string | undefined {
	let shortcut: string | undefined;
	const pi = {
		registerTool() {},
		registerShortcut(value: string) {
			shortcut = value;
		},
		registerCommand() {},
		on() {},
	} as unknown as ExtensionAPI;

	mindQueue(pi, { agentDir, ...options });
	return shortcut;
}

describe("Mind Queue shortcut configuration", () => {
	test("reads the shortcut from the global extension config", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mind-queue-shortcut-"));
		tempDirectories.push(agentDir);
		const configDirectory = join(agentDir, "extensions");
		mkdirSync(configDirectory, { recursive: true });
		writeFileSync(
			join(configDirectory, "mind-queue.json"),
			JSON.stringify({ shortcut: "ctrl+shift+q" }),
		);

		expect(registeredShortcut(agentDir)).toBe("ctrl+shift+q");
	});

	test("rejects an invalid configured shortcut with the config path", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mind-queue-shortcut-"));
		tempDirectories.push(agentDir);
		const configDirectory = join(agentDir, "extensions");
		mkdirSync(configDirectory, { recursive: true });
		const configPath = join(configDirectory, "mind-queue.json");
		writeFileSync(configPath, JSON.stringify({ shortcut: "ctrl+not-a-key" }));

		expect(() => registeredShortcut(agentDir)).toThrow(configPath);
	});

	test("lets a programmatic option override the config file", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mind-queue-shortcut-"));
		tempDirectories.push(agentDir);
		const configDirectory = join(agentDir, "extensions");
		mkdirSync(configDirectory, { recursive: true });
		writeFileSync(
			join(configDirectory, "mind-queue.json"),
			JSON.stringify({ shortcut: "ctrl+shift+q" }),
		);

		expect(registeredShortcut(agentDir, { shortcut: "alt+m" })).toBe("alt+m");
	});
});
