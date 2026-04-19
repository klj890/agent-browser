/**
 * TaskStateStore unit tests — Stage 7.1.
 */
import { describe, expect, it, vi } from "vitest";
import {
	InvalidTransitionError,
	isTerminalTaskStatus,
	type Task,
	TaskNotFoundError,
	TaskStateStore,
	type TaskStatus,
} from "../task-state.js";

function mkStore(): TaskStateStore {
	return new TaskStateStore();
}

const INIT = { prompt: "hello", persona: "default", tabId: "tab-1" };

describe("isTerminalTaskStatus", () => {
	it("classifies all six statuses correctly", () => {
		const map: Record<TaskStatus, boolean> = {
			pending: false,
			running: false,
			completed: true,
			failed: true,
			killed: true,
			budget_exceeded: true,
		};
		for (const [s, expected] of Object.entries(map)) {
			expect(isTerminalTaskStatus(s as TaskStatus)).toBe(expected);
		}
	});
});

describe("TaskStateStore.create", () => {
	it("creates a task with unique id and sensible defaults", () => {
		const s = mkStore();
		const a = s.create(INIT);
		const b = s.create(INIT);
		expect(a.id).not.toEqual(b.id);
		expect(a.status).toBe("pending");
		expect(a.step).toBe(0);
		expect(a.totalTokens).toBe(0);
		expect(a.totalUsd).toBe(0);
		expect(typeof a.createdAt).toBe("number");
		expect(a.abortController.signal.aborted).toBe(false);
	});

	it("100 concurrent creations keep state isolated", () => {
		const s = mkStore();
		const tasks: Task[] = [];
		for (let i = 0; i < 100; i++) {
			tasks.push(s.create({ ...INIT, tabId: `tab-${i}` }));
		}
		// transition every other task to running; mutate step for a few
		for (let i = 0; i < tasks.length; i++) {
			const t = tasks[i];
			if (!t) continue;
			if (i % 2 === 0) s.transition(t.id, "running");
			if (i % 10 === 0) s.update(t.id, { step: i });
		}
		const ids = new Set(tasks.map((t) => t.id));
		expect(ids.size).toBe(100);
		const t0 = tasks[0];
		const t1 = tasks[1];
		const t20 = tasks[20];
		if (!t0 || !t1 || !t20) throw new Error("unreachable");
		// Task 0 was transitioned + step updated
		expect(s.get(t0.id).status).toBe("running");
		expect(s.get(t0.id).step).toBe(0);
		// Task 1 was not transitioned
		expect(s.get(t1.id).status).toBe("pending");
		// Task 20 should have step=20
		expect(s.get(t20.id).step).toBe(20);
		expect(s.get(t20.id).status).toBe("running");
	});
});

describe("TaskStateStore.transition", () => {
	it("pending → running is legal", () => {
		const s = mkStore();
		const t = s.create(INIT);
		const t2 = s.transition(t.id, "running");
		expect(t2.status).toBe("running");
		expect(t2.updatedAt).toBeGreaterThanOrEqual(t.createdAt);
	});

	it("running → completed is legal", () => {
		const s = mkStore();
		const t = s.create(INIT);
		s.transition(t.id, "running");
		const t2 = s.transition(t.id, "completed");
		expect(t2.status).toBe("completed");
	});

	it("running → running is forbidden", () => {
		const s = mkStore();
		const t = s.create(INIT);
		s.transition(t.id, "running");
		expect(() => s.transition(t.id, "running")).toThrow(InvalidTransitionError);
	});

	it("completed → running throws InvalidTransitionError", () => {
		const s = mkStore();
		const t = s.create(INIT);
		s.transition(t.id, "running");
		s.transition(t.id, "completed");
		expect(() => s.transition(t.id, "running")).toThrow(InvalidTransitionError);
	});

	it("terminal → any is forbidden", () => {
		const s = mkStore();
		const t = s.create(INIT);
		s.transition(t.id, "running");
		s.transition(t.id, "killed");
		for (const next of [
			"running",
			"completed",
			"failed",
			"budget_exceeded",
			"killed",
		] as const) {
			expect(() => s.transition(t.id, next)).toThrow(InvalidTransitionError);
		}
	});

	it("pending → terminal short-circuit is allowed", () => {
		const s = mkStore();
		const t = s.create(INIT);
		const t2 = s.transition(t.id, "failed");
		expect(t2.status).toBe("failed");
	});

	it("transition on missing id throws TaskNotFoundError", () => {
		const s = mkStore();
		expect(() => s.transition("no-such-id", "running")).toThrow(
			TaskNotFoundError,
		);
	});
});

describe("TaskStateStore.abort", () => {
	it("fires AbortSignal and transitions to killed", () => {
		const s = mkStore();
		const t = s.create(INIT);
		s.transition(t.id, "running");
		expect(t.abortController.signal.aborted).toBe(false);
		s.abort(t.id);
		expect(t.abortController.signal.aborted).toBe(true);
		expect(s.get(t.id).status).toBe("killed");
	});

	it("abort on an already-terminal task is a no-op", () => {
		const s = mkStore();
		const t = s.create(INIT);
		s.transition(t.id, "running");
		s.transition(t.id, "completed");
		const statusBefore = t.status;
		s.abort(t.id); // should not throw, should not change status
		expect(s.get(t.id).status).toBe(statusBefore);
		// Abort controller was not fired (task completed naturally)
		expect(t.abortController.signal.aborted).toBe(false);
	});
});

describe("TaskStateStore.update", () => {
	it("accumulates step + tokens + usd", () => {
		const s = mkStore();
		const t = s.create(INIT);
		s.update(t.id, { step: 1 });
		s.update(t.id, { step: 2, totalTokens: 1500 });
		s.update(t.id, { totalUsd: 0.03 });
		const got = s.get(t.id);
		expect(got.step).toBe(2);
		expect(got.totalTokens).toBe(1500);
		expect(got.totalUsd).toBeCloseTo(0.03, 6);
	});
});

describe("TaskStateStore.listActive", () => {
	it("filters out terminal tasks", () => {
		const s = mkStore();
		const a = s.create(INIT);
		const b = s.create(INIT);
		const c = s.create(INIT);
		s.transition(b.id, "running");
		s.transition(c.id, "running");
		s.transition(c.id, "completed");
		const active = s
			.listActive()
			.map((t) => t.id)
			.sort();
		expect(active).toEqual([a.id, b.id].sort());
	});
});

describe("TaskStateStore.onChange", () => {
	it("notifies subscribers on create / transition / update / abort", () => {
		const s = mkStore();
		const cb = vi.fn();
		const unsub = s.onChange(cb);
		const t = s.create(INIT);
		s.transition(t.id, "running");
		s.update(t.id, { step: 1 });
		s.abort(t.id);
		// 4 events total: create, transition, update, abort
		expect(cb).toHaveBeenCalledTimes(4);
		unsub();
		s.create(INIT);
		// No further notifications after unsubscribe
		expect(cb).toHaveBeenCalledTimes(4);
	});

	it("listener exceptions do not break the store", () => {
		const s = mkStore();
		s.onChange(() => {
			throw new Error("boom");
		});
		// Should not throw
		expect(() => s.create(INIT)).not.toThrow();
	});
});
