/**
 * RoutinesEngine unit tests — Stage 10.
 *
 * We inject a fake `cronImpl` so tests don't actually schedule real timers.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseRoutine,
	type Routine,
	type RoutineOrchestrator,
	RoutinesEngine,
	serializeRoutine,
} from "../routines.js";

interface FakeTask {
	started: boolean;
	stopped: boolean;
	fire: () => Promise<void>;
}

function makeCronImpl() {
	const scheduled: Array<{
		expr: string;
		fn: () => void | Promise<void>;
		task: FakeTask;
	}> = [];
	const validate = (expr: string) => /^[\d*/,\- ]+$/.test(expr);
	const schedule = (expr: string, fn: () => void | Promise<void>) => {
		const task: FakeTask = {
			started: false,
			stopped: false,
			fire: async () => {
				await fn();
			},
		};
		const api = {
			start: () => {
				task.started = true;
			},
			stop: () => {
				task.stopped = true;
				task.started = false;
			},
		};
		scheduled.push({ expr, fn, task });
		// node-cron's ScheduledTask is an opaque EventEmitter-like object; the
		// engine only uses .start/.stop.
		return api as unknown as import("node-cron").ScheduledTask;
	};
	return { scheduled, impl: { schedule, validate } };
}

function fakeOrch(): RoutineOrchestrator & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async startTask(prompt) {
			calls.push(prompt);
			return "task-id";
		},
	};
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "routines-test-"));
});

describe("parseRoutine", () => {
	it("parses a minimal routine", () => {
		const r = parseRoutine(
			[
				'name: "daily"',
				'schedule: "0 9 * * *"',
				"prompt: hello world",
				"enabled: true",
			].join("\n"),
		);
		expect(r).toMatchObject({
			name: "daily",
			schedule: "0 9 * * *",
			prompt: "hello world",
			enabled: true,
		});
	});

	it("parses block scalar prompt", () => {
		const r = parseRoutine(
			[
				'name: "multi"',
				'schedule: "* * * * *"',
				"prompt: |",
				"  line one",
				"  line two",
				"enabled: false",
			].join("\n"),
		);
		expect(r.prompt).toBe("line one\nline two");
		expect(r.enabled).toBe(false);
	});

	it("throws on missing required fields", () => {
		expect(() => parseRoutine("name: x\nenabled: true")).toThrow(
			/missing required/,
		);
	});
});

describe("serializeRoutine round-trip", () => {
	it("round-trips through parseRoutine", () => {
		const r: Routine = {
			name: "weekly-summary",
			description: "runs weekly",
			schedule: "0 9 * * MON",
			persona: "analyst",
			prompt: "Summarise the week.\nInclude key events.",
			enabled: true,
		};
		const yaml = serializeRoutine(r);
		const back = parseRoutine(yaml);
		expect(back).toMatchObject(r);
	});
});

describe("RoutinesEngine.load", () => {
	it("loads enabled + disabled routines but only schedules enabled ones on start()", async () => {
		writeFileSync(
			path.join(tmp, "a.yaml"),
			'name: "a"\nschedule: "* * * * *"\nprompt: A\nenabled: true\n',
		);
		writeFileSync(
			path.join(tmp, "b.yaml"),
			'name: "b"\nschedule: "* * * * *"\nprompt: B\nenabled: false\n',
		);
		const cron = makeCronImpl();
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: fakeOrch(),
			cronImpl: cron.impl,
		});
		await engine.load();
		expect(engine.list()).toHaveLength(2);
		engine.start();
		// only the enabled routine got scheduled
		expect(cron.scheduled).toHaveLength(1);
		expect(cron.scheduled[0]?.expr).toBe("* * * * *");
		const statuses = engine.list();
		const a = statuses.find((s) => s.name === "a");
		const b = statuses.find((s) => s.name === "b");
		expect(a?.scheduled).toBe(true);
		expect(b?.scheduled).toBe(false);
	});

	it("warns and skips yaml with parse errors", async () => {
		writeFileSync(
			path.join(tmp, "bad.yaml"),
			"this is : not : valid\nname: x\n",
		);
		writeFileSync(
			path.join(tmp, "good.yaml"),
			'name: "ok"\nschedule: "* * * * *"\nprompt: hi\nenabled: true\n',
		);
		const warn = vi.fn();
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: fakeOrch(),
			cronImpl: makeCronImpl().impl,
			logger: { warn, error: () => {} },
		});
		await engine.load();
		expect(engine.list().map((r) => r.name)).toEqual(["ok"]);
		expect(warn).toHaveBeenCalled();
		expect(engine.getParseErrors().length).toBeGreaterThanOrEqual(1);
	});

	it("warns and skips yaml with invalid cron expression", async () => {
		writeFileSync(
			path.join(tmp, "bad-cron.yaml"),
			'name: "bc"\nschedule: "not a cron"\nprompt: hi\nenabled: true\n',
		);
		const warn = vi.fn();
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: fakeOrch(),
			cronImpl: makeCronImpl().impl,
			logger: { warn, error: () => {} },
		});
		await engine.load();
		expect(engine.list()).toHaveLength(0);
		expect(warn).toHaveBeenCalled();
	});
});

