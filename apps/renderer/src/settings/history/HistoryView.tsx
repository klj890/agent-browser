import { useCallback, useEffect, useState } from "react";
import type { HistoryEntry } from "../../types/preload";

export function HistoryView() {
	const [entries, setEntries] = useState<HistoryEntry[]>([]);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [available, setAvailable] = useState(true);

	const load = useCallback(async (q: string) => {
		const bridge = window.agentBrowser?.history;
		if (!bridge) {
			setAvailable(false);
			return;
		}
		try {
			const list = await bridge.list(q || undefined);
			setEntries(list);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void load("");
	}, [load]);

	const onSearch = (e: React.FormEvent) => {
		e.preventDefault();
		void load(query);
	};

	const onClear = async () => {
		const bridge = window.agentBrowser?.history;
		if (!bridge) return;
		if (!confirm("Clear all history?")) return;
		await bridge.clear();
		void load(query);
	};

	const onDelete = async (id: string) => {
		const bridge = window.agentBrowser?.history;
		if (!bridge) return;
		await bridge.delete(id);
		void load(query);
	};

	if (!available) {
		return (
			<section className="settings-view">
				<h2>History</h2>
				<p className="settings-empty">History IPC not available.</p>
			</section>
		);
	}

	return (
		<section className="settings-view">
			<div className="settings-view-header">
				<h2>History</h2>
				<button type="button" onClick={onClear}>
					Clear all
				</button>
			</div>
			<form className="settings-search" onSubmit={onSearch}>
				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search URL or title…"
				/>
				<button type="submit">Search</button>
			</form>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			<ul className="settings-list">
				{entries.map((e) => (
					<li key={e.id} className="settings-list-item">
						<div className="settings-list-main">
							<div className="settings-list-title">{e.title || e.url}</div>
							<div className="settings-list-sub">
								<a href={e.url}>{e.url}</a>
								<span> · {new Date(e.visitedAt).toLocaleString()}</span>
							</div>
						</div>
						<button type="button" onClick={() => onDelete(e.id)}>
							Delete
						</button>
					</li>
				))}
				{entries.length === 0 && (
					<li className="settings-empty">No history entries.</li>
				)}
			</ul>
		</section>
	);
}
