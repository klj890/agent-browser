/**
 * Audit Log (Stage 6.4)
 *
 * JSONL-formatted audit log that records every gate/hook event in the agent
 * step loop. See PLAN.md 附录 I for the authoritative event schema and 附录 L
 * for the exact hook points. This module is intentionally independent of
 * AgentHost — Stage 3 will wire hooks in via `installAuditHooks`.
 *
 * Design:
 *   - One file per UTC day at `{dir}/YYYY-MM-DD.jsonl`.
 *   - Append-only; each event is a single line of JSON with a trailing `\n`.
 *   - Rotation is driven lazily on each `append()` (cheap UTC date check).
 *   - Concurrent appends are serialized via an internal promise chain so lines
 *     are never interleaved and order matches call order.
 *   - `close()` flushes and closes the active write stream; further `append`
 *     calls throw.
 *   - `archiveOlderThan(days)` is currently a stub (no zstd dep); it enumerates
 *     candidate files and leaves a TODO for Stage 6.4 hardening.
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
	type WriteStream,
	unlinkSync,
} from "node:fs";
import path from "node:path";

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

export type AuditEvent =
	| LlmCallPreEvent
	| LlmCallPostEvent
	| ToolCallEvent
	| ToolConfirmEvent
	| TaskStartEvent
	| TaskEndEvent
	| TaskStateChangeEvent
	| PolicyChangeEvent
	| InjectionFlagEvent;

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

export class AuditLog {
	private readonly dir: string;
	private readonly now: () => number;
	private currentDate: string | null = null;
	private stream: WriteStream | null = null;
	private closed = false;
	/** Mutex: sequential promise chain so `append()` order == call order. */
	private writeChain: Promise<void> = Promise.resolve();

	constructor(opts: AuditLogOptions = {}) {
		this.dir = opts.dir ?? resolveDefaultDir();
		this.now = opts.now ?? (() => Date.now());
		if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
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

	/** Await any pending writes and close the active stream. */
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
	}

	/** Currently-open jsonl file path, or `null` if no writes yet. */
	get activeFile(): string | null {
		return this.currentDate
			? path.join(this.dir, `${this.currentDate}.jsonl`)
			: null;
	}

	#readAllEvents(): AuditEvent[] {
		if (!existsSync(this.dir)) return [];
		const files = readdirSync(this.dir)
			.filter((n) => /^(\d{4}-\d{2}-\d{2})\.jsonl$/.test(n))
			.sort();
		const events: AuditEvent[] = [];
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
					events.push(JSON.parse(line) as AuditEvent);
				} catch {
					// skip malformed line
				}
			}
		}
		return events;
	}

	list(opts: ListOptions = {}): AuditEvent[] {
		const { taskId, since, limit = 500, offset = 0 } = opts;
		let events = this.#readAllEvents();
		if (taskId !== undefined) {
			events = events.filter((e) => "task_id" in e && e.task_id === taskId);
		}
		if (since !== undefined) {
			events = events.filter((e) => e.ts >= since);
		}
		events.reverse();
		return events.slice(offset, offset + limit);
	}

	listTasks(limit = 50): TaskTraceSummary[] {
		const events = this.#readAllEvents();
		const byId = new Map<string, TaskTraceSummary>();
		for (const e of events) {
			if (e.event === "task.start") {
				byId.set(e.task_id, {
					task_id: e.task_id,
					started_at: e.ts,
					persona: e.persona,
					status: "running",
				});
			} else if (e.event === "task.end") {
				const existing = byId.get(e.task_id);
				if (existing) {
					existing.ended_at = e.ts;
					existing.status = e.status;
				} else {
					byId.set(e.task_id, {
						task_id: e.task_id,
						started_at: e.ts,
						ended_at: e.ts,
						persona: "",
						status: e.status,
					});
				}
			}
		}
		const out = [...byId.values()].sort((a, b) => b.started_at - a.started_at);
		return out.slice(0, limit);
	}

	async clear(): Promise<void> {
		if (this.stream) {
			const old = this.stream;
			this.stream = null;
			await new Promise<void>((resolve) => old.end(() => resolve()));
		}
		this.currentDate = null;
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
