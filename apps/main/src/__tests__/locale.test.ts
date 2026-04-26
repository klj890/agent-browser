/**
 * Locale resolver + persistence tests (Stage 21).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LocaleStore,
	normalizeSystemLocale,
	resolveLocale,
} from "../locale.js";

describe("normalizeSystemLocale", () => {
	it("maps zh-CN / zh-TW / zh / zh_HK to 'zh'", () => {
		for (const tag of ["zh-CN", "zh-TW", "zh-HK", "zh", "zh_HK"]) {
			expect(normalizeSystemLocale(tag)).toBe("zh");
		}
	});

	it("maps unknown / English tags to 'en'", () => {
		for (const tag of ["en-US", "en", "fr-FR", "de", "ja-JP", ""]) {
			expect(normalizeSystemLocale(tag)).toBe("en");
		}
	});

	it("falls back to 'en' for null/undefined", () => {
		expect(normalizeSystemLocale(null)).toBe("en");
		expect(normalizeSystemLocale(undefined)).toBe("en");
	});
});

describe("resolveLocale priority", () => {
	it("admin pin beats user and system", () => {
		const r = resolveLocale({
			admin: "en",
			user: "zh",
			systemRaw: "zh-CN",
		});
		expect(r.effective).toBe("en");
		expect(r.source).toBe("admin");
	});

	it("admin 'auto' is transparent — user pref wins", () => {
		const r = resolveLocale({
			admin: "auto",
			user: "zh",
			systemRaw: "en-US",
		});
		expect(r.effective).toBe("zh");
		expect(r.source).toBe("user");
	});

	it("user 'auto' falls back to system", () => {
		const r = resolveLocale({
			admin: null,
			user: "auto",
			systemRaw: "zh-CN",
		});
		expect(r.effective).toBe("zh");
		expect(r.source).toBe("system");
	});

	it("returns the normalized system locale on the resolution payload", () => {
		const r = resolveLocale({
			admin: null,
			user: "auto",
			systemRaw: "fr-FR",
		});
		expect(r.system).toBe("en");
		expect(r.effective).toBe("en");
	});
});

describe("LocaleStore persistence", () => {
	let dir: string;
	let file: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "locale-test-"));
		file = path.join(dir, "locale.json");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("defaults to 'auto' when no file exists", async () => {
		const s = new LocaleStore({ filePath: file, systemLocale: () => "en-US" });
		await s.load();
		expect(s.getUserPref()).toBe("auto");
	});

	it("persists and reloads the user preference", async () => {
		const s1 = new LocaleStore({ filePath: file, systemLocale: () => "en-US" });
		await s1.load();
		await s1.setUserPref("zh");
		expect(s1.getUserPref()).toBe("zh");
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ user: "zh" });

		const s2 = new LocaleStore({ filePath: file, systemLocale: () => "en-US" });
		await s2.load();
		expect(s2.getUserPref()).toBe("zh");
	});

	it("rejects unknown values", async () => {
		const s = new LocaleStore({ filePath: file, systemLocale: () => "en-US" });
		await s.load();
		await expect(
			// @ts-expect-error — runtime check, test forces invalid type
			s.setUserPref("fr"),
		).rejects.toThrow(/invalid locale/);
	});

	it("ignores corrupt JSON gracefully", async () => {
		const fs = await import("node:fs/promises");
		await fs.writeFile(file, "{ not json", "utf8");
		const s = new LocaleStore({ filePath: file, systemLocale: () => "en-US" });
		await s.load();
		expect(s.getUserPref()).toBe("auto");
	});

	it("does not advance in-memory state when writeFile throws (gemini R1)", async () => {
		// Point at a path that cannot be written: a pre-existing *file* that we
		// then ask to be the *directory* for our locale.json.
		const fs = await import("node:fs/promises");
		const blocker = path.join(dir, "blocker");
		await fs.writeFile(blocker, "x", "utf8");
		const bad = path.join(blocker, "locale.json");
		const s = new LocaleStore({ filePath: bad, systemLocale: () => "en-US" });
		await s.load();
		await expect(s.setUserPref("zh")).rejects.toBeTruthy();
		// Crucially, in-memory state must NOT have flipped to "zh".
		expect(s.getUserPref()).toBe("auto");
	});

	it("resolve() composes admin + user + system correctly", async () => {
		const s = new LocaleStore({ filePath: file, systemLocale: () => "zh-CN" });
		await s.load();
		// user=auto, system=zh → system wins
		expect(s.resolve(null).effective).toBe("zh");
		expect(s.resolve(null).source).toBe("system");
		// user override
		await s.setUserPref("en");
		expect(s.resolve(null).effective).toBe("en");
		expect(s.resolve(null).source).toBe("user");
		// admin override beats user
		expect(s.resolve("zh").effective).toBe("zh");
		expect(s.resolve("zh").source).toBe("admin");
	});
});
