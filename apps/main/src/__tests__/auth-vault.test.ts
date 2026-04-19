/**
 * AuthVault unit tests (P1 Stage 9).
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AuthVault,
	type KeychainAdapter,
	memoryKeychainAdapter,
} from "../auth-vault.js";

async function tmpFile(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-vault-"));
	return path.join(dir, "vault.json");
}

describe("AuthVault", () => {
	let filePath: string;
	let kc: KeychainAdapter;

	beforeEach(async () => {
		filePath = await tmpFile();
		kc = memoryKeychainAdapter();
	});

	afterEach(async () => {
		try {
			await fs.rm(path.dirname(filePath), { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("generates a master key on first use and persists entries round-trip", async () => {
		const v = new AuthVault({ filePath, keychain: kc });
		await v.set("github.token", "ghp_secret");
		expect(await v.get("github.token")).toBe("ghp_secret");
		const stored = await kc.getPassword("agent-browser-vault", "master");
		expect(stored).not.toBeNull();
		expect(Buffer.from(stored as string, "base64").length).toBe(32);
	});

	it("persists across instances via vault.json + keychain", async () => {
		const v1 = new AuthVault({ filePath, keychain: kc });
		await v1.set("api", "s3cr3t");
		const v2 = new AuthVault({ filePath, keychain: kc });
		expect(await v2.get("api")).toBe("s3cr3t");
	});

	it("writes GCM ciphertext — plaintext must not appear on disk", async () => {
		const v = new AuthVault({ filePath, keychain: kc });
		await v.set("k", "super-secret-plaintext-value");
		const raw = await fs.readFile(filePath, "utf8");
		expect(raw).not.toContain("super-secret-plaintext-value");
		const parsed = JSON.parse(raw);
		expect(parsed.k).toHaveProperty("iv");
		expect(parsed.k).toHaveProperty("ciphertext");
		expect(parsed.k).toHaveProperty("tag");
		// GCM tag is 16 bytes = 24 base64 chars (with padding).
		expect(Buffer.from(parsed.k.tag, "base64").length).toBe(16);
		expect(Buffer.from(parsed.k.iv, "base64").length).toBe(12);
	});

	it("list() returns only key names, sorted, never secrets", async () => {
		const v = new AuthVault({ filePath, keychain: kc });
		await v.set("b", "v1");
		await v.set("a", "v2");
		const names = await v.list();
		expect(names).toEqual(["a", "b"]);
		// Structural: list() signature returns string[]; no secrets possible.
	});

	it("delete() removes the entry", async () => {
		const v = new AuthVault({ filePath, keychain: kc });
		await v.set("foo", "bar");
		expect(await v.delete("foo")).toBe(true);
		expect(await v.get("foo")).toBeUndefined();
		expect(await v.delete("foo")).toBe(false);
	});

	it("get() returns undefined for unknown key", async () => {
		const v = new AuthVault({ filePath, keychain: kc });
		expect(await v.get("nope")).toBeUndefined();
	});

	it("clear() wipes entries and deletes the master key from keychain", async () => {
		const v = new AuthVault({ filePath, keychain: kc });
		await v.set("a", "1");
		await v.clear();
		expect(await kc.getPassword("agent-browser-vault", "master")).toBeNull();
		// Subsequent set() regenerates a fresh master key.
		await v.set("b", "2");
		expect(await v.get("b")).toBe("2");
		// Old entries are gone.
		expect(await v.get("a")).toBeUndefined();
	});

	it("rejects a tampered ciphertext via GCM auth tag", async () => {
		const v = new AuthVault({ filePath, keychain: kc });
		await v.set("k", "hello");
		const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
		// Flip a byte of the ciphertext.
		const ct = Buffer.from(raw.k.ciphertext, "base64");
		ct[0] = (ct[0] ?? 0) ^ 0xff;
		raw.k.ciphertext = ct.toString("base64");
		await fs.writeFile(filePath, JSON.stringify(raw), "utf8");
		const v2 = new AuthVault({ filePath, keychain: kc });
		await expect(v2.get("k")).rejects.toThrow();
	});

	it("uses a fresh IV per set() call (no nonce reuse)", async () => {
		const v = new AuthVault({ filePath, keychain: kc });
		await v.set("a", "same");
		const iv1 = JSON.parse(await fs.readFile(filePath, "utf8")).a.iv;
		await v.set("a", "same");
		const iv2 = JSON.parse(await fs.readFile(filePath, "utf8")).a.iv;
		expect(iv1).not.toBe(iv2);
	});
});
