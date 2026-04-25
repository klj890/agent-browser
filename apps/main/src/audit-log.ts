/**
 * Audit Log (Stage 6.4 + query-index hardening)
 *
 * Writes every gate/hook event in the agent step loop to two destinations:
 *
 *   1. jsonl — one append-only file per UTC day at `{dir}/YYYY-MM-DD.jsonl`.
 *      Cheap to read with `grep/jq`, trivial to archive/compress, immutable.
 *   2. SQLite — `{dir}/events.sqlite` indexed for `list()` / `listTasks()`.
 *      Queries O(log N) instead of O(total events), doesn't pin the process
 *      on `readFileSync` during Trace viewer loads.
 *
 * Why dual-write: the jsonl form is great for backup / postmortem / external
 * scripts; the SQLite form is great for interactive queries. Either can be
 * rebuilt from the other — backfill from jsonl runs automatically on first
 * boot when the SQLite index is empty.
 *
 * NEVER write raw prompt/tool-result payloads into audit log. Use
 * `summarizeInput` / `summarizeOutput` which truncate + hash.
 */
import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	type WriteStream,
} from "node:fs";
import path from "node:path";
import Database, { type Database as BetterSqliteDb } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Event schema (discriminated union) — PLAN.md 附录 I
// ---------------------------------------------------------------------------

export interface LlmCallPreEvent {
	event: "llm.call.pre";
	ts: number;
	task_id: string;
	model: string;
	provider: string;
	input_tokens_est: number;
	redaction_hits: Record<string, number>;
	persona: string;
	autonomy: string;
}

export interface LlmCallPostEvent {
	event: "llm.call.post";
	ts: number;
	task_id: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	usd_cost: number;
	finish_reason: string;
	duration_ms: number;
}

export interface ToolCallEvent {
	event: "tool.call";
	ts: number;
	task_id: string;
	tool: string;
	args_hash: string;
	ref?: string;
	result_ref: string | null;
	byte_size: number;
	high_risk_flags: string[];
}

export interface ToolConfirmEvent {
	event: "tool.confirm";
	ts: number;
	task_id: string;
	tool: string;
	decision: "approved" | "denied" | "timeout";
	latency_ms: number;
}

export interface TaskStartEvent {
	event: "task.start";
	ts: number;
	task_id: string;
	user_prompt_hash: string;
	persona: string;
	tab_url: string;
}

export interface TaskEndEvent {
	event: "task.end";
	ts: number;
	task_id: string;
	status: "completed" | "failed" | "killed" | "budget_exceeded";
	steps: number;
	total_usd: number;
	total_tokens: number;
}

export interface TaskStateChangeEvent {
	event: "task.state-change";
	ts: number;
	task_id: string;
	from: string;
	to: string;
	reason?: string;
}

export interface PolicyChangeEvent {
	event: "policy.change";
	ts: number;
	actor: "admin";
	diff: object;
	prev_hash: string;
	new_hash: string;
}

export interface InjectionFlagEvent {
	event: "injection.flag";
	ts: number;
	task_id: string;
	source_url: string;
	pattern: string;
	snippet_hash: string;
}

/**
 * Agent-initiated edit to SOUL.md (P2 §2.2 self-evolution). Recorded when
 * the user approves a `soul_amend` tool call so a later auditor can replay
 * "what new boundary/preference did the Agent slip into the system prompt
 * on this date, and was the file content before/after what we expected".
 *
 * Payload is intentionally narrow: section + 200-char bullet excerpt +
 * before/after content hashes. The full bullet body lives in tool.call's
 * `args_hash` slot already; duplicating it here would balloon every event.
 */
export interface SoulAmendEvent {
	event: "soul.amend";
	ts: number;
	task_id: string;
	section: string;
	bullet_excerpt: string;
	before_hash: string;
	after_hash: string;
	byte_size: number;
	created_section: boolean;
}

export type AuditEvent =
	| LlmCallPreEvent
	| LlmCallPostEvent
	| ToolCallEvent
	| ToolConfirmEvent
	| TaskStartEvent
	| TaskEndEvent
	| TaskStateChangeEvent
	| PolicyChangeEvent
	| InjectionFlagEvent
	| SoulAmendEvent;

// ---------------------------------------------------------------------------
// Hash / summarize helpers
// ---------------------------------------------------------------------------

/**
 * Stable JSON stringify — sorts object keys so `hashPayload` is order-invariant.
 * Handles arrays, plain objects, primitives. Non-serializable values (functions,
 * symbols) are coerced to `null`; cycles throw via JSON.stringify's default.
 */
export function stableStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		const parts: string[] = [];
		for (const k of keys) {
			const v = obj[k];
			if (v === undefined) continue;
			parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
		}
		return `{${parts.join(",")}}`;
	}
	// functions / symbols / undefined
	return "null";
}

