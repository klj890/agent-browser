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

	it("(url, visited_at) UNIQUE — second record returns the same id", () => {
		const db = mkDb();
		const h = new HistoryStore(db);
		const first = h.record("https://a/", "A", 42);
		const again = h.record("https://a/", "A", 42);
		expect(first).toBeGreaterThan(0);
		expect(again).toBe(first);
		expect(h.list()).toHaveLength(1);
		db.close();
	});

	it("listSince paginates strictly ascending by (visited_at, id)", () => {
		const db = mkDb();
		const h = new HistoryStore(db);
		for (let i = 1; i <= 5; i++) h.record(`https://x${i}.com/`, `x${i}`, i);
		// Start from (0,0): first page = rows 1,2 (visited_at 1 and 2).
		const page1 = h.listSince(0, 0, 2);
		expect(page1.map((e) => e.visited_at)).toEqual([1, 2]);
		const lastP1 = page1[page1.length - 1];
		// Next page starts strictly after (2, page1last.id).
		const page2 = h.listSince(lastP1?.visited_at ?? 0, lastP1?.id ?? 0, 2);
		expect(page2.map((e) => e.visited_at)).toEqual([3, 4]);
		const lastP2 = page2[page2.length - 1];
		const page3 = h.listSince(lastP2?.visited_at ?? 0, lastP2?.id ?? 0, 2);
		expect(page3.map((e) => e.visited_at)).toEqual([5]);
		const lastP3 = page3[page3.length - 1];
		expect(h.listSince(lastP3?.visited_at ?? 0, lastP3?.id ?? 0, 2)).toEqual(
			[],
		);
		db.close();
	});

	it("listSince does not drop rows sharing a visited_at across page boundaries", () => {
		const db = mkDb();
		const h = new HistoryStore(db);
		// All three rows share visited_at=7 but differ in url — id tiebreaker
		// must let us paginate through all of them.
		h.record("https://a/", "A", 7);
		h.record("https://b/", "B", 7);
		h.record("https://c/", "C", 7);
		const page1 = h.listSince(0, 0, 2);
		expect(page1.length).toBe(2);
		const last1 = page1[page1.length - 1];
		const page2 = h.listSince(last1?.visited_at ?? 0, last1?.id ?? 0, 2);
		expect(page2.length).toBe(1);
		// None dropped.
		const allUrls = new Set([...page1, ...page2].map((r) => r.url));
		expect(allUrls).toEqual(
			new Set(["https://a/", "https://b/", "https://c/"]),
		);
		db.close();
	});
});
