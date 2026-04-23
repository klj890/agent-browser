/**
 * HistoryIndex tests (Stage 11).
 *
 * We inject a deterministic fake embedder so no model is ever downloaded.
 * Coverage:
 *   - upsert writes; count reflects inserts; upsert is idempotent per id
 *   - search returns dot-product-sorted descending, top-K truncated
 *   - delete / deleteAll remove rows
 *   - empty query short-circuits
 */
import { afterEach, describe, expect, it } from "vitest";
import { HistoryIndex, setEmbedderForTests } from "../history-index.js";
import { AppDatabase } from "../storage/sqlite.js";

/**
 * Build a deterministic 4-dim embedding from a small keyword bag. Every test
 * case uses disjoint keyword sets so dot products are predictable.
 */
function keywordEmbedder(text: string): Float32Array {
	const dim = 4;
	const v = new Float32Array(dim);
	const lower = text.toLowerCase();
	if (lower.includes("cat")) v[0] = 1;
	if (lower.includes("dog")) v[1] = 1;
	if (lower.includes("fish")) v[2] = 1;
	if (lower.includes("bird")) v[3] = 1;
	return v;
}

function mkDb(): AppDatabase {
	return new AppDatabase(":memory:");
}

describe("HistoryIndex", () => {
	afterEach(() => setEmbedderForTests(null));

	it("upsert stores a vector and search returns dot-product-sorted hits", async () => {
		setEmbedderForTests(async (t) => keywordEmbedder(t));
		const db = mkDb();
		// Need a history row to satisfy FK? FK references exist, but we allow
		// orphan rows because the FK target is checked on delete cascade, not
		// on insert when FK is ON — actually better-sqlite3 FK=ON enforces on
		// insert too. So insert parent history rows first.
		db.db
			.prepare(
				"INSERT INTO history (id, url, title, visited_at) VALUES (?, ?, ?, ?)",
			)
			.run(1, "https://a/", "cat page", 1);
		db.db
			.prepare(
				"INSERT INTO history (id, url, title, visited_at) VALUES (?, ?, ?, ?)",
			)
			.run(2, "https://b/", "dog page", 2);
		db.db
			.prepare(
				"INSERT INTO history (id, url, title, visited_at) VALUES (?, ?, ?, ?)",
			)
			.run(3, "https://c/", "fish page", 3);

		const idx = new HistoryIndex(db);
		await idx.upsert(1, "cat");
		await idx.upsert(2, "dog");
		await idx.upsert(3, "fish");

		expect(idx.count()).toBe(3);

		const hits = await idx.search("dog", 10);
		expect(hits[0]?.id).toBe(2);
		expect(hits[0]?.score).toBeCloseTo(1);
		// The non-matching rows score 0.
		expect(hits.slice(1).every((h) => h.score === 0)).toBe(true);

		db.close();
	});

	it("search truncates to limit", async () => {
		setEmbedderForTests(async (t) => keywordEmbedder(t));
		const db = mkDb();
		for (let i = 1; i <= 3; i++) {
			db.db
				.prepare(
					"INSERT INTO history (id, url, title, visited_at) VALUES (?, ?, ?, ?)",
				)
				.run(i, `https://${i}/`, "cat dog fish", i);
		}
		const idx = new HistoryIndex(db);
		for (let i = 1; i <= 3; i++) await idx.upsert(i, "cat dog fish");

		const hits = await idx.search("cat", 2);
		expect(hits).toHaveLength(2);

		db.close();
	});

	it("upsert is idempotent per history_id (overwrites vector)", async () => {
		setEmbedderForTests(async (t) => keywordEmbedder(t));
		const db = mkDb();
		db.db
			.prepare(
				"INSERT INTO history (id, url, title, visited_at) VALUES (?, ?, ?, ?)",
			)
			.run(1, "https://a/", "x", 1);
		const idx = new HistoryIndex(db);
		await idx.upsert(1, "cat");
		await idx.upsert(1, "dog");
		expect(idx.count()).toBe(1);

		// Now stored vector should match "dog".
		const hits = await idx.search("dog", 5);
		expect(hits[0]?.score).toBeCloseTo(1);
		const catHits = await idx.search("cat", 5);
		expect(catHits[0]?.score).toBeCloseTo(0);

		db.close();
	});

	it("delete and deleteAll remove entries", async () => {
		setEmbedderForTests(async (t) => keywordEmbedder(t));
		const db = mkDb();
		for (let i = 1; i <= 3; i++) {
			db.db
				.prepare(
					"INSERT INTO history (id, url, title, visited_at) VALUES (?, ?, ?, ?)",
				)
				.run(i, `https://${i}/`, "cat", i);
		}
		const idx = new HistoryIndex(db);
		for (let i = 1; i <= 3; i++) await idx.upsert(i, "cat");
		expect(idx.count()).toBe(3);
		idx.delete(2);
		expect(idx.count()).toBe(2);
		idx.deleteAll();
		expect(idx.count()).toBe(0);
		db.close();
	});

	it("empty query returns no hits without embedding", async () => {
		let calls = 0;
		setEmbedderForTests(async (t) => {
			calls++;
			return keywordEmbedder(t);
		});
		const db = mkDb();
		const idx = new HistoryIndex(db);
		const hits = await idx.search("", 10);
		expect(hits).toEqual([]);
		expect(calls).toBe(0);
		db.close();
	});
});
