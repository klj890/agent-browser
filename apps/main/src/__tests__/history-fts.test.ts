/**
 * History FTS5 full-text search (P1-13).
 */
import { describe, expect, it } from "vitest";
import { HistoryStore, toFtsMatch } from "../history.js";
import { AppDatabase } from "../storage/sqlite.js";

function mk(): { db: AppDatabase; store: HistoryStore } {
	const db = new AppDatabase(":memory:");
	return { db, store: new HistoryStore(db) };
}

describe("toFtsMatch", () => {
	it("builds prefix-match tokens joined by space", () => {
		expect(toFtsMatch("hello world")).toBe('"hello"* "world"*');
	});

	it("returns empty on whitespace-only input", () => {
		expect(toFtsMatch("   ")).toBe("");
	});

	it("escapes embedded double-quotes", () => {
		expect(toFtsMatch('foo"bar')).toBe('"foo""bar"*');
	});

	it("drops FTS operator chars so user input is safe", () => {
		expect(toFtsMatch("a(b):c")).toBe('"abc"*');
	});
});

describe("HistoryStore.fullTextSearch", () => {
	it("finds rows by title or url token", () => {
		const { db, store } = mk();
		store.record("https://example.com/guide", "Vue 3 Performance Guide");
		store.record("https://rust-lang.org/", "Rust Programming Language");
		store.record("https://kubernetes.io/", "Kubernetes Docs");

		const vue = store.fullTextSearch("vue");
		expect(vue.map((r) => r.url)).toEqual(["https://example.com/guide"]);

		const byUrl = store.fullTextSearch("rust-lang");
		expect(byUrl.map((r) => r.url)).toEqual(["https://rust-lang.org/"]);
		db.close();
	});

	it("supports multi-word AND semantics with prefix matching", () => {
		const { db, store } = mk();
		store.record("https://a/", "Vue 3 Performance Guide");
		store.record("https://b/", "Performance notes on Go");
		store.record("https://c/", "Vue 2 upgrade path");

		const both = store.fullTextSearch("vue perf");
		expect(both.map((r) => r.url)).toEqual(["https://a/"]);
		db.close();
	});

	it("stays empty on blank query", () => {
		const { db, store } = mk();
		store.record("https://a/", "Hello");
		expect(store.fullTextSearch("")).toEqual([]);
		expect(store.fullTextSearch("   ")).toEqual([]);
		db.close();
	});

	it("deletes propagate to the FTS index", () => {
		const { db, store } = mk();
		store.record("https://a/", "Kubernetes");
		expect(store.fullTextSearch("kubernetes")).toHaveLength(1);
		store.clear();
		expect(store.fullTextSearch("kubernetes")).toHaveLength(0);
		db.close();
	});

	it("handles stray quote from user without throwing", () => {
		const { db, store } = mk();
		store.record("https://a/", "Test");
		expect(() => store.fullTextSearch('"')).not.toThrow();
		db.close();
	});
});
