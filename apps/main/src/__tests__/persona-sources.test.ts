import { describe, expect, it, vi } from "vitest";
import { PersonaManager } from "../persona-manager.js";
import {
	bootstrapDefaultSource,
	PersonaSourceStore,
} from "../persona-sources.js";
import {
	PersonaCache,
	type RemotePersona,
	syncPersonasFromAllSources,
} from "../persona-sync.js";
import { AppDatabase } from "../storage/sqlite.js";

function mkDb() {
	return new AppDatabase(":memory:");
}

function remote(slug: string, domains: string[] = []): RemotePersona {
	return {
		slug,
		name: slug,
		description: `desc-${slug}`,
		domains,
		contentMd: `# ${slug}`,
		lastUpdated: Date.now(),
	};
}

describe("PersonaSourceStore", () => {
	it("upsert + list + get round-trip", () => {
		const db = mkDb();
		const store = new PersonaSourceStore(db);
		store.upsert({
			id: "team-main",
			name: "Engineering Team",
			url: "https://team.example.com",
			token: "abc",
			kind: "team",
		});
		store.upsert({
			id: "public-mkt",
			name: "Community Marketplace",
			url: "https://market.example.com",
			kind: "public",
		});
		expect(store.list()).toHaveLength(2);
		expect(store.get("team-main")?.token).toBe("abc");
		expect(store.get("public-mkt")?.kind).toBe("public");
		db.close();
	});

	it("setEnabled toggles visibility in enabledOnly list", () => {
		const db = mkDb();
		const store = new PersonaSourceStore(db);
		store.upsert({
			id: "s",
			name: "s",
			url: "u",
			kind: "team",
			enabled: true,
		});
		store.setEnabled("s", false);
		expect(store.list({ enabledOnly: true })).toHaveLength(0);
		expect(store.list()).toHaveLength(1);
		db.close();
	});

	it("remove purges the source AND its cached personas", () => {
		const db = mkDb();
		const store = new PersonaSourceStore(db);
		store.upsert({ id: "s", name: "s", url: "u", kind: "team" });
		new PersonaCache(db).upsertMany([remote("p1"), remote("p2")], "s");
		expect(new PersonaCache(db).listBySource("s")).toHaveLength(2);
		store.remove("s");
		expect(store.get("s")).toBeUndefined();
		expect(new PersonaCache(db).listBySource("s")).toHaveLength(0);
		db.close();
	});

	it("bootstrapDefaultSource seeds from env when registry is empty", () => {
		const db = mkDb();
		const store = new PersonaSourceStore(db);
		const seeded = bootstrapDefaultSource(store, {
			PERSONA_SERVER_URL: "https://env.example.com",
			PERSONA_SERVER_TOKEN: "envtok",
		});
		expect(seeded?.id).toBe("default");
		expect(seeded?.token).toBe("envtok");
		// Second call is a no-op since registry is now populated.
		const again = bootstrapDefaultSource(store, {
			PERSONA_SERVER_URL: "https://different.example.com",
		});
		expect(again).toBeUndefined();
		db.close();
	});

	it("bootstrapDefaultSource returns undefined when env unset", () => {
		const db = mkDb();
		const store = new PersonaSourceStore(db);
		expect(bootstrapDefaultSource(store, {})).toBeUndefined();
		db.close();
	});
});

