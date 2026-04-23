import { type FormEvent, useCallback, useEffect, useState } from "react";
import { SettingsRouter } from "../settings/SettingsRouter";
import { Sidebar } from "../sidebar/Sidebar";
import type { ProfileView, TabSummary } from "../types/preload";
import { ReadingMode } from "./ReadingMode";

const REFRESH_MS = 500;

export function App() {
	const [tabs, setTabs] = useState<TabSummary[]>([]);
	const [urlInput, setUrlInput] = useState("");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [profiles, setProfiles] = useState<ProfileView[]>([]);
	const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
	const [readingTabId, setReadingTabId] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const bridge = window.agentBrowser;
		if (!bridge) return;
		try {
			const list = await bridge.tab.list();
			setTabs(list);
			const active = list.find((t) => t.active);
			if (active) setUrlInput((prev) => (prev === "" ? active.url : prev));
		} catch {
			// IPC not ready (e.g., running renderer standalone); ignore.
		}
	}, []);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => {
			void refresh();
		}, REFRESH_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: settingsOpen is the edge trigger — reload profiles so newly-created ones show up in the tabstrip without a full refresh.
	useEffect(() => {
		const bridge = window.agentBrowser?.profiles;
		if (!bridge) return;
		void bridge
			.list()
			.then(setProfiles)
			.catch(() => setProfiles([]));
	}, [settingsOpen]);

	const active = tabs.find((t) => t.active);

	const onNavigate = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (!active) return;
		void window.agentBrowser?.tab.navigate(active.id, urlInput);
	};

	const onNewTab = () => {
		void window.agentBrowser?.tab.open("about:blank");
	};

	const onNewIncognito = () => {
		setNewTabMenuOpen(false);
		void window.agentBrowser?.tab.open("about:blank", { incognito: true });
	};

	const onNewInProfile = (profileId: string) => {
		setNewTabMenuOpen(false);
		void window.agentBrowser?.tab.open("about:blank", { profileId });
	};

	const onFocus = (id: string) => {
		void window.agentBrowser?.tab.focus(id);
	};

	const onClose = (e: React.MouseEvent, id: string) => {
		e.stopPropagation();
		void window.agentBrowser?.tab.close(id);
	};

	const onBack = () => {
		if (active) void window.agentBrowser?.tab.back(active.id);
	};
	const onForward = () => {
		if (active) void window.agentBrowser?.tab.forward(active.id);
	};
	const onReload = () => {
		if (active) void window.agentBrowser?.tab.reload(active.id);
	};

	return (
		<div className="shell">
			<header className="tabstrip">
				{tabs.map((t) => (
					<div
						key={t.id}
						className={`tab ${t.active ? "active" : ""}${
							t.isIncognito ? " incognito" : ""
						}`}
						title={`${t.url}${t.isIncognito ? " (incognito)" : ""}`}
					>
						{t.isIncognito && (
							<span className="tab-badge" role="img" aria-label="Incognito">
								🕶
							</span>
						)}
						{!t.isIncognito && t.profileId && t.profileId !== "default" && (
							<span className="tab-badge" role="img" aria-label="Profile">
								{profiles.find((p) => p.id === t.profileId)?.name.slice(0, 1) ??
									"·"}
							</span>
						)}
						<button
							type="button"
							className="tab-title"
							onClick={() => onFocus(t.id)}
						>
							{t.title || t.url || "New tab"}
						</button>
						<button
							type="button"
							className="tab-close"
							onClick={(e) => onClose(e, t.id)}
							aria-label="Close tab"
						>
							×
						</button>
					</div>
				))}
				<div className="tab-new-wrapper">
					<button type="button" className="tab-new" onClick={onNewTab}>
						+
					</button>
					<button
						type="button"
						className="tab-new-menu"
						onClick={() => setNewTabMenuOpen((v) => !v)}
						aria-label="New tab options"
						title="New tab options"
					>
						▾
					</button>
					{newTabMenuOpen && (
						<div className="tab-new-popover" role="menu">
							<button type="button" role="menuitem" onClick={onNewIncognito}>
								🕶 New incognito tab
							</button>
							{profiles
								.filter((p) => p.id !== "default")
								.map((p) => (
									<button
										key={p.id}
										type="button"
										role="menuitem"
										onClick={() => onNewInProfile(p.id)}
									>
										👤 Open in profile: {p.name}
									</button>
								))}
							{profiles.length <= 1 && (
								<div className="tab-new-popover-hint">
									Create additional profiles in Settings → Profiles.
								</div>
							)}
						</div>
					)}
				</div>
			</header>
			<form className="addressbar" onSubmit={onNavigate}>
				<button type="button" onClick={onBack}>
					←
				</button>
				<button type="button" onClick={onForward}>
					→
				</button>
				<button type="button" onClick={onReload}>
					↻
				</button>
				<input
					value={urlInput}
					onChange={(e) => setUrlInput(e.target.value)}
					placeholder="URL or search"
				/>
				<button
					type="button"
					onClick={() => active && setReadingTabId(active.id)}
					disabled={!active}
					aria-label="Reading mode"
					title="Reading mode"
				>
					📖
				</button>
				<button
					type="button"
					onClick={() => setSettingsOpen(true)}
					aria-label="Open settings"
					title="Settings"
				>
					⚙
				</button>
			</form>
			<main className="content">
				<section className="webview-slot">
					{active
						? `Active tab: ${active.title || active.url}`
						: "No tab — click + to open"}
				</section>
				<Sidebar />
			</main>
			{settingsOpen && (
				<div className="settings-overlay" role="dialog" aria-modal="true">
					<SettingsRouter onClose={() => setSettingsOpen(false)} />
				</div>
			)}
			{readingTabId && (
				<ReadingMode
					tabId={readingTabId}
					onClose={() => setReadingTabId(null)}
				/>
			)}
		</div>
	);
}
