/**
 * SOUL.md (P2 §2.2, BrowserOS-inspired).
 *
 * A single Markdown file the user edits to steer the Agent's long-lived
 * behaviour — communication style, hard boundaries, preferences. Injected
 * at the end of the system prompt on every task, AFTER persona body, so
 * that it applies across personas.
 *
 * Clear separation of concerns (mirrors BrowserOS):
 *   - **SOUL**:    "how I want the Agent to behave"  (stable, per-user)
 *   - **Persona**: "what role for this task/domain"  (short-lived, per-domain)
 *   - **Memory**:  "what the Agent knows about me"   (factual, future stage)
 *
 * This round implements **read-only** injection. Agent-initiated updates
 * (the "SOUL.md auto-evolution" from BrowserOS) are deliberately deferred
 * to a separate PR because they need AuditLog integration + confirmation
 * gate — self-modifying system prompt is high-trust territory.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Cap on SOUL.md size. Anything larger blows up LLM context cost and is
 * almost certainly not a preferences file (someone pasted a document by
 * mistake). 64KB is generous enough for thousands of preference lines
 * while bounding memory + tokens — loadout fails closed with a clear
 * error rather than silently smuggling a huge payload into every prompt.
 */
const SOUL_MAX_BYTES = 64 * 1024;

/** Literal text of the trailing fence. Kept as a single source of truth so
 * both the appender and the sanitiser agree. */
const SOUL_END_FENCE = "<!-- soul:end -->";

/**
 * Shipped default — written to disk on first launch so the user always has
 * a concrete file to edit. Kept inline (not loaded from a .md resource) so
 * the Electron build doesn't need a custom asset-copy step.
 */
export const DEFAULT_SOUL_BODY = `# SOUL — long-lived user preferences for this Agent

Edit this file to steer the Agent's style and boundaries. Everything below is
injected at the end of the system prompt on every task, after the persona
content, so it applies across personas.

**Scope**: this is "how I want the Agent to behave" — communication style,
boundaries, personal preferences. It is NOT a place for facts about the user,
ongoing projects, or session context (those belong in Memory, feature coming
in a later release).

## Core truths

- _(none yet — add sentences like "I prefer concise replies", "Never send
  email without my explicit approval", "Always cite source URLs".)_

## Communication style

- _(none yet — add lines like "Prefer bullet points over paragraphs",
  "Skip the praise, get to the point", "Ask clarifying questions when the
  task is ambiguous rather than guessing".)_

## Hard boundaries

- _(none yet — add items the Agent must never do regardless of autonomy
  level, e.g. "Never open incognito tabs for me automatically", "Never
  fill in my credit-card number even if the page looks trustworthy".)_

## Preferences

- _(none yet — add items like "Default time zone is Asia/Shanghai",
  "When summarising, prefer original-language quotes plus English
  paraphrase".)_
`;

export interface SoulProvider {
	/** Return the markdown body to append to the system prompt. */
	load(): Promise<string>;
}

/**
 * Result of a successful {@link MutableSoulProvider.amend} call. Used by the
 * audit-log adapter so an outside observer can replay "what did the Agent
 * write into SOUL" without re-reading the file (which by then may already
 * contain a later edit).
 */
export interface SoulAmendResult {
	/** Section heading the bullet was added under (canonical, no leading `##`). */
	section: string;
	/** First 200 chars of the bullet text — enough to skim in the trace UI. */
	bulletExcerpt: string;
	/** sha256 of the file content before the write (`""` if file did not exist). */
	beforeHash: string;
	/** sha256 of the file content after the write. */
	afterHash: string;
	/** Byte size of the post-write file (utf-8). */
	byteSize: number;
	/** True if the section header was created by this call. */
	createdSection: boolean;
}

/**
 * Provider variant that the Agent itself can write to. The split lets unit
 * tests / read-only contexts keep using {@link SoulProvider} without
 * accidentally pulling in the write path.
 */
