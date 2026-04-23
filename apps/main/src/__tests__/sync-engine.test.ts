/**
 * SyncEngine tests (P1-16). Uses in-memory stores, a fake transport, and the
 * fast-derive hook to keep the suite well under 1s.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BookmarksStore } from "../bookmarks.js";
import { HistoryStore } from "../history.js";
import { AppDatabase } from "../storage/sqlite.js";
import { SyncConfigStore } from "../sync-config.js";
import { __testHooks } from "../sync-crypto.js";
import {
	type EncryptedItem,
	type PullResponse,
	SyncEngine,
	type SyncTransport,
} from "../sync-engine.js";

const fastDerive = __testHooks.makeFastDerive(64);

class InMemoryTransport implements SyncTransport {
	pushed: EncryptedItem[] = [];
	bookmarks: EncryptedItem[] = [];
	history: EncryptedItem[] = [];
	bookmarkCursor = 0;
	historyCursor = 0;

	async push(items: EncryptedItem[]): Promise<void> {
		for (const it of items) this.pushed.push(it);
	}
	async pullBookmarks(since: number): Promise<PullResponse> {
		void since;
		return { items: this.bookmarks, cursor: this.bookmarkCursor };
	}
	async pullHistory(since: number): Promise<PullResponse> {
		void since;
		return { items: this.history, cursor: this.historyCursor };
	}
}

function mkEngine(): {
	engine: SyncEngine;
	db: AppDatabase;
	bookmarks: BookmarksStore;
	history: HistoryStore;
	transport: InMemoryTransport;
	tmp: string;
} {
	const tmp = mkdtempSync(path.join(tmpdir(), "sync-engine-"));
	const db = new AppDatabase(":memory:");
	const bookmarks = new BookmarksStore(db);
	const history = new HistoryStore(db);
	const transport = new InMemoryTransport();
	const configStore = new SyncConfigStore(path.join(tmp, "sync-config.json"));
	const engine = new SyncEngine({
		configStore,
		bookmarks,
		history,
		transport,
		deriveKeyFn: fastDerive,
	});
	return { engine, db, bookmarks, history, transport, tmp };
}

describe("SyncEngine.configure/unlock/lock", () => {
	let cleanup: string[] = [];
	beforeEach(() => {
		for (const c of cleanup) {
			try {
				rmSync(c, { recursive: true, force: true });
			} catch {}
		}
		cleanup = [];
	});

	it("configure seeds salt+verifier and leaves the engine unlocked", async () => {
		const { engine, db, tmp } = mkEngine();
		cleanup.push(tmp);
		await engine.configure("hunter2", "https://example.com");
		const s = engine.status();
		expect(s.configured).toBe(true);
		expect(s.unlocked).toBe(true);
		expect(s.serverUrl).toBe("https://example.com");
		db.close();
	});

	it("unlock accepts the correct passphrase, rejects wrong ones", async () => {
		const { engine, db, tmp } = mkEngine();
		cleanup.push(tmp);
		await engine.configure("hunter2");
		engine.lock();
		expect(engine.status().unlocked).toBe(false);
		expect(await engine.unlock("wrong")).toBe(false);
		expect(engine.status().unlocked).toBe(false);
		expect(await engine.unlock("hunter2")).toBe(true);
		expect(engine.status().unlocked).toBe(true);
		db.close();
	});

	it("disable wipes config and relocks", async () => {
		const { engine, db, tmp } = mkEngine();
		cleanup.push(tmp);
		await engine.configure("hunter2");
		engine.disable();
		expect(engine.status().configured).toBe(false);
		expect(engine.status().unlocked).toBe(false);
		db.close();
	});
});

describe("SyncEngine.pushNow", () => {
	it("refuses to push while locked", async () => {
		const { engine, db, tmp } = mkEngine();
		await engine.configure("p");
		engine.lock();
		await expect(engine.pushNow()).rejects.toThrow(/locked/);
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("pushes bookmarks + new history rows as ciphertext", async () => {
		const { engine, db, bookmarks, history, transport, tmp } = mkEngine();
		// Use a distinctive plaintext marker that base64url alphabet cannot
		// express as a substring (contains '.' and '!') — guarantees that any
		// occurrence of the marker in the wire payload is a plaintext leak.
		const marker = "uniq.marker!token";
		bookmarks.add({ url: `https://ex.com/${marker}`, title: marker });
		history.record(`https://ex.com/${marker}`, marker, 1000);
		history.record("https://b.com/", "B", 2000);
		await engine.configure("p");
		const r = await engine.pushNow();
		expect(r.pushed).toBe(1 + 2);
		const kinds = transport.pushed.map((i) => i.kind);
		expect(kinds.filter((k) => k === "bookmark")).toHaveLength(1);
		expect(kinds.filter((k) => k === "history")).toHaveLength(2);
		for (const it of transport.pushed) {
			expect(JSON.stringify(it)).not.toContain(marker);
		}
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("second push skips history rows already pushed (cursor advance)", async () => {
		const { engine, db, history, transport, tmp } = mkEngine();
		history.record("https://a/", "A", 1000);
		await engine.configure("p");
		await engine.pushNow();
		const first = transport.pushed.length;
		history.record("https://b/", "B", 2000);
		await engine.pushNow();
		const addedKinds = transport.pushed.slice(first).map((i) => i.kind);
		// Only the new history row should appear (bookmarks is empty).
		expect(addedKinds).toEqual(["history"]);
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("second push skips bookmarks already pushed", async () => {
		const { engine, db, bookmarks, transport, tmp } = mkEngine();
		bookmarks.add({ url: "https://a/", title: "A" });
		await engine.configure("p");
		await engine.pushNow();
		const first = transport.pushed.length;
		bookmarks.add({ url: "https://b/", title: "B" });
		await engine.pushNow();
		const addedKinds = transport.pushed.slice(first).map((i) => i.kind);
		expect(addedKinds).toEqual(["bookmark"]);
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("push watermarks are independent from pull cursors", async () => {
		const { engine, db, bookmarks, transport, tmp } = mkEngine();
		bookmarks.add({ url: "https://a/", title: "A" });
		await engine.configure("p");
		await engine.pushNow();
		const s = engine.status();
		// Push bumped only the push watermark; pull cursor still at zero.
		expect(s.lastBookmarksCursor).toBe(0);
		// Reach into cfg via status is indirect — we verify by simulating a
		// pull: if push had corrupted the pull cursor, pullBookmarks would be
		// called with a non-zero since. Our stub echoes it back; assert 0.
		const calls: number[] = [];
		transport.pullBookmarks = async (since: number) => {
			calls.push(since);
			return { items: [], cursor: 0 };
		};
		await engine.pullNow();
		expect(calls).toEqual([0]);
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});
});

describe("SyncEngine.pullNow", () => {
	it("applies bookmark ciphertext to BookmarksStore", async () => {
		const { engine, db, bookmarks, transport, tmp } = mkEngine();
		await engine.configure("p");
		// "Publish" a bookmark from another device by encrypting with the same engine key.
		const envEngine = new SyncEngine({
			configStore: new SyncConfigStore(path.join(tmp, "peer.json")),
			bookmarks: new BookmarksStore(db),
			history: new HistoryStore(db),
			transport: new InMemoryTransport(),
			deriveKeyFn: fastDerive,
		});
		void envEngine; // unused; we just need encrypt via engine's current key
		const peerBookmarks = new BookmarksStore(new AppDatabase(":memory:"));
		peerBookmarks.add({ url: "https://remote/", title: "Remote" });
		// Re-use engine.pushNow to produce the encrypted item, then strip to local list.
		const stealTransport = new InMemoryTransport();
		const mirrorEngine = new SyncEngine({
			configStore: new SyncConfigStore(path.join(tmp, "mirror.json")),
			bookmarks: peerBookmarks,
			history: new HistoryStore(new AppDatabase(":memory:")),
			transport: stealTransport,
			deriveKeyFn: fastDerive,
		});
		// Share the same salt so the derived key matches across engines.
		const cfgPrimary = JSON.parse(
			require("node:fs").readFileSync(
				path.join(tmp, "sync-config.json"),
				"utf-8",
			),
		);
		require("node:fs").writeFileSync(
			path.join(tmp, "mirror.json"),
			JSON.stringify(cfgPrimary),
		);
		// Reconstruct the mirror engine now that config matches.
		const mirror2 = new SyncEngine({
			configStore: new SyncConfigStore(path.join(tmp, "mirror.json")),
			bookmarks: peerBookmarks,
			history: new HistoryStore(new AppDatabase(":memory:")),
			transport: stealTransport,
			deriveKeyFn: fastDerive,
		});
		expect(await mirror2.unlock("p")).toBe(true);
		await mirror2.pushNow();
		transport.bookmarks = stealTransport.pushed.filter(
			(i) => i.kind === "bookmark",
		);
		const r = await engine.pullNow();
		expect(r.applied).toBeGreaterThanOrEqual(1);
		const list = bookmarks.list();
		expect(list.map((b) => b.url)).toContain("https://remote/");
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("skips items that decrypt-fail (wrong key / corrupt)", async () => {
		const { engine, db, transport, tmp } = mkEngine();
		await engine.configure("p");
		transport.bookmarks = [
			{
				pointerId: "x",
				kind: "bookmark",
				updatedAt: 0,
				envelope: {
					v: 1,
					alg: "aes-256-gcm",
					iv: "AAAAAAAAAAAAAAAA",
					ct: "AAAA",
					tag: "AAAAAAAAAAAAAAAAAAAAAA",
				},
			},
		];
		const r = await engine.pullNow();
		expect(r.applied).toBe(0);
		expect(r.skipped).toBeGreaterThanOrEqual(1);
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});
});
