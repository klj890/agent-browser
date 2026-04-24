/**
 * RoutinesEngine (Stage 10).
 *
 * Loads routine YAML files from a directory, schedules them via `node-cron`
 * and triggers them through the Agent orchestrator as headless tasks
 * (no renderer stream subscriber — chunks are discarded, audit-log still
 * records the task).
 *
 * YAML schema (one per `.routines/*.yaml`):
 *   name: string
 *   description?: string
 *   schedule: string      # cron expression
 *   persona?: string      # persona slug
 *   prompt: string
 *   enabled: boolean
 *
 * We intentionally re-implement (rather than depending on
 * `@cogni-refract/core`) because CogniRefract's engine is tightly coupled to
 * its own PersonaManager / Agent factory. The schema subset here is
 * deliberately small and lives in-tree so the main bundle stays
 * self-contained.
 */
import {
	mkdir,
	readdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import cron, { type ScheduledTask } from "node-cron";

export interface Routine {
	name: string;
	description?: string;
	schedule: string;
	persona?: string;
	prompt: string;
	enabled: boolean;
}

export type RoutineRunStatus = "ok" | "error" | "stale_timeout" | "aborted";

export interface RoutineRun {
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	status: RoutineRunStatus;
	error?: string;
	taskId?: string;
}

export interface RoutineStatus {
	name: string;
	description?: string;
	schedule: string;
	persona?: string;
	prompt: string;
	enabled: boolean;
	lastRunAt?: number;
	lastRunStatus?: RoutineRunStatus;
	lastRunError?: string;
	nextRunAt?: number; // best-effort; node-cron doesn't expose precise next-fire so left undefined
	scheduled: boolean;
	/** Count of entries retained in run history (capped by RUN_HISTORY_LIMIT). */
	runCount?: number;
}

export interface RoutineOrchestrator {
	startTask(prompt: string, target: (chunk: unknown) => void): Promise<string>;
	/**
	 * Optional: execute prompt and resolve only when the underlying task
	 * reaches a terminal state. Implementations should honour the AbortSignal
	 * to kill in-flight work on stale timeout. `scheduledTask` lets the
	 * orchestrator apply a restricted tool set — scheduled routines should
	 * not, for example, upload files or drive cross-origin navigation
	 * without an explicit user in the loop.
	 *
	 * Routines engine prefers this when present and falls back to
	 * `startTask` (fire-and-forget) otherwise. Falling back means the engine
	 * can only record "started" not "finished" — the run history entry's
	 * `status` will always be `ok` in that mode.
	 */
	runToCompletion?(
		prompt: string,
		opts?: { signal?: AbortSignal; scheduledTask?: boolean },
	): Promise<{
		taskId: string;
		endReason: "completed" | "failed" | "killed" | "budget_exceeded";
		durationMs: number;
		error?: string;
	}>;
}

const RUN_HISTORY_LIMIT = 15;
const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — matches BrowserOS

interface ParseError {
	file: string;
	error: string;
}

// ---------------------------------------------------------------------------
// Minimal YAML parser for the routine schema.
//
// Only supports the flat key: value form (plus the leaf types we need:
// string | boolean). Multi-line `>-` / `|` block scalars are supported for
// the `prompt` field since prompts tend to be long.
// ---------------------------------------------------------------------------

function stripQuotes(s: string): string {
	if (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	) {
		return s.slice(1, -1);
	}
	return s;
}

function parseScalar(raw: string): string | boolean {
	const v = raw.trim();
	if (v === "true") return true;
	if (v === "false") return false;
	return stripQuotes(v);
}

export class RoutineParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoutineParseError";
	}
}

export function parseRoutine(raw: string): Routine {
	const lines = raw.split(/\r?\n/);
	const obj: Record<string, string | boolean> = {};
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		i++;
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
		if (!m) continue;
		const key = m[1] as string;
		const rest = (m[2] ?? "").trim();
		if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
			// Block scalar: collect indented lines.
			const buf: string[] = [];
			while (i < lines.length) {
				const next = lines[i] ?? "";
				if (next.match(/^\S/) && next.trim() !== "") break;
				if (next.trim() === "" && i === lines.length - 1) {
					i++;
					break;
				}
				buf.push(next.replace(/^ {1,2}/, ""));
				i++;
			}
			obj[key] = buf.join(rest.startsWith(">") ? " " : "\n").trim();
		} else {
			obj[key] = parseScalar(rest);
		}
	}
	const name = obj.name;
	const schedule = obj.schedule;
	const prompt = obj.prompt;
	if (typeof name !== "string" || name === "") {
		throw new RoutineParseError("missing required field: name");
	}
	if (typeof schedule !== "string" || schedule === "") {
		throw new RoutineParseError("missing required field: schedule");
	}
	if (typeof prompt !== "string" || prompt === "") {
		throw new RoutineParseError("missing required field: prompt");
	}
	const out: Routine = {
		name,
		schedule,
		prompt,
		enabled: obj.enabled === true,
	};
	if (typeof obj.description === "string") out.description = obj.description;
	if (typeof obj.persona === "string") out.persona = obj.persona;
	return out;
}

