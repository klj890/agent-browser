/**
 * AuditLog unit tests — Stage 6.4.
 */
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type AuditEvent,
	type AuditHookHost,
	AuditLog,
	hashPayload,
	installAuditHooks,
	stableStringify,
	summarizeInput,
	summarizeOutput,
} from "../audit-log.js";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "audit-log-test-"));
});

function readLines(file: string): AuditEvent[] {
	const content = readFileSync(file, "utf8").trim();
	if (!content) return [];
	return content.split("\n").map((l) => JSON.parse(l) as AuditEvent);
}

function sample(event: AuditEvent["event"], taskId = "t1"): AuditEvent {
	const ts = 0; // overridden by event body below
	switch (event) {
		case "llm.call.pre":
			return {
				event,
				ts,
				task_id: taskId,
				model: "claude-sonnet",
				provider: "anthropic",
				input_tokens_est: 100,
				redaction_hits: { cookie: 1 },
				persona: "default",
				autonomy: "confirm-each",
			};
		case "llm.call.post":
			return {
				event,
				ts,
				task_id: taskId,
				model: "claude-sonnet",
				input_tokens: 100,
				output_tokens: 50,
				usd_cost: 0.001,
				finish_reason: "end_turn",
				duration_ms: 420,
			};
		case "tool.call":
			return {
				event,
				ts,
				task_id: taskId,
				tool: "snapshot",
				args_hash: "abc",
				result_ref: "ref-1",
				byte_size: 123,
				high_risk_flags: [],
			};
		case "tool.confirm":
			return {
				event,
				ts,
				task_id: taskId,
				tool: "act",
				decision: "approved",
				latency_ms: 42,
			};
		case "task.start":
			return {
				event,
				ts,
				task_id: taskId,
				user_prompt_hash: "h",
				persona: "default",
				tab_url: "https://example.com",
			};
		case "task.end":
			return {
				event,
				ts,
				task_id: taskId,
				status: "completed",
				steps: 3,
				total_usd: 0.01,
				total_tokens: 500,
			};
		case "task.state-change":
			return { event, ts, task_id: taskId, from: "pending", to: "running" };
		case "policy.change":
			return {
				event,
				ts,
				actor: "admin",
				diff: { maxSteps: [10, 20] },
				prev_hash: "p",
				new_hash: "n",
			};
		case "injection.flag":
			return {
				event,
				ts,
				task_id: taskId,
				source_url: "https://evil.com",
				pattern: "ignore-instructions",
				snippet_hash: "s",
			};
		case "soul.amend":
			return {
				event,
				ts,
				task_id: taskId,
				section: "Hard boundaries",
				bullet_excerpt: "never email without consent",
				before_hash: "b".repeat(64),
				after_hash: "a".repeat(64),
				byte_size: 1234,
				created_section: false,
			};
	}
}

describe("AuditLog — event appending", () => {
	it("appends all 10 event types and every line round-trips as JSON", async () => {
		const log = new AuditLog({
			dir: tmp,
			now: () => Date.UTC(2026, 3, 18, 12),
		});
		const events: AuditEvent["event"][] = [
			"llm.call.pre",
			"llm.call.post",
			"tool.call",
			"tool.confirm",
			"task.start",
			"task.end",
			"task.state-change",
			"policy.change",
			"injection.flag",
			"soul.amend",
		];
		for (const e of events) {
			await log.append(sample(e));
		}
		await log.close();
		const file = path.join(tmp, "2026-04-18.jsonl");
		const lines = readLines(file);
		expect(lines).toHaveLength(events.length);
		expect(lines.map((l) => l.event)).toEqual(events);
	});
});

