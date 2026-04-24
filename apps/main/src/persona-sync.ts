/**
 * Persona sync (Stage 4.5 → P2-19 multi-source).
 *
 * For every enabled `persona_source` we:
 *   1. GET {source.url}/api/personas?since=<per-source cursor> with Bearer
 *      auth (team sources only — public sources are anonymous).
 *   2. Upsert returned personas into `personas_cache` tagged with source_id.
 *   3. On network failure: fall back to whatever is cached for that source;
 *      a dead source does NOT block other sources (per-source isolation).
 * After all sources have been tried, the aggregated cache is injected into
 * PersonaManager. When two sources publish the same slug, the last write
 * wins — the union of all sources is what PersonaManager sees.
 *
 * Backwards compatibility: `syncPersonasOnce(deps)` is preserved as a
 * convenience that bootstraps a default source from the env vars (if
 * nothing is configured yet) and then delegates to the multi-source path.
 */
import type { Persona, PersonaManager } from "./persona-manager.js";
import {
	bootstrapDefaultSource,
	type PersonaSource,
	PersonaSourceStore,
} from "./persona-sources.js";
import type { AppDatabase } from "./storage/sqlite.js";

export interface RemotePersona {
	slug: string;
	name: string;
	description: string;
	domains: string[];
	allowedTools?: string[];
	contentMd: string;
	lastUpdated: number;
}

