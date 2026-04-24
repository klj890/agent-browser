import { describe, expect, it } from "vitest";
import { BookmarksStore } from "../bookmarks.js";
import { AppDatabase } from "../storage/sqlite.js";

function mkDb(): AppDatabase {
	return new AppDatabase(":memory:");
}

describe("BookmarksStore", () => {
	it("add assigns incrementing position per folder", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		const a = b.add({ url: "https://a.com/", title: "A", folder: "work" });
		const c = b.add({ url: "https://b.com/", title: "B", folder: "work" });
		expect(a.position).toBe(0);
		expect(c.position).toBe(1);
		db.close();
	});

	it("list filters by folder", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		b.add({ url: "https://a.com/", folder: "work" });
		b.add({ url: "https://b.com/", folder: "home" });
		expect(b.list("work").map((x) => x.url)).toEqual(["https://a.com/"]);
		expect(b.list().length).toBe(2);
		db.close();
	});

	it("remove deletes by id", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		const x = b.add({ url: "https://a.com/" });
		expect(b.remove(x.id)).toBe(true);
		expect(b.list()).toEqual([]);
		db.close();
	});

	it("reorder updates positions transactionally", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		const a = b.add({ url: "https://a.com/", folder: "f" });
		const c = b.add({ url: "https://b.com/", folder: "f" });
		const d = b.add({ url: "https://c.com/", folder: "f" });
		b.reorder("f", [d.id, a.id, c.id]);
		const list = b.list("f");
		expect(list.map((x) => x.url)).toEqual([
			"https://c.com/",
			"https://a.com/",
			"https://b.com/",
		]);
		db.close();
	});

	it("duplicate (url, folder) is upserted not duplicated", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		b.add({ url: "https://a.com/", title: "First", folder: "f" });
		b.add({ url: "https://a.com/", title: "Second", folder: "f" });
		const list = b.list("f");
		expect(list.length).toBe(1);
		expect(list[0]?.title).toBe("Second");
		db.close();
	});

	it("remove writes a tombstone; skipTombstone=true bypasses it", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		const a = b.add({
			url: "https://a.com/",
			title: "A",
			folder: "f",
			createdAt: 1,
		});
		expect(b.remove(a.id, { deletedAt: 100 })).toBe(true);
		// Live row gone, tombstone present.
		expect(b.list()).toEqual([]);
		const ts = b.listTombstonesSince(0, 0, 10);
		expect(ts).toHaveLength(1);
		expect(ts[0]).toMatchObject({
			folder: "f",
			url: "https://a.com/",
			deleted_at: 100,
		});

		// skipTombstone path: add-then-remove-with-skip should NOT yield a tombstone.
		const b2 = b.add({
			url: "https://b.com/",
			folder: "f",
			createdAt: 2,
		});
		expect(b.remove(b2.id, { skipTombstone: true })).toBe(true);
		const ts2 = b.listTombstonesSince(100, ts[0]?.id ?? 0, 10);
		expect(ts2).toEqual([]);
		db.close();
	});

	it("re-add after delete drops the tombstone so it can't bounce", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		const row = b.add({ url: "https://a/", folder: "", createdAt: 10 });
		b.remove(row.id, { deletedAt: 20 });
		expect(b.listTombstonesSince(0, 0, 10)).toHaveLength(1);
		b.add({ url: "https://a/", folder: "", createdAt: 30 });
		expect(b.listTombstonesSince(0, 0, 10)).toEqual([]);
		expect(b.list().map((x) => x.url)).toEqual(["https://a/"]);
		db.close();
	});

	it("removeByUrlFolder deletes without writing a tombstone", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		b.add({ url: "https://a/", folder: "", createdAt: 1 });
		expect(b.removeByUrlFolder("https://a/", "")).toBe(true);
		expect(b.list()).toEqual([]);
		expect(b.listTombstonesSince(0, 0, 10)).toEqual([]);
		// Non-existent row → false, no effect.
		expect(b.removeByUrlFolder("https://nope/", "")).toBe(false);
		db.close();
	});

	it("listTombstonesSince paginates by (deleted_at, id)", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		// Three rows with distinct deleted_at.
		const r1 = b.add({ url: "https://1/", folder: "", createdAt: 1 });
		const r2 = b.add({ url: "https://2/", folder: "", createdAt: 2 });
		const r3 = b.add({ url: "https://3/", folder: "", createdAt: 3 });
		b.remove(r1.id, { deletedAt: 10 });
		b.remove(r2.id, { deletedAt: 20 });
		b.remove(r3.id, { deletedAt: 30 });
		const p1 = b.listTombstonesSince(0, 0, 2);
		expect(p1.map((t) => t.url)).toEqual(["https://1/", "https://2/"]);
		const last = p1[p1.length - 1];
		const p2 = b.listTombstonesSince(last?.deleted_at ?? 0, last?.id ?? 0, 2);
		expect(p2.map((t) => t.url)).toEqual(["https://3/"]);
		db.close();
	});

	it("gcTombstones drops only entries older than keepMs", () => {
		const db = mkDb();
		const b = new BookmarksStore(db);
		const row = b.add({ url: "https://a/", folder: "", createdAt: 1 });
		b.remove(row.id, { deletedAt: Date.now() - 1000 * 60 * 60 * 24 * 40 });
		const row2 = b.add({ url: "https://fresh/", folder: "", createdAt: 2 });
		b.remove(row2.id);
		const removed = b.gcTombstones(1000 * 60 * 60 * 24 * 30);
		expect(removed).toBe(1);
		expect(b.listTombstonesSince(0, 0, 10)).toHaveLength(1);
		db.close();
	});
});
