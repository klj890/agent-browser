/**
 * Semantic index for browsing history (Stage 11).
 *
 * Stores one embedding per history row in `history_embeddings`. The embedding
 * vector is a 384-dim Float32Array (Xenova/all-MiniLM-L6-v2, mean-pooled) kept
 * as a raw BLOB. Search is a brute-force cosine/dot-product scan across the
 * table in JavaScript — there are at most a few thousand rows per user, so a
 * JS scan is fast enough and avoids the sqlite-vss native-build pain.
 *
 * The embedding pipeline is lazy: the first `embed()` call downloads the model
 * via `@xenova/transformers` and caches it locally. Tests inject a fake embed
 * function via `setEmbedderForTests()` to avoid any model download.
 */
import type { AppDatabase } from "./storage/sqlite.js";

/** Embed function contract — `text` → unit-length Float32Array of length `dim`. */
export type EmbedFn = (text: string) => Promise<Float32Array>;

let injectedEmbed: EmbedFn | null = null;

/** Test-only: inject a deterministic embed function. Pass `null` to restore. */
export function setEmbedderForTests(fn: EmbedFn | null): void {
	injectedEmbed = fn;
}

// ---------------------------------------------------------------------------
// Real embedder (lazy-loaded)
// ---------------------------------------------------------------------------

type Pipeline = (
	text: string,
	opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

let realPipelinePromise: Promise<Pipeline> | null = null;

async function getRealPipeline(): Promise<Pipeline> {
	if (!realPipelinePromise) {
		realPipelinePromise = (async () => {
			// Dynamic import so the dep isn't required at test time. Cast to any
			// because @xenova/transformers' PipelineType enum is too narrow to
			// match our minimal structural type.
			// biome-ignore lint/suspicious/noExplicitAny: see comment
			const mod: any = await import("@xenova/transformers");
			return mod.pipeline(
				"feature-extraction",
				"Xenova/all-MiniLM-L6-v2",
			) as Promise<Pipeline>;
		})();
	}
	return realPipelinePromise;
}

async function realEmbed(text: string): Promise<Float32Array> {
	const pipe = await getRealPipeline();
	const out = await pipe(text, { pooling: "mean", normalize: true });
	return out.data instanceof Float32Array
		? out.data
		: Float32Array.from(out.data);
}

/** Embed via injected fn (tests) or real transformers.js pipeline. */
export async function embed(text: string): Promise<Float32Array> {
	if (injectedEmbed) return injectedEmbed(text);
	return realEmbed(text);
}

// ---------------------------------------------------------------------------
// BLOB codec
// ---------------------------------------------------------------------------

function vecToBuffer(vec: Float32Array): Buffer {
	// Copy so we never hand sqlite a view over shared memory.
	return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
}

function bufferToVec(buf: Buffer, dim: number): Float32Array {
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const f = new Float32Array(ab);
	if (f.length !== dim) {
		// Tolerate mismatch by trimming / padding.
		const trimmed = new Float32Array(dim);
		trimmed.set(f.subarray(0, Math.min(dim, f.length)));
		return trimmed;
	}
	return f;
}

function dot(a: Float32Array, b: Float32Array): number {
	const n = Math.min(a.length, b.length);
	let s = 0;
	for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
	return s;
}

// ---------------------------------------------------------------------------
// HistoryIndex
// ---------------------------------------------------------------------------

export interface SemanticHit {
	id: number;
	score: number;
}

export class HistoryIndex {
	private readonly upsertStmt: import("better-sqlite3").Statement<
		[number, number, Buffer]
	>;
	private readonly deleteStmt: import("better-sqlite3").Statement<[number]>;
	private readonly clearStmt: import("better-sqlite3").Statement;
	private readonly selectAllStmt: import("better-sqlite3").Statement;

	constructor(private readonly appDb: AppDatabase) {
		const db = appDb.db;
		this.upsertStmt = db.prepare(
			"INSERT INTO history_embeddings (history_id, dim, vec) VALUES (?, ?, ?) " +
				"ON CONFLICT(history_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec",
		);
		this.deleteStmt = db.prepare(
			"DELETE FROM history_embeddings WHERE history_id = ?",
		);
		this.clearStmt = db.prepare("DELETE FROM history_embeddings");
		this.selectAllStmt = db.prepare(
			"SELECT history_id, dim, vec FROM history_embeddings",
		);
	}

	async upsert(historyId: number, text: string): Promise<void> {
		if (!text) return;
		const vec = await embed(text);
		this.upsertStmt.run(historyId, vec.length, vecToBuffer(vec));
	}

	async search(query: string, limit = 20): Promise<SemanticHit[]> {
		if (!query) return [];
		const qvec = await embed(query);
		const rows = this.selectAllStmt.all() as Array<{
			history_id: number;
			dim: number;
			vec: Buffer;
		}>;
		const hits: SemanticHit[] = [];
		for (const r of rows) {
			const v = bufferToVec(r.vec, r.dim);
			hits.push({ id: r.history_id, score: dot(qvec, v) });
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}

	delete(historyId: number): void {
		this.deleteStmt.run(historyId);
	}

	deleteAll(): void {
		this.clearStmt.run();
	}

	/** Number of stored embeddings (useful in tests). */
	count(): number {
		const row = this.appDb.db
			.prepare("SELECT COUNT(*) AS n FROM history_embeddings")
			.get() as { n: number };
		return row.n;
	}
}
