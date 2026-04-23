/**
 * Auth Vault (P1 Stage 9) — AES-256-GCM encrypted credential store.
 *
 * Design (see PLAN 附录 J):
 *   - Master key: 32 random bytes, stored in the OS keychain via keytar
 *     (service="agent-browser-vault", account="master"). Never written to disk
 *     in plaintext. Generated on first use.
 *   - Per-entry crypto: AES-256-GCM with a fresh 12-byte IV and a 16-byte auth
 *     tag. Ciphertext, IV, and tag are stored base64 in `vault.json` under
 *     `app.getPath('userData')`.
 *   - Public API: set / get / delete / list (names only) / clear.
 *
 * The keychain adapter is pluggable so tests can run without a real OS
 * keychain — the default adapter is a thin wrapper around `keytar`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Keychain adapter
// ---------------------------------------------------------------------------

export interface KeychainAdapter {
	getPassword(service: string, account: string): Promise<string | null>;
	setPassword(service: string, account: string, secret: string): Promise<void>;
	deletePassword(service: string, account: string): Promise<boolean>;
}

/** Loads `keytar` lazily so vitest (no native binding build) can still import this module. */
export async function defaultKeychainAdapter(): Promise<KeychainAdapter> {
	const mod = (await import("keytar")) as unknown as {
		default?: typeof import("keytar");
	} & typeof import("keytar");
	const keytar = mod.default ?? mod;
	return {
		getPassword: (s, a) => keytar.getPassword(s, a),
		setPassword: (s, a, p) => keytar.setPassword(s, a, p),
		deletePassword: (s, a) => keytar.deletePassword(s, a),
	};
}

/** In-memory adapter — tests only. */
export function memoryKeychainAdapter(): KeychainAdapter {
	const store = new Map<string, string>();
	const k = (s: string, a: string) => `${s}::${a}`;
	return {
		async getPassword(s, a) {
			return store.get(k(s, a)) ?? null;
		},
		async setPassword(s, a, p) {
			store.set(k(s, a), p);
		},
		async deletePassword(s, a) {
			return store.delete(k(s, a));
		},
	};
}

// ---------------------------------------------------------------------------
// AuthVault
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = "agent-browser-vault";
const KEYCHAIN_ACCOUNT = "master";

interface VaultEntry {
	iv: string; // base64, 12 bytes
	ciphertext: string; // base64
	tag: string; // base64, 16 bytes
}

type VaultFile = Record<string, VaultEntry>;

export interface AuthVaultOpts {
	/** Absolute path to the vault JSON file (usually `${userData}/vault.json`). */
	filePath: string;
	/** Keychain adapter; defaults to `defaultKeychainAdapter()` (uses keytar). */
	keychain?: KeychainAdapter;
}

export class AuthVault {
	private readonly filePath: string;
	private readonly keychainPromise: Promise<KeychainAdapter>;
	private masterKey?: Buffer;
	private entries?: VaultFile;
	private loading?: Promise<void>;

	constructor(opts: AuthVaultOpts) {
		this.filePath = opts.filePath;
		this.keychainPromise = opts.keychain
			? Promise.resolve(opts.keychain)
			: defaultKeychainAdapter();
	}

	private async ensureLoaded(): Promise<void> {
		if (this.entries && this.masterKey) return;
		if (!this.loading) {
			this.loading = this.doLoad();
		}
		await this.loading;
	}

	private async doLoad(): Promise<void> {
		const kc = await this.keychainPromise;
		let keyB64 = await kc.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
		if (!keyB64) {
			const fresh = randomBytes(32);
			keyB64 = fresh.toString("base64");
			await kc.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, keyB64);
			this.masterKey = fresh;
		} else {
			const buf = Buffer.from(keyB64, "base64");
			if (buf.length !== 32) {
				throw new Error("vault: corrupt master key in keychain");
			}
			this.masterKey = buf;
		}
		this.entries = await this.readFile();
	}

	private async readFile(): Promise<VaultFile> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as VaultFile;
			if (!parsed || typeof parsed !== "object") return {};
			return parsed;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
			throw err;
		}
	}

	private async writeFile(): Promise<void> {
		if (!this.entries) return;
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		await fs.writeFile(
			this.filePath,
			JSON.stringify(this.entries, null, 2),
			"utf8",
		);
	}

	// -------- public API --------

	async set(key: string, secret: string): Promise<void> {
		if (!key || typeof key !== "string") throw new Error("vault: key required");
		if (typeof secret !== "string")
			throw new Error("vault: secret must be string");
		await this.ensureLoaded();
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.masterKey!, iv);
		const ct = Buffer.concat([
			cipher.update(Buffer.from(secret, "utf8")),
			cipher.final(),
		]);
		const tag = cipher.getAuthTag();
		this.entries![key] = {
			iv: iv.toString("base64"),
			ciphertext: ct.toString("base64"),
			tag: tag.toString("base64"),
		};
		await this.writeFile();
	}

	async get(key: string): Promise<string | undefined> {
		await this.ensureLoaded();
		const entry = this.entries![key];
		if (!entry) return undefined;
		const iv = Buffer.from(entry.iv, "base64");
		const ct = Buffer.from(entry.ciphertext, "base64");
		const tag = Buffer.from(entry.tag, "base64");
		const decipher = createDecipheriv("aes-256-gcm", this.masterKey!, iv);
		decipher.setAuthTag(tag);
		const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
		return pt.toString("utf8");
	}

	async delete(key: string): Promise<boolean> {
		await this.ensureLoaded();
		if (!(key in this.entries!)) return false;
		delete this.entries![key];
		await this.writeFile();
		return true;
	}

	/** Returns the entry names only. Secrets are never returned from this call. */
	async list(): Promise<string[]> {
		await this.ensureLoaded();
		return Object.keys(this.entries!).sort();
	}

	/** Wipe all entries + delete master key from the keychain. Irreversible. */
	async clear(): Promise<void> {
		await this.ensureLoaded();
		this.entries = {};
		await this.writeFile();
		const kc = await this.keychainPromise;
		try {
			await kc.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
		} catch {
			// best effort
		}
		// Zero the master key buffer before dropping the reference — matches
		// the hygiene pattern in SyncEngine.lock() so the derived 32B key
		// cannot linger in freed heap pages.
		if (this.masterKey) this.masterKey.fill(0);
		this.masterKey = undefined;
		// Force re-init on next access.
		this.loading = undefined;
		this.entries = undefined;
	}
}
