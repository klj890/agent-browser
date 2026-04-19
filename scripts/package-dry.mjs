#!/usr/bin/env node
/**
 * package-dry — validate electron-builder.yml without actually packaging.
 *
 * Why not `electron-builder --dir`? That requires a pre-built apps/main/dist,
 * which depends on TypeScript compile of the whole tree. For CI config-sanity,
 * we only need to know the YAML parses and references fields electron-builder
 * understands. The real `--mac`/`--win`/`--linux` scripts run the full build.
 *
 * Exits 0 on a valid config, non-zero with a useful diagnostic otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ymlPath = path.join(root, "electron-builder.yml");

if (!existsSync(ymlPath)) {
	console.error(`missing ${ymlPath}`);
	process.exit(1);
}

const raw = readFileSync(ymlPath, "utf8");

// ---- very small YAML shape check (no dep on js-yaml) --------------------
// We require top-level keys that electron-builder needs. We intentionally do
// not parse YAML — instead we grep for the top-level anchors, which is enough
// to catch the common "forgot to update productName" / "wrong indent" errors.
const required = [
	"appId:",
	"productName:",
	"directories:",
	"files:",
	"mac:",
	"win:",
	"linux:",
];
const missing = required.filter(
	(k) => !raw.includes(`\n${k}`) && !raw.startsWith(k),
);
if (missing.length > 0) {
	console.error(
		`electron-builder.yml missing required keys: ${missing.join(", ")}`,
	);
	process.exit(2);
}

// ---- sanity-check referenced files exist ---------------------------------
const iconPath = path.join(root, "build", "icon.png");
if (!existsSync(iconPath)) {
	console.error(`build/icon.png missing. Run: node build/generate-icon.mjs`);
	process.exit(3);
}

// ---- Quick probe that electron-builder CLI is installed ------------------
// We don't invoke it (it would re-resolve deps, slow); just resolve its entry.
try {
	const req = (await import("node:module")).createRequire(import.meta.url);
	const resolved = req.resolve("electron-builder/out/cli/cli.js");
	if (!existsSync(resolved)) throw new Error(`not found: ${resolved}`);
} catch (err) {
	console.error(`electron-builder not installed: ${err?.message || err}`);
	process.exit(4);
}

console.log("electron-builder.yml OK");
console.log(`  appId:         ${(raw.match(/^appId:\s*(.+)$/m) || [])[1]}`);
console.log(
	`  productName:   ${(raw.match(/^productName:\s*(.+)$/m) || [])[1]}`,
);
console.log(`  icon:          ${path.relative(root, iconPath)}`);
console.log("To produce installers, run one of:");
console.log("  pnpm run package:mac");
console.log("  pnpm run package:win");
console.log("  pnpm run package:linux");
