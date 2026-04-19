/**
 * Vault resolver unit tests (P1 Stage 9).
 */
import { describe, expect, it } from "vitest";
import {
	resolveArgs,
	resolveTemplate,
	type VaultLookup,
} from "../vault-resolver.js";

function mkVault(entries: Record<string, string>): VaultLookup {
	return {
		async get(k) {
			return entries[k];
		},
	};
}

describe("resolveTemplate", () => {
	it("replaces a single placeholder", async () => {
		const v = mkVault({ github: "ghp_123" });
		expect(await resolveTemplate("token={{vault:github}}", v)).toBe(
			"token=ghp_123",
		);
	});

	it("replaces multiple placeholders (different keys)", async () => {
		const v = mkVault({ u: "alice", p: "hunter2" });
		expect(await resolveTemplate("{{vault:u}}:{{vault:p}}", v)).toBe(
			"alice:hunter2",
		);
	});

	it("replaces repeated placeholders (same key)", async () => {
		const v = mkVault({ a: "X" });
		expect(await resolveTemplate("{{vault:a}}-{{vault:a}}", v)).toBe("X-X");
	});

	it("supports keys with dots, dashes, underscores", async () => {
		const v = mkVault({ "github.user_name-1": "bob" });
		expect(await resolveTemplate("hi {{vault:github.user_name-1}}!", v)).toBe(
			"hi bob!",
		);
	});

	it("throws for unknown keys", async () => {
		const v = mkVault({});
		await expect(resolveTemplate("{{vault:missing}}", v)).rejects.toThrow(
			/unknown key "missing"/,
		);
	});

	it("leaves strings without placeholders untouched", async () => {
		const v = mkVault({});
		expect(await resolveTemplate("plain", v)).toBe("plain");
		expect(await resolveTemplate("", v)).toBe("");
	});

	it("does not treat malformed patterns as placeholders", async () => {
		const v = mkVault({ a: "X" });
		// Missing closing braces / invalid chars.
		expect(await resolveTemplate("{{vault:a}", v)).toBe("{{vault:a}");
		expect(await resolveTemplate("{vault:a}", v)).toBe("{vault:a}");
	});
});

describe("resolveArgs (nested)", () => {
	it("resolves placeholders inside nested objects and arrays", async () => {
		const v = mkVault({ pw: "s3cr3t", user: "alice" });
		const out = await resolveArgs(
			{
				ref: "@e3",
				value: "{{vault:pw}}",
				meta: { login: "{{vault:user}}", keep: 42 },
				extras: ["{{vault:user}}", "static"],
			},
			v,
		);
		expect(out).toEqual({
			ref: "@e3",
			value: "s3cr3t",
			meta: { login: "alice", keep: 42 },
			extras: ["alice", "static"],
		});
	});

	it("passes non-string values through unchanged", async () => {
		const v = mkVault({});
		const out = await resolveArgs(
			{ n: 1, b: true, nil: null, obj: { nested: 7 } },
			v,
		);
		expect(out).toEqual({
			n: 1,
			b: true,
			nil: null,
			obj: { nested: 7 },
		});
	});

	it("propagates unknown-key error from deep within args", async () => {
		const v = mkVault({ a: "1" });
		await expect(
			resolveArgs({ nested: { inner: "{{vault:b}}" } }, v),
		).rejects.toThrow(/unknown key "b"/);
	});
});
