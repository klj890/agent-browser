/**
 * fs.ts — sandboxed filesystem skills (P2 §2.7, BrowserOS "Cowork" inspiration).
 *
 * Three read/write primitives so an Agent can research in the browser AND
 * persist results to a user-chosen folder in the same conversation.
 * BrowserOS ships seven (read/write/edit/grep/find/ls/bash); we start with
 * **three** — `fs_read`, `fs_write`, `fs_ls` — on purpose:
 *
 *   - bash is a high-blast-radius primitive that deserves its own sandbox
 *     design and belongs in a follow-up PR.
 *   - edit/grep/find are convenience layers over read/write/ls + a bit of
 *     string matching; once the primitives land they compose cheaply and
 *     can join in whatever follow-up needs them.
 *
 * Security model (the only reason this exists):
 *   - Every path is normalised with `path.resolve` and checked against
 *     an allowed-dir list. A request that escapes via `..`, a symlink
 *     pointing outside, or an absolute path to /etc/passwd is rejected
 *     BEFORE any fs call.
 *   - The allowed-dir set is supplied by the caller (AgentHost wires in
 *     AdminPolicy.fsSandboxDirs); this module has no opinion on where it
 *     comes from.
 *   - Read size + write size + list entry counts are capped so a runaway
 *     Agent cannot exhaust memory or the LLM context by slurping a log
 *     file.
 *   - The filesystem driver is injected (test + production split) so unit
 *     tests run entirely in-memory — we don't need a tmpdir dance.
 */
import { z } from "zod";
import type { Skill } from "./index.js";

/**
 * One fs entry's metadata — all the skill layer ever needs. Mirrors
 * `node:fs Dirent` + `stat` intersection so production and test drivers
 * can fill it with one pass instead of stat-per-entry.
 */
export interface FsDirEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	size: number;
}

/**
 * Minimal fs interface the skills need. Return types avoid Node globals
 * so this module stays consumable from renderer / browser contexts —
 * Node-backed callers wrap buffers into Uint8Array at the driver edge.
 */
export interface FsDriver {
	readFile(p: string): Promise<Uint8Array>;
	/**
	 * Write bytes. `flag: "wx"` must fail with EEXIST when the target
	 * exists — this is the atomic primitive the `createOnly` skill option
	 * piggybacks on, avoiding the TOCTOU window between stat-and-write.
	 */
	writeFile(
		p: string,
		data: Uint8Array,
		opts?: { flag?: "w" | "wx" },
	): Promise<void>;
	/** Return entries + their dirent-style type + size in ONE pass. */
	readdirDetailed(p: string): Promise<FsDirEntry[]>;
	stat(p: string): Promise<{
		isFile: boolean;
		isDirectory: boolean;
		size: number;
	}>;
	mkdir(p: string, opts: { recursive: true }): Promise<void>;
	realpath(p: string): Promise<string>;
}

export interface FsSandbox {
	/**
	 * Absolute paths the Agent may read/write under. Empty list = FS tools
	 * are effectively disabled even if the skill is registered — every
	 * operation returns `reason: "not_in_sandbox"`.
	 */
	allowedDirs: string[];
	driver: FsDriver;
	/** Max bytes returned by a single fs_read. Default 256KB. */
	maxReadBytes?: number;
	/** Max bytes accepted by a single fs_write. Default 256KB. */
	maxWriteBytes?: number;
	/** Max entries returned by a single fs_ls. Default 200. */
	maxLsEntries?: number;
	/**
	 * Path primitives injected so the skill layer stays cross-platform
	 * without importing `node:path`. On Windows callers supply helpers
	 * backed by `path.win32`; posix callers pass the default-ish set.
	 *
	 *  - `resolve`: canonicalise a possibly-relative path to absolute.
	 *  - `dirname`: parent of a path. Used for mkdir-parent-before-write.
	 *  - `sep`:     platform path separator (e.g. "/" on posix, "\\" on win32).
	 *               Both prefix-check and sandbox-root compare use it so
	 *               a sandbox of "/" (posix root) or "C:\\" (win drive root)
	 *               still matches `/x` / `C:\\x` children correctly.
	 */
	resolve: (p: string) => string;
	dirname: (p: string) => string;
	sep: string;
}

export type FsReason =
	| "not_in_sandbox"
	| "not_found"
	| "not_file"
	| "not_directory"
	| "too_large"
	| "invalid_path"
	| "io_error";

export const FsReadInput = z.object({
	path: z.string().min(1),
});
export type FsReadInput = z.infer<typeof FsReadInput>;

export const FsWriteInput = z.object({
	path: z.string().min(1),
	content: z.string(),
	/** If true, fail when the target already exists. Default false (overwrite). */
	createOnly: z.boolean().optional(),
});
export type FsWriteInput = z.infer<typeof FsWriteInput>;

export const FsLsInput = z.object({
	path: z.string().min(1),
});
export type FsLsInput = z.infer<typeof FsLsInput>;

export type FsReadResult =
	| { ok: true; content: string; byteSize: number }
	| { ok: false; reason: FsReason; detail?: string };

