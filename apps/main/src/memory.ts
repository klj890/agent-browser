/**
 * Memory (P2 §2.1, BrowserOS-inspired two-layer design).
 *
 * Clean job split, mirrored from BrowserOS:
 *   - **CORE.md** (single file): permanent facts about the user — name,
 *     recurring projects, tool preferences, aliases. User deletes manually.
 *   - **daily/YYYY-MM-DD.md** (per-day files, append-only): session notes
 *     and transient context. Auto-GC'd after 30 days so the Agent doesn't
 *     drag a year of noise into every prompt.
 *
 * Separation from SOUL.md (§2.2):
 *   - SOUL: "how I want the Agent to behave" — injected into system prompt.
 *   - Memory: "what the Agent knows about me" — retrieved on demand via
 *     `memory_search`; CORE is also summarised into the system prompt.
 *
 * Search approach (this round): simple AND-keyword match over section-split
 * content, ranked by keyword hit count. BrowserOS uses Fuse.js for fuzzy
 * matching; we defer fuzzy until real usage shows it's needed — a dep-free
 * implementation keeps the startup cost where it matters (today: the Agent
 * loop, not a keyword grep).
 *
 * Scope (intentional):
 *   - **Read + search only in this PR's skill layer.** Agent self-write is
 *     a follow-up because it needs confirmation-gate + AuditLog wiring,
 *     same trajectory as SOUL.md's two-step rollout.
 *   - `MemoryStore.writeCore / appendDaily` are exported so IPC handlers
 *     (next increment) can plug the UI directly. No new tools exposed here.
 */
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface MemoryStoreOpts {
	/** Directory containing CORE.md + daily/. Usually `<userData>/agent-browser/memory`. */
	dir: string;
	/** Days before daily entries are GC'd. Default 30, aligning with BrowserOS. */
	dailyRetentionDays?: number;
	/** Maximum CORE.md size in bytes. Same rationale as SOUL.md's cap. */
	maxCoreBytes?: number;
	/** Injected clock for deterministic tests. */
	now?: () => Date;
}

export interface MemorySearchHit {
	/** Which file contributed the hit — `core` or `YYYY-MM-DD`. */
	source: string;
	/** Section heading the match sits under (`##` line), or `""` at file head. */
	section: string;
	/** The matched line, trimmed. */
	line: string;
	/** Number of input keywords that matched (case-insensitive). */
	matchedKeywords: number;
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_CORE_BYTES = 64 * 1024;
const DEFAULT_SEARCH_LIMIT = 10;
const CORE_FILENAME = "CORE.md";
const DAILY_DIR = "daily";
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

const DEFAULT_CORE_BODY = `# CORE memory — long-lived facts about me

The Agent reads this file on every task (same slot as SOUL.md for
behaviour, but Memory is for *facts*). Add sentences like:

- "My name is Alice."
- "I work on the payments team at Acme."
- "Prefer kilobytes in powers of 1024, not 1000."

Delete anything you don't want the Agent to remember — nothing is cloud-
synced, everything lives in this file on your machine.
`;

export class MemoryStore {
	private readonly dir: string;
	private readonly dailyDir: string;
	private readonly corePath: string;
	private readonly retentionDays: number;
	private readonly maxCoreBytes: number;
	private readonly now: () => Date;

	constructor(opts: MemoryStoreOpts) {
		this.dir = opts.dir;
		this.dailyDir = path.join(this.dir, DAILY_DIR);
		this.corePath = path.join(this.dir, CORE_FILENAME);
		this.retentionDays = opts.dailyRetentionDays ?? DEFAULT_RETENTION_DAYS;
		this.maxCoreBytes = opts.maxCoreBytes ?? DEFAULT_MAX_CORE_BYTES;
		this.now = opts.now ?? (() => new Date());
	}

