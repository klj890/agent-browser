import { useCallback, useEffect, useState } from "react";
import type { ExtensionView } from "../../types/preload";

export function ExtensionsView() {
	const [entries, setEntries] = useState<ExtensionView[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [available, setAvailable] = useState(true);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		const bridge = window.agentBrowser?.extensions;
		if (!bridge) {
			setAvailable(false);
			return;
		}
		try {
			setEntries(await bridge.list());
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const onInstall = async () => {
		const bridge = window.agentBrowser?.extensions;
		if (!bridge) return;
		setBusy(true);
		try {
			const installed = await bridge.install();
			if (installed) void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const onToggle = async (ext: ExtensionView) => {
		const bridge = window.agentBrowser?.extensions;
		if (!bridge) return;
		try {
			await bridge.setEnabled(ext.id, !ext.enabled);
			void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const onRemove = async (ext: ExtensionView) => {
		if (!window.confirm(`Remove extension "${ext.name}"?`)) return;
		const bridge = window.agentBrowser?.extensions;
		if (!bridge) return;
		try {
			await bridge.remove(ext.id);
			void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	if (!available) {
		return (
			<section className="settings-view">
				<h2>Extensions</h2>
				<p className="settings-empty">Extensions IPC not available.</p>
			</section>
		);
	}

	return (
		<section className="settings-view">
			<div className="settings-view-header">
				<h2>Extensions</h2>
				<button type="button" onClick={onInstall} disabled={busy}>
					{busy ? "Loading…" : "Load unpacked"}
				</button>
			</div>
			<p className="settings-hint">
				Only Chrome MV3 extensions (manifest_version: 3) are supported.
				Supported APIs: storage, tabs, webRequest, contextMenus, scripting.
				Admins can restrict which extensions may load via the policy’s
				allowedExtensionIds.
			</p>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			<ul className="settings-list">
				{entries.map((e) => (
					<li key={e.id} className="settings-list-item">
						<div className="settings-list-main">
							<div className="settings-list-title">
								{e.name}{" "}
								<span style={{ color: "#888", fontWeight: 400 }}>
									v{e.version}
								</span>
							</div>
							<div className="settings-list-sub">
								<code>{e.id}</code> · {e.path}
							</div>
						</div>
						<div>
							<button
								type="button"
								onClick={() => onToggle(e)}
								style={{ marginRight: 8 }}
							>
								{e.enabled ? "Disable" : "Enable"}
							</button>
							<button type="button" onClick={() => onRemove(e)}>
								Remove
							</button>
						</div>
					</li>
				))}
				{entries.length === 0 && (
					<li className="settings-empty">No extensions installed.</li>
				)}
			</ul>
		</section>
	);
}