export interface PersonaSyncDeps {
	appDb: AppDatabase;
	personaManager: PersonaManager;
	/** Deprecated: prefer configuring a `persona_source` row. Env var fallback. */
	serverUrl?: string;
	token?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export class PersonaCache {
	constructor(private readonly appDb: AppDatabase) {}

	list(): Persona[] {
		const rows = this.appDb.db
			.prepare(
				`SELECT pc.slug, pc.name, pc.description, pc.domains_json, pc.allowed_tools_json,
				        pc.content_md, pc.source_id, ps.name AS source_name, ps.kind AS source_kind
				 FROM personas_cache pc
				 LEFT JOIN persona_sources ps ON ps.id = pc.source_id
				 ORDER BY pc.last_updated DESC`,
			)
			.all() as CacheRow[];
		return rows.map(rowToPersona);
	}

	listBySource(sourceId: string): Persona[] {
		const rows = this.appDb.db
			.prepare(
				`SELECT pc.slug, pc.name, pc.description, pc.domains_json, pc.allowed_tools_json,
				        pc.content_md, pc.source_id, ps.name AS source_name, ps.kind AS source_kind
				 FROM personas_cache pc
				 LEFT JOIN persona_sources ps ON ps.id = pc.source_id
				 WHERE pc.source_id = ?
				 ORDER BY pc.last_updated DESC`,
			)
			.all(sourceId) as CacheRow[];
		return rows.map(rowToPersona);
	}

	upsertMany(items: RemotePersona[], sourceId: string): void {
		const db = this.appDb.db;
		const stmt = db.prepare(
			`INSERT INTO personas_cache (slug, name, description, domains_json, allowed_tools_json, content_md, last_updated, source_id)
			 VALUES (@slug, @name, @description, @domains_json, @allowed_tools_json, @content_md, @last_updated, @source_id)
			 ON CONFLICT(slug) DO UPDATE SET
				name = excluded.name,
				description = excluded.description,
				domains_json = excluded.domains_json,
				allowed_tools_json = excluded.allowed_tools_json,
				content_md = excluded.content_md,
				last_updated = excluded.last_updated,
				source_id = excluded.source_id`,
		);
		const tx = db.transaction((rows: RemotePersona[]) => {
			for (const r of rows) {
				stmt.run({
					slug: r.slug,
					name: r.name,
					description: r.description,
					domains_json: JSON.stringify(r.domains ?? []),
					allowed_tools_json: r.allowedTools
						? JSON.stringify(r.allowedTools)
						: null,
					content_md: r.contentMd ?? "",
					last_updated: r.lastUpdated,
					source_id: sourceId,
				});
			}
		});
		tx(items);
	}

	/** Max last_updated across all rows — kept for backwards compat. */
	lastUpdated(): number {
		const row = this.appDb.db
			.prepare("SELECT MAX(last_updated) AS mx FROM personas_cache")
			.get() as { mx: number | null } | undefined;
		return row?.mx ?? 0;
	}

	/** Max last_updated for a single source — used as the per-source `since`. */
	lastUpdatedForSource(sourceId: string): number {
		const row = this.appDb.db
			.prepare(
				"SELECT MAX(last_updated) AS mx FROM personas_cache WHERE source_id = ?",
			)
			.get(sourceId) as { mx: number | null } | undefined;
		return row?.mx ?? 0;
	}
}

interface CacheRow {
	slug: string;
	name: string;
	description: string;
	domains_json: string;
	allowed_tools_json: string | null;
	content_md: string;
	source_id: string;
	source_name: string | null;
	source_kind: string | null;
}

function rowToPersona(r: CacheRow): Persona {
	let domains: string[] = [];
	try {
		const parsed = JSON.parse(r.domains_json);
		if (Array.isArray(parsed)) domains = parsed.map(String);
	} catch {
		/* ignore */
	}
	let allowedTools: string[] | undefined;
	if (r.allowed_tools_json) {
		try {
			const parsed = JSON.parse(r.allowed_tools_json);
			if (Array.isArray(parsed)) allowedTools = parsed.map(String);
		} catch {
			/* ignore */
		}
	}
	const kind =
		r.source_kind === "team" || r.source_kind === "public"
			? r.source_kind
			: undefined;
	return {
		slug: r.slug,
		name: r.name,
		description: r.description,
		contentMd: r.content_md,
		frontmatter: {
			name: r.name,
			description: r.description,
			domains,
			allowedTools,
		},
		source: kind
			? { id: r.source_id, kind, name: r.source_name ?? r.source_id }
			: undefined,
	};
}

export interface SourceSyncOutcome {
	sourceId: string;
	source: "network" | "cache";
	count: number;
	error?: string;
}

export interface SyncAllResult {
	sources: SourceSyncOutcome[];
	total: number;
}

/**
 * Sync every enabled persona source in parallel, isolating failures.
 * Caller provides the PersonaSourceStore; usually wired by the host.
 */
export async function syncPersonasFromAllSources(deps: {
	appDb: AppDatabase;
	personaManager: PersonaManager;
	sources: PersonaSourceStore;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<SyncAllResult> {
	const cache = new PersonaCache(deps.appDb);
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? 5000;
	const enabled = deps.sources.list({ enabledOnly: true });

	// Parallel per-source fetch with independent failure handling.
	const outcomes = await Promise.all(
		enabled.map(async (src) => {
			try {
				const fetched = await fetchFromSource(src, cache, fetchImpl, timeoutMs);
				if (fetched.length > 0) cache.upsertMany(fetched, src.id);
				return {
					sourceId: src.id,
					source: "network" as const,
					count: fetched.length,
				};
			} catch (err) {
				console.warn(
					`[persona-sync] source '${src.id}' failed, keeping cache:`,
					err,
				);
				const cached = cache.listBySource(src.id);
				return {
					sourceId: src.id,
					source: "cache" as const,
					count: cached.length,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}),
	);

	const all = cache.list();
	deps.personaManager.upsert(all);
	return { sources: outcomes, total: all.length };
}

async function fetchFromSource(
	src: PersonaSource,
	cache: PersonaCache,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<RemotePersona[]> {
	const since = cache.lastUpdatedForSource(src.id);
	const url = `${src.url.replace(/\/$/, "")}/api/personas${
		since > 0 ? `?since=${since}` : ""
	}`;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	const headers: Record<string, string> = { Accept: "application/json" };
	// Public marketplace sources are anonymous — do not attach a token even
	// if one exists in the row (defense-in-depth: token leak prevention).
	if (src.kind === "team" && src.token) {
		headers.Authorization = `Bearer ${src.token}`;
	}
	try {
		const res = await fetchImpl(url, { headers, signal: ctrl.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = (await res.json()) as unknown;
		return normalizePayload(body);
	} finally {
		clearTimeout(t);
	}
}

/**
 * Backwards-compatible entry point. If the source registry is empty and
 * PERSONA_SERVER_URL is set in env, a default 'team' source is created;
 * then the multi-source sync runs as usual.
 */
export async function syncPersonasOnce(deps: PersonaSyncDeps): Promise<{
	source: "network" | "cache";
	count: number;
}> {
	const sources = new PersonaSourceStore(deps.appDb);

	// Explicit override: caller still passed serverUrl/token directly → seed
	// a default source from those. Lets tests/legacy bootstrapping inject.
	if (deps.serverUrl && sources.list().length === 0) {
		sources.upsert({
			id: "default",
			name: "Team Personas",
			url: deps.serverUrl,
			token: deps.token,
			kind: "team",
			enabled: true,
		});
	} else {
		bootstrapDefaultSource(sources);
	}

	const result = await syncPersonasFromAllSources({
		appDb: deps.appDb,
		personaManager: deps.personaManager,
		sources,
		fetchImpl: deps.fetchImpl,
		timeoutMs: deps.timeoutMs,
	});

	// Collapse per-source outcomes into the legacy single-source return shape:
	// "network" if ANY source fetched successfully, else "cache".
	const anyNetwork = result.sources.some((s) => s.source === "network");
	return {
		source: anyNetwork ? "network" : "cache",
		count: result.total,
	};
}

function normalizePayload(body: unknown): RemotePersona[] {
	const arr = Array.isArray(body)
		? body
		: body &&
				typeof body === "object" &&
				Array.isArray((body as { personas?: unknown[] }).personas)
			? (body as { personas: unknown[] }).personas
			: [];
	const out: RemotePersona[] = [];
	for (const item of arr) {
		if (!item || typeof item !== "object") continue;
		const it = item as Record<string, unknown>;
		if (typeof it.slug !== "string" || typeof it.name !== "string") continue;
		out.push({
			slug: it.slug,
			name: it.name,
			description: typeof it.description === "string" ? it.description : "",
			domains: Array.isArray(it.domains) ? it.domains.map(String) : [],
			allowedTools: Array.isArray(it.allowedTools)
				? it.allowedTools.map(String)
				: undefined,
			contentMd:
				typeof it.contentMd === "string"
					? it.contentMd
					: typeof it.content_md === "string"
						? it.content_md
						: "",
			lastUpdated:
				typeof it.lastUpdated === "number"
					? it.lastUpdated
					: typeof it.last_updated === "number"
						? it.last_updated
						: Date.now(),
		});
	}
	return out;
}
