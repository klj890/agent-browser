/**
 * PersonaManager (Stage 3.6).
 *
 * Personas are Markdown files with a YAML front matter preamble. They steer
 * the Agent's behaviour per tab/domain. This module:
 *   - Parses the front matter + markdown body into a typed Persona.
 *   - Holds an in-memory registry keyed by slug.
 *   - Matches personas to a URL via glob-style domain patterns so TabManager
 *     can auto-switch when navigating.
 *
 * Front matter is parsed with a tiny hand-rolled YAML subset (strings, lists,
 * nested single-level). We deliberately avoid `gray-matter` / `js-yaml` — the
 * fields we care about are a fixed schema and adding a runtime dep for this
 * feels wasteful.
 *
 * Stage 4.5 will add a sync-from-server path; this file stays local-only.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface PersonaFrontmatter {
	name: string;
	description: string;
	/** glob-style domain patterns, e.g. `*.github.com`, `example.com`. */
	domains: string[];
	/** Optional tool whitelist; empty/undefined = all tools. */
	allowedTools?: string[];
}

/**
 * Provenance attached to a persona so the UI can badge it and the user can
 * unsubscribe a whole source. Local file-system personas get `kind: 'local'`
 * and no url/token. Undefined on legacy personas loaded before P2-19.
 */
export interface PersonaSourceRef {
	id: string;
	kind: "team" | "public" | "local";
	name: string;
}

export interface Persona {
	slug: string;
	name: string;
	description: string;
	contentMd: string;
	frontmatter: PersonaFrontmatter;
	/** Where this persona came from. Added in P2-19. */
	source?: PersonaSourceRef;
}

// ---------------------------------------------------------------------------
// Front matter parsing (minimal YAML subset)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

export class PersonaParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PersonaParseError";
	}
}

/**
 * Parse the inline array `[a, b, c]` or strip quotes from a scalar.
 */
function parseScalarOrArray(raw: string): string | string[] {
	const v = raw.trim();
	if (v.startsWith("[") && v.endsWith("]")) {
		const inner = v.slice(1, -1).trim();
		if (inner === "") return [];
		return inner.split(",").map((s) => stripQuotes(s.trim()));
	}
	return stripQuotes(v);
}

function stripQuotes(v: string): string {
	if (
		(v.startsWith('"') && v.endsWith('"')) ||
		(v.startsWith("'") && v.endsWith("'"))
	) {
		return v.slice(1, -1);
	}
	return v;
}

/**
 * Parse front matter YAML. Supports `key: scalar`, `key: [a, b]` and multiline
 * block lists (`key:\n  - a\n  - b`). Unknown keys are retained as strings.
 */
export function parseFrontmatter(
	yamlBody: string,
): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	const lines = yamlBody.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		i++;
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const valuePart = line.slice(colonIdx + 1).trim();
		if (valuePart === "") {
			// Multiline block list.
			const items: string[] = [];
			while (i < lines.length) {
				const next = lines[i] ?? "";
				const m = /^\s+-\s+(.*)$/.exec(next);
				if (!m) break;
				const raw = m[1] ?? "";
				items.push(stripQuotes(raw.trim()));
				i++;
			}
			out[key] = items;
		} else {
			out[key] = parseScalarOrArray(valuePart);
		}
	}
	return out;
}

function toStringArray(
	v: string | string[] | undefined,
	field: string,
): string[] {
	if (v === undefined) return [];
	if (typeof v === "string") {
		throw new PersonaParseError(`persona field '${field}' must be a list`);
	}
	return v;
}

/**
 * Parse a full persona markdown source (front matter + body).
 */
export function parsePersona(slug: string, source: string): Persona {
	const m = FRONTMATTER_RE.exec(source);
	if (!m) {
		throw new PersonaParseError(`persona '${slug}' missing front matter`);
	}
	const fm = parseFrontmatter(m[1] ?? "");
	const body = m[2] ?? "";

	const name = fm.name;
	const description = fm.description;
	if (typeof name !== "string" || name === "") {
		throw new PersonaParseError(`persona '${slug}' missing 'name'`);
	}
	if (typeof description !== "string" || description === "") {
		throw new PersonaParseError(`persona '${slug}' missing 'description'`);
	}
	const domains = toStringArray(fm.domains, "domains");
	const allowedToolsRaw = fm.allowedTools;
	const allowedTools =
		allowedToolsRaw === undefined
			? undefined
			: toStringArray(allowedToolsRaw, "allowedTools");

	return {
		slug,
		name,
		description,
		contentMd: body.trim(),
		frontmatter: { name, description, domains, allowedTools },
	};
}

