import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { BookmarkView } from "../../types/preload";

export function BookmarksView() {
	const [entries, setEntries] = useState<BookmarkView[]>([]);
	const [url, setUrl] = useState("");
	const [title, setTitle] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [available, setAvailable] = useState(true);

	const load = useCallback(async () => {
		const bridge = window.agentBrowser?.bookmarks;
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

	const onAdd = async (e: FormEvent) => {
		e.preventDefault();
		const bridge = window.agentBrowser?.bookmarks;
		if (!bridge || !url.trim()) return;
		try {
			await bridge.add({ url: url.trim(), title: title.trim() || url.trim() });
			setUrl("");
			setTitle("");
			void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const onDelete = async (id: number) => {
		const bridge = window.agentBrowser?.bookmarks;
		if (!bridge) return;
		await bridge.remove(id);
		void load();
	};

	if (!available) {
		return (
			<section className="settings-view">
				<h2>Bookmarks</h2>
				<p className="settings-empty">Bookmarks IPC not available.</p>
			</section>
		);
	}

	return (
		<section className="settings-view">
			<h2>Bookmarks</h2>
			<form className="settings-search" onSubmit={onAdd}>
				<input
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://…"
				/>
				<input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="Title (optional)"
				/>
				<button type="submit">Add</button>
			</form>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			<ul className="settings-list">
				{entries.map((b) => (
					<li key={b.id} className="settings-list-item">
						<div className="settings-list-main">
							<div className="settings-list-title">{b.title}</div>
							<div className="settings-list-sub">
								<a href={b.url}>{b.url}</a>
							</div>
						</div>
						<button type="button" onClick={() => onDelete(b.id)}>
							Delete
						</button>
					</li>
				))}
				{entries.length === 0 && (
					<li className="settings-empty">No bookmarks yet.</li>
				)}
			</ul>
		</section>
	);
}
