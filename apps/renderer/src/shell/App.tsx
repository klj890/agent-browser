import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/I18nProvider";
import { SettingsRouter } from "../settings/SettingsRouter";
import { Sidebar } from "../sidebar/Sidebar";
import type { ProfileView, TabSummary } from "../types/preload";
import { ReadingMode } from "./ReadingMode";

const REFRESH_MS = 500;

export function App() {
	const { t } = useT();
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
				{tabs.map((tab) => (
					<div
						key={tab.id}
						className={`tab ${tab.active ? "active" : ""}${
							tab.isIncognito ? " incognito" : ""
						}`}
						title={`${tab.url}${tab.isIncognito ? " (incognito)" : ""}`}
					>
						{tab.isIncognito && (
							<span
								className="tab-badge"
								role="img"
								aria-label={t("shell.tab.incognitoLabel")}
							>
								🕶
							</span>
						)}
						{!tab.isIncognito &&
							tab.profileId &&
							tab.profileId !== "default" && (
								<span
									className="tab-badge"
									role="img"
									aria-label={t("shell.tab.profileLabel")}
								>
									{profiles
										.find((p) => p.id === tab.profileId)
										?.name.slice(0, 1) ?? "·"}
								</span>
							)}
						<button
							type="button"
							className="tab-title"
							onClick={() => onFocus(tab.id)}
						>
							{tab.title || tab.url || t("shell.tab.title.fallback")}
						</button>
						<button
							type="button"
							className="tab-close"
							onClick={(e) => onClose(e, tab.id)}
							aria-label={t("shell.tab.close")}
						>
							×
						</button>
					</div>
				))}
				<div className="tab-new-wrapper">
					<button
						type="button"
						className="tab-new"
						onClick={onNewTab}
						aria-label={t("shell.tab.new")}
					>
						+
					</button>
					<button
						type="button"
						className="tab-new-menu"
						onClick={() => setNewTabMenuOpen((v) => !v)}
						aria-label={t("shell.tab.newOptions")}
						aria-haspopup="menu"
						aria-expanded={newTabMenuOpen}
						title={t("shell.tab.newOptions")}
					>
						▾
					</button>
					{newTabMenuOpen && (
						<div className="tab-new-popover" role="menu">
							<button type="button" role="menuitem" onClick={onNewIncognito}>
								{t("shell.tab.incognito")}
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
										{t("shell.tab.openInProfile", { name: p.name })}
									</button>
								))}
							{profiles.length <= 1 && (
								<div className="tab-new-popover-hint">
									{t("shell.tab.profileHint")}
								</div>
							)}
						</div>
					)}
				</div>
			</header>
			<form className="addressbar" onSubmit={onNavigate}>
				<button
					type="button"
					onClick={onBack}
					aria-label={t("shell.address.back")}
					title={t("shell.address.back")}
				>
					←
				</button>
				<button
					type="button"
					onClick={onForward}
					aria-label={t("shell.address.forward")}
					title={t("shell.address.forward")}
				>
					→
				</button>
				<button
					type="button"
					onClick={onReload}
					aria-label={t("shell.address.reload")}
					title={t("shell.address.reload")}
				>
					↻
				</button>
				<input
					value={urlInput}
					onChange={(e) => setUrlInput(e.target.value)}
					placeholder={t("shell.address.placeholder")}
					aria-label={t("shell.address.placeholder")}
				/>
				<button
					type="button"
					onClick={() => active && setReadingTabId(active.id)}
					disabled={!active}
					aria-label={t("shell.address.reading")}
					title={t("shell.address.reading")}
				>
					📖
				</button>
				<button
					type="button"
					onClick={() => setSettingsOpen(true)}
					aria-label={t("shell.address.settings")}
					title={t("shell.address.settings")}
				>
					⚙
				</button>
			</form>
			<main className="content">
				<section className="webview-slot">
					{active
						? t("shell.content.activeTab", {
								label: active.title || active.url,
							})
						: t("shell.content.empty")}
				</section>
				<Sidebar />
			</main>
			{settingsOpen && (
				<div
					className="settings-overlay"
					role="dialog"
					aria-modal="true"
					aria-label={t("settings.title")}
				>
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
