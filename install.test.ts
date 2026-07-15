import { afterEach, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

async function installedCommands(home: string): Promise<string[]> {
	const pi = join(packageRoot, "node_modules", ".bin", "pi");
	const env = { ...process.env, HOME: home };
	const extracted = packAndExtract(home);
	execFileSync(pi, ["install", extracted], { env, stdio: "pipe" });

	return await new Promise((resolve, reject) => {
		const child = execFile(pi, ["--mode", "rpc", "--no-session"], {
			cwd: home,
			env,
			timeout: 15_000,
		});
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
						data?: { commands?: Array<{ name: string }> };
					};
					if (message.type !== "response" || message.command !== "get_commands") continue;
					clearTimeout(timer);
					child.kill();
					resolve((message.data?.commands ?? []).map((command) => command.name));
					return;
				} catch {
					continue;
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

test("a packed installation autoloads Mind Queue commands", async () => {
	const home = mkdtempSync(join(tmpdir(), "mind-queue-pi-home-"));
	tempHomes.push(home);

	const commands = await installedCommands(home);

	expect(commands).toContain("mind");
	expect(commands).toContain("mind-undo");
}, 60_000);