	/**
	 * Read CORE.md. Seeds the file with a template on first access so the
	 * user has something concrete to edit (same UX as SOUL.md).
	 */
	async readCore(): Promise<string> {
		try {
			// Size-gate BEFORE reading so an accidentally-bloated file (e.g.
			// a rogue writer appended GB of junk) doesn't page into memory
			// just to fail the guard. `stat` is cheap; readFile is not when
			// the file is hostile.
			const s = await stat(this.corePath);
			if (s.size > this.maxCoreBytes) {
				throw new Error(
					`CORE.md exceeds ${this.maxCoreBytes} bytes (${s.size})`,
				);
			}
			const raw = await readFile(this.corePath);
			return new TextDecoder("utf-8").decode(raw);
		} catch (err) {
			if (!isEnoent(err)) throw err;
			await mkdir(this.dir, { recursive: true });
			await writeFile(this.corePath, DEFAULT_CORE_BODY, "utf-8").catch(() => {
				/* non-fatal */
			});
			return DEFAULT_CORE_BODY;
		}
	}

	/** Overwrite CORE.md. Caller is responsible for any user confirmation. */
	async writeCore(body: string): Promise<void> {
		const bytes = new TextEncoder().encode(body);
		if (bytes.byteLength > this.maxCoreBytes) {
			throw new Error(
				`CORE.md write rejected: ${bytes.byteLength} > ${this.maxCoreBytes}`,
			);
		}
		await mkdir(this.dir, { recursive: true });
		await writeFile(this.corePath, bytes);
	}

	/**
	 * Append a bulleted note to today's daily file, creating it if absent.
	 * Each append gets an ISO-8601 timestamp prefix so chronological order
	 * is visible when the user opens the file.
	 */
	async appendDaily(note: string): Promise<void> {
		const clean = note.trim();
		if (clean === "") return;
		await mkdir(this.dailyDir, { recursive: true });
		const date = this.todayIso();
		const file = path.join(this.dailyDir, `${date}.md`);
		const ts = this.now().toISOString();
		const line = `- [${ts}] ${clean}\n`;
		// Atomic first-write vs subsequent-append. The old read-modify-write
		// pattern raced under concurrent appends — two simultaneous calls
		// could both read "" and each write their own header-plus-line,
		// the second overwriting the first. Now:
		//   • wx flag creates file exclusively; the winning caller writes
		//     header + its own line; losers get EEXIST.
		//   • EEXIST branch calls appendFile, which the OS guarantees lands
		//     as an atomic tail-write (O_APPEND / FILE_APPEND_DATA). Safe
		//     for any number of concurrent callers.
		try {
			await writeFile(file, `# ${date}\n\n${line}`, { flag: "wx" });
		} catch (err) {
			if ((err as { code?: string } | null)?.code !== "EEXIST") throw err;
			await appendFile(file, line);
		}
	}

	/** Read a specific daily file by ISO date. Empty string if missing. */
	async readDaily(date: string): Promise<string> {
		const file = path.join(this.dailyDir, `${date}.md`);
		try {
			return await readFile(file, "utf-8");
		} catch (err) {
			if (!isEnoent(err)) throw err;
			return "";
		}
	}

