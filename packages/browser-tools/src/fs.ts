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

/** Minimal fs interface the skills need. Matches node:fs/promises subset. */
export interface FsDriver {
	readFile(p: string): Promise<Buffer>;
	writeFile(p: string, data: string | Buffer): Promise<void>;
	readdir(p: string): Promise<string[]>;
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
	 * Path-join helper injected so the skill layer stays platform-aware
	 * without importing `node:path` (this file is shared with a future
	 * renderer-side consumer that has no Node built-ins). Defaults to a
	 * simple posix-style join at the call sites where a default is okay.
	 */
	resolve: (p: string) => string;
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

export interface FsLsEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	size: number;
}

export type FsLsResult =
	| { ok: true; entries: FsLsEntry[]; truncated: boolean }
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
	// realpath resolves symlinks so we can't be fooled by a link inside
	// the sandbox that points to /etc. realpath on a non-existent path
	// throws — in that case fall back to the pre-realpath abs (for writes
	// to new files) and still enforce the prefix check below.
	let real = abs;
	try {
		real = await sandbox.driver.realpath(abs);
	} catch {
		// not yet created — use the lexical abs; caller handles non-existence.
	}
	const inside = sandbox.allowedDirs.some(
		(dir) => real === dir || real.startsWith(`${dir}/`),
	);
	if (!inside) {
		return { ok: false, reason: "not_in_sandbox", detail: real };
	}
	return { ok: true, abs: real };
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
					const buf = await sandbox.driver.readFile(r.abs);
					return {
						ok: true,
						content: buf.toString("utf8"),
						byteSize: buf.byteLength,
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
				const byteSize = Buffer.byteLength(input.content, "utf8");
				if (byteSize > maxWrite) {
					return {
						ok: false,
						reason: "too_large",
						detail: `${byteSize} > ${maxWrite}`,
					} satisfies FsWriteResult;
				}
				const r = await resolveInSandbox(input.path, sandbox);
				if (!r.ok) return r satisfies FsWriteResult;
				if (input.createOnly) {
					// Use stat (not realpath, already done above) — if it
					// resolves the target exists, which is a createOnly no-go.
					try {
						await sandbox.driver.stat(r.abs);
						return {
							ok: false,
							reason: "io_error",
							detail: "exists and createOnly=true",
						} satisfies FsWriteResult;
					} catch {
						// stat threw → doesn't exist → proceed.
					}
				}
				try {
					// Ensure parent directory exists. Caller's resolve() has
					// already produced an absolute path; extracting the parent
					// without node:path keeps the skill reusable in a plain
					// browser test harness.
					const sep = r.abs.lastIndexOf("/");
					if (sep > 0) {
						const dir = r.abs.slice(0, sep);
						await sandbox.driver.mkdir(dir, { recursive: true });
					}
					await sandbox.driver.writeFile(r.abs, input.content);
					return { ok: true, path: r.abs, byteSize } satisfies FsWriteResult;
				} catch (err) {
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
					const names = await sandbox.driver.readdir(r.abs);
					const cut = names.slice(0, maxLs);
					const entries: FsLsEntry[] = [];
					for (const name of cut) {
						const child = `${r.abs}/${name}`;
						try {
							const cs = await sandbox.driver.stat(child);
							entries.push({
								name,
								isFile: cs.isFile,
								isDirectory: cs.isDirectory,
								size: cs.size,
							});
						} catch {
							// Entry vanished between readdir and stat — skip it
							// silently. Surfacing the race as an error would
							// confuse the LLM for no gain.
						}
					}
					return {
						ok: true,
						entries,
						truncated: names.length > maxLs,
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