export interface MutableSoulProvider extends SoulProvider {
	/**
	 * Append a single bullet under a named section. If the section is missing,
	 * create it at the end of the file. Atomic against concurrent calls — the
	 * write goes to a temp file then renames over the target.
	 *
	 * Throws if the post-amend file would exceed the size cap, leaving the
	 * existing file untouched (fail-closed).
	 */
	amend(req: SoulAmendRequest): Promise<SoulAmendResult>;
}

export interface SoulAmendRequest {
	/** Heading text without leading `##` (e.g. "Hard boundaries"). Whitespace-trimmed. */
	section: string;
	/** Bullet body without leading `- `. Whitespace-trimmed. */
	bullet: string;
}

export interface FileSoulProviderOpts {
	/** Absolute path to the user's SOUL.md. */
	path: string;
	/** Fallback content used when the file does not exist. */
	defaultBody: string;
	/**
	 * If true (default), the default body is written to `path` on first read
	 * so the user has a concrete file to edit. Set to false for tests or
	 * read-only contexts.
	 */
	seedOnMissing?: boolean;
	fsImpl?: {
		readFile: typeof readFile;
		writeFile: typeof writeFile;
		mkdir: typeof mkdir;
	};
}

/**
 * Reads SOUL.md from disk. Treats ENOENT as "not configured" — we return
 * the default body and (by default) seed the file so the user has something
 * to edit. Any other read error surfaces to the caller; a corrupted SOUL.md
 * should not silently fall back to default because the user may have
 * critical boundaries encoded there.
 *
 * Implements {@link MutableSoulProvider}; the Agent self-evolution path
 * (P2 §2.2 follow-up) calls {@link amend} via a confirmation-gated tool.
 */
export class FileSoulProvider implements MutableSoulProvider {
	private readonly path: string;
	private readonly defaultBody: string;
	private readonly seedOnMissing: boolean;
	private readonly fs: {
		readFile: typeof readFile;
		writeFile: typeof writeFile;
		mkdir: typeof mkdir;
	};
	/**
	 * Per-instance promise chain that serialises concurrent amends. Two
	 * Agent loops in different tabs both calling `soul_amend` would race
	 * read-modify-write otherwise; the second writer would clobber the
	 * first. Chaining via promise (rather than a re-entrant mutex lib)
	 * keeps the dependency footprint zero.
	 */
	private amendChain: Promise<unknown> = Promise.resolve();

	constructor(opts: FileSoulProviderOpts) {
		this.path = opts.path;
		this.defaultBody = opts.defaultBody;
		this.seedOnMissing = opts.seedOnMissing ?? true;
		this.fs = opts.fsImpl ?? { readFile, writeFile, mkdir };
	}

	async load(): Promise<string> {
		try {
			// Read as Buffer so we can bound by real byte count. Using
			// `readFile(..., "utf8").length` counts UTF-16 code units — a
			// file of Chinese/emoji text would under-report its size and
			// sneak past the 64KB cap. `readFile(path)` with no encoding
			// already returns Promise<Buffer>, no cast needed.
			const buf = await this.fs.readFile(this.path);
			if (buf.byteLength > SOUL_MAX_BYTES) {
				throw new Error(
					`soul.md exceeds ${SOUL_MAX_BYTES} bytes (${buf.byteLength})`,
				);
			}
			return buf.toString("utf8");
		} catch (err) {
			if (!isEnoent(err)) throw err;
			if (this.seedOnMissing) {
				try {
					// Ensure parent exists — on first launch agent-browser's
					// userData/agent-browser/ may not be created yet.
					await this.fs.mkdir(path.dirname(this.path), { recursive: true });
					await this.fs.writeFile(this.path, this.defaultBody, "utf8");
				} catch (seedErr) {
					// Non-fatal: caller still gets the default body below.
					// Surface the reason so the user can see why their
					// `soul.md` wasn't created (e.g. parent dir missing,
					// readonly fs). A silent failure here led to hours of
					// "my edits don't apply" confusion in review.
					console.warn(
						`[soul] seed write failed at ${this.path}: ${
							seedErr instanceof Error ? seedErr.message : String(seedErr)
						}`,
					);
				}
			}
			return this.defaultBody;
		}
	}

