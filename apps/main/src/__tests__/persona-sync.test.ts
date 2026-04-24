import { describe, expect, it, vi } from "vitest";
import { PersonaManager } from "../persona-manager.js";
import { PersonaSourceStore } from "../persona-sources.js";
import {
	PersonaCache,
	type RemotePersona,
	syncPersonasOnce,
} from "../persona-sync.js";
import { AppDatabase } from "../storage/sqlite.js";

function mkDb() {
	return new AppDatabase(":memory:");
}

function seedDefaultSource(db: AppDatabase) {
	new PersonaSourceStore(db).upsert({
		id: "default",
		name: "Default",
		url: "http://unused",
		kind: "team",
	});
}

function remote(slug: string, domains: string[]): RemotePersona {
	return {
		slug,
		name: slug,
		description: `desc-${slug}`,
		domains,
		contentMd: `# ${slug}`,
		lastUpdated: Date.now(),
	};
}

describe("PersonaCache", () => {
	it("upsertMany + list round-trip", () => {
		const db = mkDb();
		seedDefaultSource(db);
		const cache = new PersonaCache(db);
		cache.upsertMany(
			[remote("a", ["*.a.com"]), remote("b", ["b.com"])],
			"default",
		);
		const list = cache.list();
		expect(list.map((p) => p.slug).sort()).toEqual(["a", "b"]);
		const a = list.find((p) => p.slug === "a");
		expect(a?.frontmatter.domains).toEqual(["*.a.com"]);
		db.close();
	});

	it("upsert overwrites existing slug", () => {
		const db = mkDb();
		seedDefaultSource(db);
		const cache = new PersonaCache(db);
		cache.upsertMany([remote("a", ["old.com"])], "default");
		cache.upsertMany([remote("a", ["new.com"])], "default");
		expect(cache.list()[0]?.frontmatter.domains).toEqual(["new.com"]);
		db.close();
	});
});

describe("syncPersonasOnce", () => {
	it("uses network when fetch succeeds, writes cache and injects pm", async () => {
		const db = mkDb();
		const pm = new PersonaManager();
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => [remote("gh", ["*.github.com"])],
		}) as unknown as typeof fetch;
		const res = await syncPersonasOnce({
			appDb: db,
			personaManager: pm,
			fetchImpl,
			serverUrl: "http://srv",
			token: "test-token",
		});
		expect(res.source).toBe("network");
		expect(res.count).toBe(1);
		expect(pm.getBySlug("gh")?.name).toBe("gh");
		// Bearer header passed
		const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
			.calls[0];
		expect(
			(call?.[1] as { headers?: Record<string, string> })?.headers
				?.Authorization,
		).toBe("Bearer test-token");
		db.close();
	});

	it("falls back to cache when fetch fails", async () => {
		const db = mkDb();
		const pm = new PersonaManager();
		// Pre-seed cache belonging to a configured source so multi-source
		// sync picks it up on the failure fallback.
		new PersonaCache(db).upsertMany([remote("cached", ["c.com"])], "default");
		const fetchImpl = vi
			.fn()
			.mockRejectedValue(new Error("network")) as unknown as typeof fetch;
		const res = await syncPersonasOnce({
			appDb: db,
			personaManager: pm,
			fetchImpl,
			serverUrl: "http://srv",
		});
		expect(res.source).toBe("cache");
		expect(res.count).toBe(1);
		expect(pm.getBySlug("cached")).toBeDefined();
		db.close();
	});

	it("sends ?since= on subsequent sync", async () => {
		const db = mkDb();
		new PersonaCache(db).upsertMany(
			[{ ...remote("x", ["x.com"]), lastUpdated: 12345 }],
			"default",
		);
		const pm = new PersonaManager();
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => [],
		}) as unknown as typeof fetch;
		await syncPersonasOnce({
			appDb: db,
			personaManager: pm,
			fetchImpl,
			serverUrl: "http://srv",
		});
		const url = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
			.calls[0]?.[0];
		expect(String(url)).toBe("http://srv/api/personas?since=12345");
		db.close();
	});
});
