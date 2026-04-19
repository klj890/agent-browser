/**
 * AdminView — Stage 5.2 read-only policy display.
 *
 * Shows the current AdminPolicy as pretty-printed JSON. Editing flows belong
 * to a later stage and MUST go through an authenticated channel (admin
 * password) — renderer never mutates policy directly.
 */
import { useEffect, useState } from "react";
import type { AdminPolicyView } from "../../types/preload";

type LoadState =
	| { status: "loading" }
	| { status: "ready"; policy: AdminPolicyView }
	| { status: "error"; message: string };

export function AdminView() {
	const [state, setState] = useState<LoadState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		const bridge = window.agentBrowser;
		if (!bridge?.policy) {
			setState({ status: "error", message: "policy bridge unavailable" });
			return;
		}
		bridge.policy
			.get()
			.then((policy) => {
				if (!cancelled) setState({ status: "ready", policy });
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setState({
						status: "error",
						message: err instanceof Error ? err.message : String(err),
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<section className="admin-view">
			<h2>Admin Policy (read-only)</h2>
			{state.status === "loading" && <p>Loading…</p>}
			{state.status === "error" && (
				<p role="alert">Failed to load policy: {state.message}</p>
			)}
			{state.status === "ready" && (
				<pre
					style={{
						background: "#0b1220",
						color: "#d7e3f4",
						padding: "12px",
						borderRadius: "6px",
						overflow: "auto",
						fontFamily:
							'ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace',
						fontSize: "12px",
						lineHeight: 1.5,
					}}
				>
					{JSON.stringify(state.policy, null, 2)}
				</pre>
			)}
		</section>
	);
}