	async amend(req: SoulAmendRequest): Promise<SoulAmendResult> {
		// Serialize through the per-instance chain. We swallow the chain's
		// rejection so a single failed amend doesn't poison subsequent ones,
		// but the *current* call still surfaces its own error via `next`.
		const next = this.amendChain.then(
			() => this.amendOne(req),
			() => this.amendOne(req),
		);
		this.amendChain = next.catch(() => undefined);
		return next;
	}

	private async amendOne(req: SoulAmendRequest): Promise<SoulAmendResult> {
		const section = req.section.trim();
		const bullet = req.bullet.trim();
		if (section === "") throw new Error("soul.amend: section is empty");
		if (bullet === "") throw new Error("soul.amend: bullet is empty");
		// One bullet = one line. Multi-line bullets would either break our
		// "find end of section by next heading" walk or smuggle a heading
		// past the section header check below. Force the LLM to split.
		if (/[\r\n]/.test(bullet)) {
			throw new Error("soul.amend: bullet must be a single line");
		}
		// Reject markdown structural tokens in the section name. Without this
		// the Agent could pass `Boundaries\n## Evil` as a section and forge
		// a sibling heading. We also forbid leading `#` to avoid double-hash.
		if (
			/[\r\n]/.test(section) ||
			section.includes("##") ||
			section.startsWith("#")
		) {
			throw new Error("soul.amend: section name has reserved characters");
		}
		// Defang the same fence tokens appendSoulToPrompt strips so the user's
		// in-prompt SOUL block stays well-formed even after the LLM writes a
		// trick payload back through this tool.
		const safeSection = defangFence(section);
		const safeBullet = defangFence(bullet);

		let beforeBody: string;
		try {
			const buf = await this.fs.readFile(this.path);
			if (buf.byteLength > SOUL_MAX_BYTES) {
				throw new Error(
					`soul.md exceeds ${SOUL_MAX_BYTES} bytes (${buf.byteLength})`,
				);
			}
			beforeBody = buf.toString("utf8");
		} catch (err) {
			if (!isEnoent(err)) throw err;
			// File not yet on disk — operate against the seeded default so the
			// user's edits land on the same template `load()` would have
			// shown. The audit `before_hash` reflects this synthetic basis,
			// which is what an auditor diffing the trace will compare against.
			beforeBody = this.defaultBody;
		}

		const { body: afterBody, createdSection } = insertBullet(
			beforeBody,
			safeSection,
			safeBullet,
		);
		const afterBuf = Buffer.from(afterBody, "utf8");
		// Fail-closed cap check BEFORE writing — exceeding this leaves the
		// existing file untouched (atomic property: no temp file, no rename).
		if (afterBuf.byteLength > SOUL_MAX_BYTES) {
			throw new Error(
				`soul.amend would exceed ${SOUL_MAX_BYTES} bytes (${afterBuf.byteLength})`,
			);
		}

		const beforeHash = sha256(Buffer.from(beforeBody, "utf8"));
		const afterHash = sha256(afterBuf);

		// Atomic write: temp file in the same directory + rename. POSIX
		// rename within one filesystem is atomic; on Windows it's "best
		// effort" but still does not produce a torn read. Random suffix
		// avoids collisions if two providers point at the same file.
		await mkdir(path.dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			await writeFile(tmp, afterBuf);
			await rename(tmp, this.path);
		} catch (err) {
			// Best-effort cleanup. A leaked .tmp file is a cosmetic issue,
			// not a security one — it's the same content we tried to write.
			await unlink(tmp).catch(() => undefined);
			throw err;
		}

		return {
			section: safeSection,
			bulletExcerpt: truncate(safeBullet, 200),
			beforeHash,
			afterHash,
			byteSize: afterBuf.byteLength,
			createdSection,
		};
	}
}