describe("AuditLog — rotation", () => {
	it("writes to today's UTC date file", async () => {
		const ts = Date.UTC(2026, 0, 5, 3, 0);
		const log = new AuditLog({ dir: tmp, now: () => ts });
		await log.append(sample("task.start"));
		await log.close();
		expect(readdirSync(tmp).filter((n) => n.endsWith(".jsonl"))).toEqual([
			"2026-01-05.jsonl",
		]);
	});

	it("rotates when UTC day advances across appends", async () => {
		let now = Date.UTC(2026, 0, 5, 23, 59, 30);
		const log = new AuditLog({ dir: tmp, now: () => now });
		await log.append(sample("task.start"));
		now = Date.UTC(2026, 0, 6, 0, 0, 30); // cross midnight UTC
		await log.append(sample("task.end"));
		await log.close();
		const files = readdirSync(tmp)
			.filter((n) => n.endsWith(".jsonl"))
			.sort();
		expect(files).toEqual(["2026-01-05.jsonl", "2026-01-06.jsonl"]);
		expect(readLines(path.join(tmp, "2026-01-05.jsonl"))).toHaveLength(1);
		expect(readLines(path.join(tmp, "2026-01-06.jsonl"))).toHaveLength(1);
	});

	it("rotate() eagerly opens the new file when day changed", async () => {
		let now = Date.UTC(2026, 0, 5, 23, 59, 30);
		const log = new AuditLog({ dir: tmp, now: () => now });
		await log.append(sample("task.start"));
		now = Date.UTC(2026, 0, 7, 0, 0, 0);
		await log.rotate();
		await log.append(sample("task.end"));
		await log.close();
		expect(
			readdirSync(tmp)
				.filter((n) => n.endsWith(".jsonl"))
				.sort(),
		).toEqual(["2026-01-05.jsonl", "2026-01-07.jsonl"]);
	});
});

describe("AuditLog — lifecycle", () => {
	it("close() causes subsequent append to reject", async () => {
		const log = new AuditLog({ dir: tmp });
		await log.append(sample("task.start"));
		await log.close();
		await expect(log.append(sample("task.end"))).rejects.toThrow(/closed/);
	});

	it("redaction_hits field round-trips unchanged", async () => {
		const log = new AuditLog({ dir: tmp, now: () => Date.UTC(2026, 3, 18) });
		const ev = sample("llm.call.pre");
		(ev as Extract<AuditEvent, { event: "llm.call.pre" }>).redaction_hits = {
			cookie: 2,
			jwt: 1,
			credit_card: 0,
		};
		await log.append(ev);
		await log.close();
		const [line] = readLines(path.join(tmp, "2026-04-18.jsonl"));
		expect(
			(line as Extract<AuditEvent, { event: "llm.call.pre" }>).redaction_hits,
		).toEqual({
			cookie: 2,
			jwt: 1,
			credit_card: 0,
		});
	});

	it("archiveOlderThan stub enumerates old files but does not throw", async () => {
		// Pre-seed files: two old, one current
		writeFileSync(path.join(tmp, "2020-01-01.jsonl"), "");
		writeFileSync(path.join(tmp, "2020-02-15.jsonl"), "");
		const now = Date.UTC(2026, 5, 1);
		writeFileSync(path.join(tmp, "2026-06-01.jsonl"), "");
		const log = new AuditLog({ dir: tmp, now: () => now });
		const archived = await log.archiveOlderThan(90);
		await log.close();
		expect(archived.sort()).toEqual(
			[
				path.join(tmp, "2020-01-01.jsonl"),
				path.join(tmp, "2020-02-15.jsonl"),
			].sort(),
		);
	});

	it("archiveOlderThan ignores non-jsonl files", async () => {
		writeFileSync(path.join(tmp, "2020-01-01.jsonl"), "");
		writeFileSync(path.join(tmp, "notes.txt"), "hi");
		writeFileSync(path.join(tmp, "archive"), "x");
		const log = new AuditLog({ dir: tmp, now: () => Date.UTC(2026, 0, 1) });
		const list = await log.archiveOlderThan(90);
		await log.close();
		expect(list).toEqual([path.join(tmp, "2020-01-01.jsonl")]);
	});

	it("concurrent appends serialize in call order (500 events)", async () => {
		const log = new AuditLog({ dir: tmp, now: () => Date.UTC(2026, 3, 18) });
		const N = 500;
		const jobs: Promise<void>[] = [];
		for (let i = 0; i < N; i++) {
			const ev = {
				event: "task.state-change",
				ts: i,
				task_id: `t${i}`,
				from: "a",
				to: "b",
			} satisfies AuditEvent;
			jobs.push(log.append(ev));
		}
		await Promise.all(jobs);
		await log.close();
		const lines = readLines(path.join(tmp, "2026-04-18.jsonl"));
		expect(lines).toHaveLength(N);
		// Each line intact & task_ids unique
		const ids = new Set(lines.map((l) => (l as { task_id: string }).task_id));
		expect(ids.size).toBe(N);
		// Ordering preserved (ts field)
		expect(lines.map((l) => (l as { ts: number }).ts)).toEqual(
			Array.from({ length: N }, (_, i) => i),
		);
	});
});