	/** List daily entries in descending date order, newest first. */
	async listDailyDates(): Promise<string[]> {
		try {
			const names = await readdir(this.dailyDir);
			return names
				.map((n) => n.match(DAILY_FILE_RE)?.[1])
				.filter((d): d is string => typeof d === "string")
				.sort()
				.reverse();
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	}

	/**
	 * Search across CORE + every daily file. Returns up to `limit` hits
	 * ranked by number of matched keywords (desc) then recency (daily
	 * date desc; CORE slots above same-score daily).
	 */
	async search(
		query: string,
		limit = DEFAULT_SEARCH_LIMIT,
	): Promise<MemorySearchHit[]> {
		const keywords = tokenise(query);
		if (keywords.length === 0) return [];
		// Read CORE and every daily file in parallel. With the default
		// 30-day retention, the old sequential loop did 30 round-trips in
		// the worst case — one missing fsync pause and the Agent step loop
		// stalled visibly. Promise.all caps it at a single wall-clock
		// latency, bounded only by how many files the kernel will open
		// concurrently.
		const [coreText, dates] = await Promise.all([
			this.readCore().catch(() => ""),
			this.listDailyDates(),
		]);
		const dailyResults = await Promise.all(
			dates.map(async (date) => {
				const text = await this.readDaily(date);
				return scanSource(text, date, keywords);
			}),
		);
		// CORE first so equally-scored hits prefer permanent facts.
		const hits: MemorySearchHit[] = [
			...scanSource(coreText, "core", keywords),
			...dailyResults.flat(),
		];
		hits.sort((a, b) => {
			if (b.matchedKeywords !== a.matchedKeywords) {
				return b.matchedKeywords - a.matchedKeywords;
			}
			// Tie-break: core > daily, then newer daily > older.
			if (a.source === "core" && b.source !== "core") return -1;
			if (b.source === "core" && a.source !== "core") return 1;
			return a.source < b.source ? 1 : -1;
		});
		return hits.slice(0, limit);
	}

	/**
	 * Delete daily files whose date is older than `retentionDays` ago.
	 * Returns the number of files removed; 0 if directory is missing.
	 */
	async gcDaily(): Promise<number> {
		let names: string[];
		try {
			names = await readdir(this.dailyDir);
		} catch (err) {
			if (isEnoent(err)) return 0;
			throw err;
		}
		const cutoff = new Date(this.now().getTime());
		cutoff.setUTCDate(cutoff.getUTCDate() - this.retentionDays);
		const cutoffIso = cutoff.toISOString().slice(0, 10);
		let removed = 0;
		for (const n of names) {
			const m = n.match(DAILY_FILE_RE);
			if (!m) continue;
			const date = m[1] as string;
			if (date >= cutoffIso) continue;
			try {
				await unlink(path.join(this.dailyDir, n));
				removed++;
			} catch {
				/* best-effort — another process may have removed it */
			}
		}
		return removed;
	}

	/**
	 * Cheap summary of CORE suitable for system-prompt injection. Strips
	 * the boilerplate "help" paragraphs the default template seeds with so
	 * a pristine Memory doesn't waste tokens. Returns "" when nothing
	 * useful is left.
	 */
	async coreSummary(): Promise<string> {
		const body = await this.readCore();
		// Detect the default template by checking for its distinct header.
		if (body.startsWith(DEFAULT_CORE_BODY.slice(0, 40))) return "";
		return body.trim();
	}

	private todayIso(): string {
		return this.now().toISOString().slice(0, 10);
	}
}

function tokenise(q: string): string[] {
	return q
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

interface Section {
	heading: string;
	lines: string[];
}

function splitSections(text: string): Section[] {
	const sections: Section[] = [{ heading: "", lines: [] }];
	for (const raw of text.split(/\r?\n/)) {
		if (/^##\s/.test(raw)) {
			sections.push({ heading: raw.replace(/^##\s*/, "").trim(), lines: [] });
		} else {
			sections[sections.length - 1]?.lines.push(raw);
		}
	}
	return sections;
}

function scanSource(
	text: string,
	source: string,
	keywords: string[],
): MemorySearchHit[] {
	if (text.trim() === "") return [];
	const out: MemorySearchHit[] = [];
	for (const sec of splitSections(text)) {
		for (const line of sec.lines) {
			if (line.trim() === "") continue;
			const lower = line.toLowerCase();
			let matched = 0;
			for (const kw of keywords) if (lower.includes(kw)) matched++;
			// Strict AND: the tool contract (`memory_search` description) says
			// "keywords are AND-matched". Returning lines that matched just
			// one of three requested terms floods the LLM context with
			// false positives and breaks the user's mental model of the
			// query. matchedKeywords is still carried for the ordering step
			// (all results now have the same count by construction, but the
			// field remains useful once partial-match modes get added).
			if (matched === keywords.length) {
				out.push({
					source,
					section: sec.heading,
					line: line.trim(),
					matchedKeywords: matched,
				});
			}
		}
	}
	return out;
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: string }).code === "ENOENT"
	);
}
