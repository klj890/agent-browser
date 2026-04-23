/**
 * SyncCrypto (P1 Stage 16) — the cryptographic core of E2E sync.
 *
 * Threat model (from PLAN):
 *   - Server is assumed semi-honest: it MUST NOT see plaintext bookmarks /
 *     history. It only sees opaque item IDs + ciphertext.
 *   - The passphrase never leaves the device; only the derived 32-byte key
 *     is ever kept in memory, and only during an unlocked session.
 *
 * Primitives:
 *   - Key derivation: scrypt (N=2^15, r=8, p=1) — ~50ms, OWASP-ok in 2024.
 *   - Symmetric cipher: AES-256-GCM with 96-bit random IV + 128-bit authTag.
 *   - Envelope JSON: {v:1, alg:"aes-256-gcm", iv, ct, tag} — all base64url.
 *
 * This module is intentionally pure — no I/O, no state. Callers (SyncEngine)
 * manage the key lifetime.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	scrypt as scryptCb,
	timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
	password: string | Buffer,
	salt: string | Buffer,
	keylen: number,
	options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
// scrypt N=2^15 → ~50ms on a laptop, 32MB RAM. Good defense in depth for a
// user-chosen passphrase of middling strength.
const SCRYPT_N = 1 << 15;

export interface EnvelopeV1 {
	v: 1;
	alg: "aes-256-gcm";
	iv: string; // base64url
	ct: string; // base64url
	tag: string; // base64url
}

export function generateSalt(): Buffer {
	return randomBytes(SALT_BYTES);
}

/**
 * Derive a 32-byte key from a passphrase + salt.
 * Keep the returned Buffer; do NOT persist it — re-derive on unlock.
 */
export async function deriveKey(
	passphrase: string,
	salt: Buffer,
): Promise<Buffer> {
	if (!passphrase) throw new Error("passphrase cannot be empty");
	if (salt.length !== SALT_BYTES) {
		throw new Error(`salt must be ${SALT_BYTES} bytes (got ${salt.length})`);
	}
	return scrypt(passphrase.normalize("NFKC"), salt, KEY_BYTES, {
		N: SCRYPT_N,
		r: 8,
		p: 1,
		// scrypt needs ~128 * r * N bytes, cap comfortably above.
		maxmem: 64 * 1024 * 1024,
	});
}

/**
 * Encrypt a plaintext string into an envelope.
 * Never re-use an iv — always random per call.
 */
export function encrypt(key: Buffer, plaintext: string): EnvelopeV1 {
	if (key.length !== KEY_BYTES) {
		throw new Error(`key must be ${KEY_BYTES} bytes (got ${key.length})`);
	}
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		v: 1,
		alg: "aes-256-gcm",
		iv: toB64Url(iv),
		ct: toB64Url(ct),
		tag: toB64Url(tag),
	};
}

/**
 * Decrypt an envelope back to its plaintext string. Throws on auth failure
 * (wrong key / tampered ciphertext) — callers should catch & treat as fatal
 * sync-state corruption rather than retry.
 */
export function decrypt(key: Buffer, env: EnvelopeV1): string {
	if (key.length !== KEY_BYTES) {
		throw new Error(`key must be ${KEY_BYTES} bytes (got ${key.length})`);
	}
	if (env.v !== 1 || env.alg !== "aes-256-gcm") {
		throw new Error(`unsupported envelope version/alg: ${env.v}/${env.alg}`);
	}
	const iv = fromB64Url(env.iv);
	const ct = fromB64Url(env.ct);
	const tag = fromB64Url(env.tag);
	if (iv.length !== IV_BYTES) throw new Error("bad iv length");
	if (tag.length !== TAG_BYTES) throw new Error("bad tag length");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
		"utf8",
	);
}

/**
 * Compute a deterministic, non-reversible pointer ID from a plaintext key
 * (e.g. bookmark URL). Uses HMAC-SHA256(key, plaintextId) — a stateless,
 * MAC-equivalent construction that is the standard recipe for "stable opaque
 * ID the server can dedup on without learning the plaintext".
 *
 * Previously used AES-256-GCM over a fixed zero IV, which is a classic
 * crypto misuse: GCM's underlying CTR stream becomes the same keystream
 * for every plaintext, so XORing two pointers leaks XOR of their plaintexts
 * (many-time-pad attack). HMAC-SHA256 has no such pitfall and is faster.
 */
export function itemPointer(key: Buffer, plaintextId: string): string {
	if (key.length !== KEY_BYTES) {
		throw new Error(`key must be ${KEY_BYTES} bytes (got ${key.length})`);
	}
	const mac = createHmac("sha256", key).update(plaintextId, "utf8").digest();
	return toB64Url(mac);
}

/**
 * Constant-time compare two derived keys — used to confirm a re-entered
 * passphrase matches the one originally configured (via a stored "check"
 * envelope).
 */
export function keysEqual(a: Buffer, b: Buffer): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

// ---------- base64url helpers ----------

function toB64Url(buf: Buffer): string {
	return buf
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromB64Url(s: string): Buffer {
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

// Test-only: expose a fast-iter knob so unit tests don't wait 50ms per call.
// Intentionally undocumented; production should not call this.
export const __testHooks = {
	makeFastDerive(iterations = 1024): (p: string, s: Buffer) => Promise<Buffer> {
		return (passphrase, salt) =>
			scrypt(passphrase.normalize("NFKC"), salt, KEY_BYTES, {
				N: iterations,
				r: 8,
				p: 1,
				maxmem: 64 * 1024 * 1024,
			});
	},
};
