/**
 * e2e #2 — Persona CRUD via PersonaManager.
 *
 * PLAN scenario 2 requires a round-trip to agent-browser-server (Postgres).
 * That server is not in this repo; it lives in a sibling repo (D1). Until it
 * lands we exercise the client-side contract:
 *   - write a persona markdown file
 *   - PersonaManager.loadFromDir parses it
 *   - getBySlug / list return the parsed record
 *   - editing the file + reloading reflects the change
 *
 * When the server lands, replace `loadFromDir` here with `persona-sync.fetch`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PersonaManager } from "../apps/main/src/persona-manager.js";

function writePersona(dir: string, slug: string, body: string) {
	writeFileSync(path.join(dir, `${slug}.md`), body, "utf8");
}

describe("e2e/persona-crud: local file-backed PersonaManager", () => {
	it("loads, re-loads, and reflects edits", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "persona-crud-"));
		writePersona(
			dir,
			"shopping-expert",
			[
				"---",
				'name: "Shopping Expert"',
				"description: E-commerce savvy",
				"domains: [amazon.com]",
				"---",
				"Body v1",
			].join("\n"),
		);

		const mgr1 = new PersonaManager();
		await mgr1.loadFromDir(dir);
		const p1 = mgr1.getBySlug("shopping-expert");
		expect(p1?.name).toBe("Shopping Expert");
		expect(p1?.frontmatter.domains).toEqual(["amazon.com"]);
		expect(mgr1.list()).toHaveLength(1);

		// Mutate the file (simulate "user edits persona in settings UI").
		writePersona(
			dir,
			"shopping-expert",
			[
				"---",
				'name: "Shopping Expert"',
				"description: E-commerce savvy v2",
				"domains: [amazon.com, jd.com]",
				"---",
				"Body v2",
			].join("\n"),
		);
		const mgr2 = new PersonaManager();
		await mgr2.loadFromDir(dir);
		const p2 = mgr2.getBySlug("shopping-expert");
		expect(p2?.description).toBe("E-commerce savvy v2");
		expect(p2?.frontmatter.domains).toEqual(["amazon.com", "jd.com"]);
	});

	it("rejects personas missing required fields", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "persona-bad-"));
		writePersona(dir, "broken", "---\nname: x\n---\n");
		const mgr = new PersonaManager();
		await expect(mgr.loadFromDir(dir)).rejects.toThrow(/description/);
	});
});
