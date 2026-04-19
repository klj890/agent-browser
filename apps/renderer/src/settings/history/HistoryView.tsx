import { useCallback, useEffect, useState } from "react";
import type { HistoryEntryView } from "../../types/preload";

export function HistoryView() {
	const [entries, setEntries] = useState<HistoryEntryView[]>([]);
	const [query, setQuery] = useState("");
	const [semantic, setSemantic] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [available, setAvailable] = useState(true);

	const load = useCallback(async (q: string, useSemantic: boolean) => {
		const bridge = window.agentBrowser?.history;
		if (!bridge) {
			setAvailable(false);
			return;
		}
		try {
			let list: HistoryEntryView[];
			if (!q) {
				list = await bridge.list();
			} else if (useSemantic) {
				list = await bridge.semanticSearch(q);
			} else {
				list = await bridge.search(q);
			}
			setEntries(list);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void load("", false);
	}, [load]);

	const onSearch = (e: React.FormEvent) => {
		e.preventDefault();
		void load(query, semantic);
	};

	const onClear = async () => {
		const bridge = window.agentBrowser?.history;
		if (!bridge) return;
		if (!confirm("Clear all history?")) return;
		await bridge.clear();
		void load(query, semantic);
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
					placeholder={
						semantic ? "Semantic search…" : "Search URL or title…"
					}
				/>
				<button type="submit">Search</button>
				<label
					style={{
						marginLeft: 8,
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
					}}
				>
					<input
						type="checkbox"
						checked={semantic}
						onChange={(e) => setSemantic(e.target.checked)}
					/>
					Semantic
				</label>
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
								<span> · {new Date(e.visited_at).toLocaleString()}</span>
							</div>
						</div>
					</li>
				))}
				{entries.length === 0 && (
					<li className="settings-empty">No history entries.</li>
				)}
			</ul>
		</section>
	);
}
