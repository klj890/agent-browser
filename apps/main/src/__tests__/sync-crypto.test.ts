/**
 * SyncCrypto tests (P1-16). Uses the fast-derive test hook so a full suite
 * runs in ~20ms instead of ~500ms of scrypt churn.
 */
import { describe, expect, it } from "vitest";
import {
	__testHooks,
	decrypt,
	encrypt,
	generateSalt,
	itemPointer,
	keysEqual,
} from "../sync-crypto.js";

const fastDerive = __testHooks.makeFastDerive(64);

describe("SyncCrypto", () => {
	it("derives a reproducible 32-byte key from passphrase + salt", async () => {
		const salt = generateSalt();
		const a = await fastDerive("correct horse battery staple", salt);
		const b = await fastDerive("correct horse battery staple", salt);
		expect(a.length).toBe(32);
		expect(keysEqual(a, b)).toBe(true);
	});

	it("different passphrases produce different keys", async () => {
		const salt = generateSalt();
		const a = await fastDerive("alpha", salt);
		const b = await fastDerive("bravo", salt);
		expect(keysEqual(a, b)).toBe(false);
	});

	it("different salts produce different keys for same passphrase", async () => {
		const a = await fastDerive("alpha", generateSalt());
		const b = await fastDerive("alpha", generateSalt());
		expect(keysEqual(a, b)).toBe(false);
	});

	it("encrypt/decrypt roundtrips UTF-8 content", async () => {
		const key = await fastDerive("alpha", generateSalt());
		const plaintext = "你好 — réservé — 🔐 payload";
		const env = encrypt(key, plaintext);
		expect(env.v).toBe(1);
		expect(env.alg).toBe("aes-256-gcm");
		expect(decrypt(key, env)).toBe(plaintext);
	});

	it("each encrypt call produces a fresh iv", async () => {
		const key = await fastDerive("alpha", generateSalt());
		const a = encrypt(key, "same");
		const b = encrypt(key, "same");
		expect(a.iv).not.toBe(b.iv);
		expect(a.ct).not.toBe(b.ct);
	});

	it("decrypt throws with a wrong key", async () => {
		const key = await fastDerive("alpha", generateSalt());
		const wrong = await fastDerive("bravo", generateSalt());
		const env = encrypt(key, "secret");
		expect(() => decrypt(wrong, env)).toThrow();
	});

	it("decrypt rejects a tampered ciphertext", async () => {
		const key = await fastDerive("alpha", generateSalt());
		const env = encrypt(key, "hello");
		// Flip a bit in the base64url; at minimum swap a char for a clearly-bad one.
		const tampered = {
			...env,
			ct: env.ct[0] === "A" ? `B${env.ct.slice(1)}` : `A${env.ct.slice(1)}`,
		};
		expect(() => decrypt(key, tampered)).toThrow();
	});

	it("itemPointer is deterministic per key but differs across keys", async () => {
		const k1 = await fastDerive("alpha", generateSalt());
		const k2 = await fastDerive("bravo", generateSalt());
		const p1a = itemPointer(k1, "bookmark:/:https://example/");
		const p1b = itemPointer(k1, "bookmark:/:https://example/");
		const p2 = itemPointer(k2, "bookmark:/:https://example/");
		expect(p1a).toBe(p1b);
		expect(p1a).not.toBe(p2);
	});
});
