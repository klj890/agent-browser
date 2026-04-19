import { describe, expect, it } from "vitest";
import { HistoryStore } from "../history.js";
import { AppDatabase } from "../storage/sqlite.js";

function mkDb(): AppDatabase {
	return new AppDatabase(":memory:");
}

describe("HistoryStore", () => {
	it("record + list returns most-recent-first", () => {
		const db = mkDb();
		const h = new HistoryStore(db);
		h.record("https://a.example.com/", "A", 1000);
		h.record("https://b.example.com/", "B", 2000);
		h.record("https://c.example.com/", "C", 3000);
		const list = h.list(10, 0);
		expect(list.map((e) => e.url)).toEqual([
			"https://c.example.com/",
			"https://b.example.com/",
			"https://a.example.com/",
		]);
		db.close();
	});

	it("search matches url or title substring", () => {
		const db = mkDb();
		const h = new HistoryStore(db);
		h.record("https://github.com/foo", "Foo Repo", 1);
		h.record("https://example.com/bar", "Bar Site", 2);
		expect(h.search("github").map((e) => e.url)).toEqual([
			"https://github.com/foo",
		]);
		expect(h.search("bar").map((e) => e.title)).toEqual(["Bar Site"]);
		db.close();
	});

	it("skips non-http schemes", () => {
		const db = mkDb();
		const h = new HistoryStore(db);
		h.record("chrome://settings", "Settings");
		h.record("about:blank", "Blank");
		h.record("https://ok.com/", "OK");
		expect(h.list().map((e) => e.url)).toEqual(["https://ok.com/"]);
		db.close();
	});

	it("clear empties the table", () => {
		const db = mkDb();
		const h = new HistoryStore(db);
		h.record("https://a.example.com/", "A");
		h.clear();
		expect(h.list()).toEqual([]);
		db.close();
	});

	it("pagination via limit/offset", () => {
		const db = mkDb();
		const h = new HistoryStore(db);
		for (let i = 0; i < 5; i++) h.record(`https://x${i}.com/`, `x${i}`, i);
		expect(h.list(2, 0).length).toBe(2);
		expect(h.list(2, 2).length).toBe(2);
		expect(h.list(2, 4).length).toBe(1);
		db.close();
	});
});
