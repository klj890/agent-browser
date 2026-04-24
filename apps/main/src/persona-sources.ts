/**
 * PersonaSourceStore (P2-19) — registry of remote persona feeds.
 *
 * Replaces the single PERSONA_SERVER_URL model. Each row is one subscription:
 *   - `team` kind: authenticated internal server (company personas)
 *   - `public` kind: anonymous community marketplace
 *
 * Local file-system personas (loadFromDir) are NOT modelled here — they have
 * no URL and no lifecycle; PersonaManager keeps those in-process.
 *
 * Sync runs per enabled source in parallel; one source failing cannot block
 * others (see `syncPersonasFromAllSources`).
 */
import type { AppDatabase } from "./storage/sqlite.js";

export type PersonaSourceKind = "team" | "public";

export interface PersonaSource {
	id: string;
	name: string;
	url: string;
	/** Bearer token for `team`; always undefined for `public` (anonymous). */
	token?: string;
	kind: PersonaSourceKind;
	enabled: boolean;
	createdAt: number;
}

export interface NewPersonaSource {
	id: string;
	name: string;
	url: string;
	token?: string;
	kind: PersonaSourceKind;
	enabled?: boolean;
}

interface SourceRow {
	id: string;
	name: string;
	url: string;
	token: string | null;
	kind: string;
	enabled: number;
	created_at: number;
}

export class PersonaSourceStore {
	constructor(private readonly appDb: AppDatabase) {}

	list(opts: { enabledOnly?: boolean } = {}): PersonaSource[] {
		const rows = (
			opts.enabledOnly
				? this.appDb.db
						.prepare(
							"SELECT id, name, url, token, kind, enabled, created_at FROM persona_sources WHERE enabled = 1 ORDER BY created_at ASC",
						)
						.all()
				: this.appDb.db
						.prepare(
							"SELECT id, name, url, token, kind, enabled, created_at FROM persona_sources ORDER BY created_at ASC",
						)
						.all()
		) as SourceRow[];
		return rows.map(rowToSource);
	}

	get(id: string): PersonaSource | undefined {
		const row = this.appDb.db
			.prepare(
				"SELECT id, name, url, token, kind, enabled, created_at FROM persona_sources WHERE id = ?",
			)
			.get(id) as SourceRow | undefined;
		return row ? rowToSource(row) : undefined;
	}

	upsert(src: NewPersonaSource): PersonaSource {
		const now = Date.now();
		const enabled = src.enabled ?? true;
		this.appDb.db
			.prepare(
				`INSERT INTO persona_sources (id, name, url, token, kind, enabled, created_at)
				 VALUES (@id, @name, @url, @token, @kind, @enabled, @created_at)
				 ON CONFLICT(id) DO UPDATE SET
					 name = excluded.name,
					 url = excluded.url,
					 token = excluded.token,
					 kind = excluded.kind,
					 enabled = excluded.enabled`,
			)
			.run({
				id: src.id,
				name: src.name,
				url: src.url,
				token: src.token ?? null,
				kind: src.kind,
				enabled: enabled ? 1 : 0,
				created_at: now,
			});
		const saved = this.get(src.id);
		if (!saved) throw new Error(`persona_source upsert failed for '${src.id}'`);
		return saved;
	}

	setEnabled(id: string, enabled: boolean): void {
		this.appDb.db
			.prepare("UPDATE persona_sources SET enabled = ? WHERE id = ?")
			.run(enabled ? 1 : 0, id);
	}

	remove(id: string): void {
		// Also purge cached personas belonging to this source so the UI list
		// reflects the unsubscribe immediately (no orphaned entries).
		const db = this.appDb.db;
		const tx = db.transaction((sid: string) => {
			db.prepare("DELETE FROM personas_cache WHERE source_id = ?").run(sid);
			db.prepare("DELETE FROM persona_sources WHERE id = ?").run(sid);
		});
		tx(id);
	}
}

function rowToSource(r: SourceRow): PersonaSource {
	if (r.kind !== "team" && r.kind !== "public") {
		throw new Error(`persona_source '${r.id}' has unknown kind '${r.kind}'`);
	}
	return {
		id: r.id,
		name: r.name,
		url: r.url,
		token: r.token ?? undefined,
		kind: r.kind,
		enabled: r.enabled !== 0,
		createdAt: r.created_at,
	};
}

/**
 * Bootstrap the default team source from the legacy env vars
 * PERSONA_SERVER_URL / PERSONA_SERVER_TOKEN, but only if the user has not
 * configured any sources yet. Lets existing deployments upgrade silently.
 */
export function bootstrapDefaultSource(
	store: PersonaSourceStore,
	env: NodeJS.ProcessEnv = process.env,
): PersonaSource | undefined {
	if (store.list().length > 0) return undefined;
	const url = env.PERSONA_SERVER_URL;
	if (!url) return undefined;
	return store.upsert({
		id: "default",
		name: "Team Personas",
		url,
		token: env.PERSONA_SERVER_TOKEN || undefined,
		kind: "team",
		enabled: true,
	});
}
