/**
 * ExtensionHost (P1 Stage 15) — minimal MV3 extension installer.
 *
 * Scope per PLAN decision D6: support the 90%-common surface
 * (`storage` / `tabs` / `webRequest` / `contextMenus` / `scripting`) via
 * Electron's native Chrome extension support. Electron 30+ exposes
 * `session.extensions.loadExtension(path)`; older versions exposed it
 * directly on Session. We abstract that behind `ExtensionSessionLike`.
 *
 * Policy integration (admin-policy.ts extension block):
 *   - allowMv3 = false         → NO extensions load, period.
 *   - allowedExtensionIds = [] → any extension allowed (when allowMv3).
 *   - allowedExtensionIds = [… ids …] → only those ids permitted to load.
 *
 * Security stance:
 *   - Extensions run inside their own Chrome sandbox; they never get access
 *     to `window.agentBrowser` — preload is not injected into extension pages.
 *   - Installed list lives in a plain JSON file under userData — paths only,
 *     no secrets. If the user removes the source folder, `loadEnabledAll`
 *     surfaces the failure via the returned `failed[]` array but keeps
 *     going (other extensions still load).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ExtensionLike {
	id: string;
	name: string;
	version: string;
	manifest: { name?: string; version?: string; manifest_version?: number };
	path: string;
}

export interface ExtensionSessionLike {
	loadExtension(
		path: string,
		opts?: { allowFileAccess?: boolean },
	): Promise<ExtensionLike>;
	removeExtension(id: string): void;
	getExtension(id: string): ExtensionLike | null;
}

export interface InstalledExtension {
	id: string;
	name: string;
	version: string;
	path: string;
	enabled: boolean;
	manifestVersion: number;
}

export interface ExtensionPolicyView {
	allowMv3: boolean;
	allowedExtensionIds: string[];
}

export interface ExtensionHostDeps {
	storePath: string;
	session: ExtensionSessionLike;
	getPolicy: () => ExtensionPolicyView;
}

export interface BootResult {
	loaded: InstalledExtension[];
	failed: Array<{ id: string; reason: string }>;
	blockedByPolicy: Array<{ id: string; reason: string }>;
}

export class ExtensionHost {
	private readonly storePath: string;
	private readonly session: ExtensionSessionLike;
	private readonly getPolicy: () => ExtensionPolicyView;
	private installed: InstalledExtension[] = [];

	constructor(deps: ExtensionHostDeps) {
		this.storePath = deps.storePath;
		this.session = deps.session;
		this.getPolicy = deps.getPolicy;
		this.installed = this.readStore();
	}

	list(): InstalledExtension[] {
		return this.installed.map((e) => ({ ...e }));
	}

	/**
	 * Install an unpacked MV3 extension from a folder. Validates the manifest
	 * before calling into Electron to give a clean error for common mistakes.
	 *
	 * Whitelist enforcement (allowedExtensionIds non-empty):
	 *   - If manifest.key is present, compute the Chromium-style extension ID
	 *     deterministically (sha256 of pubkey, first 16 bytes → a–p chars) and
	 *     validate against the whitelist BEFORE loadExtension — this prevents
	 *     background scripts from running even briefly for rejected IDs.
	 *   - If manifest.key is absent we cannot know the ID until after Chromium
	 *     assigns one, so we refuse to install rather than silently fall back
	 *     to the race-prone load-then-remove flow. Users must add a signed
	 *     manifest.key to their unpacked extension or disable the whitelist.
	 */
	async install(folderPath: string): Promise<InstalledExtension> {
		if (!existsSync(folderPath)) {
			throw new Error(`extension path not found: ${folderPath}`);
		}
		const manifest = readManifest(folderPath);
		if (manifest.manifest_version !== 3) {
			throw new Error(
				`manifest_version must be 3 (got ${manifest.manifest_version ?? "unknown"})`,
			);
		}
		const policy = this.getPolicy();
		this.guardPolicyBeforeLoad(policy);
		if (policy.allowedExtensionIds.length > 0) {
			const preId = manifest.key ? chromiumIdFromKey(manifest.key) : null;
			if (preId == null) {
				throw new Error(
					"extension manifest has no 'key' field — cannot validate against " +
						"allowedExtensionIds before loading. Add a signed key to the " +
						"manifest or disable the whitelist.",
				);
			}
			if (!policy.allowedExtensionIds.includes(preId)) {
				throw new Error(
					`extension id ${preId} is not in admin allowedExtensionIds`,
				);
			}
		}
		const ext = await this.session.loadExtension(folderPath, {
			allowFileAccess: false,
		});
		if (
			policy.allowedExtensionIds.length > 0 &&
			!policy.allowedExtensionIds.includes(ext.id)
		) {
			// Defense-in-depth: the pre-validated id from manifest.key should
			// match ext.id, but double-check in case Chromium's derivation drifts.
			this.session.removeExtension(ext.id);
			throw new Error(
				`extension id ${ext.id} (post-load) is not in admin allowedExtensionIds`,
			);
		}
		const record: InstalledExtension = {
			id: ext.id,
			name: ext.manifest?.name ?? ext.name ?? manifest.name ?? "Unnamed",
			version:
				ext.manifest?.version ?? ext.version ?? manifest.version ?? "0.0.0",
			path: folderPath,
			enabled: true,
			manifestVersion: 3,
		};
		// Replace existing record with same id (re-install).
		this.installed = this.installed.filter((e) => e.id !== record.id);
		this.installed.push(record);
		this.writeStore();
		return { ...record };
	}

	remove(id: string): boolean {
		const existed = this.installed.some((e) => e.id === id);
		if (!existed) return false;
		try {
			this.session.removeExtension(id);
		} catch {
			// Already unloaded — keep going so we can drop the record.
		}
		this.installed = this.installed.filter((e) => e.id !== id);
		this.writeStore();
		return true;
	}

	async setEnabled(id: string, enabled: boolean): Promise<InstalledExtension> {
		const rec = this.installed.find((e) => e.id === id);
		if (!rec) throw new Error(`no installed extension with id=${id}`);
		if (enabled === rec.enabled) return { ...rec };
		if (enabled) {
			const policy = this.getPolicy();
			this.guardPolicyBeforeLoad(policy);
			if (
				policy.allowedExtensionIds.length > 0 &&
				!policy.allowedExtensionIds.includes(id)
			) {
				throw new Error(`extension ${id} is not allowed by admin policy`);
			}
			await this.session.loadExtension(rec.path, { allowFileAccess: false });
		} else {
			try {
				this.session.removeExtension(id);
			} catch {
				// best effort
			}
		}
		rec.enabled = enabled;
		this.writeStore();
		return { ...rec };
	}

	/**
	 * Load every enabled installed extension into the session. Called once at
	 * app boot. Failures (e.g. deleted folders) are collected and returned so
	 * index.ts can log them — they do not abort startup.
	 */
	async loadEnabledAll(): Promise<BootResult> {
		const result: BootResult = { loaded: [], failed: [], blockedByPolicy: [] };
		const policy = this.getPolicy();
		if (!policy.allowMv3) {
			for (const rec of this.installed.filter((e) => e.enabled)) {
				result.blockedByPolicy.push({ id: rec.id, reason: "allowMv3=false" });
			}
			return result;
		}
		for (const rec of this.installed) {
			if (!rec.enabled) continue;
			if (
				policy.allowedExtensionIds.length > 0 &&
				!policy.allowedExtensionIds.includes(rec.id)
			) {
				result.blockedByPolicy.push({
					id: rec.id,
					reason: "not in allowedExtensionIds",
				});
				continue;
			}
			try {
				await this.session.loadExtension(rec.path, { allowFileAccess: false });
				result.loaded.push({ ...rec });
			} catch (err) {
				result.failed.push({
					id: rec.id,
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		}
		return result;
	}

	private guardPolicyBeforeLoad(policy: ExtensionPolicyView): void {
		if (!policy.allowMv3) {
			throw new Error("extensions disabled by admin policy (allowMv3=false)");
		}
	}

	private readStore(): InstalledExtension[] {
		if (!existsSync(this.storePath)) return [];
		try {
			const raw = readFileSync(this.storePath, "utf-8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(isInstalledRecord);
		} catch {
			return [];
		}
	}

	private writeStore(): void {
		const dir = path.dirname(this.storePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.storePath, JSON.stringify(this.installed, null, 2));
	}
}

function readManifest(folder: string): {
	name: string;
	version: string;
	manifest_version?: number;
	key?: string;
} {
	const p = path.join(folder, "manifest.json");
	if (!existsSync(p)) {
		throw new Error(`manifest.json not found in ${folder}`);
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(p, "utf-8"));
	} catch (err) {
		throw new Error(
			`failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const name = typeof parsed.name === "string" ? parsed.name : "";
	const version = typeof parsed.version === "string" ? parsed.version : "";
	const mv = parsed.manifest_version;
	const key = typeof parsed.key === "string" ? parsed.key : undefined;
	return {
		name,
		version,
		manifest_version: typeof mv === "number" ? mv : undefined,
		key,
	};
}

/**
 * Derive the Chromium extension ID from the base64-encoded public key in
 * `manifest.key`. Chromium hashes the pubkey with SHA-256 and encodes the
 * first 16 bytes as 32 chars in the alphabet 'a'..'p' (each nibble + 'a').
 * This matches the IDs users see in chrome://extensions.
 */
function chromiumIdFromKey(keyB64: string): string | null {
	try {
		const pubkey = Buffer.from(keyB64, "base64");
		if (pubkey.length === 0) return null;
		const hash = createHash("sha256").update(pubkey).digest();
		let id = "";
		for (let i = 0; i < 16; i++) {
			const b = hash[i] ?? 0;
			id += String.fromCharCode(97 + (b >> 4));
			id += String.fromCharCode(97 + (b & 0xf));
		}
		return id;
	} catch {
		return null;
	}
}

function isInstalledRecord(v: unknown): v is InstalledExtension {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		typeof o.name === "string" &&
		typeof o.version === "string" &&
		typeof o.path === "string" &&
		typeof o.enabled === "boolean"
	);
}
