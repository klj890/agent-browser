import { describe, expect, it } from "vitest";
import {
	createFsSkills,
	type FsDriver,
	type FsLsResult,
	type FsReadResult,
	type FsSandbox,
	type FsWriteResult,
} from "../fs.js";

/**
 * In-memory FsDriver — a Map of absolute-path → Buffer|'<dir>'. Skips a
 * tmpdir dance and makes path logic fully observable.
 */
function memDriver(
	initial: Record<string, string | "<dir>">,
	opts: { symlinks?: Record<string, string> } = {},
): FsDriver & { files: Map<string, Buffer | "<dir>"> } {
	const files = new Map<string, Buffer | "<dir>">(
		Object.entries(initial).map(([k, v]) => [
			k,
			v === "<dir>" ? "<dir>" : Buffer.from(v, "utf8"),
		]),
	);
	const symlinks = new Map<string, string>(Object.entries(opts.symlinks ?? {}));
	return {
		files,
		async readFile(p) {
			const v = files.get(p);
			if (v === undefined || v === "<dir>") {
				throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			}
			return v;
		},
		async writeFile(p, data) {
			files.set(
				p,
				Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"),
			);
		},
		async readdir(p) {
			const prefix = `${p}/`;
			const names = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest.length === 0) continue;
				// Only immediate child, not nested grandchildren.
				const slash = rest.indexOf("/");
				names.add(slash === -1 ? rest : rest.slice(0, slash));
			}
			return Array.from(names);
		},
		async stat(p) {
			const v = files.get(p);
			if (v === undefined) {
				// A directory that has children but no explicit entry.
				for (const key of files.keys()) {
					if (key.startsWith(`${p}/`)) {
						return { isFile: false, isDirectory: true, size: 0 };
					}
				}
				throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			}
			if (v === "<dir>") return { isFile: false, isDirectory: true, size: 0 };
			return { isFile: true, isDirectory: false, size: v.byteLength };
		},
		async mkdir(p, _opts) {
			files.set(p, "<dir>");
		},
		async realpath(p) {
			const target = symlinks.get(p);
			return target ?? p;
		},
	};
}

function mkSandbox(
	driver: FsDriver,
	allowedDirs: string[],
	extras: Partial<FsSandbox> = {},
): FsSandbox {
	return {
		allowedDirs,
		driver,
		resolve: (p) => p,
		...extras,
	};
}

function getSkill(skills: ReturnType<typeof createFsSkills>, name: string) {
	const s = skills.find((x) => x.name === name);
	if (!s) throw new Error(`skill ${name} missing`);
	return s;
}

describe("createFsSkills — sandbox", () => {
	it("empty allowedDirs → every call returns not_in_sandbox", async () => {
		const driver = memDriver({ "/work/f.txt": "hi" });
		const skills = createFsSkills(mkSandbox(driver, []));
		const read = (await getSkill(skills, "fs_read").execute({
			path: "/work/f.txt",
		})) as FsReadResult;
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.reason).toBe("not_in_sandbox");
		const write = (await getSkill(skills, "fs_write").execute({
			path: "/work/new.txt",
			content: "x",
		})) as FsWriteResult;
		expect(write.ok).toBe(false);
		if (!write.ok) expect(write.reason).toBe("not_in_sandbox");
		const ls = (await getSkill(skills, "fs_ls").execute({
			path: "/work",
		})) as FsLsResult;
		expect(ls.ok).toBe(false);
	});

	it("path escaping via realpath symlink → rejected as not_in_sandbox", async () => {
		// /work is sandboxed; /work/escape is a symlink to /etc → must NOT open.
		const driver = memDriver(
			{ "/work": "<dir>", "/etc/passwd": "secret" },
			{ symlinks: { "/work/escape": "/etc/passwd" } },
		);
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_read").execute({
			path: "/work/escape",
		})) as FsReadResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_in_sandbox");
	});

	it("absolute path outside sandbox → rejected", async () => {
		const driver = memDriver({
			"/work": "<dir>",
			"/etc/passwd": "secret",
		});
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_read").execute({
			path: "/etc/passwd",
		})) as FsReadResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_in_sandbox");
	});
});

