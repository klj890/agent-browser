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
});
