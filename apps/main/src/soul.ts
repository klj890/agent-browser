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
import { readFile, writeFile } from "node:fs/promises";

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
	};
}

/**
 * Reads SOUL.md from disk. Treats ENOENT as "not configured" — we return
 * the default body and (by default) seed the file so the user has something
 * to edit. Any other read error surfaces to the caller; a corrupted SOUL.md
 * should not silently fall back to default because the user may have
 * critical boundaries encoded there.
 */
export class FileSoulProvider implements SoulProvider {
	private readonly path: string;
	private readonly defaultBody: string;
	private readonly seedOnMissing: boolean;
	private readonly fs: {
		readFile: typeof readFile;
		writeFile: typeof writeFile;
	};

	constructor(opts: FileSoulProviderOpts) {
		this.path = opts.path;
		this.defaultBody = opts.defaultBody;
		this.seedOnMissing = opts.seedOnMissing ?? true;
		this.fs = opts.fsImpl ?? { readFile, writeFile };
	}

	async load(): Promise<string> {
		try {
			const raw = await this.fs.readFile(this.path, "utf8");
			if (raw.length > SOUL_MAX_BYTES) {
				throw new Error(
					`soul.md exceeds ${SOUL_MAX_BYTES} bytes (${raw.length})`,
				);
			}
			return raw;
		} catch (err) {
			if (!isEnoent(err)) throw err;
			if (this.seedOnMissing) {
				try {
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
}

/**
 * Append a SOUL.md body to an existing system prompt with a clearly-labelled
 * fence so the LLM (and audit tooling) can tell them apart. Empty / only
 * whitespace body yields the original prompt unchanged.
 */
export function appendSoulToPrompt(systemPrompt: string, soul: string): string {
	// Defang any literal `<!-- soul:end -->` inside the user's body so the
	// outer fence can't be closed prematurely. A malicious or accidental
	// "</soul>" inside preferences would otherwise corrupt audit tooling
	// that scans for the fence boundary and, worst case, let content after
	// the injection point be interpreted as post-SOUL prompt.
	const body = soul
		.trim()
		.replace(/<!-- soul:end -->/g, "<!-- soul:end-escaped -->");
	if (body === "") return systemPrompt;
	// Explicit fence is belt-and-braces: the LLM can already see the section
	// header, but a machine-readable boundary helps future tooling (audit
	// diffing, structured redaction) locate SOUL without parsing markdown.
	return `${systemPrompt}\n\n<!-- soul:start -->\n${body}\n${SOUL_END_FENCE}\n`;
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: string }).code === "ENOENT"
	);
}