/** sha256 hex of the stable-stringified payload. */
export function hashPayload(data: unknown): string {
	return createHash("sha256").update(stableStringify(data)).digest("hex");
}

export interface Summary {
	excerpt: string;
	hash: string;
	byte_size: number;
}

function summarize(payload: unknown): Summary {
	const s = typeof payload === "string" ? payload : stableStringify(payload);
	const excerpt = s.length > 200 ? s.slice(0, 200) : s;
	return {
		excerpt,
		hash: hashPayload(payload),
		byte_size: Buffer.byteLength(s, "utf8"),
	};
}

export function summarizeInput(payload: unknown): Summary {
	return summarize(payload);
}

export function summarizeOutput(payload: unknown): Summary {
	return summarize(payload);
}

// ---------------------------------------------------------------------------
// AuditLog class
// ---------------------------------------------------------------------------

export interface AuditLogOptions {
	/** Directory to write jsonl files into. Defaults to
	 * `{userData}/agent-browser/audit` when running under Electron;
	 * tests should always inject their own tmp dir. */
	dir?: string;
	/** Clock override for testability. Defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Path to the SQLite file used as the query index. Defaults to
	 * `{dir}/events.sqlite`. Tests can pass `:memory:` for a pure in-memory
	 * index that never touches disk.
	 */
	dbPath?: string;
}

/** Format a ms-epoch timestamp as `YYYY-MM-DD` in UTC. */
function utcDateStamp(ts: number): string {
	const d = new Date(ts);
	const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
	const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
	const dd = d.getUTCDate().toString().padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function resolveDefaultDir(): string {
	// Lazily attempt to locate Electron's userData path. In non-Electron
	// environments (unit tests, dev scripts without Electron bootstrap) the
	// require throws — callers must pass `dir` explicitly.
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const electron = require("electron") as {
			app?: { getPath(n: string): string };
		};
		if (electron?.app?.getPath) {
			return path.join(electron.app.getPath("userData"), "agent-browser/audit");
		}
	} catch {
		// fallthrough
	}
	throw new Error(
		"AuditLog: no `dir` supplied and Electron userData path unavailable. " +
			"Pass `new AuditLog({ dir })` explicitly.",
	);
}

/**
 * SQLite-backed query index for audit events. Shape kept internal to this
 * module so the outer AuditLog surface stays unchanged.
 */
class AuditIndex {
	private readonly db: BetterSqliteDb;
	private readonly insertEvent: import("better-sqlite3").Statement<
		[number, string, string | null, string]
	>;
	private readonly upsertTaskStart: import("better-sqlite3").Statement;
	private readonly updateTaskEnd: import("better-sqlite3").Statement;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				event TEXT NOT NULL,
				task_id TEXT,
				payload TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
			CREATE INDEX IF NOT EXISTS events_task ON events(task_id, ts);
			CREATE TABLE IF NOT EXISTS tasks (
				task_id TEXT PRIMARY KEY,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				persona TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'running'
			);
			CREATE INDEX IF NOT EXISTS tasks_started ON tasks(started_at DESC);
		`);
		this.insertEvent = this.db.prepare(
			"INSERT INTO events (ts, event, task_id, payload) VALUES (?, ?, ?, ?)",
		);
		this.upsertTaskStart = this.db.prepare(
			`INSERT INTO tasks (task_id, started_at, persona, status)
			 VALUES (?, ?, ?, 'running')
			 ON CONFLICT(task_id) DO UPDATE SET
			   started_at = excluded.started_at,
			   persona = excluded.persona`,
		);
		this.updateTaskEnd = this.db.prepare(
			`INSERT INTO tasks (task_id, started_at, ended_at, status)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(task_id) DO UPDATE SET
			   ended_at = excluded.ended_at,
			   status = excluded.status`,
		);
	}

	recordEvent(event: AuditEvent): void {
		const taskId =
			"task_id" in event && typeof event.task_id === "string"
				? event.task_id
				: null;
		this.insertEvent.run(event.ts, event.event, taskId, JSON.stringify(event));
		if (event.event === "task.start") {
			this.upsertTaskStart.run(event.task_id, event.ts, event.persona);
		} else if (event.event === "task.end") {
			this.updateTaskEnd.run(event.task_id, event.ts, event.ts, event.status);
		}
	}

	count(): number {
		const r = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
			n: number;
		};
		return r.n;
	}

	list(opts: {
		taskId?: string;
		since?: number;
		limit: number;
		offset: number;
	}): AuditEvent[] {
		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (opts.taskId !== undefined) {
			clauses.push("task_id = ?");
			params.push(opts.taskId);
		}
		if (opts.since !== undefined) {
			clauses.push("ts >= ?");
			params.push(opts.since);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.db
			.prepare(
				`SELECT payload FROM events ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.all(...params, opts.limit, opts.offset) as Array<{ payload: string }>;
		return rows
			.map((r) => {
				try {
					return JSON.parse(r.payload) as AuditEvent;
				} catch {
					return null;
				}
			})
			.filter((e): e is AuditEvent => e !== null);
	}

	listTasks(limit: number): TaskTraceSummary[] {
		const rows = this.db
			.prepare(
				`SELECT task_id, started_at, ended_at, persona, status
				 FROM tasks ORDER BY started_at DESC LIMIT ?`,
			)
			.all(limit) as Array<{
			task_id: string;
			started_at: number;
			ended_at: number | null;
			persona: string;
			status: string;
		}>;
		return rows.map((r) => ({
			task_id: r.task_id,
			started_at: r.started_at,
			ended_at: r.ended_at ?? undefined,
			persona: r.persona,
			status: r.status as TaskTraceSummary["status"],
		}));
	}

	clear(): void {
		this.db.exec("DELETE FROM events; DELETE FROM tasks;");
	}

	close(): void {
		this.db.close();
	}
}

