import { type FormEvent, useCallback, useEffect, useState } from "react";

export function VaultView() {
	const [keys, setKeys] = useState<string[]>([]);
	const [keyName, setKeyName] = useState("");
	const [secret, setSecret] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [available, setAvailable] = useState(true);

	const load = useCallback(async () => {
		const bridge = window.agentBrowser?.vault;
		if (!bridge) {
			setAvailable(false);
			return;
		}
		try {
			setKeys(await bridge.list());
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
		const bridge = window.agentBrowser?.vault;
		if (!bridge || !keyName.trim() || !secret) return;
		try {
			await bridge.set(keyName.trim(), secret);
			setKeyName("");
			setSecret("");
			void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const onDelete = async (key: string) => {
		const bridge = window.agentBrowser?.vault;
		if (!bridge) return;
		if (!confirm(`Delete vault key "${key}"?`)) return;
		await bridge.delete(key);
		void load();
	};

	const onClear = async () => {
		const bridge = window.agentBrowser?.vault;
		if (!bridge) return;
		if (!confirm("Clear the entire vault? This cannot be undone.")) return;
		await bridge.clear();
		void load();
	};

	if (!available) {
		return (
			<section className="settings-view">
				<h2>Auth Vault</h2>
				<p className="settings-empty">Vault IPC not available.</p>
			</section>
		);
	}

	return (
		<section className="settings-view">
			<div className="settings-view-header">
				<h2>Auth Vault</h2>
				<button type="button" onClick={onClear}>
					Clear vault
				</button>
			</div>
			<p className="settings-hint">
				<strong>Plaintext never leaves the main process.</strong> Secrets are
				AES-256-GCM encrypted on disk; the renderer only sees key names. Use{" "}
				<code>{"{{vault:key}}"}</code> placeholders in agent tasks — the agent
				host substitutes values before executing page actions.
			</p>
			<form className="settings-search" onSubmit={onAdd}>
				<input
					value={keyName}
					onChange={(e) => setKeyName(e.target.value)}
					placeholder="key (e.g. github.password)"
				/>
				<input
					value={secret}
					onChange={(e) => setSecret(e.target.value)}
					type="password"
					placeholder="secret value"
					autoComplete="new-password"
				/>
				<button type="submit">Add</button>
			</form>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			<ul className="settings-list">
				{keys.map((k) => (
					<li key={k} className="settings-list-item">
						<div className="settings-list-main">
							<div className="settings-list-title">
								<code>{k}</code>
							</div>
							<div className="settings-list-sub">secret hidden</div>
						</div>
						<button type="button" onClick={() => onDelete(k)}>
							Delete
						</button>
					</li>
				))}
				{keys.length === 0 && (
					<li className="settings-empty">Vault is empty.</li>
				)}
			</ul>
		</section>
	);
}