describe("syncPersonasFromAllSources", () => {
	it("fetches enabled sources in parallel and unions results in PM", async () => {
		const db = mkDb();
		const sources = new PersonaSourceStore(db);
		sources.upsert({
			id: "team",
			name: "Team",
			url: "https://team",
			kind: "team",
			token: "t1",
		});
		sources.upsert({
			id: "pub",
			name: "Public",
			url: "https://pub",
			kind: "public",
		});
		const pm = new PersonaManager();
		const fetchImpl = vi.fn(async (url: string) => {
			if (String(url).startsWith("https://team")) {
				return { ok: true, json: async () => [remote("a")] } as Response;
			}
			return { ok: true, json: async () => [remote("b")] } as Response;
		}) as unknown as typeof fetch;
		const res = await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(res.total).toBe(2);
		expect(res.sources.every((s) => s.source === "network")).toBe(true);
		expect(pm.getBySlug("a")?.source?.kind).toBe("team");
		expect(pm.getBySlug("b")?.source?.kind).toBe("public");
		db.close();
	});

	it("one source failing does not block the others (failure isolation)", async () => {
		const db = mkDb();
		const sources = new PersonaSourceStore(db);
		sources.upsert({ id: "ok", name: "OK", url: "https://ok", kind: "team" });
		sources.upsert({
			id: "bad",
			name: "Bad",
			url: "https://bad",
			kind: "team",
		});
		const pm = new PersonaManager();
		const fetchImpl = vi.fn(async (url: string) => {
			if (String(url).startsWith("https://bad")) throw new Error("DNS fail");
			return { ok: true, json: async () => [remote("ok-persona")] } as Response;
		}) as unknown as typeof fetch;
		const res = await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(pm.getBySlug("ok-persona")).toBeDefined();
		const bad = res.sources.find((s) => s.sourceId === "bad");
		expect(bad?.source).toBe("cache");
		expect(bad?.error).toMatch(/DNS/);
		db.close();
	});

	it("public sources NEVER send Authorization even if token column is set", async () => {
		const db = mkDb();
		const sources = new PersonaSourceStore(db);
		// Shove a token in directly (e.g. via a buggy admin UI): the fetch
		// path must still strip it for public kind.
		db.db
			.prepare(
				"INSERT INTO persona_sources (id, name, url, token, kind, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
			)
			.run("pub", "Public", "https://pub", "leaked", "public", Date.now());
		const pm = new PersonaManager();
		let seenAuth: string | undefined;
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			seenAuth = (init?.headers as Record<string, string> | undefined)
				?.Authorization;
			return { ok: true, json: async () => [] } as Response;
		}) as unknown as typeof fetch;
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(seenAuth).toBeUndefined();
		db.close();
	});

	it("per-source since cursor: second call advances independently", async () => {
		const db = mkDb();
		const sources = new PersonaSourceStore(db);
		sources.upsert({
			id: "src",
			name: "Src",
			url: "https://srv",
			kind: "team",
		});
		const pm = new PersonaManager();
		const seenUrls: string[] = [];
		const fetchImpl = vi.fn(async (url: string) => {
			seenUrls.push(String(url));
			if (seenUrls.length === 1) {
				return {
					ok: true,
					json: async () => [{ ...remote("p"), lastUpdated: 9999 }],
				} as Response;
			}
			return { ok: true, json: async () => [] } as Response;
		}) as unknown as typeof fetch;
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(seenUrls[0]).toBe("https://srv/api/personas");
		expect(seenUrls[1]).toBe("https://srv/api/personas?since=9999");
		db.close();
	});

	it("same slug from two sources coexists in cache; newest wins in PM", async () => {
		const db = mkDb();
		const sources = new PersonaSourceStore(db);
		sources.upsert({
			id: "team",
			name: "Team",
			url: "https://team",
			kind: "team",
			token: "t",
		});
		sources.upsert({
			id: "pub",
			name: "Public",
			url: "https://pub",
			kind: "public",
		});
		const pm = new PersonaManager();
		const fetchImpl = vi.fn(async (url: string) => {
			if (String(url).startsWith("https://team")) {
				return {
					ok: true,
					json: async () => [
						{
							...remote("assistant", ["team.com"]),
							description: "team copy",
							lastUpdated: 100,
						},
					],
				} as Response;
			}
			return {
				ok: true,
				json: async () => [
					{
						...remote("assistant", ["pub.com"]),
						description: "public copy",
						lastUpdated: 200,
					},
				],
			} as Response;
		}) as unknown as typeof fetch;
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		const cache = new PersonaCache(db);
		// Both rows coexist in the cache — no overwrite.
		expect(cache.listBySource("team")).toHaveLength(1);
		expect(cache.listBySource("pub")).toHaveLength(1);
		// PM picks the newer row on slug collision.
		const picked = pm.getBySlug("assistant");
		expect(picked?.description).toBe("public copy");
		expect(picked?.source?.id).toBe("pub");
		db.close();
	});

	it("per-source since cursor is not contaminated by another source's writes", async () => {
		const db = mkDb();
		const sources = new PersonaSourceStore(db);
		sources.upsert({ id: "a", name: "A", url: "https://a", kind: "team" });
		sources.upsert({ id: "b", name: "B", url: "https://b", kind: "team" });
		const pm = new PersonaManager();
		const fetchImpl = vi.fn(async (url: string) => {
			if (String(url).startsWith("https://a")) {
				return {
					ok: true,
					json: async () => [{ ...remote("p"), lastUpdated: 500 }],
				} as Response;
			}
			return {
				ok: true,
				json: async () => [{ ...remote("p"), lastUpdated: 900 }],
			} as Response;
		}) as unknown as typeof fetch;
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		const cache = new PersonaCache(db);
		expect(cache.lastUpdatedForSource("a")).toBe(500);
		expect(cache.lastUpdatedForSource("b")).toBe(900);
		db.close();
	});

	it("unsubscribing a source clears its personas from PM on next sync (no restart needed)", async () => {
		const db = mkDb();
		const sources = new PersonaSourceStore(db);
		sources.upsert({ id: "team", name: "T", url: "https://t", kind: "team" });
		const pm = new PersonaManager();
		// Inject a *local* persona too; clearRemote must NOT evict it.
		pm.register({
			slug: "local-only",
			name: "Local Only",
			description: "",
			contentMd: "",
			frontmatter: { name: "Local Only", description: "", domains: [] },
			source: { id: "local", kind: "local", name: "Local" },
		});
		const fetchImpl = vi.fn(async () => {
			return {
				ok: true,
				json: async () => [remote("team-one"), remote("team-two")],
			} as Response;
		}) as unknown as typeof fetch;
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(pm.getBySlug("team-one")).toBeDefined();
		expect(pm.getBySlug("local-only")).toBeDefined();
		// Unsubscribe the team source (cascade removes personas_cache rows)
		sources.remove("team");
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(pm.getBySlug("team-one")).toBeUndefined();
		expect(pm.getBySlug("team-two")).toBeUndefined();
		expect(pm.getBySlug("local-only")).toBeDefined(); // local preserved
		db.close();
	});

	it("disabling a source hides its cached personas from cache.list and PM on next sync", async () => {
		const db = mkDb();
		const sources = new PersonaSourceStore(db);
		sources.upsert({ id: "s", name: "S", url: "https://s", kind: "team" });
		const pm = new PersonaManager();
		const fetchImpl = vi.fn(async () => {
			return { ok: true, json: async () => [remote("hidden")] } as Response;
		}) as unknown as typeof fetch;
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(pm.getBySlug("hidden")).toBeDefined();
		// Toggle off without removing — cache row stays, but list() must filter it out.
		sources.setEnabled("s", false);
		const cache = new PersonaCache(db);
		expect(cache.listBySource("s")).toHaveLength(1); // row preserved
		expect(cache.list()).toHaveLength(0); // filtered out via WHERE ps.enabled
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(pm.getBySlug("hidden")).toBeUndefined();
		// Re-enable: sync again and the persona comes back without re-fetch
		sources.setEnabled("s", true);
		await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(pm.getBySlug("hidden")).toBeDefined();
		db.close();
	});

	it("disabled source is skipped", async () => {
		const db = mkDb();
		const sources = new PersonaSourceStore(db);
		sources.upsert({
			id: "off",
			name: "Off",
			url: "https://off",
			kind: "team",
			enabled: false,
		});
		const pm = new PersonaManager();
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const res = await syncPersonasFromAllSources({
			appDb: db,
			personaManager: pm,
			sources,
			fetchImpl,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(res.sources).toHaveLength(0);
		db.close();
	});
});
