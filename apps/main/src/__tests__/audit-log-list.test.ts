/**
 * AuditLog read-API tests — Stage 14 (trace viewer).
 *
 * Covers `list()`, `listTasks()`, and `clear()`. Uses injected clock to drive
 * ordering deterministically and a tmp dir to isolate state.
 */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type AuditEvent, AuditLog } from "../audit-log.js";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "audit-list-test-"));
});

async function seed(log: AuditLog, events: AuditEvent[]): Promise<void> {
	for (const e of events) await log.append(e);
}

function fakeClock(startMs: number): () => number {
	let t = startMs;
	return () => {
		const cur = t;
		t += 1000;
		return cur;
	};
}

describe("AuditLog.list / listTasks / clear", () => {
	it("lists events newest-first and filters by task_id", async () => {
		const log = new AuditLog({ dir: tmp, now: fakeClock(1_700_000_000_000) });
		await seed(log, [
			{
				event: "task.start",
				ts: 1_700_000_000_000,
				task_id: "t1",
				user_prompt_hash: "h1",
				persona: "default",
				tab_url: "https://a.com",
			},
			{
				event: "task.start",
				ts: 1_700_000_001_000,
				task_id: "t2",
				user_prompt_hash: "h2",
				persona: "coder",
				tab_url: "https://b.com",
			},
			{
				event: "tool.call",
				ts: 1_700_000_002_000,
				task_id: "t1",
				tool: "snapshot",
				args_hash: "x",
				result_ref: null,
				byte_size: 10,
				high_risk_flags: [],
			},
			{
				event: "task.end",
				ts: 1_700_000_003_000,
				task_id: "t1",
				status: "completed",
				steps: 1,
				total_usd: 0.01,
				total_tokens: 100,
			},
		]);
		await log.close();

		const log2 = new AuditLog({ dir: tmp });
		const all = log2.list();
		// newest-first
		expect(all[0]?.event).toBe("task.end");
		expect(all[all.length - 1]?.event).toBe("task.start");

		const forT1 = log2.list({ taskId: "t1" });
		expect(forT1.length).toBe(3);
		expect(forT1.every((e) => "task_id" in e && e.task_id === "t1")).toBe(true);

		const forT2 = log2.list({ taskId: "t2" });
		expect(forT2.length).toBe(1);
		expect(forT2[0]?.event).toBe("task.start");
	});

	it("respects limit + offset", async () => {
		const log = new AuditLog({ dir: tmp, now: fakeClock(1_700_000_000_000) });
		const evts: AuditEvent[] = [];
		for (let i = 0; i < 5; i++) {
			evts.push({
				event: "task.state-change",
				ts: 1_700_000_000_000 + i,
				task_id: "t",
				from: "a",
				to: `s${i}`,
			});
		}
		await seed(log, evts);
		await log.close();

		const log2 = new AuditLog({ dir: tmp });
		const page1 = log2.list({ limit: 2 });
		const page2 = log2.list({ limit: 2, offset: 2 });
		expect(page1.length).toBe(2);
		expect(page2.length).toBe(2);
		// newest first: page1 should contain to=s4,s3; page2 s2,s1
		expect((page1[0] as { to: string }).to).toBe("s4");
		expect((page2[0] as { to: string }).to).toBe("s2");
	});

	it("aggregates task.start + task.end into summaries", async () => {
		const log = new AuditLog({ dir: tmp, now: fakeClock(1_700_000_000_000) });
		await seed(log, [
			{
				event: "task.start",
				ts: 1_700_000_000_000,
				task_id: "t1",
				user_prompt_hash: "h1",
				persona: "default",
				tab_url: "https://a.com",
			},
			{
				event: "task.start",
				ts: 1_700_000_005_000,
				task_id: "t2",
				user_prompt_hash: "h2",
				persona: "coder",
				tab_url: "https://b.com",
			},
			{
				event: "task.end",
				ts: 1_700_000_006_000,
				task_id: "t2",
				status: "failed",
				steps: 2,
				total_usd: 0,
				total_tokens: 0,
			},
		]);
		await log.close();

		const log2 = new AuditLog({ dir: tmp });
		const tasks = log2.listTasks();
		expect(tasks.length).toBe(2);
		// Newest started_at first.
		expect(tasks[0]?.task_id).toBe("t2");
		expect(tasks[0]?.status).toBe("failed");
		expect(tasks[0]?.ended_at).toBe(1_700_000_006_000);
		expect(tasks[1]?.task_id).toBe("t1");
		// t1 had no task.end yet → still running
		expect(tasks[1]?.status).toBe("running");
		expect(tasks[1]?.ended_at).toBeUndefined();
	});

	it("listTasks truncates to limit", async () => {
		const log = new AuditLog({ dir: tmp, now: fakeClock(1_700_000_000_000) });
		const evts: AuditEvent[] = [];
		for (let i = 0; i < 10; i++) {
			evts.push({
				event: "task.start",
				ts: 1_700_000_000_000 + i * 1000,
				task_id: `t${i}`,
				user_prompt_hash: "h",
				persona: "p",
				tab_url: "https://x",
			});
		}
		await seed(log, evts);
		await log.close();

		const log2 = new AuditLog({ dir: tmp });
		const tasks = log2.listTasks(3);
		expect(tasks.length).toBe(3);
		// Newest first (t9, t8, t7)
		expect(tasks.map((t) => t.task_id)).toEqual(["t9", "t8", "t7"]);
	});

	it("clear removes all jsonl files and allows subsequent appends", async () => {
		const log = new AuditLog({ dir: tmp, now: fakeClock(1_700_000_000_000) });
		await log.append({
			event: "task.start",
			ts: 1_700_000_000_000,
			task_id: "t1",
			user_prompt_hash: "h",
			persona: "p",
			tab_url: "https://x",
		});
		expect(readdirSync(tmp).filter((n) => n.endsWith(".jsonl")).length).toBe(1);

		await log.clear();
		expect(readdirSync(tmp).filter((n) => n.endsWith(".jsonl")).length).toBe(0);
		expect(log.list()).toEqual([]);
		expect(log.listTasks()).toEqual([]);

		// still usable after clear
		await log.append({
			event: "task.start",
			ts: 1_700_000_010_000,
			task_id: "t2",
			user_prompt_hash: "h",
			persona: "p",
			tab_url: "https://y",
		});
		await log.close();

		expect(existsSync(tmp)).toBe(true);
		const log2 = new AuditLog({ dir: tmp });
		const after = log2.list();
		expect(after.length).toBe(1);
		expect(after[0]?.event).toBe("task.start");
		if (after[0]?.event === "task.start") {
			expect(after[0].task_id).toBe("t2");
		}
	});

	it("backfills the SQLite index from pre-existing jsonl on first boot", async () => {
		// Simulate an older install: only jsonl files exist, no events.sqlite.
		const fs = await import("node:fs");
		const day = "2026-04-23";
		const jsonl = [
			'{"event":"task.start","ts":1700000000000,"task_id":"t1","user_prompt_hash":"h","persona":"p","tab_url":"https://a"}',
			'{"event":"task.end","ts":1700000005000,"task_id":"t1","status":"completed","steps":3,"total_usd":0.01,"total_tokens":100}',
		].join("\n");
		fs.writeFileSync(path.join(tmp, `${day}.jsonl`), `${jsonl}\n`);

		// Fresh AuditLog — index is empty, so constructor replays the jsonl.
		const log = new AuditLog({ dir: tmp });
		const events = log.list();
		expect(events.map((e) => e.event)).toEqual(["task.end", "task.start"]);
		const tasks = log.listTasks();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.status).toBe("completed");
		expect(tasks[0]?.ended_at).toBe(1_700_000_005_000);
	});

	it("list() honors limit/offset via SQL pagination", async () => {
		const log = new AuditLog({
			dir: tmp,
			now: fakeClock(1_700_000_000_000),
			dbPath: ":memory:",
		});
		for (let i = 0; i < 10; i++) {
			await log.append({
				event: "task.state-change",
				ts: 1_700_000_000_000 + i * 1000,
				task_id: `t${i}`,
				from: "pending",
				to: "running",
			});
		}
		expect(
			log.list({ limit: 3 }).map((e) => (e as { task_id: string }).task_id),
		).toEqual(["t9", "t8", "t7"]);
		expect(
			log
				.list({ limit: 3, offset: 3 })
				.map((e) => (e as { task_id: string }).task_id),
		).toEqual(["t6", "t5", "t4"]);
	});
});
