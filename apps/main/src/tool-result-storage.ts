/**
 * Tool Result Storage (Stage 6.5)
 *
 * Large tool outputs (> threshold) are persisted to SQLite and replaced in the
 * LLM context by a compact `{ ref_id, summary, byte_size }` envelope. The LLM
 * may recall the full payload by calling the `read_result` meta-skill.
 *
 * See PLAN.md Stage 6.5 + 附录 L (post-tool-call hook).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Skill } from "@agent-browser/browser-tools";
import Database, { type Database as BetterSqliteDb } from "better-sqlite3";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PutResult {
	/** `null` when the payload is under threshold — caller should pass the
	 * original `result` straight to the LLM. */
	refId: string | null;
	/** When `refId == null`: the raw result. Otherwise: a truncated preview. */
	summary: unknown;
	/** Byte size of the JSON-stringified payload. */
	byteSize: number;
}

export interface ToolResultListEntry {
	refId: string;
	toolName: string;
	byteSize: number;
	createdAt: number;
}

export interface ToolResultStorageOptions {
	/** SQLite file path. Use `:memory:` for tests. Defaults to
	 * `{cwd}/tool-results.db` — callers should pass an explicit path. */
	dbPath?: string;
	/** Payload byte size above which results are spilled to disk. */
	thresholdBytes?: number;
	/** Max characters kept in the `summary` field returned to the LLM. */
	summaryChars?: number;
}

// ---------------------------------------------------------------------------
// Safe stringify (handles circular refs without throwing)
// ---------------------------------------------------------------------------

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, v) => {
		if (typeof v === "bigint") return v.toString();
		if (typeof v === "object" && v !== null) {
			if (seen.has(v as object)) return "[Circular]";
			seen.add(v as object);
		}
		return v;
	});
}