describe("fs_read", () => {
	it("reads text content and reports byte size", async () => {
		const driver = memDriver({ "/work/hello.txt": "hi there" });
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_read").execute({
			path: "/work/hello.txt",
		})) as FsReadResult;
		expect(res).toEqual({ ok: true, content: "hi there", byteSize: 8 });
	});

	it("rejects non-file (directory) with not_file", async () => {
		const driver = memDriver({ "/work": "<dir>" });
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_read").execute({
			path: "/work",
		})) as FsReadResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_file");
	});

	it("rejects oversize files with too_large (bytes, not chars)", async () => {
		const driver = memDriver({ "/work/big": "x".repeat(100) });
		const skills = createFsSkills(
			mkSandbox(driver, ["/work"], { maxReadBytes: 10 }),
		);
		const res = (await getSkill(skills, "fs_read").execute({
			path: "/work/big",
		})) as FsReadResult;
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.reason).toBe("too_large");
			expect(res.detail).toMatch(/100 > 10/);
		}
	});

	it("missing file → not_found (ENOENT mapped, not io_error)", async () => {
		const driver = memDriver({ "/work": "<dir>" });
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_read").execute({
			path: "/work/ghost",
		})) as FsReadResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_found");
	});
});

describe("fs_write", () => {
	it("writes new file inside sandbox", async () => {
		const driver = memDriver({ "/work": "<dir>" });
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_write").execute({
			path: "/work/report.md",
			content: "# hello",
		})) as FsWriteResult;
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.byteSize).toBe(7);
		expect(driver.files.get("/work/report.md")?.toString()).toBe("# hello");
	});

	it("overwrites by default, respects createOnly", async () => {
		const driver = memDriver({
			"/work": "<dir>",
			"/work/exists.txt": "old",
		});
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		// default overwrite succeeds
		const ow = (await getSkill(skills, "fs_write").execute({
			path: "/work/exists.txt",
			content: "new",
		})) as FsWriteResult;
		expect(ow.ok).toBe(true);
		expect(driver.files.get("/work/exists.txt")?.toString()).toBe("new");
		// createOnly refuses
		const co = (await getSkill(skills, "fs_write").execute({
			path: "/work/exists.txt",
			content: "newer",
			createOnly: true,
		})) as FsWriteResult;
		expect(co.ok).toBe(false);
		if (!co.ok) expect(co.detail).toMatch(/exists/);
		expect(driver.files.get("/work/exists.txt")?.toString()).toBe("new");
	});

	it("refuses oversize content (byte length, not char length)", async () => {
		const driver = memDriver({ "/work": "<dir>" });
		const skills = createFsSkills(
			mkSandbox(driver, ["/work"], { maxWriteBytes: 10 }),
		);
		// Emoji: 4 bytes in UTF-8. 4 emoji = 16 bytes > 10.
		const res = (await getSkill(skills, "fs_write").execute({
			path: "/work/f",
			content: "😀😀😀😀",
		})) as FsWriteResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("too_large");
	});
});

describe("fs_ls", () => {
	it("lists immediate children with type + size", async () => {
		const driver = memDriver({
			"/work": "<dir>",
			"/work/a.txt": "aa",
			"/work/b.md": "bbbb",
			"/work/sub": "<dir>",
			"/work/sub/deep.txt": "deep", // grandchild — excluded
		});
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_ls").execute({
			path: "/work",
		})) as FsLsResult;
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const names = res.entries.map((e) => e.name).sort();
		expect(names).toEqual(["a.txt", "b.md", "sub"]);
		const a = res.entries.find((e) => e.name === "a.txt");
		expect(a).toMatchObject({ isFile: true, isDirectory: false, size: 2 });
		const sub = res.entries.find((e) => e.name === "sub");
		expect(sub?.isDirectory).toBe(true);
		expect(res.truncated).toBe(false);
	});

	it("truncates at maxLsEntries and sets truncated:true", async () => {
		const files: Record<string, string> = { "/work": "<dir>" };
		for (let i = 0; i < 10; i++) files[`/work/f${i}`] = "x";
		const driver = memDriver(files);
		const skills = createFsSkills(
			mkSandbox(driver, ["/work"], { maxLsEntries: 3 }),
		);
		const res = (await getSkill(skills, "fs_ls").execute({
			path: "/work",
		})) as FsLsResult;
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.entries).toHaveLength(3);
		expect(res.truncated).toBe(true);
	});

	it("refuses a file path with not_directory", async () => {
		const driver = memDriver({ "/work": "<dir>", "/work/f.txt": "x" });
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_ls").execute({
			path: "/work/f.txt",
		})) as FsLsResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_directory");
	});
});