describe("hashPayload + stableStringify", () => {
	it("hashPayload is stable regardless of key order", () => {
		const a = { b: 1, a: 2, c: [1, 2, 3] };
		const b = { c: [1, 2, 3], a: 2, b: 1 };
		expect(hashPayload(a)).toBe(hashPayload(b));
	});

	it("hashPayload differs for different values", () => {
		expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
	});

	it("hashPayload handles nested objects stably", () => {
		const a = { outer: { y: 1, x: 2 }, tail: [3, { m: 1, l: 0 }] };
		const b = { tail: [3, { l: 0, m: 1 }], outer: { x: 2, y: 1 } };
		expect(hashPayload(a)).toBe(hashPayload(b));
	});

	it("stableStringify drops undefined values", () => {
		expect(stableStringify({ a: 1, b: undefined, c: 3 })).toBe(
			stableStringify({ a: 1, c: 3 }),
		);
	});
});

describe("summarizeInput / summarizeOutput", () => {
	it("truncates long strings to 200 chars", () => {
		const long = "x".repeat(500);
		const s = summarizeInput(long);
		expect(s.excerpt.length).toBe(200);
		expect(s.byte_size).toBeGreaterThanOrEqual(500);
	});

	it("short inputs are preserved verbatim", () => {
		const s = summarizeOutput("hi");
		expect(s.excerpt).toBe("hi");
	});

	it("hashes match hashPayload", () => {
		const obj = { foo: "bar", n: 1 };
		expect(summarizeInput(obj).hash).toBe(hashPayload(obj));
	});
});

describe("installAuditHooks", () => {
	it("registered hooks forward events to the log", async () => {
		const log = new AuditLog({ dir: tmp, now: () => Date.UTC(2026, 3, 18) });
		const handlers = new Map<string, (p: unknown) => void>();
		const host: AuditHookHost = {
			on(hook, cb) {
				handlers.set(hook, cb as (p: unknown) => void);
			},
		};
		installAuditHooks(host, log);

		handlers.get("task.start")?.(sample("task.start"));
		handlers.get("pre-llm-call")?.(sample("llm.call.pre"));
		handlers.get("post-tool-call")?.(sample("tool.call"));
		handlers.get("task.end")?.(sample("task.end"));

		// Allow fire-and-forget microtasks to flush
		await new Promise((r) => setTimeout(r, 20));
		await log.close();
		const lines = readLines(path.join(tmp, "2026-04-18.jsonl"));
		expect(lines.map((l) => l.event).sort()).toEqual(
			["task.start", "llm.call.pre", "tool.call", "task.end"].sort(),
		);
	});
});

describe("AuditLog — file structure sanity", () => {
	it("activeFile reflects currently-open jsonl after first append", async () => {
		const log = new AuditLog({ dir: tmp, now: () => Date.UTC(2026, 3, 18) });
		expect(log.activeFile).toBeNull();
		await log.append(sample("task.start"));
		expect(log.activeFile).toBe(path.join(tmp, "2026-04-18.jsonl"));
		await log.close();
	});

	it("file is valid line-delimited JSON (one line per append, no partial writes)", async () => {
		const log = new AuditLog({ dir: tmp, now: () => Date.UTC(2026, 3, 18) });
		for (let i = 0; i < 10; i++) await log.append(sample("tool.call", `t${i}`));
		await log.close();
		const file = path.join(tmp, "2026-04-18.jsonl");
		const size = statSync(file).size;
		const raw = readFileSync(file, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(size).toBe(Buffer.byteLength(raw, "utf8"));
		// Each non-empty line parses
		for (const line of raw.split("\n").filter(Boolean)) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});
});
