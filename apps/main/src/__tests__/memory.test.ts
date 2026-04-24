import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../memory.js";

function iso(y: number, m: number, d: number): string {
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

describe("MemoryStore — CORE.md", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "memory-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("seeds the template on first readCore and returns default body", async () => {
		const mem = new MemoryStore({ dir });
		const body = await mem.readCore();
		expect(body).toContain("CORE memory");
		const onDisk = await readFile(path.join(dir, "CORE.md"), "utf-8");
		expect(onDisk).toBe(body);
	});

	it("writeCore overwrites the file", async () => {
		const mem = new MemoryStore({ dir });
		await mem.writeCore("# my facts\n- name: Alice\n");
		expect(await mem.readCore()).toBe("# my facts\n- name: Alice\n");
	});

	it("rejects reads of oversize CORE.md (byteLength, not chars)", async () => {
		const mem = new MemoryStore({ dir, maxCoreBytes: 10 });
		await writeFile(path.join(dir, "CORE.md"), "中".repeat(20), "utf-8");
		await expect(mem.readCore()).rejects.toThrow(/exceeds/);
	});

	it("writeCore rejects oversize bodies", async () => {
		const mem = new MemoryStore({ dir, maxCoreBytes: 10 });
		await expect(mem.writeCore("x".repeat(11))).rejects.toThrow(/rejected/);
	});

	it("coreSummary returns '' when file still holds only the default template", async () => {
		const mem = new MemoryStore({ dir });
		await mem.readCore(); // seed
		expect(await mem.coreSummary()).toBe("");
	});

	it("coreSummary returns body.trim() once user has customised", async () => {
		const mem = new MemoryStore({ dir });
		await mem.writeCore("# My facts\n- works at Acme\n\n");
		expect(await mem.coreSummary()).toBe("# My facts\n- works at Acme");
	});
});