export type FsWriteResult =
	| { ok: true; path: string; byteSize: number }
	| { ok: false; reason: FsReason; detail?: string };

/**
 * Alias of {@link FsDirEntry}. Exists so callers that destructure from
 * `FsLsResult.entries` can import a name that reads ergonomically at the
 * call site (`FsLsEntry`) without us having to maintain two identical
 * shapes. Not deprecated — both names are stable.
 */
export type FsLsEntry = FsDirEntry;

export type FsLsResult =
	| { ok: true; entries: FsDirEntry[]; truncated: boolean }
	| { ok: false; reason: FsReason; detail?: string };

const DEFAULT_MAX_READ = 256 * 1024;
const DEFAULT_MAX_WRITE = 256 * 1024;
const DEFAULT_MAX_LS = 200;

/**
 * Resolve + sandbox-check a caller-supplied path. Returns the resolved
 * absolute path on success or an FsReason on rejection. Resolves symlinks
 * via `realpath` to prevent escape via a link placed inside the sandbox.
 */
async function resolveInSandbox(
	input: string,
	sandbox: FsSandbox,
): Promise<
	{ ok: true; abs: string } | { ok: false; reason: FsReason; detail?: string }
> {
	if (sandbox.allowedDirs.length === 0) {
		return { ok: false, reason: "not_in_sandbox", detail: input };
	}
	let abs: string;
	try {
		abs = sandbox.resolve(input);
	} catch (err) {
		return {
			ok: false,
			reason: "invalid_path",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
	// Security-critical: realpath the deepest existing ancestor.
	//
	// Naive realpath(abs) throws ENOENT for paths that don't exist yet
	// (fs_write to a new file), so a previous version fell back to the
	// lexical `abs`. That opens a sandbox escape: if any parent is a
	// symlink pointing OUT of the sandbox (e.g. `/sandbox/link_to_etc`
	// → `/etc`) and the leaf is new, `abs` stays lexically inside the
	// sandbox — but the subsequent mkdir/write follows the symlink and
	// lands in /etc. We walk up until an ancestor exists, realpath
	// that, then stitch the untouched tail back on. Any symlink in the
	// existing prefix is resolved; any symlink in the (non-existent)
	// tail can't exist yet and will only become real via mkdir beneath
	// the already-canonicalised base.
	let real: string;
	try {
		real = await sandbox.driver.realpath(abs);
	} catch {
		real = await resolveExistingAncestor(abs, sandbox);
	}
	const inside = sandbox.allowedDirs.some((dir) => {
		if (real === dir) return true;
		// If the sandbox root already ends with the separator (e.g. "/"
		// posix root, "C:\\" win32 drive root), don't double-append —
		// that would check `startsWith("//")` / `"C:\\\\"` and miss all
		// children. Otherwise join dir + sep to enforce "child of dir",
		// not just "lexical prefix of dir" (blocks sandbox="/work"
		// allowing "/workshop").
		const prefix = dir.endsWith(sandbox.sep) ? dir : `${dir}${sandbox.sep}`;
		return real.startsWith(prefix);
	});
	if (!inside) {
		return { ok: false, reason: "not_in_sandbox", detail: real };
	}
	return { ok: true, abs: real };
}

/**
 * Walk up `abs` one `dirname` at a time until `realpath` succeeds, then
 * rejoin the non-existent tail onto the canonicalised ancestor. The rejoined
 * tail is guaranteed not to contain symlinks yet (they would require parent
 * directories to exist). If even the sandbox root doesn't realpath (really
 * unusual — driver misconfig), we still return the lexical abs so the caller
 * fails closed at the prefix check instead of hanging.
 */
async function resolveExistingAncestor(
	abs: string,
	sandbox: FsSandbox,
): Promise<string> {
	const tailParts: string[] = [];
	let cursor = abs;
	// Bound iterations so a pathological `dirname` that never shrinks doesn't loop.
	for (let i = 0; i < 64; i++) {
		try {
			const realAncestor = await sandbox.driver.realpath(cursor);
			if (tailParts.length === 0) return realAncestor;
			// If the ancestor already ends with the separator (root `/` or
			// Windows drive root `C:\\`), don't add another or we produce
			// `//missing` / `C:\\\\missing` — cosmetic in most cases but
			// breaks downstream `startsWith` checks that assume no double
			// separators.
			const joiner = realAncestor.endsWith(sandbox.sep) ? "" : sandbox.sep;
			return `${realAncestor}${joiner}${tailParts.reverse().join(sandbox.sep)}`;
		} catch {
			const parent = sandbox.dirname(cursor);
			if (parent === cursor) break; // reached filesystem root
			// When parent already ends with the separator (root case), slicing
			// an extra `sep.length` would chop a real character off the leaf.
			// `/missing` → parent `/` → naive slice(1+1)=2 drops 'm' and
			// returns 'issing'. Branch on whether parent already carries a
			// trailing separator.
			const offset = parent.endsWith(sandbox.sep)
				? parent.length
				: parent.length + sandbox.sep.length;
			const leaf = cursor.slice(offset);
			if (leaf) tailParts.push(leaf);
			cursor = parent;
		}
	}
	return abs;
}

export function createFsSkills(sandbox: FsSandbox): Skill[] {
	const maxRead = sandbox.maxReadBytes ?? DEFAULT_MAX_READ;
	const maxWrite = sandbox.maxWriteBytes ?? DEFAULT_MAX_WRITE;
	const maxLs = sandbox.maxLsEntries ?? DEFAULT_MAX_LS;

	return [
		{
			name: "fs_read",
			description: `Read the full text content of a file inside the sandboxed directories. Max ${maxRead} bytes; larger files are rejected so the Agent cannot exhaust context.`,
			inputSchema: FsReadInput,
			execute: async (raw) => {
				const input = FsReadInput.parse(raw);
				const r = await resolveInSandbox(input.path, sandbox);
				if (!r.ok) return r satisfies FsReadResult;
				try {
					const stat = await sandbox.driver.stat(r.abs);
					if (!stat.isFile) {
						return { ok: false, reason: "not_file" } satisfies FsReadResult;
					}
					if (stat.size > maxRead) {
						return {
							ok: false,
							reason: "too_large",
							detail: `${stat.size} > ${maxRead}`,
						} satisfies FsReadResult;
					}
					const bytes = await sandbox.driver.readFile(r.abs);
					// TextDecoder, not Buffer, so this file has no Node-only
					// dependency — matches the renderer-share promise in the
					// file header.
					const content = new TextDecoder("utf-8").decode(bytes);
					return {
						ok: true,
						content,
						byteSize: bytes.byteLength,
					} satisfies FsReadResult;
				} catch (err) {
					return ioError(err);
				}
			},
		},
		{
			name: "fs_write",
			description: `Write UTF-8 text to a file inside the sandboxed directories. Creates parent directories as needed. Max ${maxWrite} bytes; use 'createOnly' to refuse overwriting existing files.`,
			inputSchema: FsWriteInput,
			execute: async (raw) => {
				const input = FsWriteInput.parse(raw);
				const bytes = new TextEncoder().encode(input.content);
				if (bytes.byteLength > maxWrite) {
					return {
						ok: false,
						reason: "too_large",
						detail: `${bytes.byteLength} > ${maxWrite}`,
					} satisfies FsWriteResult;
				}
				const r = await resolveInSandbox(input.path, sandbox);
				if (!r.ok) return r satisfies FsWriteResult;
				try {
					// Ensure parent directory exists. Use injected dirname
					// so Windows ('\\') and posix ('/') both work without
					// string slicing on a hard-coded separator.
					const dir = sandbox.dirname(r.abs);
					if (dir && dir !== r.abs) {
						await sandbox.driver.mkdir(dir, { recursive: true });
					}
					// `createOnly` → `wx` flag: atomic "fail if exists" at the
					// OS level, no stat-then-write TOCTOU window.
					await sandbox.driver.writeFile(r.abs, bytes, {
						flag: input.createOnly ? "wx" : "w",
					});
					return {
						ok: true,
						path: r.abs,
						byteSize: bytes.byteLength,
					} satisfies FsWriteResult;
				} catch (err) {
					// Map EEXIST (raised by the wx flag) back into the
					// existing io_error + 'exists' detail so callers don't
					// have to special-case the errno code.
					if ((err as { code?: string } | null)?.code === "EEXIST") {
						return {
							ok: false,
							reason: "io_error",
							detail: "exists and createOnly=true",
						} satisfies FsWriteResult;
					}
					return ioError(err);
				}
			},
		},
		{
			name: "fs_ls",
			description: `List directory entries inside the sandboxed directories. Returns up to ${maxLs} entries with name / isFile / isDirectory / size.`,
			inputSchema: FsLsInput,
			execute: async (raw) => {
				const input = FsLsInput.parse(raw);
				const r = await resolveInSandbox(input.path, sandbox);
				if (!r.ok) return r satisfies FsLsResult;
				try {
					const stat = await sandbox.driver.stat(r.abs);
					if (!stat.isDirectory) {
						return { ok: false, reason: "not_directory" } satisfies FsLsResult;
					}
					// One readdir call returns name + type + size for every
					// entry — previous implementation did 1 + N stat calls
					// (201 FS hits for a 200-entry directory).
					const entries = await sandbox.driver.readdirDetailed(r.abs);
					const cut = entries.slice(0, maxLs);
					return {
						ok: true,
						entries: cut,
						truncated: entries.length > maxLs,
					} satisfies FsLsResult;
				} catch (err) {
					return ioError(err);
				}
			},
		},
	];
}

function ioError(err: unknown): {
	ok: false;
	reason: FsReason;
	detail: string;
} {
	const code = (err as { code?: string } | null)?.code;
	if (code === "ENOENT") {
		return { ok: false, reason: "not_found", detail: String(err) };
	}
	return {
		ok: false,
		reason: "io_error",
		detail: err instanceof Error ? err.message : String(err),
	};
}