export class AuditLog {
	private readonly dir: string;
	private readonly now: () => number;
	private currentDate: string | null = null;
	private stream: WriteStream | null = null;
	private closed = false;
	/** Mutex: sequential promise chain so `append()` order == call order. */
	private writeChain: Promise<void> = Promise.resolve();
	private readonly index: AuditIndex;

	constructor(opts: AuditLogOptions = {}) {
		this.dir = opts.dir ?? resolveDefaultDir();
		this.now = opts.now ?? (() => Date.now());
		if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
		const dbPath = opts.dbPath ?? path.join(this.dir, "events.sqlite");
		this.index = new AuditIndex(dbPath);
		// First-boot migration: if the SQLite index is empty but jsonl files
		// exist, replay the jsonl into the index so prior events stay queryable.
		if (this.index.count() === 0) this.backfillFromJsonl();
	}

	private backfillFromJsonl(): void {
		if (!existsSync(this.dir)) return;
		const files = readdirSync(this.dir)
			.filter((n) => /^(\d{4}-\d{2}-\d{2})\.jsonl$/.test(n))
			.sort();
		for (const name of files) {
			const full = path.join(this.dir, name);
			let content: string;
			try {
				content = readFileSync(full, "utf8");
			} catch {
				continue;
			}
			for (const line of content.split("\n")) {
				if (!line) continue;
				try {
					const ev = JSON.parse(line) as AuditEvent;
					this.index.recordEvent(ev);
				} catch {
					// skip malformed line
				}
			}
		}
	}

	/** Append one event as a JSONL line. Rotates file lazily if UTC day changed. */
	append(event: AuditEvent): Promise<void> {
		if (this.closed) {
			return Promise.reject(new Error("AuditLog: closed"));
		}
		// Chain writes so order is preserved across concurrent appends.
		const p = this.writeChain.then(() => this.#doAppend(event));
		// Swallow errors on the chain so one failed write doesn't poison further writes.
		this.writeChain = p.catch(() => undefined);
		return p;
	}

	async #doAppend(event: AuditEvent): Promise<void> {
		if (this.closed) throw new Error("AuditLog: closed");
		// Index first (synchronous, in-proc): if the jsonl write fails after
		// this we still have a queryable record, and the jsonl can be
		// reconstructed from SQLite if needed.
		try {
			this.index.recordEvent(event);
		} catch (err) {
			console.warn("[audit-log] index insert failed:", err);
		}
		const dateStamp = utcDateStamp(this.now());
		if (dateStamp !== this.currentDate || !this.stream) {
			await this.#openStreamForDate(dateStamp);
		}
		const line = `${JSON.stringify(event)}\n`;
		const stream = this.stream;
		if (!stream) throw new Error("AuditLog: stream not open");
		await new Promise<void>((resolve, reject) => {
			stream.write(line, (err) => (err ? reject(err) : resolve()));
		});
	}

	/** Force a rotation check — opens a new writer if the UTC day changed. */
	async rotate(): Promise<void> {
		if (this.closed) throw new Error("AuditLog: closed");
		const dateStamp = utcDateStamp(this.now());
		if (dateStamp !== this.currentDate) {
			await this.#openStreamForDate(dateStamp);
		}
	}

