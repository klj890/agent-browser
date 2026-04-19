import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	domainMatches,
	PersonaManager,
	PersonaParseError,
	parseFrontmatter,
	parsePersona,
} from "../persona-manager.js";

describe("PersonaManager — front matter parsing", () => {
	it("parses scalar fields + inline list", () => {
		const fm = parseFrontmatter(
			[
				'name: "Browse Helper"',
				"description: Helpful",
				"domains: [a.com, b.com]",
				"allowedTools: [snapshot, read]",
			].join("\n"),
		);
		expect(fm.name).toBe("Browse Helper");
		expect(fm.description).toBe("Helpful");
		expect(fm.domains).toEqual(["a.com", "b.com"]);
		expect(fm.allowedTools).toEqual(["snapshot", "read"]);
	});

	it("parses block list", () => {
		const fm = parseFrontmatter(
			["domains:", "  - a.com", "  - b.com", "  - c.com"].join("\n"),
		);
		expect(fm.domains).toEqual(["a.com", "b.com", "c.com"]);
	});

	it("throws on missing required fields", () => {
		expect(() => parsePersona("p", "---\nname: x\n---\nbody")).toThrow(
			PersonaParseError,
		);
	});
});

describe("PersonaManager — domainMatches", () => {
	it("matches exact host", () => {
		expect(domainMatches("github.com", "github.com")).toBe(true);
		expect(domainMatches("github.com", "gitlab.com")).toBe(false);
	});

	it("matches subdomain wildcard", () => {
		expect(domainMatches("api.github.com", "*.github.com")).toBe(true);
		expect(domainMatches("a.b.github.com", "*.github.com")).toBe(true);
		expect(domainMatches("github.com", "*.github.com")).toBe(true);
		expect(domainMatches("notgithub.com", "*.github.com")).toBe(false);
	});

	it("matches universal wildcard", () => {
		expect(domainMatches("any.thing.com", "*")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(domainMatches("GITHUB.com", "github.com")).toBe(true);
	});
});

describe("PersonaManager — registry", () => {
	const p1 = parsePersona(
		"shopping",
		[
			"---",
			'name: "Shopping Expert"',
			"description: Helps shop",
			"domains: [*.amazon.com]",
			"---",
			"body",
		].join("\n"),
	);
	const p2 = parsePersona(
		"default",
		[
			"---",
			'name: "Default"',
			"description: General",
			"domains: []",
			"---",
			"",
		].join("\n"),
	);

	it("register/getBySlug/list", () => {
		const pm = new PersonaManager();
		pm.register(p1);
		pm.register(p2);
		expect(pm.getBySlug("shopping")?.name).toBe("Shopping Expert");
		expect(pm.getBySlug("nope")).toBeUndefined();
		expect(pm.list().map((p) => p.slug)).toEqual(["shopping", "default"]);
	});

	it("matchByDomain returns first domain-matching persona", () => {
		const pm = new PersonaManager();
		pm.register(p1);
		pm.register(p2);
		expect(pm.matchByDomain("https://www.amazon.com/abc")?.slug).toBe(
			"shopping",
		);
		expect(pm.matchByDomain("https://example.com")).toBeUndefined();
	});

	it("matchByDomain returns undefined for non-URL", () => {
		const pm = new PersonaManager();
		pm.register(p1);
		expect(pm.matchByDomain("not a url")).toBeUndefined();
	});
});

describe("PersonaManager — loadFromDir", () => {
	it("loads .md files and registers them", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "persona-mgr-"));
		const src = [
			"---",
			'name: "Loaded"',
			"description: Loaded persona",
			"domains: [example.com]",
			"---",
			"",
			"Body text",
		].join("\n");
		writeFileSync(path.join(dir, "loaded.md"), src);
		// non-md files are ignored
		writeFileSync(path.join(dir, "README.txt"), "ignored");
		const pm = new PersonaManager();
		const loaded = await pm.loadFromDir(dir);
		expect(loaded.map((p) => p.slug)).toEqual(["loaded"]);
		expect(pm.getBySlug("loaded")?.contentMd).toBe("Body text");
	});
});
