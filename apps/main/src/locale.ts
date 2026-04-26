/**
 * Locale resolution + persistence (Stage 21).
 *
 * Priority: AdminPolicy.uiLocale (pin) > user pref (file) > system locale.
 * `user` and `admin` may both be 'auto' which means "defer to next layer".
 *
 * The user preference lives in a tiny JSON file under userData; locale is
 * global to the install (not per-profile) so a sibling JSON next to vault.json
 * keeps the on-disk surface flat.
 */
import fs from "node:fs/promises";
import path from "node:path";

export type Locale = "zh" | "en";
export type LocalePref = "auto" | Locale;

export const LOCALE_PREFS: readonly LocalePref[] = [
	"auto",
	"zh",
	"en",
] as const;

export interface LocaleResolution {
	effective: Locale;
	source: "admin" | "user" | "system";
	user: LocalePref;
	system: Locale;
	admin: LocalePref | null;
}

/**
 * Map an arbitrary BCP-47-ish tag (e.g. `zh-CN`, `zh_TW`, `en-US`) onto the
 * two locales we ship. We deliberately don't split into sub-variants — Stage 21
 * scope is "中文 vs English"; granularity comes later.
 */
export function normalizeSystemLocale(raw: string | undefined | null): Locale {
	if (!raw) return "en";
	const lower = raw.toLowerCase();
	if (lower === "zh" || lower.startsWith("zh-") || lower.startsWith("zh_")) {
		return "zh";
	}
	return "en";
}

export function resolveLocale(input: {
	admin: LocalePref | null;
	user: LocalePref;
	systemRaw: string | undefined | null;
}): LocaleResolution {
	const system = normalizeSystemLocale(input.systemRaw);
	if (input.admin && input.admin !== "auto") {
		return {
			effective: input.admin,
			source: "admin",
			user: input.user,
			system,
			admin: input.admin,
		};
	}
	if (input.user !== "auto") {
		return {
			effective: input.user,
			source: "user",
			user: input.user,
			system,
			admin: input.admin,
		};
	}
	return {
		effective: system,
		source: "system",
		user: input.user,
		system,
		admin: input.admin,
	};
}

export interface LocaleStoreOpts {
	filePath: string;
	/** Returns the OS-reported locale tag (Electron `app.getLocale()`). */
	systemLocale: () => string;
}

interface PersistedShape {
	user?: unknown;
}

export class LocaleStore {
	private user: LocalePref = "auto";

	constructor(private readonly opts: LocaleStoreOpts) {}

	async load(): Promise<void> {
		try {
			const raw = await fs.readFile(this.opts.filePath, "utf8");
			const parsed = JSON.parse(raw) as PersistedShape;
			if (
				parsed &&
				typeof parsed.user === "string" &&
				LOCALE_PREFS.includes(parsed.user as LocalePref)
			) {
				this.user = parsed.user as LocalePref;
			}
		} catch (err) {
			// ENOENT on first run is expected — every other error (permission,
			// disk failure, malformed JSON) is worth a one-line warning so it
			// surfaces in logs instead of silently snapping back to default.
			const code = (err as NodeJS.ErrnoException | null)?.code;
			if (code !== "ENOENT") {
				console.warn("[locale] failed to load locale.json:", err);
			}
			// Either way, keep default "auto" rather than crashing boot.
		}
	}

	getUserPref(): LocalePref {
		return this.user;
	}

	async setUserPref(value: LocalePref): Promise<void> {
		if (!LOCALE_PREFS.includes(value)) {
			throw new Error(`invalid locale: ${value}`);
		}
		// Write-then-set: if the disk operation throws (permissions, full disk),
		// the in-memory state must NOT advance — otherwise a subsequent reload
		// would silently revert and the running session would diverge from disk.
		//
		// Atomic via tmp+rename: a crash mid-write would otherwise leave a
		// truncated locale.json that fails JSON.parse on next boot. We accept
		// the default rather than crashing, so it's not catastrophic — but
		// rename is essentially free and prevents the warn log noise too.
		await fs.mkdir(path.dirname(this.opts.filePath), { recursive: true });
		const tmpPath = `${this.opts.filePath}.tmp`;
		await fs.writeFile(tmpPath, JSON.stringify({ user: value }), "utf8");
		await fs.rename(tmpPath, this.opts.filePath);
		this.user = value;
	}

	resolve(adminPref: LocalePref | null | undefined): LocaleResolution {
		return resolveLocale({
			admin: adminPref ?? null,
			user: this.user,
			systemRaw: this.opts.systemLocale(),
		});
	}
}
