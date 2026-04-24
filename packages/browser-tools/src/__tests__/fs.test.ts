import { describe, expect, it, vi } from "vitest";
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
): FsDriver & { files: Map<string, Uint8Array | "<dir>"> } {
	const enc = new TextEncoder();
	const files = new Map<string, Uint8Array | "<dir>">(
		Object.entries(initial).map(([k, v]) => [
			k,
			v === "<dir>" ? "<dir>" : enc.encode(v),
		]),
	);
	const symlinks = new Map<string, string>(Object.entries(opts.symlinks ?? {}));
	const isDirKey = (p: string): boolean => {
		if (files.get(p) === "<dir>") return true;
		for (const k of files.keys()) if (k.startsWith(`${p}/`)) return true;
		return false;
	};
	return {
		files,
		async readFile(p) {
			const v = files.get(p);
			if (v === undefined || v === "<dir>") {
				throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			}
			return v;
		},
		async writeFile(p, data, optsInner) {
			if (optsInner?.flag === "wx" && files.has(p)) {
				throw Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" });
			}
			files.set(p, data);
		},
		async readdirDetailed(p) {
			const prefix = `${p}/`;
			const names = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest.length === 0) continue;
				const slash = rest.indexOf("/");
				names.add(slash === -1 ? rest : rest.slice(0, slash));
			}
			const out: {
				name: string;
				isFile: boolean;
				isDirectory: boolean;
				size: number;
			}[] = [];
			for (const name of names) {
				const child = `${p}/${name}`;
				const v = files.get(child);
				if (v === "<dir>" || isDirKey(child)) {
					out.push({ name, isFile: false, isDirectory: true, size: 0 });
				} else if (v instanceof Uint8Array) {
					out.push({
						name,
						isFile: true,
						isDirectory: false,
						size: v.byteLength,
					});
				}
			}
			return out;
		},
		async stat(p) {
			const v = files.get(p);
			if (v === undefined) {
				if (isDirKey(p)) {
					return { isFile: false, isDirectory: true, size: 0 };
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
			// Posix semantics: resolve symlinks left-to-right component by
			// component; leaf must exist or ENOENT. Bounded to avoid loops.
			let cursor = p;
			for (let i = 0; i < 32; i++) {
				const direct = symlinks.get(cursor);
				if (direct !== undefined) {
					cursor = direct;
					continue;
				}
				// Is any parent a symlink? Take the longest matching prefix.
				let matched: { link: string; target: string } | undefined;
				for (const [link, target] of symlinks) {
					if (cursor.startsWith(`${link}/`)) {
						if (!matched || link.length > matched.link.length) {
							matched = { link, target };
						}
					}
				}
				if (matched) {
					cursor = `${matched.target}${cursor.slice(matched.link.length)}`;
					continue;
				}
				// No more symlinks to resolve. Leaf must exist.
				if (files.has(cursor) || isDirKey(cursor)) return cursor;
				throw Object.assign(new Error(`ENOENT: ${cursor}`), {
					code: "ENOENT",
				});
			}
			throw Object.assign(new Error(`ELOOP: ${p}`), { code: "ELOOP" });
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
		dirname: (p) => {
			const i = p.lastIndexOf("/");
			return i <= 0 ? "/" : p.slice(0, i);
		},
		sep: "/",
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

	it("parent-symlink escape on NEW file → rejected (lexical fallback is not enough)", async () => {
		// /sandbox exists; /sandbox/link_to_etc is a symlink to /etc.
		// The Agent asks to write /sandbox/link_to_etc/new_file. realpath
		// throws ENOENT for the non-existent leaf; a naive implementation
		// falls back to the lexical abs which PASSES the prefix check
		// (starts with "/sandbox") — but mkdir/write would follow the
		// symlink and drop the file inside /etc.
		const driver = memDriver(
			{ "/sandbox": "<dir>", "/etc": "<dir>" },
			{ symlinks: { "/sandbox/link_to_etc": "/etc" } },
		);
		const skills = createFsSkills(mkSandbox(driver, ["/sandbox"]));
		const res = (await getSkill(skills, "fs_write").execute({
			path: "/sandbox/link_to_etc/new_file",
			content: "gotcha",
		})) as FsWriteResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_in_sandbox");
		// And nothing was written anywhere
		expect(driver.files.has("/etc/new_file")).toBe(false);
	});

	it("sandbox root = '/' still gates children correctly (no double-sep bug)", async () => {
		const driver = memDriver({ "/work/a": "hi" });
		const skills = createFsSkills(mkSandbox(driver, ["/"]));
		const res = (await getSkill(skills, "fs_read").execute({
			path: "/work/a",
		})) as FsReadResult;
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.content).toBe("hi");
	});

	it("sandbox '/work' does NOT grant access to '/workshop' (prefix vs child distinction)", async () => {
		const driver = memDriver({
			"/work": "<dir>",
			"/workshop/secret": "nope",
		});
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_read").execute({
			path: "/workshop/secret",
		})) as FsReadResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_in_sandbox");
	});

	it("Windows-style sandbox (sep='\\\\') gates correctly", async () => {
		const driver = memDriver({
			"C:\\work\\a.txt": "hi",
		});
		const skills = createFsSkills({
			allowedDirs: ["C:\\work"],
			driver,
			resolve: (p) => p,
			dirname: (p) => {
				const i = p.lastIndexOf("\\");
				return i <= 0 ? p : p.slice(0, i);
			},
			sep: "\\",
		});
		const res = (await getSkill(skills, "fs_read").execute({
			path: "C:\\work\\a.txt",
		})) as FsReadResult;
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.content).toBe("hi");
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
		expect(
			new TextDecoder().decode(
				driver.files.get("/work/report.md") as Uint8Array,
			),
		).toBe("# hello");
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
		expect(
			new TextDecoder().decode(
				driver.files.get("/work/exists.txt") as Uint8Array,
			),
		).toBe("new");
		// createOnly refuses
		const co = (await getSkill(skills, "fs_write").execute({
			path: "/work/exists.txt",
			content: "newer",
			createOnly: true,
		})) as FsWriteResult;
		expect(co.ok).toBe(false);
		if (!co.ok) expect(co.detail).toMatch(/exists/);
		expect(
			new TextDecoder().decode(
				driver.files.get("/work/exists.txt") as Uint8Array,
			),
		).toBe("new");
	});

	it("createOnly uses atomic wx flag (TOCTOU-safe) — driver sees flag:'wx'", async () => {
		const driver = memDriver({ "/work": "<dir>" });
		const writeSpy = vi.fn(driver.writeFile.bind(driver));
		driver.writeFile = writeSpy;
		const skills = createFsSkills(mkSandbox(driver, ["/work"]));
		const res = (await getSkill(skills, "fs_write").execute({
			path: "/work/new.txt",
			content: "x",
			createOnly: true,
		})) as FsWriteResult;
		expect(res.ok).toBe(true);
		expect(writeSpy).toHaveBeenCalledWith(
			"/work/new.txt",
			expect.any(Uint8Array),
			{ flag: "wx" },
		);
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
