import { useCallback, useEffect, useState } from "react";
import type { McpStatusView } from "../../types/preload";

export function McpView() {
	const [status, setStatus] = useState<McpStatusView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [portInput, setPortInput] = useState("17890");
	const [available, setAvailable] = useState(true);

	const refresh = useCallback(async () => {
		const bridge = window.agentBrowser?.mcp;
		if (!bridge) {
			setAvailable(false);
			return;
		}
		try {
			const s = await bridge.status();
			setStatus(s);
			setPortInput(String(s.port));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const clearMessages = () => setError(null);

	const onEnable = async () => {
		const bridge = window.agentBrowser?.mcp;
		if (!bridge) return;
		clearMessages();
		setBusy(true);
		try {
			const p = Number(portInput);
			if (!Number.isFinite(p) || p < 1024 || p > 65535) {
				setError("Port must be an integer in 1024..65535");
				return;
			}
			const s = await bridge.enable(p);
			setStatus(s);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const onDisable = async () => {
		const bridge = window.agentBrowser?.mcp;
		if (!bridge) return;
		clearMessages();
		setBusy(true);
		try {
			setStatus(await bridge.disable());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const onRegenToken = async () => {
		if (
			!window.confirm(
				"Regenerate token? Existing client configurations will stop working until updated.",
			)
		)
			return;
		const bridge = window.agentBrowser?.mcp;
		if (!bridge) return;
		clearMessages();
		setBusy(true);
		try {
			setStatus(await bridge.regenerateToken());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const copy = (text: string) => {
		void navigator.clipboard?.writeText(text).catch(() => undefined);
	};

	if (!available) {
		return (
			<section className="settings-view">
				<h2>MCP Server</h2>
				<p className="settings-empty">MCP IPC not available.</p>
			</section>
		);
	}

	const clientSnippet = status?.endpoint
		? JSON.stringify(
				{
					"agent-browser": {
						url: status.endpoint,
						headers: {
							Authorization: `Bearer ${status.token ?? "<paste token>"}`,
						},
					},
				},
				null,
				2,
			)
		: "";

	return (
		<section className="settings-view">
			<h2>MCP Server</h2>
			<p className="settings-hint">
				Expose this browser as a Model Context Protocol server so external
				clients like Claude Desktop or Cursor can list/open tabs, search
				history, and read bookmarks. Loopback only (127.0.0.1). Requires the
				bearer token below.
			</p>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}

			<div className="settings-editor">
				<h3>Status</h3>
				<div className="settings-list-sub">
					<div>Enabled: {status?.enabled ? "yes" : "no"}</div>
					<div>Running: {status?.running ? "yes" : "no"}</div>
					<div>Port: {status?.port ?? "?"}</div>
					<div>Endpoint: {status?.endpoint ?? "—"}</div>
				</div>
			</div>

			<div className="settings-editor">
				<h3>Control</h3>
				<label className="settings-field">
					Port
					<input
						value={portInput}
						onChange={(e) => setPortInput(e.target.value)}
						disabled={status?.running === true}
						placeholder="17890"
					/>
				</label>
				<div className="settings-actions">
					{!status?.running ? (
						<button type="button" onClick={onEnable} disabled={busy}>
							Enable & start
						</button>
					) : (
						<button type="button" onClick={onDisable} disabled={busy}>
							Disable
						</button>
					)}
				</div>
			</div>

			{status?.enabled && status?.token && (
				<div className="settings-editor">
					<h3>Token</h3>
					<p className="settings-list-sub">
						Treat like a password — anyone with this token can drive the browser
						remotely. Share only with MCP clients you trust on this machine.
					</p>
					<div className="settings-actions">
						<input
							readOnly
							value={status.token}
							style={{
								flex: 1,
								fontFamily: "ui-monospace, Menlo, monospace",
								fontSize: 12,
								padding: "4px 6px",
								border: "1px solid #ccc",
								borderRadius: 4,
							}}
						/>
						<button type="button" onClick={() => copy(status.token ?? "")}>
							Copy
						</button>
						<button type="button" onClick={onRegenToken} disabled={busy}>
							Regenerate
						</button>
					</div>
				</div>
			)}

			{status?.running && status?.endpoint && (
				<div className="settings-editor">
					<h3>Client config</h3>
					<p className="settings-list-sub">
						Paste into your MCP client's config (Claude Desktop, Cursor…):
					</p>
					<pre
						style={{
							background: "#f6f8fa",
							padding: 12,
							borderRadius: 6,
							fontSize: 12,
							overflowX: "auto",
						}}
					>
						{clientSnippet}
					</pre>
					<div className="settings-actions">
						<button type="button" onClick={() => copy(clientSnippet)}>
							Copy config
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
