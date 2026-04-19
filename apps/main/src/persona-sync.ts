/**
 * Persona sync (Stage 4.5).
 *
 * On boot: GET {server}/api/personas?since=<last_updated> with Bearer auth.
 * Writes to `personas_cache`; on network failure falls back to cache.
 * Injects the resulting personas into PersonaManager.
 */
import type { Persona, PersonaManager } from "./persona-manager.js";
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
				`SELECT slug, name, description, domains_json, allowed_tools_json, content_md
				 FROM personas_cache ORDER BY last_updated DESC`,
			)
			.all() as Array<{
			slug: string;
			name: string;
			description: string;
			domains_json: string;
			allowed_tools_json: string | null;
			content_md: string;
		}>;
		return rows.map((r) => rowToPersona(r));
	}

	upsertMany(items: RemotePersona[]): void {
		const db = this.appDb.db;
		const stmt = db.prepare(
			`INSERT INTO personas_cache (slug, name, description, domains_json, allowed_tools_json, content_md, last_updated)
			 VALUES (@slug, @name, @description, @domains_json, @allowed_tools_json, @content_md, @last_updated)
			 ON CONFLICT(slug) DO UPDATE SET
				name = excluded.name,
				description = excluded.description,
				domains_json = excluded.domains_json,
				allowed_tools_json = excluded.allowed_tools_json,
				content_md = excluded.content_md,
				last_updated = excluded.last_updated`,
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
				});
			}
		});
		tx(items);
	}

	lastUpdated(): number {
		const row = this.appDb.db
			.prepare("SELECT MAX(last_updated) AS mx FROM personas_cache")
			.get() as { mx: number | null } | undefined;
		return row?.mx ?? 0;
	}
}

function rowToPersona(r: {
	slug: string;
	name: string;
	description: string;
	domains_json: string;
	allowed_tools_json: string | null;
	content_md: string;
}): Persona {
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
	};
}

export async function syncPersonasOnce(deps: PersonaSyncDeps): Promise<{
	source: "network" | "cache";
	count: number;
}> {
	const cache = new PersonaCache(deps.appDb);
	const serverUrl =
		deps.serverUrl ?? process.env.PERSONA_SERVER_URL ?? "http://localhost:3100";
	const token = deps.token ?? process.env.PERSONA_SERVER_TOKEN;
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? 5000;

	const since = cache.lastUpdated();
	const url = `${serverUrl.replace(/\/$/, "")}/api/personas${
		since > 0 ? `?since=${since}` : ""
	}`;

	let fetched: RemotePersona[] | null = null;
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		const headers: Record<string, string> = { Accept: "application/json" };
		if (token) headers.Authorization = `Bearer ${token}`;
		const res = await fetchImpl(url, {
			headers,
			signal: ctrl.signal,
		});
		clearTimeout(t);
		if (!res.ok) throw new Error(`persona-sync HTTP ${res.status}`);
		const body = (await res.json()) as unknown;
		fetched = normalizePayload(body);
	} catch (err) {
		console.warn("[persona-sync] network failed, falling back to cache:", err);
	}

	if (fetched && fetched.length > 0) {
		cache.upsertMany(fetched);
	}
	const all = cache.list();
	// Inject into PersonaManager
	const pm = deps.personaManager;
	if (typeof pm.upsert === "function") {
		pm.upsert(all);
	} else {
		for (const p of all) pm.register(p);
	}
	return {
		source: fetched ? "network" : "cache",
		count: all.length,
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
