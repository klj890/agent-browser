import { useCallback, useEffect, useState } from "react";
import type { DownloadEntry, DownloadProgress } from "../../types/preload";

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DownloadsView() {
	const [entries, setEntries] = useState<DownloadEntry[]>([]);
	const [available, setAvailable] = useState(true);

	const load = useCallback(async () => {
		const bridge = window.agentBrowser?.downloads;
		if (!bridge) {
			setAvailable(false);
			return;
		}
		setEntries(await bridge.list());
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		const bridge = window.agentBrowser?.downloads;
		if (!bridge) return;
		const off = bridge.onProgress((p: DownloadProgress) => {
			setEntries((prev) =>
				prev.map((e) =>
					e.id === p.id
						? {
								...e,
								bytesReceived: p.bytesReceived,
								bytesTotal: p.bytesTotal,
								state: p.state,
							}
						: e,
				),
			);
		});
		return off;
	}, []);

	const onCancel = async (id: string) => {
		await window.agentBrowser?.downloads?.cancel(id);
		void load();
	};

	const onOpen = async (id: string) => {
		await window.agentBrowser?.downloads?.openFolder(id);
	};

	if (!available) {
		return (
			<section className="settings-view">
				<h2>Downloads</h2>
				<p className="settings-empty">Downloads IPC not available.</p>
			</section>
		);
	}

	return (
		<section className="settings-view">
			<h2>Downloads</h2>
			<ul className="settings-list">
				{entries.map((d) => {
					const pct =
						d.bytesTotal > 0
							? Math.min(
									100,
									Math.floor((d.bytesReceived / d.bytesTotal) * 100),
								)
							: 0;
					return (
						<li key={d.id} className="settings-list-item">
							<div className="settings-list-main">
								<div className="settings-list-title">{d.filename}</div>
								<div className="settings-list-sub">
									{d.state} · {fmtBytes(d.bytesReceived)} /{" "}
									{fmtBytes(d.bytesTotal)} ({pct}%)
								</div>
								<div className="settings-progress">
									<div
										className="settings-progress-bar"
										style={{ width: `${pct}%` }}
									/>
								</div>
							</div>
							<div className="settings-actions">
								{d.state === "progressing" && (
									<button type="button" onClick={() => onCancel(d.id)}>
										Cancel
									</button>
								)}
								<button type="button" onClick={() => onOpen(d.id)}>
									Open folder
								</button>
							</div>
						</li>
					);
				})}
				{entries.length === 0 && (
					<li className="settings-empty">No downloads.</li>
				)}
			</ul>
		</section>
	);
}