export function serializeRoutine(r: Routine): string {
	const lines: string[] = [];
	lines.push(`name: ${JSON.stringify(r.name)}`);
	if (r.description !== undefined) {
		lines.push(`description: ${JSON.stringify(r.description)}`);
	}
	lines.push(`schedule: ${JSON.stringify(r.schedule)}`);
	if (r.persona !== undefined) {
		lines.push(`persona: ${JSON.stringify(r.persona)}`);
	}
	// prompt as block scalar for readability
	lines.push("prompt: |");
	for (const row of r.prompt.split(/\r?\n/)) lines.push(`  ${row}`);
	lines.push(`enabled: ${r.enabled ? "true" : "false"}`);
	return `${lines.join("\n")}\n`;
}

function safeFilename(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ---------------------------------------------------------------------------

export interface RoutinesEngineOptions {
	dir: string;
	orchestrator: RoutineOrchestrator;
	/** Optional logger — defaults to console. */
	logger?: { warn: (msg: string) => void; error: (msg: string) => void };
	/** Test hook: override node-cron. */
	cronImpl?: {
		schedule: (expr: string, fn: () => void | Promise<void>) => ScheduledTask;
		validate: (expr: string) => boolean;
	};
	/**
	 * Kill a running routine if it exceeds this duration; its run record is
	 * marked `stale_timeout`. Default 10 minutes; matches BrowserOS so a
	 * runaway Agent can't occupy resources for hours.
	 */
	executionTimeoutMs?: number;
	/** Injected clock — lets tests pin `startedAt` / `durationMs`. */
	now?: () => number;
}

interface Entry {
	routine: Routine;
	status: RoutineStatus;
	task?: ScheduledTask;
	runs: RoutineRun[];
}

export class RoutinesEngine {
	private readonly dir: string;
	private readonly orchestrator: RoutineOrchestrator;
	private readonly logger: {
		warn: (m: string) => void;
		error: (m: string) => void;
	};
	private readonly cronImpl: {
		schedule: (e: string, f: () => void | Promise<void>) => ScheduledTask;
		validate: (e: string) => boolean;
	};
	private readonly executionTimeoutMs: number;
	private readonly now: () => number;
	private entries: Map<string, Entry> = new Map();
	private parseErrors: ParseError[] = [];
	private running = false;

	constructor(opts: RoutinesEngineOptions) {
		this.dir = opts.dir;
		this.orchestrator = opts.orchestrator;
		this.logger = opts.logger ?? {
			warn: (m) => console.warn(`[routines] ${m}`),
			error: (m) => console.error(`[routines] ${m}`),
		};
		this.cronImpl = opts.cronImpl ?? {
			schedule: (e, f) => {
				const task = cron.schedule(e, f);
				task.stop();
				return task;
			},
			validate: (e) => cron.validate(e),
		};
		this.executionTimeoutMs =
			opts.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
		this.now = opts.now ?? Date.now;
	}

	/** Scan directory, parse yaml files, rebuild entry map. Does not start cron. */
	async load(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		this.parseErrors = [];
		const fresh = new Map<string, Entry>();
		let entries: string[] = [];
		try {
			const all = await readdir(this.dir);
			entries = all.filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"));
		} catch (err) {
			this.logger.warn(`readdir failed: ${(err as Error).message}`);
			return;
		}
		for (const file of entries) {
			const full = path.join(this.dir, file);
			try {
				const raw = await readFile(full, "utf8");
				const r = parseRoutine(raw);
				if (!this.cronImpl.validate(r.schedule)) {
					this.logger.warn(
						`${file}: invalid cron expression "${r.schedule}" — skipped`,
					);
					this.parseErrors.push({ file, error: "invalid cron" });
					continue;
				}
				if (fresh.has(r.name)) {
					this.logger.warn(
						`${file}: duplicate routine name "${r.name}" — skipped`,
					);
					this.parseErrors.push({ file, error: "duplicate name" });
					continue;
				}
				// Preserve in-memory run history across reload so UI state
				// doesn't reset when the user edits a YAML file on disk.
				const prior = this.entries.get(r.name);
				fresh.set(r.name, {
					routine: r,
					status: {
						name: r.name,
						description: r.description,
						schedule: r.schedule,
						persona: r.persona,
						prompt: r.prompt,
						enabled: r.enabled,
						scheduled: false,
						lastRunAt: prior?.status.lastRunAt,
						lastRunStatus: prior?.status.lastRunStatus,
						lastRunError: prior?.status.lastRunError,
						runCount: prior?.runs.length ?? 0,
					},
					runs: prior?.runs ?? [],
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.warn(`${file}: parse failed — ${msg}`);
				this.parseErrors.push({ file, error: msg });
			}
		}
		// Stop any cron jobs removed from disk.
		for (const [name, prev] of this.entries.entries()) {
			if (!fresh.has(name)) prev.task?.stop();
		}
		this.entries = fresh;
	}

	/** Schedule cron jobs for every enabled routine. */
	start(): void {
		this.running = true;
		for (const entry of this.entries.values()) {
			this.scheduleEntry(entry);
		}
	}

	/** Stop every scheduled cron job. */
	stop(): void {
		this.running = false;
		for (const entry of this.entries.values()) {
			if (entry.task) {
				entry.task.stop();
				entry.task = undefined;
				entry.status.scheduled = false;
			}
		}
	}

	private scheduleEntry(entry: Entry): void {
		if (!entry.routine.enabled) return;
		if (entry.task) {
			entry.task.stop();
			entry.task = undefined;
		}
		try {
			const task = this.cronImpl.schedule(entry.routine.schedule, async () => {
				await this.execute(entry).catch(() => {
					// execute() already records error on status; swallow so cron
					// loop doesn't crash the process.
				});
			});
			task.start();
			entry.task = task;
			entry.status.scheduled = true;
		} catch (err) {
			this.logger.error(
				`schedule failed for ${entry.routine.name}: ${(err as Error).message}`,
			);
			entry.status.scheduled = false;
		}
	}

	private async execute(entry: Entry): Promise<void> {
		const discard = (_chunk: unknown) => {
			/* headless — renderer has no subscription */
		};
		const startedAt = this.now();
		const run: RoutineRun = {
			startedAt,
			finishedAt: startedAt,
			durationMs: 0,
			status: "ok",
		};
		const record = (patch: Partial<RoutineRun>): void => {
			Object.assign(run, patch);
			run.finishedAt = this.now();
			run.durationMs = run.finishedAt - startedAt;
			entry.status.lastRunAt = run.finishedAt;
			entry.status.lastRunStatus = run.status;
			entry.status.lastRunError = run.error;
			// Push + cap. We append then shift rather than unshift so the
			// array stays in chronological order (oldest → newest) and the
			// UI can reverse for display. Cap constant intentionally small
			// since history lives in memory only.
			entry.runs.push(run);
			if (entry.runs.length > RUN_HISTORY_LIMIT) {
				entry.runs.splice(0, entry.runs.length - RUN_HISTORY_LIMIT);
			}
			entry.status.runCount = entry.runs.length;
		};

		const runner = this.orchestrator.runToCompletion;
		if (!runner) {
			// Legacy fire-and-forget path: the engine only knows the task
			// started, not whether it finished. Record 'ok' optimistically;
			// timeout/abort detection is impossible without runToCompletion.
			try {
				const taskId = await this.orchestrator.startTask(
					entry.routine.prompt,
					discard,
				);
				record({ status: "ok", taskId });
			} catch (err) {
				record({
					status: "error",
					error: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}
			return;
		}

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.executionTimeoutMs);
		let timedOut = false;
		ac.signal.addEventListener(
			"abort",
			() => {
				timedOut = true;
			},
			{ once: true },
		);
		try {
			const res = await runner.call(this.orchestrator, entry.routine.prompt, {
				signal: ac.signal,
				scheduledTask: true,
			});
			if (res.endReason === "completed") {
				record({ status: "ok", taskId: res.taskId });
			} else if (res.endReason === "killed" && timedOut) {
				record({
					status: "stale_timeout",
					error: `exceeded ${this.executionTimeoutMs}ms`,
					taskId: res.taskId,
				});
			} else if (res.endReason === "killed") {
				record({ status: "aborted", taskId: res.taskId });
			} else {
				record({
					status: "error",
					error: res.error ?? res.endReason,
					taskId: res.taskId,
				});
			}
		} catch (err) {
			if (timedOut) {
				record({
					status: "stale_timeout",
					error: `exceeded ${this.executionTimeoutMs}ms`,
				});
			} else {
				record({
					status: "error",
					error: err instanceof Error ? err.message : String(err),
				});
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Manually trigger a routine by name. Bypasses `enabled`. */
	async runNow(name: string): Promise<void> {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`no such routine: ${name}`);
		await this.execute(entry);
	}

	list(): RoutineStatus[] {
		return Array.from(this.entries.values()).map((e) => ({
			...e.status,
			runCount: e.runs.length,
		}));
	}

	/** Return parse errors from the most recent load() — useful for UI hints. */
	getParseErrors(): ParseError[] {
		return [...this.parseErrors];
	}

	/** Recent runs for a routine, newest last. Returns `[]` for unknown name. */
	getRuns(name: string, limit?: number): RoutineRun[] {
		const entry = this.entries.get(name);
		if (!entry) return [];
		const out = entry.runs.slice();
		if (limit != null && limit >= 0 && out.length > limit) {
			return out.slice(out.length - limit);
		}
		return out;
	}

	/** Create a routine (writes `<name>.yaml`, reloads cron for it). */
	async create(routine: Routine): Promise<RoutineStatus> {
		if (this.entries.has(routine.name)) {
			throw new Error(`routine already exists: ${routine.name}`);
		}
		if (!this.cronImpl.validate(routine.schedule)) {
			throw new Error(`invalid cron expression: ${routine.schedule}`);
		}
		const file = path.join(this.dir, `${safeFilename(routine.name)}.yaml`);
		await mkdir(this.dir, { recursive: true });
		await writeFile(file, serializeRoutine(routine), "utf8");
		const entry: Entry = {
			routine,
			status: {
				name: routine.name,
				description: routine.description,
				schedule: routine.schedule,
				persona: routine.persona,
				prompt: routine.prompt,
				enabled: routine.enabled,
				scheduled: false,
				runCount: 0,
			},
			runs: [],
		};
		this.entries.set(routine.name, entry);
		if (this.running) this.scheduleEntry(entry);
		return { ...entry.status };
	}

	/** Overwrite an existing routine. Re-schedules cron. */
	async update(name: string, next: Routine): Promise<RoutineStatus> {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`no such routine: ${name}`);
		if (!this.cronImpl.validate(next.schedule)) {
			throw new Error(`invalid cron expression: ${next.schedule}`);
		}
		entry.task?.stop();
		entry.task = undefined;
		entry.status.scheduled = false;
		if (name !== next.name) {
			// delete old file, write new one
			const oldFile = path.join(this.dir, `${safeFilename(name)}.yaml`);
			try {
				await unlink(oldFile);
			} catch {
				/* ok */
			}
			this.entries.delete(name);
			this.entries.set(next.name, entry);
		}
		entry.routine = next;
		entry.status = {
			name: next.name,
			description: next.description,
			schedule: next.schedule,
			persona: next.persona,
			prompt: next.prompt,
			enabled: next.enabled,
			scheduled: false,
			lastRunAt: entry.status.lastRunAt,
			lastRunStatus: entry.status.lastRunStatus,
			lastRunError: entry.status.lastRunError,
			runCount: entry.runs.length,
		};
		const file = path.join(this.dir, `${safeFilename(next.name)}.yaml`);
		await writeFile(file, serializeRoutine(next), "utf8");
		if (this.running) this.scheduleEntry(entry);
		return { ...entry.status };
	}

	/** Remove a routine: stop cron + delete file. */
	async remove(name: string): Promise<void> {
		const entry = this.entries.get(name);
		if (!entry) return;
		entry.task?.stop();
		this.entries.delete(name);
		const file = path.join(this.dir, `${safeFilename(name)}.yaml`);
		try {
			await stat(file);
			await unlink(file);
		} catch {
			/* file already gone */
		}
	}

	/** Toggle enabled flag (persists to disk). */
	async setEnabled(name: string, enabled: boolean): Promise<RoutineStatus> {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`no such routine: ${name}`);
		const next: Routine = { ...entry.routine, enabled };
		return this.update(name, next);
	}
}