describe("RoutinesEngine.runNow", () => {
	it("invokes orchestrator.startTask with the routine prompt (even when disabled)", async () => {
		writeFileSync(
			path.join(tmp, "r.yaml"),
			'name: "r"\nschedule: "* * * * *"\nprompt: "test prompt"\nenabled: false\n',
		);
		const orch = fakeOrch();
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await engine.runNow("r");
		expect(orch.calls).toEqual(["test prompt"]);
		const status = engine.list()[0];
		expect(status?.lastRunStatus).toBe("ok");
		expect(status?.lastRunAt).toBeTypeOf("number");
	});

	it("captures orchestrator errors on status", async () => {
		writeFileSync(
			path.join(tmp, "r.yaml"),
			'name: "r"\nschedule: "* * * * *"\nprompt: boom\nenabled: true\n',
		);
		const orch: RoutineOrchestrator = {
			startTask: async () => {
				throw new Error("nope");
			},
		};
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await expect(engine.runNow("r")).rejects.toThrow("nope");
		const s = engine.list()[0];
		expect(s?.lastRunStatus).toBe("error");
		expect(s?.lastRunError).toBe("nope");
	});

	it("throws for unknown routine", async () => {
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: fakeOrch(),
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await expect(engine.runNow("ghost")).rejects.toThrow(/no such routine/);
	});
});

describe("RoutinesEngine.start/stop", () => {
	it("start registers cron jobs and stop unregisters them", async () => {
		writeFileSync(
			path.join(tmp, "a.yaml"),
			'name: "a"\nschedule: "* * * * *"\nprompt: A\nenabled: true\n',
		);
		const cron = makeCronImpl();
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: fakeOrch(),
			cronImpl: cron.impl,
		});
		await engine.load();
		engine.start();
		expect(cron.scheduled).toHaveLength(1);
		expect((cron.scheduled[0]?.task as unknown as FakeTask).started).toBe(true);
		engine.stop();
		expect((cron.scheduled[0]?.task as unknown as FakeTask).stopped).toBe(true);
		const status = engine.list()[0];
		expect(status?.scheduled).toBe(false);
	});

	it("cron fire invokes orchestrator", async () => {
		writeFileSync(
			path.join(tmp, "a.yaml"),
			'name: "a"\nschedule: "* * * * *"\nprompt: "cron fired"\nenabled: true\n',
		);
		const cron = makeCronImpl();
		const orch = fakeOrch();
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: cron.impl,
		});
		await engine.load();
		engine.start();
		await cron.scheduled[0]?.fn();
		expect(orch.calls).toEqual(["cron fired"]);
	});
});

describe("RoutinesEngine.create/update/delete/setEnabled", () => {
	it("create writes yaml and appears in list", async () => {
		const cron = makeCronImpl();
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: fakeOrch(),
			cronImpl: cron.impl,
		});
		await engine.load();
		await engine.create({
			name: "new",
			schedule: "* * * * *",
			prompt: "yo",
			enabled: true,
		});
		const files = await readdir(tmp);
		expect(files).toContain("new.yaml");
		const content = await readFile(path.join(tmp, "new.yaml"), "utf8");
		expect(content).toMatch(/name: "new"/);
		expect(engine.list().map((r) => r.name)).toContain("new");
	});

	it("update rewrites yaml and reschedules", async () => {
		writeFileSync(
			path.join(tmp, "x.yaml"),
			'name: "x"\nschedule: "* * * * *"\nprompt: old\nenabled: true\n',
		);
		const cron = makeCronImpl();
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: fakeOrch(),
			cronImpl: cron.impl,
		});
		await engine.load();
		engine.start();
		await engine.update("x", {
			name: "x",
			schedule: "0 0 * * *",
			prompt: "new",
			enabled: true,
		});
		const content = await readFile(path.join(tmp, "x.yaml"), "utf8");
		expect(content).toMatch(/prompt: \|\n {2}new/);
		// original task stopped + new one scheduled
		expect(cron.scheduled.length).toBeGreaterThanOrEqual(2);
	});

	it("delete removes file and entry", async () => {
		writeFileSync(
			path.join(tmp, "gone.yaml"),
			'name: "gone"\nschedule: "* * * * *"\nprompt: bye\nenabled: true\n',
		);
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: fakeOrch(),
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await engine.remove("gone");
		expect(engine.list()).toHaveLength(0);
		const files = await readdir(tmp);
		expect(files).not.toContain("gone.yaml");
	});

	it("setEnabled toggles persisted flag", async () => {
		writeFileSync(
			path.join(tmp, "t.yaml"),
			'name: "t"\nschedule: "* * * * *"\nprompt: p\nenabled: true\n',
		);
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: fakeOrch(),
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await engine.setEnabled("t", false);
		const content = await readFile(path.join(tmp, "t.yaml"), "utf8");
		expect(content).toMatch(/enabled: false/);
		expect(engine.list()[0]?.enabled).toBe(false);
	});
});

