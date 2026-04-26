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
		} catch {
			// Missing or corrupt — keep default "auto" rather than crashing boot.
		}
	}

	getUserPref(): LocalePref {
		return this.user;
	}

	async setUserPref(value: LocalePref): Promise<void> {
		if (!LOCALE_PREFS.includes(value)) {
			throw new Error(`invalid locale: ${value}`);
		}
		this.user = value;
		await fs.mkdir(path.dirname(this.opts.filePath), { recursive: true });
		await fs.writeFile(
			this.opts.filePath,
			JSON.stringify({ user: value }),
			"utf8",
		);
	}

	resolve(adminPref: LocalePref | null | undefined): LocaleResolution {
		return resolveLocale({
			admin: adminPref ?? null,
			user: this.user,
			systemRaw: this.opts.systemLocale(),
		});
	}
}
