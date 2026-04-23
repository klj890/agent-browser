import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { SyncStatusView } from "../../types/preload";

export function SyncView() {
	const [status, setStatus] = useState<SyncStatusView | null>(null);
	const [passphrase, setPassphrase] = useState("");
	const [serverUrl, setServerUrl] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [available, setAvailable] = useState(true);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const bridge = window.agentBrowser?.sync;
		if (!bridge) {
			setAvailable(false);
			return;
		}
		try {
			const s = await bridge.status();
			setStatus(s);
			setServerUrl((prev) => (prev ? prev : (s.serverUrl ?? "")));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const clearMessages = () => {
		setError(null);
		setInfo(null);
	};

	const onConfigure = async (e: FormEvent) => {
		e.preventDefault();
		if (!passphrase) return;
		const bridge = window.agentBrowser?.sync;
		if (!bridge) return;
		clearMessages();
		setBusy(true);
		try {
			await bridge.configure(passphrase, serverUrl || undefined);
			setPassphrase("");
			setInfo("Sync configured and unlocked.");
			void refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const onUnlock = async (e: FormEvent) => {
		e.preventDefault();
		if (!passphrase) return;
		const bridge = window.agentBrowser?.sync;
		if (!bridge) return;
		clearMessages();
		setBusy(true);
		try {
			const r = await bridge.unlock(passphrase);
			if (!r.ok) {
				setError("Passphrase rejected.");
			} else {
				setPassphrase("");
				setInfo("Unlocked.");
				void refresh();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const onLock = async () => {
		const bridge = window.agentBrowser?.sync;
		if (!bridge) return;
		clearMessages();
		await bridge.lock();
		void refresh();
	};

	const onDisable = async () => {
		if (
			!window.confirm(
				"Disable sync? The passphrase and local cursors will be forgotten on this device.",
			)
		) {
			return;
		}
		const bridge = window.agentBrowser?.sync;
		if (!bridge) return;
		clearMessages();
		await bridge.disable();
		void refresh();
	};

	const onPush = async () => {
		const bridge = window.agentBrowser?.sync;
		if (!bridge) return;
		clearMessages();
		setBusy(true);
		try {
			const r = await bridge.pushNow();
			setInfo(`Pushed ${r.pushed} item(s).`);
			void refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const onPull = async () => {
		const bridge = window.agentBrowser?.sync;
		if (!bridge) return;
		clearMessages();
		setBusy(true);
		try {
			const r = await bridge.pullNow();
			setInfo(`Applied ${r.applied}, skipped ${r.skipped}.`);
			void refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (!available) {
		return (
			<section className="settings-view">
				<h2>Cloud sync</h2>
				<p className="settings-empty">Sync IPC not available.</p>
			</section>
		);
	}

	const configured = status?.configured ?? false;
	const unlocked = status?.unlocked ?? false;

	return (
		<section className="settings-view">
			<h2>Cloud sync</h2>
			<p className="settings-hint">
				End-to-end encrypted. The passphrase derives the key via scrypt and
				never leaves this device; the server only sees ciphertext. Forgetting
				the passphrase means losing access to synced data — there is no
				recovery.
			</p>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			{info && (
				<p className="settings-hint" style={{ background: "#e6ffed" }}>
					{info}
				</p>
			)}
			<div className="settings-editor">
				<h3>Status</h3>
				<div className="settings-list-sub">
					<div>Configured: {configured ? "yes" : "no"}</div>
					<div>Unlocked: {unlocked ? "yes" : "no"}</div>
					<div>Server: {status?.serverUrl ?? "—"}</div>
					<div>
						Last bookmarks cursor: {status?.lastBookmarksCursor ?? 0} · history
						cursor: {status?.lastHistoryCursor ?? 0}
					</div>
				</div>
			</div>

			{!configured && (
				<form className="settings-editor" onSubmit={onConfigure}>
					<h3>Configure</h3>
					<label className="settings-field">
						Passphrase
						<input
							type="password"
							value={passphrase}
							onChange={(e) => setPassphrase(e.target.value)}
							placeholder="Choose a strong passphrase"
							autoComplete="new-password"
						/>
					</label>
					<label className="settings-field">
						Server URL (optional)
						<input
							value={serverUrl}
							onChange={(e) => setServerUrl(e.target.value)}
							placeholder="https://sync.example.com"
						/>
					</label>
					<div className="settings-actions">
						<button type="submit" disabled={busy || !passphrase}>
							Configure
						</button>
					</div>
				</form>
			)}

			{configured && !unlocked && (
				<form className="settings-editor" onSubmit={onUnlock}>
					<h3>Unlock</h3>
					<label className="settings-field">
						Passphrase
						<input
							type="password"
							value={passphrase}
							onChange={(e) => setPassphrase(e.target.value)}
							autoComplete="current-password"
						/>
					</label>
					<div className="settings-actions">
						<button type="submit" disabled={busy || !passphrase}>
							Unlock
						</button>
						<button type="button" onClick={onDisable} disabled={busy}>
							Disable sync
						</button>
					</div>
				</form>
			)}

			{configured && unlocked && (
				<>
					<div className="settings-editor">
						<h3>Actions</h3>
						<div className="settings-actions">
							<button type="button" onClick={onPush} disabled={busy}>
								Push now
							</button>
							<button type="button" onClick={onPull} disabled={busy}>
								Pull now
							</button>
							<button type="button" onClick={onLock} disabled={busy}>
								Lock
							</button>
							<button type="button" onClick={onDisable} disabled={busy}>
								Disable sync
							</button>
						</div>
					</div>
					<form
						className="settings-editor"
						onSubmit={async (e) => {
							e.preventDefault();
							const bridge = window.agentBrowser?.sync;
							if (!bridge) return;
							clearMessages();
							setBusy(true);
							try {
								const next = serverUrl.trim() || null;
								const s = await bridge.updateServerUrl(next);
								setStatus(s);
								setInfo(
									next
										? `Server URL updated to ${next}. Next push/pull will use it.`
										: "Cleared server URL — sync is now local-only.",
								);
							} catch (err) {
								setError(err instanceof Error ? err.message : String(err));
							} finally {
								setBusy(false);
							}
						}}
					>
						<h3>Change server URL</h3>
						<p className="settings-list-sub">
							Repoint sync at a different backend without restarting. Does not
							touch keys, cursors, or local data.
						</p>
						<label className="settings-field">
							Server URL
							<input
								value={serverUrl}
								onChange={(e) => setServerUrl(e.target.value)}
								placeholder="https://sync.example.com or leave blank"
							/>
						</label>
						<div className="settings-actions">
							<button type="submit" disabled={busy}>
								Update
							</button>
						</div>
					</form>
				</>
			)}
		</section>
	);
}