/**
 * Insert a `- bullet` line under the named section. If the section is
 * absent, append a fresh `## section` block at file end.
 *
 * Algorithm:
 *   1. Find the first line whose trimmed content equals `## {section}`
 *      (case-insensitive). That's the section header.
 *   2. Walk forward to the next line starting with `# ` or `## ` — that's
 *      the section's exclusive end. EOF if none.
 *   3. Insert before any trailing blank lines so the bullet sits flush
 *      with the section's existing content.
 *
 * Heading match is case-insensitive because users naturally write
 * "Hard boundaries" while the LLM might propose "Hard Boundaries"; we'd
 * rather merge than fork the section silently.
 */
export function insertBullet(
	body: string,
	section: string,
	bullet: string,
): { body: string; createdSection: boolean } {
	const lines = body.split("\n");
	const targetLc = `## ${section}`.toLowerCase();
	let sectionStart = -1;
	for (let i = 0; i < lines.length; i++) {
		// `i` is bounded by `lines.length`; `?? ""` is just to satisfy
		// noUncheckedIndexedAccess without changing semantics.
		if ((lines[i] ?? "").trim().toLowerCase() === targetLc) {
			sectionStart = i;
			break;
		}
	}
	if (sectionStart === -1) {
		// No section: append. Strip trailing whitespace so we don't emit
		// runs of blank lines after repeated amends, then re-add a single
		// trailing newline for the conventional file ending.
		const trimmed = body.replace(/\s+$/, "");
		const prefix = trimmed === "" ? "" : `${trimmed}\n\n`;
		return {
			body: `${prefix}## ${section}\n\n- ${bullet}\n`,
			createdSection: true,
		};
	}
	let sectionEnd = lines.length;
	for (let i = sectionStart + 1; i < lines.length; i++) {
		const t = (lines[i] ?? "").trimStart();
		// Treat any `# ` / `## ` heading as a section boundary. Same-level
		// headings are the natural separator; deeper ones like `### sub`
		// belong to the *current* section, so we keep inserting below
		// them — the `{1,2}` bound limits the match to one or two `#`.
		if (/^#{1,2}\s/.test(t)) {
			sectionEnd = i;
			break;
		}
	}
	let insertAt = sectionEnd;
	while (
		insertAt > sectionStart + 1 &&
		(lines[insertAt - 1] ?? "").trim() === ""
	) {
		insertAt--;
	}
	lines.splice(insertAt, 0, `- ${bullet}`);
	return { body: lines.join("\n"), createdSection: false };
}

function defangFence(s: string): string {
	return s
		.replace(/<!--\s*soul:start\s*-->/g, "<!-- soul:start-escaped -->")
		.replace(/<!--\s*soul:end\s*-->/g, "<!-- soul:end-escaped -->");
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) : s;
}

/**
 * Append a SOUL.md body to an existing system prompt with a clearly-labelled
 * fence so the LLM (and audit tooling) can tell them apart. Empty / only
 * whitespace body yields the original prompt unchanged.
 */
export function appendSoulToPrompt(systemPrompt: string, soul: string): string {
	// Defang any literal `soul:start` / `soul:end` fence tokens inside the
	// user's body so the outer fence can't be closed prematurely or a fake
	// inner section injected. Accept whitespace variants (`<!--soul:end-->`,
	// `<!--  soul:end  -->`, etc.) because downstream audit tooling scans
	// loosely; matching only the canonical spelling would leave an escape.
	const body = soul
		.trim()
		.replace(/<!--\s*soul:start\s*-->/g, "<!-- soul:start-escaped -->")
		.replace(/<!--\s*soul:end\s*-->/g, "<!-- soul:end-escaped -->");
	if (body === "") return systemPrompt;
	// trimEnd() on the prompt so appendPersonaBody's trailing "\n" doesn't
	// compound with our "\n\n" into a run of three blank lines. Explicit
	// fence is belt-and-braces: the LLM can already see the section header,
	// but a machine-readable boundary helps future tooling (audit diffing,
	// structured redaction) locate SOUL without parsing markdown.
	return `${systemPrompt.trimEnd()}\n\n<!-- soul:start -->\n${body}\n${SOUL_END_FENCE}\n`;
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: string }).code === "ENOENT"
	);
}
