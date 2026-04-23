import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { ProfileView } from "../../types/preload";

export function ProfilesView() {
	const [entries, setEntries] = useState<ProfileView[]>([]);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [available, setAvailable] = useState(true);

	const load = useCallback(async () => {
		const bridge = window.agentBrowser?.profiles;
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

	const onCreate = async (e: FormEvent) => {
		e.preventDefault();
		const bridge = window.agentBrowser?.profiles;
		const trimmed = name.trim();
		if (!bridge || !trimmed) return;
		try {
			await bridge.create(trimmed);
			setName("");
			void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const onRename = async (p: ProfileView) => {
		const next = window.prompt("Rename profile", p.name);
		if (next == null || next.trim() === p.name) return;
		const bridge = window.agentBrowser?.profiles;
		if (!bridge) return;
		try {
			await bridge.rename(p.id, next.trim());
			void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const onDelete = async (p: ProfileView) => {
		if (!p.removable) return;
		if (
			!window.confirm(
				`Delete profile "${p.name}"? All cookies and storage for this profile will be erased.`,
			)
		) {
			return;
		}
		const bridge = window.agentBrowser?.profiles;
		if (!bridge) return;
		try {
			await bridge.remove(p.id);
			void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	if (!available) {
		return (
			<section className="settings-view">
				<h2>Profiles</h2>
				<p className="settings-empty">Profiles IPC not available.</p>
			</section>
		);
	}

	return (
		<section className="settings-view">
			<h2>Profiles</h2>
			<p>
				Profiles keep cookies, localStorage, and extensions isolated between
				workspaces. The default profile cannot be removed.
			</p>
			<form className="settings-search" onSubmit={onCreate}>
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="New profile name (e.g. Work)"
				/>
				<button type="submit">Create</button>
			</form>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			<ul className="settings-list">
				{entries.map((p) => (
					<li key={p.id} className="settings-list-item">
						<div className="settings-list-main">
							<div className="settings-list-title">
								{p.name}
								{!p.removable ? " (default)" : ""}
							</div>
							<div className="settings-list-sub">{p.partition}</div>
						</div>
						<div>
							<button type="button" onClick={() => onRename(p)}>
								Rename
							</button>
							<button
								type="button"
								onClick={() => onDelete(p)}
								disabled={!p.removable}
								style={{ marginLeft: 8 }}
							>
								Delete
							</button>
						</div>
					</li>
				))}
				{entries.length === 0 && (
					<li className="settings-empty">No profiles yet.</li>
				)}
			</ul>
		</section>
	);
}
