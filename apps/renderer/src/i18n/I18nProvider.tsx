import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { LocalePref, LocaleResolutionView } from "../types/preload";
import { type Locale, type MessageKey, translate } from "./translate";

interface I18nContextValue {
	t: (key: MessageKey, vars?: Record<string, string | number>) => string;
	locale: Locale;
	resolution: LocaleResolutionView;
	setUserPref: (pref: LocalePref) => Promise<void>;
	refresh: () => Promise<void>;
}

const DEFAULT_RESOLUTION: LocaleResolutionView = {
	effective: "en",
	source: "system",
	user: "auto",
	system: "en",
	admin: null,
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
	const [resolution, setResolution] =
		useState<LocaleResolutionView>(DEFAULT_RESOLUTION);

	const refresh = useCallback(async () => {
		const bridge = window.agentBrowser?.locale;
		if (!bridge) return;
		try {
			setResolution(await bridge.get());
		} catch {
			// IPC not ready (renderer running standalone in vite dev) — keep default.
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Re-fetch when the renderer regains focus. Catches the MDM case where the
	// admin policy was rotated (incl. `uiLocale` pin) while the window was in
	// the background — without this, the user-facing locale would only update
	// after restart. Cheap (one IPC round-trip) and event-driven, so no polling.
	// `setUserPref` paths still update state directly via the IPC return value.
	useEffect(() => {
		const onFocus = () => {
			void refresh();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
		};
	}, [refresh]);

	// A11y: keep `<html lang>` in sync so screen readers + spellcheck pick up
	// the right language whenever the effective locale changes.
	useEffect(() => {
		document.documentElement.lang =
			resolution.effective === "zh" ? "zh-CN" : "en";
	}, [resolution.effective]);

	const setUserPref = useCallback(async (pref: LocalePref) => {
		const bridge = window.agentBrowser?.locale;
		if (!bridge) return;
		const next = await bridge.setUser(pref);
		setResolution(next);
	}, []);

	const t = useCallback(
		(key: MessageKey, vars?: Record<string, string | number>) =>
			translate(resolution.effective, key, vars),
		[resolution.effective],
	);

	const value = useMemo<I18nContextValue>(
		() => ({
			t,
			locale: resolution.effective,
			resolution,
			setUserPref,
			refresh,
		}),
		[t, resolution, setUserPref, refresh],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nContextValue {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useT must be used inside I18nProvider");
	return ctx;
}

export type { Locale, LocalePref, MessageKey };
