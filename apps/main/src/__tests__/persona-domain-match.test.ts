import { describe, expect, it } from "vitest";
import {
	type Persona,
	PersonaManager,
	scoreDomainMatch,
} from "../persona-manager.js";

function mk(slug: string, domains: string[]): Persona {
	return {
		slug,
		name: slug,
		description: slug,
		contentMd: "",
		frontmatter: { name: slug, description: slug, domains },
	};
}

describe("scoreDomainMatch", () => {
	it("exact > suffix glob > wildcard", () => {
		expect(scoreDomainMatch("github.com", "github.com")).toBeGreaterThan(
			scoreDomainMatch("sub.github.com", "*.github.com"),
		);
		// `*.x.com` also matches bare `x.com` per existing domainMatches semantics.
		expect(scoreDomainMatch("x.com", "*.x.com")).toBeGreaterThan(0);
		expect(scoreDomainMatch("a.x.com", "*.x.com")).toBeGreaterThan(
			scoreDomainMatch("a.x.com", "*"),
		);
	});

	it("non-match returns 0", () => {
		expect(scoreDomainMatch("a.com", "b.com")).toBe(0);
		expect(scoreDomainMatch("a.com", "")).toBe(0);
	});
});

describe("PersonaManager.matchByDomain (specificity)", () => {
	it("prefers exact over glob", () => {
		const pm = new PersonaManager();
		const broad = mk("broad", ["*.example.com"]);
		const exact = mk("exact", ["www.example.com"]);
		pm.register(broad);
		pm.register(exact);
		expect(pm.matchByDomain("www.example.com")?.slug).toBe("exact");
		expect(pm.matchByDomain("api.example.com")?.slug).toBe("broad");
	});

	it("accepts hostname or URL", () => {
		const pm = new PersonaManager();
		pm.register(mk("gh", ["*.github.com"]));
		expect(pm.matchByDomain("api.github.com")?.slug).toBe("gh");
		expect(pm.matchByDomain("https://api.github.com/foo")?.slug).toBe("gh");
	});

	it("falls back to browse-helper when no match", () => {
		const pm = new PersonaManager();
		pm.register(mk("browse-helper", []));
		pm.register(mk("other", ["only.net"]));
		expect(pm.matchByDomain("nothing.example")?.slug).toBe("browse-helper");
	});

	it("returns undefined when no match and no browse-helper", () => {
		const pm = new PersonaManager();
		pm.register(mk("other", ["only.net"]));
		expect(pm.matchByDomain("nothing.example")).toBeUndefined();
	});
});

describe("PersonaManager.upsert / loadFromCache", () => {
	it("upsert bulk registers new personas", () => {
		const pm = new PersonaManager();
		pm.upsert([mk("a", []), mk("b", [])]);
		expect(pm.list().map((p) => p.slug)).toEqual(["a", "b"]);
	});

	it("upsert overwrites existing slug", () => {
		const pm = new PersonaManager();
		pm.register(mk("a", ["old.com"]));
		pm.upsert([mk("a", ["new.com"])]);
		expect(pm.getBySlug("a")?.frontmatter.domains).toEqual(["new.com"]);
	});

	it("loadFromCache pulls from a cache-like object", () => {
		const pm = new PersonaManager();
		const cache = { list: () => [mk("c", [])] };
		const loaded = pm.loadFromCache(cache);
		expect(loaded.map((p) => p.slug)).toEqual(["c"]);
		expect(pm.getBySlug("c")).toBeDefined();
	});
});
