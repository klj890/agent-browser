import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
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
	const lastRefreshRef = useRef(0);
	useEffect(() => {
		// `focus` and `visibilitychange` (→ visible) typically fire within a
		// few ms of each other when the user switches back to the app, so we
		// dedupe by timestamp instead of dropping one listener — different
		// platforms cover slightly different edges (window focus vs document
		// visibility) and we want both as a safety net.
		const REFRESH_DEDUPE_MS = 200;
		const tryRefresh = () => {
			const now = Date.now();
			if (now - lastRefreshRef.current < REFRESH_DEDUPE_MS) return;
			lastRefreshRef.current = now;
			void refresh();
		};
		const onVisibility = () => {
			// We only care about the "back to visible" edge — the hide edge
			// would just waste an IPC call while the renderer is backgrounded.
			if (document.visibilityState === "visible") tryRefresh();
		};
		window.addEventListener("focus", tryRefresh);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", tryRefresh);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [refresh]);

	// A11y: keep `<html lang>` in sync so screen readers + spellcheck pick up
	// the right language whenever the effective locale changes.
	//
	// We deliberately use `zh-CN` (not `zh-TW`/`zh-HK` / bare `zh`) because
	// our catalog ships exclusively Simplified Chinese strings. The lang
	// attribute should describe the *content* language, not the user's
	// locale preference — telling a screen reader the page is `zh-TW` while
	// rendering zh-CN text would mispronounce / wrong-tone the readout. If
	// we add zh-TW translations later we'd ship a separate locale code.
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