/** UTF-8-safe truncation (never splits a multi-byte sequence). */
function truncateUtf8(s: string, maxChars: number): string {
	if (s.length <= maxChars) return s;
	return `${s.slice(0, maxChars)}…`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export class ToolResultStorage {
	private readonly db: BetterSqliteDb;
	private readonly thresholdBytes: number;
	private readonly summaryChars: number;
	private closed = false;
	private readonly putStmt: import("better-sqlite3").Statement<
		[string, string, string, string, number, number]
	>;
	private readonly getStmt: import("better-sqlite3").Statement<[string]>;
	private readonly listStmt: import("better-sqlite3").Statement<[string]>;
	private readonly vacuumStmt: import("better-sqlite3").Statement<[number]>;

	constructor(opts: ToolResultStorageOptions = {}) {
		const dbPath = opts.dbPath ?? path.join(process.cwd(), "tool-results.db");
		this.thresholdBytes = opts.thresholdBytes ?? 4096;
		this.summaryChars = opts.summaryChars ?? 100;

		if (dbPath !== ":memory:") {
			const dir = path.dirname(dbPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}

		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tool_results (
				ref_id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				payload TEXT NOT NULL,
				byte_size INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS tool_results_task ON tool_results(task_id);
			CREATE INDEX IF NOT EXISTS tool_results_created ON tool_results(created_at);
		`);

		this.putStmt = this.db.prepare<
			[string, string, string, string, number, number]
		>(
			`INSERT INTO tool_results (ref_id, task_id, tool_name, payload, byte_size, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.getStmt = this.db.prepare<[string]>(
			`SELECT payload FROM tool_results WHERE ref_id = ?`,
		);
		this.listStmt = this.db.prepare<[string]>(
			`SELECT ref_id AS refId, tool_name AS toolName, byte_size AS byteSize, created_at AS createdAt
			 FROM tool_results WHERE task_id = ? ORDER BY created_at ASC`,
		);
		this.vacuumStmt = this.db.prepare<[number]>(
			`DELETE FROM tool_results WHERE created_at < ?`,
		);
	}

	/**
	 * Store `result` if it exceeds `thresholdBytes`. Returns a compact envelope
	 * safe to pass to the LLM.
	 */
	put(taskId: string, toolName: string, result: unknown): PutResult {
		if (this.closed) throw new Error("ToolResultStorage: closed");
		let payloadJson: string;
		try {
			payloadJson = safeStringify(result);
		} catch (e) {
			// safeStringify already handles cycles; other failures (e.g. BigInt in
			// pre-v10 runtimes, custom toJSON throws) become a stringified error.
			const msg = e instanceof Error ? e.message : String(e);
			payloadJson = JSON.stringify({ __stringify_error__: msg });
		}
		// JSON.stringify returns `undefined` for values like `undefined` or
		// functions at the top level; normalize to a valid JSON string.
		if (payloadJson === undefined) payloadJson = "null";

		const byteSize = Buffer.byteLength(payloadJson, "utf8");

		if (byteSize <= this.thresholdBytes) {
			return { refId: null, summary: result, byteSize };
		}

		const refId = randomUUID();
		const createdAt = Date.now();
		this.putStmt.run(refId, taskId, toolName, payloadJson, byteSize, createdAt);

		const summary = truncateUtf8(payloadJson, this.summaryChars);
		return { refId, summary, byteSize };
	}

	/** Retrieve a full payload by refId. Returns `undefined` if missing. */
	get(refId: string): unknown {
		if (this.closed) throw new Error("ToolResultStorage: closed");
		const row = this.getStmt.get(refId) as { payload: string } | undefined;
		if (!row) return undefined;
		try {
			return JSON.parse(row.payload);
		} catch {
			return row.payload;
		}
	}

	/** List every spilled result for a task (ascending by createdAt). */
	listByTask(taskId: string): ToolResultListEntry[] {
		if (this.closed) throw new Error("ToolResultStorage: closed");
		return this.listStmt.all(taskId) as ToolResultListEntry[];
	}

	/** Delete entries older than `days` days. Returns rows removed. */
	vacuumOlderThan(days = 30): number {
		if (this.closed) throw new Error("ToolResultStorage: closed");
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const info = this.vacuumStmt.run(cutoff);
		return Number(info.changes ?? 0);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	/** Exposed for `installToolResultStorage` / tests. */
	get threshold(): number {
		return this.thresholdBytes;
	}
}

// ---------------------------------------------------------------------------
// AgentHost integration
// ---------------------------------------------------------------------------

export interface ToolResultHookHost {
	on(
		hook: "post-tool-call",
		cb: (payload: {
			tool: string;
			result: unknown;
		}) => void | Promise<void> | unknown | Promise<unknown>,
	): void;
}

/**
 * Register a `post-tool-call` hook that replaces large results with
 * `{ ref_id, summary, byte_size }` envelopes. Smaller results pass through
 * untouched.
 *
 * `taskIdProvider` returns the current task id at hook-fire time (AgentHost
 * tracks this in its TaskContext; tests may supply a stub).
 *
 * Returns an unsubscribe function if the host exposes one — we don't require
 * it in the interface, so we return `void` by default.
 */
export function installToolResultStorage(
	host: ToolResultHookHost,
	storage: ToolResultStorage,
	taskIdProvider: () => string,
): void {
	host.on("post-tool-call", (payload) => {
		const taskId = taskIdProvider();
		const out = storage.put(taskId, payload.tool, payload.result);
		if (out.refId == null) {
			return payload.result;
		}
		return {
			ref_id: out.refId,
			summary: out.summary,
			byte_size: out.byteSize,
		};
	});
}

// ---------------------------------------------------------------------------
// `read_result` meta-skill
// ---------------------------------------------------------------------------

export const ReadResultInput = z.object({
	ref_id: z.string().min(1),
});
export type ReadResultInput = z.infer<typeof ReadResultInput>;

export interface ReadResultOutput {
	ref_id: string;
	found: boolean;
	result: unknown;
}

/**
 * Meta-skill the LLM can call to rehydrate a previously-spilled tool result.
 * Registered by AgentHost (Stage 3); exported here for dependency inversion.
 */
export function createReadResultSkill(
	storage: ToolResultStorage,
): Skill<ReadResultInput, ReadResultOutput> {
	return {
		name: "read_result",
		description:
			"Fetch the full payload of a previously-stored tool result by its `ref_id`. " +
			"Use this when a prior tool call returned `{ref_id, summary, byte_size}` and " +
			"you need the complete data to proceed.",
		inputSchema: ReadResultInput,
		execute: async (input) => {
			const result = storage.get(input.ref_id);
			return {
				ref_id: input.ref_id,
				found: result !== undefined,
				result,
			};
		},
	};
}
