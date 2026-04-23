/**
 * ExtensionHost unit tests (P1-15).
 * - Stubs the Electron session.extensions surface.
 * - Writes real manifest.json files to a tmp dir so manifest validation runs.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ExtensionHost,
	type ExtensionLike,
	type ExtensionPolicyView,
	type ExtensionSessionLike,
} from "../extension-host.js";

function mkTmp(name: string): string {
	const p = path.join(
		tmpdir(),
		`ext-host-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	mkdirSync(p, { recursive: true });
	return p;
}

function writeManifest(
	dir: string,
	overrides: Partial<Record<string, unknown>> = {},
): void {
	const manifest = {
		manifest_version: 3,
		name: "Test Ext",
		version: "1.2.3",
		...overrides,
	};
	writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
}

function makeSession(): ExtensionSessionLike & {
	loaded: Map<string, ExtensionLike>;
} {
	const loaded = new Map<string, ExtensionLike>();
	let nextId = 100;
	return {
		loaded,
		loadExtension: vi.fn(async (p: string) => {
			const manifest = JSON.parse(
				readFileSync(path.join(p, "manifest.json"), "utf-8"),
			);
			const id = manifest.id ?? `ext${nextId++}`;
			const e: ExtensionLike = {
				id,
				name: manifest.name,
				version: manifest.version,
				manifest,
				path: p,
			};
			loaded.set(id, e);
			return e;
		}),
		removeExtension: vi.fn((id: string) => {
			loaded.delete(id);
		}),
		getExtension: vi.fn((id: string) => loaded.get(id) ?? null),
	};
}

function mkHost(
	opts: {
		policy?: ExtensionPolicyView;
		session?: ExtensionSessionLike;
		storeFile?: string;
	} = {},
): {
	host: ExtensionHost;
	session: ExtensionSessionLike & { loaded: Map<string, ExtensionLike> };
	storePath: string;
	dir: string;
} {
	const dir = mkTmp("store");
	const storePath = opts.storeFile ?? path.join(dir, "extensions.json");
	const session = (opts.session ?? makeSession()) as ExtensionSessionLike & {
		loaded: Map<string, ExtensionLike>;
	};
	const policy = opts.policy ?? { allowMv3: true, allowedExtensionIds: [] };
	const host = new ExtensionHost({
		storePath,
		session,
		getPolicy: () => policy,
	});
	return { host, session, storePath, dir };
}

describe("ExtensionHost.install", () => {
	let tmpDirs: string[] = [];
	beforeEach(() => {
		for (const d of tmpDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {}
		}
		tmpDirs = [];
	});

	it("rejects non-existent path", async () => {
		const { host } = mkHost();
		await expect(host.install("/does/not/exist")).rejects.toThrow(/not found/);
	});

	it("rejects missing manifest.json", async () => {
		const extDir = mkTmp("bad");
		tmpDirs.push(extDir);
		const { host } = mkHost();
		await expect(host.install(extDir)).rejects.toThrow(/manifest/);
	});

	it("rejects non-MV3 manifests", async () => {
		const extDir = mkTmp("mv2");
		tmpDirs.push(extDir);
		writeManifest(extDir, { manifest_version: 2 });
		const { host } = mkHost();
		await expect(host.install(extDir)).rejects.toThrow(
			/manifest_version must be 3/,
		);
	});

	it("loads + persists installed record", async () => {
		const extDir = mkTmp("ok");
		tmpDirs.push(extDir);
		writeManifest(extDir, { id: "abc" });
		const { host, session, storePath } = mkHost();
		const r = await host.install(extDir);
		expect(r.id).toBe("abc");
		expect(r.name).toBe("Test Ext");
		expect(r.enabled).toBe(true);
		expect(session.loaded.has("abc")).toBe(true);
		const persisted = JSON.parse(readFileSync(storePath, "utf-8"));
		expect(persisted).toHaveLength(1);
		expect(persisted[0].id).toBe("abc");
	});

	it("refuses when allowMv3 is false", async () => {
		const extDir = mkTmp("blocked");
		tmpDirs.push(extDir);
		writeManifest(extDir);
		const { host } = mkHost({
			policy: { allowMv3: false, allowedExtensionIds: [] },
		});
		await expect(host.install(extDir)).rejects.toThrow(
			/disabled by admin policy/,
		);
	});

	it("removes the extension if id not in allowedExtensionIds", async () => {
		const extDir = mkTmp("notwhitelisted");
		tmpDirs.push(extDir);
		writeManifest(extDir, { id: "rogue" });
		const { host, session } = mkHost({
			policy: { allowMv3: true, allowedExtensionIds: ["only-this"] },
		});
		await expect(host.install(extDir)).rejects.toThrow(
			/not in admin allowedExtensionIds/,
		);
		expect(session.loaded.has("rogue")).toBe(false);
	});

	it("re-install replaces existing record of same id", async () => {
		const extDir = mkTmp("reinstall");
		tmpDirs.push(extDir);
		writeManifest(extDir, { id: "same", version: "1.0.0" });
		const { host } = mkHost();
		await host.install(extDir);
		writeManifest(extDir, { id: "same", version: "1.1.0" });
		const second = await host.install(extDir);
		expect(second.version).toBe("1.1.0");
		expect(host.list()).toHaveLength(1);
	});
});

describe("ExtensionHost.remove / setEnabled", () => {
	it("remove() clears record + session entry", async () => {
		const extDir = mkTmp("remove");
		writeManifest(extDir, { id: "x1" });
		const { host, session } = mkHost();
		await host.install(extDir);
		expect(host.remove("x1")).toBe(true);
		expect(host.list()).toEqual([]);
		expect(session.loaded.has("x1")).toBe(false);
		rmSync(extDir, { recursive: true, force: true });
	});

	it("remove() returns false for unknown id", () => {
		const { host } = mkHost();
		expect(host.remove("missing")).toBe(false);
	});

	it("setEnabled(false) unloads but keeps record", async () => {
		const extDir = mkTmp("disable");
		writeManifest(extDir, { id: "d1" });
		const { host, session } = mkHost();
		await host.install(extDir);
		const rec = await host.setEnabled("d1", false);
		expect(rec.enabled).toBe(false);
		expect(session.loaded.has("d1")).toBe(false);
		expect(host.list()).toHaveLength(1);
		rmSync(extDir, { recursive: true, force: true });
	});

	it("setEnabled(true) re-loads from stored path", async () => {
		const extDir = mkTmp("reenable");
		writeManifest(extDir, { id: "re1" });
		const { host, session } = mkHost();
		await host.install(extDir);
		await host.setEnabled("re1", false);
		await host.setEnabled("re1", true);
		expect(session.loaded.has("re1")).toBe(true);
		rmSync(extDir, { recursive: true, force: true });
	});
});

describe("ExtensionHost.loadEnabledAll", () => {
	it("boots enabled records + skips disabled", async () => {
		const dirA = mkTmp("A");
		const dirB = mkTmp("B");
		writeManifest(dirA, { id: "a" });
		writeManifest(dirB, { id: "b" });
		const { host, session } = mkHost();
		await host.install(dirA);
		await host.install(dirB);
		await host.setEnabled("b", false);
		// Clear session to simulate a fresh boot.
		session.loaded.clear();
		const result = await host.loadEnabledAll();
		expect(result.loaded.map((r) => r.id)).toEqual(["a"]);
		expect(session.loaded.has("a")).toBe(true);
		expect(session.loaded.has("b")).toBe(false);
		rmSync(dirA, { recursive: true, force: true });
		rmSync(dirB, { recursive: true, force: true });
	});

	it("allowMv3=false skips all and reports as blockedByPolicy", async () => {
		const dirA = mkTmp("mv3off");
		writeManifest(dirA, { id: "z" });
		const { host } = mkHost();
		await host.install(dirA);
		const denyHost = new ExtensionHost({
			storePath: path.join(dirA, "..", "extensions-deny.json"),
			session: makeSession(),
			getPolicy: () => ({ allowMv3: false, allowedExtensionIds: [] }),
		});
		// Seed the deny host by piggy-backing on the json just persisted.
		writeFileSync(
			path.join(dirA, "..", "extensions-deny.json"),
			JSON.stringify(host.list()),
		);
		const denyHost2 = new ExtensionHost({
			storePath: path.join(dirA, "..", "extensions-deny.json"),
			session: makeSession(),
			getPolicy: () => ({ allowMv3: false, allowedExtensionIds: [] }),
		});
		const r = await denyHost2.loadEnabledAll();
		expect(r.loaded).toEqual([]);
		expect(r.blockedByPolicy.map((b) => b.id)).toEqual(["z"]);
		rmSync(dirA, { recursive: true, force: true });
		void denyHost; // silence unused
	});

	it("reports failed loads without aborting subsequent entries", async () => {
		const dirA = mkTmp("ok-boot");
		const dirGone = mkTmp("gone");
		writeManifest(dirA, { id: "good" });
		writeManifest(dirGone, { id: "gone" });
		const { host, session } = mkHost();
		await host.install(dirA);
		await host.install(dirGone);
		// Simulate the "gone" folder being deleted between sessions.
		rmSync(dirGone, { recursive: true, force: true });
		session.loaded.clear();
		session.loadExtension = vi.fn(async (p: string) => {
			const contents = readFileSync(path.join(p, "manifest.json"), "utf-8"); // will throw for "gone"
			const manifest = JSON.parse(contents);
			const ext: ExtensionLike = {
				id: manifest.id,
				name: manifest.name,
				version: manifest.version,
				manifest,
				path: p,
			};
			session.loaded.set(manifest.id, ext);
			return ext;
		});
		const r = await host.loadEnabledAll();
		expect(r.loaded.map((e) => e.id)).toEqual(["good"]);
		expect(r.failed.map((f) => f.id)).toEqual(["gone"]);
		rmSync(dirA, { recursive: true, force: true });
	});
});
