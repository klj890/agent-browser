import { useCallback, useEffect, useState } from "react";
import type { HistoryEntryView } from "../../types/preload";

type SearchMode = "like" | "fulltext" | "semantic";

export function HistoryView() {
	const [entries, setEntries] = useState<HistoryEntryView[]>([]);
	const [query, setQuery] = useState("");
	const [mode, setMode] = useState<SearchMode>("fulltext");
	const [error, setError] = useState<string | null>(null);
	const [available, setAvailable] = useState(true);

	const load = useCallback(async (q: string, m: SearchMode) => {
		const bridge = window.agentBrowser?.history;
		if (!bridge) {
			setAvailable(false);
			return;
		}
		try {
			let list: HistoryEntryView[];
			if (!q) {
				list = await bridge.list();
			} else if (m === "semantic") {
				list = await bridge.semanticSearch(q);
			} else if (m === "fulltext") {
				list = await bridge.fullTextSearch(q);
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
		void load("", "fulltext");
	}, [load]);

	const onSearch = (e: React.FormEvent) => {
		e.preventDefault();
		void load(query, mode);
	};

	const onClear = async () => {
		const bridge = window.agentBrowser?.history;
		if (!bridge) return;
		if (!confirm("Clear all history?")) return;
		await bridge.clear();
		void load(query, mode);
	};

	if (!available) {
		return (
			<section className="settings-view">
				<h2>History</h2>
				<p className="settings-empty">History IPC not available.</p>
			</section>
		);
	}

	const placeholder =
		mode === "semantic"
			? "Semantic search…"
			: mode === "fulltext"
				? "Full-text search (multi-word, prefix match)…"
				: "Substring search URL or title…";

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
					placeholder={placeholder}
				/>
				<button type="submit">Search</button>
				<select
					value={mode}
					onChange={(e) => setMode(e.target.value as SearchMode)}
					style={{
						marginLeft: 8,
						padding: "4px 6px",
						borderRadius: 4,
						border: "1px solid #ccc",
						fontSize: 12,
					}}
				>
					<option value="fulltext">Full-text</option>
					<option value="like">Substring</option>
					<option value="semantic">Semantic</option>
				</select>
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
