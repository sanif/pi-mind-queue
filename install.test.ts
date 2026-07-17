import { afterEach, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = import.meta.dir;
const tempHomes: string[] = [];

afterEach(() => {
	for (const directory of tempHomes.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function packAndExtract(home: string): string {
	const packed = join(home, "packed");
	const extracted = join(home, "extracted");
	mkdirSync(packed, { recursive: true });
	mkdirSync(extracted, { recursive: true });
	execFileSync("bun", ["pm", "pack", "--destination", packed, "--quiet"], {
		cwd: packageRoot,
		stdio: "pipe",
	});
	const tarball = readdirSync(packed).find((name) => name.endsWith(".tgz"));
	if (!tarball) throw new Error("bun pm pack did not create a tarball");
	execFileSync("tar", ["-xzf", join(packed, tarball), "-C", extracted]);
	return join(extracted, "package");
}

async function inspectInstalledPackage(
	home: string,
	thought: string,
): Promise<string[]> {
	const pi = join(packageRoot, "node_modules", ".bin", "pi");
	const env = { ...process.env, HOME: home };
	const extracted = packAndExtract(home);
	execFileSync(pi, ["install", extracted], { env, stdio: "pipe" });

	return new Promise((resolve, reject) => {
		const child = execFile(pi, ["--mode", "rpc", "--no-session"], {
			cwd: home,
			env,
			timeout: 15_000,
		});
		let commands: string[] | undefined;
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Timed out waiting for Pi commands: ${stderr}`));
		}, 10_000);

		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const message = JSON.parse(line) as {
						type?: string;
						command?: string;
						success?: boolean;
						data?: { commands?: Array<{ name: string }> };
					};
					if (message.type !== "response") continue;
					if (message.command === "get_commands") {
						commands = (message.data?.commands ?? []).map(
							(command) => command.name,
						);
						child.stdin?.write(
							`${JSON.stringify({
								id: "mind-capture",
								type: "prompt",
								message: `/mind ${thought}`,
							})}\n`,
						);
						continue;
					}
					if (message.command !== "prompt") continue;
					if (!message.success)
						throw new Error("Pi rejected the Mind Queue command");
					clearTimeout(timer);
					child.kill();
					resolve(commands ?? []);
					return;
				} catch (error) {
					clearTimeout(timer);
					child.kill();
					reject(error);
					return;
				}
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.stdin?.write(`${JSON.stringify({ type: "get_commands" })}\n`);
	});
}

test("a packed installation captures a thought through the Mind Queue command", async () => {
	const home = mkdtempSync(join(tmpdir(), "mind-queue-pi-home-"));
	tempHomes.push(home);
	const thought = "Review the streaming command behavior";

	const commands = await inspectInstalledPackage(home, thought);

	expect(commands).toContain("mind");
	expect(commands).not.toContain("mind-cleanup");
	expect(commands).toContain("mind-undo");

	const storeDirectory = join(home, ".pi", "agent", "state", "mind-queue");
	const stateFiles = readdirSync(storeDirectory).filter((name) =>
		name.endsWith(".json"),
	);
	expect(stateFiles).toHaveLength(1);
	const stateFile = stateFiles[0];
	if (!stateFile) throw new Error("Mind Queue did not create a project store");
	let state: { todos: Array<{ text: string; done: boolean }> };
	try {
		state = JSON.parse(
			readFileSync(join(storeDirectory, stateFile), "utf8"),
		) as typeof state;
	} catch (error) {
		throw new Error("Mind Queue created an invalid project store", {
			cause: error,
		});
	}
	expect(state.todos).toHaveLength(1);
	expect(state.todos[0]).toMatchObject({ text: thought, done: false });
}, 60_000);
