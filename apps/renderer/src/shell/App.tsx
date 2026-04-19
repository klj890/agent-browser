import { type FormEvent, useCallback, useEffect, useState } from "react";
import { SettingsRouter } from "../settings/SettingsRouter";
import { Sidebar } from "../sidebar/Sidebar";
import type { TabSummary } from "../types/preload";

const REFRESH_MS = 500;

export function App() {
	const [tabs, setTabs] = useState<TabSummary[]>([]);
	const [urlInput, setUrlInput] = useState("");
	const [settingsOpen, setSettingsOpen] = useState(false);

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

	const active = tabs.find((t) => t.active);

	const onNavigate = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (!active) return;
		void window.agentBrowser?.tab.navigate(active.id, urlInput);
	};

	const onNewTab = () => {
		void window.agentBrowser?.tab.open("about:blank");
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
						className={`tab ${t.active ? "active" : ""}`}
						title={t.url}
					>
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
				<button type="button" className="tab-new" onClick={onNewTab}>
					+
				</button>
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
		</div>
	);
}