	async #openStreamForDate(dateStamp: string): Promise<void> {
		if (this.stream) {
			const old = this.stream;
			this.stream = null;
			await new Promise<void>((resolve) => old.end(() => resolve()));
		}
		const file = path.join(this.dir, `${dateStamp}.jsonl`);
		this.stream = createWriteStream(file, { flags: "a", encoding: "utf8" });
		this.currentDate = dateStamp;
	}

	/**
	 * Archive files older than `days` (UTC). For Stage 6.4 we only enumerate
	 * candidates — actual zstd compression + move-to-archive/ is deferred
	 * (avoids pulling a compression dep mid-stage).
	 *
	 * TODO(Stage 6.4-hardening): compress `{dir}/{YYYY-MM}-*.jsonl` into
	 * `{dir}/archive/YYYY-MM.jsonl.zst` and delete originals.
	 */
	async archiveOlderThan(days = 90): Promise<string[]> {
		if (this.closed) throw new Error("AuditLog: closed");
		const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
		const cutoffStamp = utcDateStamp(cutoff);
		const candidates: string[] = [];
		if (!existsSync(this.dir)) return candidates;
		for (const name of readdirSync(this.dir)) {
			const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
			if (!m) continue;
			const stamp = m[1] as string;
			if (stamp < cutoffStamp) {
				candidates.push(path.join(this.dir, name));
			}
		}
		return candidates;
	}

	/** Await any pending writes and close the active stream + index db. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.writeChain;
		} catch {
			// swallow; we're closing anyway
		}
		if (this.stream) {
			const s = this.stream;
			this.stream = null;
			await new Promise<void>((resolve) => s.end(() => resolve()));
		}
		try {
			this.index.close();
		} catch {
			// idempotent close; db already gone is fine
		}
	}

	/** Currently-open jsonl file path, or `null` if no writes yet. */
	get activeFile(): string | null {
		return this.currentDate
			? path.join(this.dir, `${this.currentDate}.jsonl`)
			: null;
	}

	list(opts: ListOptions = {}): AuditEvent[] {
		const { taskId, since, limit = 500, offset = 0 } = opts;
		return this.index.list({ taskId, since, limit, offset });
	}

	listTasks(limit = 50): TaskTraceSummary[] {
		return this.index.listTasks(limit);
	}

	async clear(): Promise<void> {
		if (this.stream) {
			const old = this.stream;
			this.stream = null;
			await new Promise<void>((resolve) => old.end(() => resolve()));
		}
		this.currentDate = null;
		this.index.clear();
		if (!existsSync(this.dir)) return;
		for (const name of readdirSync(this.dir)) {
			if (!/^(\d{4}-\d{2}-\d{2})\.jsonl$/.test(name)) continue;
			try {
				unlinkSync(path.join(this.dir, name));
			} catch {
				// ignore
			}
		}
	}
}

export interface ListOptions {
	taskId?: string;
	limit?: number;
	offset?: number;
	since?: number;
}

export interface TaskTraceSummary {
	task_id: string;
	started_at: number;
	ended_at?: number;
	status: "running" | "completed" | "failed" | "killed" | "budget_exceeded";
	persona: string;
}

// ---------------------------------------------------------------------------
// installAuditHooks — wires an AgentHost-like hook registrar into AuditLog
// ---------------------------------------------------------------------------

/**
 * Minimal shape AuditLog cares about. Stage 3's AgentHost provides a richer
 * surface — `installAuditHooks` only needs `on(hook, cb)` and accepts any
 * payload shape (it calls the dedicated summarize/hash helpers).
 */
export interface AuditHookHost {
	on(
		hook:
			| "pre-llm-call"
			| "post-llm-call"
			| "pre-tool-call"
			| "post-tool-call"
			| "task.start"
			| "task.end",
		cb: (payload: unknown) => void | Promise<void>,
	): void;
}

/**
 * Register audit hooks on an AgentHost-like emitter. The emitter is expected
 * to pass already-prepared event bodies (matching the AuditEvent discriminated
 * union); this helper only fills in `ts` if missing and forwards to `append`.
 *
 * Stage 3 owns the actual transformation from raw hook payloads to AuditEvents
 * (e.g. extracting model/provider/redaction_hits from the LLM request). This
 * keeps audit-log.ts decoupled from AgentHost internals.
 */
export function installAuditHooks(host: AuditHookHost, log: AuditLog): void {
	const forward = (event: AuditEvent) => {
		const withTs =
			"ts" in event && event.ts ? event : { ...event, ts: Date.now() };
		// fire-and-forget: callers shouldn't block the step loop on disk I/O
		log.append(withTs as AuditEvent).catch(() => {
			// TODO: surface via console.error in Stage 3 once logger is in place
		});
	};
	host.on("pre-llm-call", (p) => forward(p as AuditEvent));
	host.on("post-llm-call", (p) => forward(p as AuditEvent));
	host.on("pre-tool-call", (p) => forward(p as AuditEvent));
	host.on("post-tool-call", (p) => forward(p as AuditEvent));
	host.on("task.start", (p) => forward(p as AuditEvent));
	host.on("task.end", (p) => forward(p as AuditEvent));
}