describe("RoutinesEngine — stale timeout + run history (P2 §2.5)", () => {
	function makeCompletingOrch(opts: {
		endReason?: "completed" | "failed" | "killed";
		delayMs?: number;
		throwErr?: string;
	}) {
		const calls: Array<{ prompt: string; scheduled?: boolean }> = [];
		return {
			calls,
			async startTask(_prompt: string) {
				return "legacy-id";
			},
			async runToCompletion(
				prompt: string,
				o?: { signal?: AbortSignal; scheduledTask?: boolean },
			) {
				calls.push({ prompt, scheduled: o?.scheduledTask });
				if (opts.throwErr) throw new Error(opts.throwErr);
				// Honour abort: return `killed` immediately
				if (opts.delayMs && opts.delayMs > 0) {
					await new Promise<void>((resolve) => {
						const t = setTimeout(resolve, opts.delayMs);
						o?.signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(t);
								resolve();
							},
							{ once: true },
						);
					});
					if (o?.signal?.aborted) {
						return {
							taskId: "t1",
							endReason: "killed" as const,
							durationMs: opts.delayMs,
						};
					}
				}
				return {
					taskId: "t1",
					endReason: opts.endReason ?? "completed",
					durationMs: opts.delayMs ?? 0,
				};
			},
		};
	}

	function seedRoutine(name = "r") {
		writeFileSync(
			path.join(tmp, `${name}.yaml`),
			`name: "${name}"\nschedule: "* * * * *"\nprompt: do-something\nenabled: true\n`,
		);
	}

	it("runToCompletion path records ok + scheduledTask flag on successful run", async () => {
		seedRoutine();
		const orch = makeCompletingOrch({ endReason: "completed" });
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await engine.runNow("r");
		expect(orch.calls[0]?.scheduled).toBe(true);
		const runs = engine.getRuns("r");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("ok");
		expect(runs[0]?.taskId).toBe("t1");
	});

	it("stale_timeout when orchestrator exceeds executionTimeoutMs — aborts via signal", async () => {
		seedRoutine();
		const orch = makeCompletingOrch({ delayMs: 5_000 });
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: makeCronImpl().impl,
			executionTimeoutMs: 30,
		});
		await engine.load();
		await engine.runNow("r");
		const runs = engine.getRuns("r");
		expect(runs[0]?.status).toBe("stale_timeout");
		expect(runs[0]?.error).toMatch(/exceeded/);
	});

	it("run history caps at 15 entries (oldest drops first)", async () => {
		seedRoutine();
		const orch = makeCompletingOrch({ endReason: "completed" });
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		for (let i = 0; i < 20; i++) {
			await engine.runNow("r");
		}
		const runs = engine.getRuns("r");
		expect(runs).toHaveLength(15);
		expect(engine.list()[0]?.runCount).toBe(15);
	});

	it("falls back to startTask when runToCompletion is not provided (legacy)", async () => {
		seedRoutine();
		const orch = fakeOrch();
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await engine.runNow("r");
		expect(orch.calls).toEqual(["do-something"]);
		const runs = engine.getRuns("r");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("ok");
	});

	it("run history survives reload() from disk", async () => {
		seedRoutine();
		const orch = makeCompletingOrch({ endReason: "completed" });
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await engine.runNow("r");
		await engine.runNow("r");
		expect(engine.getRuns("r")).toHaveLength(2);
		await engine.load(); // simulate user edits yaml on disk
		expect(engine.getRuns("r")).toHaveLength(2);
	});

	it("failed endReason records error status", async () => {
		seedRoutine();
		const orch = makeCompletingOrch({ endReason: "failed" });
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await engine.runNow("r");
		expect(engine.getRuns("r")[0]?.status).toBe("error");
	});

	it("orchestrator error message is surfaced into run history", async () => {
		seedRoutine();
		const orch: RoutineOrchestrator = {
			async startTask() {
				return "legacy";
			},
			async runToCompletion() {
				return {
					taskId: "t-fail",
					endReason: "failed",
					durationMs: 5,
					error: "rate_limit_exceeded",
				};
			},
		};
		const engine = new RoutinesEngine({
			dir: tmp,
			orchestrator: orch,
			cronImpl: makeCronImpl().impl,
		});
		await engine.load();
		await engine.runNow("r");
		const run = engine.getRuns("r")[0];
		expect(run?.status).toBe("error");
		expect(run?.error).toBe("rate_limit_exceeded");
	});
});