describe("MemoryStore — daily", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "memory-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("appendDaily creates today's file with ISO timestamps, subsequent appends reuse it", async () => {
		const mem = new MemoryStore({
			dir,
			now: () => new Date("2026-04-24T10:00:00Z"),
		});
		await mem.appendDaily("first note");
		await mem.appendDaily("second note");
		const body = await mem.readDaily("2026-04-24");
		expect(body).toContain("# 2026-04-24");
		expect(body).toMatch(/- \[2026-04-24T10:00:00\.000Z\] first note/);
		expect(body).toMatch(/- \[2026-04-24T10:00:00\.000Z\] second note/);
		// Only ONE header across all appends
		expect(body.match(/^# 2026-04-24$/gm)).toHaveLength(1);
	});

	it("concurrent appendDaily calls do not lose writes and produce one header", async () => {
		const mem = new MemoryStore({
			dir,
			now: () => new Date("2026-04-24T10:00:00Z"),
		});
		// 20 concurrent appends — race prone on the old read-modify-write.
		await Promise.all(
			Array.from({ length: 20 }, (_, i) => mem.appendDaily(`note ${i}`)),
		);
		const body = await mem.readDaily("2026-04-24");
		// Every note survives.
		for (let i = 0; i < 20; i++) {
			expect(body).toContain(`note ${i}`);
		}
		// Exactly one header.
		expect(body.match(/^# 2026-04-24$/gm)).toHaveLength(1);
	});

	it("readDaily returns '' for a missing date", async () => {
		const mem = new MemoryStore({ dir });
		expect(await mem.readDaily("2020-01-01")).toBe("");
	});

	it("listDailyDates returns dates newest first", async () => {
		const mem = new MemoryStore({ dir });
		// Seed 3 files directly to skip clock injection.
		for (const d of ["2026-04-01", "2026-04-10", "2026-04-05"]) {
			await writeFile(path.join(dir, "daily", `${d}.md`), "- note", {
				flag: "wx",
			}).catch(async () => {
				// mkdir if needed
				await writeFile(path.join(dir, "daily", `${d}.md`), "- note").catch(
					() => {},
				);
			});
		}
		// Ensure dir exists with all three
		const { mkdir } = await import("node:fs/promises");
		await mkdir(path.join(dir, "daily"), { recursive: true });
		for (const d of ["2026-04-01", "2026-04-10", "2026-04-05"]) {
			await writeFile(path.join(dir, "daily", `${d}.md`), "- note");
		}
		const got = await mem.listDailyDates();
		expect(got).toEqual(["2026-04-10", "2026-04-05", "2026-04-01"]);
	});

	it("listDailyDates ignores non-date filenames and missing dir", async () => {
		const fresh = mkdtempSync(path.join(tmpdir(), "memory-"));
		try {
			const mem = new MemoryStore({ dir: fresh });
			// Missing daily dir → []
			expect(await mem.listDailyDates()).toEqual([]);
			// Now create dir with junk + valid
			const { mkdir } = await import("node:fs/promises");
			await mkdir(path.join(fresh, "daily"), { recursive: true });
			await writeFile(path.join(fresh, "daily", "junk.md"), "x");
			await writeFile(path.join(fresh, "daily", "2026-01-01.md"), "x");
			expect(await mem.listDailyDates()).toEqual(["2026-01-01"]);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});
});

describe("MemoryStore — search", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "memory-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("AND-matches keywords case-insensitively and reports source + section", async () => {
		const mem = new MemoryStore({ dir });
		await mem.writeCore(
			"# facts\n## people\n- Alice works on payments\n- Bob is on infra\n",
		);
		const hits = await mem.search("alice payments");
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			source: "core",
			section: "people",
			matchedKeywords: 2,
		});
		expect(hits[0]?.line).toContain("Alice works on payments");
	});

	it("strict AND: only lines containing ALL keywords are returned", async () => {
		const mem = new MemoryStore({ dir });
		await mem.writeCore("- alpha\n- alpha beta\n- gamma\n- alpha gamma beta\n");
		const hits = await mem.search("alpha beta");
		// OR-match would return 3; AND-match keeps only lines with both.
		expect(hits).toHaveLength(2);
		for (const hit of hits) {
			expect(hit.line.toLowerCase()).toContain("alpha");
			expect(hit.line.toLowerCase()).toContain("beta");
		}
	});

	it("searches across CORE and daily; CORE wins same-score tie-break", async () => {
		const mem = new MemoryStore({
			dir,
			now: () => new Date("2026-04-24T10:00:00Z"),
		});
		await mem.writeCore("- daily standup time: 10am\n");
		await mem.appendDaily("standup ran late today");
		const hits = await mem.search("standup");
		expect(hits[0]?.source).toBe("core");
		expect(hits[1]?.source).toBe("2026-04-24");
	});

	it("returns empty array for empty/whitespace query", async () => {
		const mem = new MemoryStore({ dir });
		expect(await mem.search("")).toEqual([]);
		expect(await mem.search("   ")).toEqual([]);
	});

	it("respects limit", async () => {
		const mem = new MemoryStore({ dir });
		await mem.writeCore(
			Array.from({ length: 20 }, (_, i) => `- line ${i} match`).join("\n"),
		);
		const hits = await mem.search("match", 5);
		expect(hits).toHaveLength(5);
	});
});

describe("MemoryStore — gcDaily", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "memory-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("deletes daily files older than retentionDays, keeps fresh ones", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(path.join(dir, "daily"), { recursive: true });
		const today = new Date("2026-04-24T00:00:00Z");
		// 40 days ago → should be removed
		const old = iso(2026, 3, 15); // 40 days before 2026-04-24
		// 10 days ago → should stay
		const fresh = iso(2026, 4, 14);
		await writeFile(path.join(dir, "daily", `${old}.md`), "x");
		await writeFile(path.join(dir, "daily", `${fresh}.md`), "x");
		const mem = new MemoryStore({
			dir,
			dailyRetentionDays: 30,
			now: () => today,
		});
		const removed = await mem.gcDaily();
		expect(removed).toBe(1);
		const remaining = await readdir(path.join(dir, "daily"));
		expect(remaining).toEqual([`${fresh}.md`]);
	});

	it("gcDaily returns 0 when daily dir is missing (no-op)", async () => {
		const mem = new MemoryStore({ dir });
		expect(await mem.gcDaily()).toBe(0);
	});

	it("gcDaily ignores non-date filenames", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(path.join(dir, "daily"), { recursive: true });
		await writeFile(path.join(dir, "daily", "notes.md"), "x");
		await writeFile(path.join(dir, "daily", "2020-01-01.md"), "x");
		const mem = new MemoryStore({ dir, now: () => new Date("2026-04-24") });
		const removed = await mem.gcDaily();
		expect(removed).toBe(1);
		const remaining = await readdir(path.join(dir, "daily"));
		expect(remaining).toEqual(["notes.md"]);
	});
});
