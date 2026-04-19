/**
 * HistoryStore + RedactionPipeline integration (Stage 11).
 *
 * Ensures `recordWithIndex()` runs `title + " " + url` through the attached
 * redactor *before* calling the semantic index. Verified by inspecting the
 * string passed to the injected fake embedder.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HistoryStore } from "../history.js";
import { HistoryIndex, setEmbedderForTests } from "../history-index.js";
import { RedactionPipeline } from "../redaction-pipeline.js";
import { AppDatabase } from "../storage/sqlite.js";

function mkDb(): AppDatabase {
	return new AppDatabase(":memory:");
}

/** Wait for fire-and-forget upsert microtasks to drain. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

describe("HistoryStore + RedactionPipeline", () => {
	afterEach(() => setEmbedderForTests(null));

	it("redacts sensitive text before embedding", async () => {
		const seen: string[] = [];
		setEmbedderForTests(async (t) => {
			seen.push(t);
			return new Float32Array([0, 0, 0, 0]);
		});
		const db = mkDb();
		const store = new HistoryStore(db);
		const idx = new HistoryIndex(db);
		const redactor = new RedactionPipeline({ enableDefaultRules: true });
		store.attachIndex(idx, redactor);

		// JWT embedded in URL query — should be redacted before embedding.
		const jwt =
			"eyJabcdefghij.klmnopqrstuvwxyz0123456789.abcdefghij0123456789xyz";
		store.recordWithIndex(
			`https://example.com/?token=${jwt}`,
			"Login page",
		);
		await flush();

		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toContain(jwt);
		expect(seen[0]).toContain("[REDACTED:jwt]");

		db.close();
	});

	it("embedding failure does not break history write", async () => {
		setEmbedderForTests(async () => {
			throw new Error("boom");
		});
		const db = mkDb();
		const store = new HistoryStore(db);
		const idx = new HistoryIndex(db);
		store.attachIndex(idx, new RedactionPipeline());

		const id = store.recordWithIndex("https://ok.com/", "OK");
		expect(id).toBeGreaterThan(0);
		await flush();

		// History row is present even though embed threw.
		expect(store.list()).toHaveLength(1);
		expect(idx.count()).toBe(0);

		db.close();
	});

	it("clear() also clears the semantic index", async () => {
		setEmbedderForTests(async () => new Float32Array([1, 0, 0, 0]));
		const db = mkDb();
		const store = new HistoryStore(db);
		const idx = new HistoryIndex(db);
		store.attachIndex(idx, new RedactionPipeline());

		store.recordWithIndex("https://a/", "a");
		store.recordWithIndex("https://b/", "b");
		await flush();
		expect(idx.count()).toBe(2);

		store.clear();
		expect(store.list()).toEqual([]);
		expect(idx.count()).toBe(0);

		db.close();
	});

	it("semanticSearch returns rows ordered by vector similarity", async () => {
		// Deterministic vectors keyed by URL
		setEmbedderForTests(async (t) => {
			const v = new Float32Array(4);
			if (t.includes("cat") || t === "cat") v[0] = 1;
			if (t.includes("dog") || t === "dog") v[1] = 1;
			if (t.includes("fish") || t === "fish") v[2] = 1;
			return v;
		});
		const db = mkDb();
		const store = new HistoryStore(db);
		const idx = new HistoryIndex(db);
		store.attachIndex(idx, new RedactionPipeline());

		store.recordWithIndex("https://cat.example.com/", "cat");
		store.recordWithIndex("https://dog.example.com/", "dog");
		store.recordWithIndex("https://fish.example.com/", "fish");
		await flush();

		const hits = await store.semanticSearch("dog", 10);
		expect(hits[0]?.url).toBe("https://dog.example.com/");

		db.close();
	});
});
