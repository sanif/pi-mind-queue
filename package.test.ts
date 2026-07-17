import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;

interface PackageManifest {
	name: string;
	version: string;
	license: string;
	keywords: string[];
	files: string[];
	os?: string[];
	pi?: { extensions?: string[] };
	peerDependencies?: Record<string, string>;
	publishConfig?: { access?: string };
	repository?: { url?: string };
}

function readPackage(): PackageManifest {
	try {
		return JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as PackageManifest;
	} catch (error) {
		throw new Error("Could not read package.json", { cause: error });
	}
}

describe("Pi package manifest", () => {
	test("declares a public Pi extension package with host peers", () => {
		const pkg = readPackage();
		expect(pkg.name).toBe("pi-mind-queue");
		expect(pkg.version).toBe("0.3.0");
		expect(pkg.license).toBe("MIT");
		expect(pkg.keywords).toContain("pi-package");
		expect(pkg.pi?.extensions).toEqual(["./index.ts"]);
		expect(pkg.peerDependencies).toEqual({
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-tui": "*",
		});
		expect(pkg.publishConfig?.access).toBe("public");
		expect(pkg.os).toEqual(["darwin", "linux"]);
		expect(pkg.repository?.url).toBe(
			"git+https://github.com/sanif/pi-mind-queue.git",
		);
	});

	test("publishes only runtime source and public documentation", () => {
		const pkg = readPackage();
		expect(pkg.files).toEqual([
			"index.ts",
			"component.ts",
			"migration.ts",
			"store.ts",
			"README.md",
			"CHANGELOG.md",
			"LICENSE",
		]);
	});
});
