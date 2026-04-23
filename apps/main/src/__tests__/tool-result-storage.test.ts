/**
 * ToolResultStorage unit tests — Stage 6.5.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createReadResultSkill,
	installToolResultStorage,
	type ToolResultHookHost,
	ToolResultStorage,
} from "../tool-result-storage.js";

function makeStorage(
	opts: Partial<ConstructorParameters<typeof ToolResultStorage>[0]> = {},
) {
	return new ToolResultStorage({ dbPath: ":memory:", ...opts });
}

describe("ToolResultStorage — put / get basics", () => {
	it("small result (< threshold) returns refId=null and echoes result", () => {
		const s = makeStorage({ thresholdBytes: 4096 });
		const res = s.put("task1", "snapshot", { hello: "world" });
		expect(res.refId).toBeNull();
		expect(res.summary).toEqual({ hello: "world" });
		expect(res.byteSize).toBeGreaterThan(0);
		s.close();
	});

	it("large result is persisted, returns refId and truncated summary", () => {
		const s = makeStorage({ thresholdBytes: 100, summaryChars: 50 });
		const big = { data: "x".repeat(500) };
		const res = s.put("task1", "snapshot", big);
		expect(res.refId).toBeTruthy();
		expect(typeof res.summary).toBe("string");
		expect((res.summary as string).length).toBeLessThanOrEqual(51); // 50 + ellipsis
		expect(res.byteSize).toBeGreaterThan(100);
		s.close();
	});

	it("get() round-trips the full payload", () => {
		const s = makeStorage({ thresholdBytes: 10 });
		const payload = {
			a: 1,
			b: "some longer content here to exceed the threshold",
		};
		const res = s.put("task1", "read", payload);
		expect(res.refId).toBeTruthy();
		const round = s.get(res.refId as string);
		expect(round).toEqual(payload);
		s.close();
	});

	it("get() returns undefined for unknown refId", () => {
		const s = makeStorage();
		expect(s.get("does-not-exist")).toBeUndefined();
		s.close();
	});
});

describe("ToolResultStorage — listByTask", () => {
	it("lists only entries belonging to the given task, ordered by createdAt", () => {
		const s = makeStorage({ thresholdBytes: 10 });
		s.put("t1", "snapshot", { data: "x".repeat(100) });
		s.put("t2", "snapshot", { data: "y".repeat(100) });
		s.put("t1", "read", { data: "z".repeat(100) });
		const list = s.listByTask("t1");
		expect(list).toHaveLength(2);
		expect(list.map((e) => e.toolName)).toEqual(["snapshot", "read"]);
		expect(list.every((e) => e.byteSize > 0)).toBe(true);
		s.close();
	});
});

describe("ToolResultStorage — vacuumOlderThan", () => {
	it("deletes only rows older than cutoff", () => {
		const s = makeStorage({ thresholdBytes: 10 });
		s.put("t1", "snapshot", { data: "a".repeat(100) });
		expect(s.listByTask("t1")).toHaveLength(1);
		// Cutoff in the far future (-1 day) → every row qualifies.
		// Previous test also called vacuumOlderThan(0) first for a "boundary"
		// check, but that races millisecond Date.now() vs row.created_at on
		// fast CI runners and sometimes deletes the row we're about to test.
		expect(s.vacuumOlderThan(-1)).toBe(1);
		expect(s.listByTask("t1")).toHaveLength(0);
		s.close();
	});

	it("returns 0 when no rows are older than cutoff", () => {
		const s = makeStorage({ thresholdBytes: 10 });
		s.put("t1", "snapshot", { data: "a".repeat(100) });
		// 30 days in the past → today's row is much newer, so nothing deleted.
		expect(s.vacuumOlderThan(30)).toBe(0);
		expect(s.listByTask("t1")).toHaveLength(1);
		s.close();
	});
});

describe("ToolResultStorage — robustness", () => {
	it("handles circular references without throwing", () => {
		const s = makeStorage({ thresholdBytes: 10 });
		type Cyc = { name: string; self?: Cyc };
		const obj: Cyc = { name: "root" };
		obj.self = obj;
		const res = s.put("t1", "weird", obj);
		// Must not throw and must return a valid envelope
		expect(res.byteSize).toBeGreaterThan(0);
		if (res.refId) {
			const rehydrated = s.get(res.refId);
			expect(rehydrated).toBeTruthy();
		}
		s.close();
	});

	it("custom threshold is honored", () => {
		const s = makeStorage({ thresholdBytes: 1_000_000 });
		const res = s.put("t1", "snapshot", "x".repeat(50_000));
		expect(res.refId).toBeNull(); // still under 1MB
		s.close();
	});

	it("close() blocks further put / get / list / vacuum", () => {
		const s = makeStorage();
		s.close();
		expect(() => s.put("t", "x", { a: 1 })).toThrow(/closed/);
		expect(() => s.get("x")).toThrow(/closed/);
		expect(() => s.listByTask("t")).toThrow(/closed/);
		expect(() => s.vacuumOlderThan(1)).toThrow(/closed/);
	});

	it("ref_id values are unique across 500 puts", () => {
		const s = makeStorage({ thresholdBytes: 10 });
		const ids = new Set<string>();
		for (let i = 0; i < 500; i++) {
			const r = s.put("t1", "snapshot", { data: "x".repeat(50), i });
			expect(r.refId).toBeTruthy();
			ids.add(r.refId as string);
		}
		expect(ids.size).toBe(500);
		s.close();
	});

	it("concurrent-ish 500 puts (single-thread but tightly looped) store all rows", () => {
		const s = makeStorage({ thresholdBytes: 10 });
		for (let i = 0; i < 500; i++) {
			s.put(`task-${i % 5}`, "snapshot", { i, blob: "x".repeat(100) });
		}
		// Each task bucket should have 100 rows
		for (let t = 0; t < 5; t++) {
			expect(s.listByTask(`task-${t}`)).toHaveLength(100);
		}
		s.close();
	});

	it("summary respects UTF-8 character boundaries (no mid-codepoint split)", () => {
		const s = makeStorage({ thresholdBytes: 10, summaryChars: 5 });
		// Chinese chars — each is 1 JS char but 3 bytes UTF-8
		const res = s.put("t1", "snapshot", "你好世界你好世界你好世界");
		expect(res.refId).toBeTruthy();
		expect(typeof res.summary).toBe("string");
		// summaryChars = 5 → slice(0, 5) + ellipsis. String.prototype.slice operates
		// on UTF-16 code units but never splits a BMP character mid-codepoint.
		const sum = res.summary as string;
		expect(sum.endsWith("…")).toBe(true);
		// length of truncation before ellipsis should be summaryChars
		expect(sum.slice(0, -1).length).toBeLessThanOrEqual(5);
		s.close();
	});
});

describe("installToolResultStorage", () => {
	it("wraps large results in {ref_id, summary, byte_size}", () => {
		const s = makeStorage({ thresholdBytes: 20, summaryChars: 10 });
		const hooks = new Map<string, (p: unknown) => unknown>();
		const host: ToolResultHookHost = {
			on(hook, cb) {
				hooks.set(hook, cb as (p: unknown) => unknown);
			},
		};
		installToolResultStorage(host, s, () => "task-abc");
		const handler = hooks.get("post-tool-call");
		expect(handler).toBeDefined();
		const big = { payload: "abcdefghij".repeat(20) };
		const out = handler?.({ tool: "snapshot", result: big }) as {
			ref_id: string;
			summary: unknown;
			byte_size: number;
		};
		expect(out.ref_id).toBeTruthy();
		expect(out.byte_size).toBeGreaterThan(20);
		// The stored row belongs to "task-abc"
		const stored = s.listByTask("task-abc");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.toolName).toBe("snapshot");
		s.close();
	});

	it("passes small results through untouched", () => {
		const s = makeStorage({ thresholdBytes: 4096 });
		const hooks = new Map<string, (p: unknown) => unknown>();
		installToolResultStorage(
			{
				on(h, cb) {
					hooks.set(h, cb as (p: unknown) => unknown);
				},
			},
			s,
			() => "task-1",
		);
		const handler = hooks.get("post-tool-call");
		const small = { hello: "world" };
		const out = handler?.({ tool: "read", result: small });
		expect(out).toEqual(small);
		s.close();
	});
});

describe("createReadResultSkill", () => {
	it("exposes the ref_id lookup as a Skill", async () => {
		const s = makeStorage({ thresholdBytes: 10 });
		const { refId } = s.put("t1", "snapshot", { big: "y".repeat(100) });
		const skill = createReadResultSkill(s);
		expect(skill.name).toBe("read_result");
		const out = await skill.execute({ ref_id: refId as string });
		expect(out.found).toBe(true);
		expect((out.result as { big: string }).big).toBe("y".repeat(100));
		s.close();
	});

	it("returns found=false for unknown ref_id", async () => {
		const s = makeStorage();
		const skill = createReadResultSkill(s);
		const out = await skill.execute({ ref_id: "nope" });
		expect(out.found).toBe(false);
		expect(out.result).toBeUndefined();
		s.close();
	});

	it("input schema rejects empty ref_id", () => {
		const s = makeStorage();
		const skill = createReadResultSkill(s);
		expect(skill.inputSchema.safeParse({ ref_id: "" }).success).toBe(false);
		expect(skill.inputSchema.safeParse({ ref_id: "x" }).success).toBe(true);
		s.close();
	});
});

describe("ToolResultStorage — file-backed mode", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(path.join(tmpdir(), "tool-result-test-"));
	});

	it("creates the DB file and survives close/re-open", () => {
		const dbPath = path.join(tmp, "nested", "results.db");
		const s1 = new ToolResultStorage({ dbPath, thresholdBytes: 10 });
		const { refId } = s1.put("t1", "snapshot", { data: "x".repeat(100) });
		expect(refId).toBeTruthy();
		s1.close();

		const s2 = new ToolResultStorage({ dbPath, thresholdBytes: 10 });
		const round = s2.get(refId as string);
		expect(round).toEqual({ data: "x".repeat(100) });
		s2.close();
	});
});