// ---------------------------------------------------------------------------
// Domain matcher
// ---------------------------------------------------------------------------

/**
 * Match a host against a glob-style pattern. Supported syntax:
 *   - `example.com`        — exact match
 *   - `*.example.com`      — any single-or-multi-label subdomain (sub.example.com, a.b.example.com)
 *   - `*`                  — wildcard (matches anything)
 * Case-insensitive. Empty pattern never matches.
 */
export function domainMatches(host: string, pattern: string): boolean {
	if (!pattern) return false;
	const h = host.toLowerCase();
	const p = pattern.toLowerCase();
	if (p === "*") return true;
	if (p.startsWith("*.")) {
		const suffix = p.slice(2);
		return h === suffix || h.endsWith(`.${suffix}`);
	}
	return h === p;
}

/**
 * Score a (host, pattern) match. Higher = more specific. 0 = no match.
 */
export function scoreDomainMatch(host: string, pattern: string): number {
	if (!pattern) return 0;
	const h = host.toLowerCase();
	const p = pattern.toLowerCase();
	if (p === "*") return 1;
	if (p.startsWith("*.")) {
		const suffix = p.slice(2);
		if (h === suffix || h.endsWith(`.${suffix}`)) return 500 + suffix.length;
		return 0;
	}
	if (h === p) return 1000 + p.length;
	return 0;
}

function hostFromUrl(url: string): string | null {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class PersonaManager {
	private readonly bySlug = new Map<string, Persona>();

	register(p: Persona): void {
		this.bySlug.set(p.slug, p);
	}

	/** Bulk upsert — used by persona-sync to inject cache/remote personas. */
	upsert(personas: Persona[]): void {
		for (const p of personas) this.bySlug.set(p.slug, p);
	}

	/**
	 * Load personas previously synced to the `personas_cache` SQLite table.
	 * Accepts anything with a `list()` returning Persona[] so callers don't
	 * have to depend on `persona-sync` types here.
	 */
	loadFromCache(cache: { list(): Persona[] }): Persona[] {
		const items = cache.list();
		this.upsert(items);
		return items;
	}

	getBySlug(slug: string): Persona | undefined {
		return this.bySlug.get(slug);
	}

	list(): Persona[] {
		return Array.from(this.bySlug.values());
	}

	/**
	 * Pick the persona whose `domains` glob best matches the input. Accepts
	 * either a hostname (`github.com`) or a full URL. Ranking (higher wins):
	 *   - exact match (e.g. `github.com`)              → 1000 + len
	 *   - suffix glob `*.github.com`                   → 500  + suffix-len
	 *   - bare wildcard `*`                            → 1
	 * Ties are broken by registration order (first wins).
	 *
	 * Falls back to the persona named `browse-helper` if nothing matches.
	 */
	matchByDomain(input: string): Persona | undefined {
		const host =
			input.includes("://") || input.startsWith("//")
				? hostFromUrl(input)
				: input.toLowerCase();
		if (!host) return this.bySlug.get("browse-helper");
		let best: { persona: Persona; score: number } | undefined;
		for (const p of this.bySlug.values()) {
			for (const pattern of p.frontmatter.domains) {
				const s = scoreDomainMatch(host, pattern);
				if (s <= 0) continue;
				if (!best || s > best.score) best = { persona: p, score: s };
			}
		}
		return best?.persona ?? this.bySlug.get("browse-helper");
	}

	/**
	 * Load every `*.md` file under `dir` as a persona. Slug = filename without
	 * extension. Parse errors are surfaced to caller (fail fast during boot).
	 */
	async loadFromDir(dir: string): Promise<Persona[]> {
		const entries = await readdir(dir);
		const loaded: Persona[] = [];
		for (const name of entries) {
			if (!name.endsWith(".md")) continue;
			const slug = name.slice(0, -3);
			const source = await readFile(path.join(dir, name), "utf8");
			const persona = parsePersona(slug, source);
			// Stamp file-system personas with the `local` source so the UI can
			// tell them apart from team/public and so unsubscribing a remote
			// source never wipes the user's own files.
			persona.source = { id: "local", kind: "local", name: "Local" };
			this.register(persona);
			loaded.push(persona);
		}
		return loaded;
	}
}
