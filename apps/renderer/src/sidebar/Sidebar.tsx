import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStreamChunk, PersonaSummary } from "../types/preload";
import { Composer } from "./Composer";
import { MessageList, type SidebarMessage } from "./MessageList";

/**
 * Sidebar (Stage 3.3 + 3.7) — chat UI bound to window.agentBrowser.agent.
 *
 * Protocol (see apps/main/src/agent-host.ts StreamChunk):
 *   - 'text' deltas are appended into the LAST assistant message (or a new one
 *     if none is streaming).
 *   - 'tool_call' and 'tool_result' get their own message rows.
 *   - 'error' shows an inline error.
 *   - 'done' ends the running state and (if no preceding error) keeps the
 *     transcript unchanged.
 */
export function Sidebar() {
	const [messages, setMessages] = useState<SidebarMessage[]>([]);
	const [running, setRunning] = useState(false);
	const [taskId, setTaskId] = useState<string | null>(null);
	const [personas, setPersonas] = useState<PersonaSummary[]>([]);
	const [pageAttached, setPageAttached] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Wire the stream listener once.
	useEffect(() => {
		const bridge = window.agentBrowser;
		if (!bridge) return;
		const off = bridge.agent.onStream((chunk: AgentStreamChunk) => {
			setMessages((prev) => applyChunk(prev, chunk));
			if (chunk.type === "done" || chunk.type === "error") {
				setRunning(false);
				setTaskId(null);
			}
		});
		return off;
	}, []);

	// Load personas on mount.
	useEffect(() => {
		const bridge = window.agentBrowser;
		if (!bridge) return;
		void bridge.persona.list().then((ps) => setPersonas(ps));
	}, []);

	useEffect(() => {
		if (!scrollRef.current) return;
		scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, []);

	const handleSubmit = useCallback(
		async (text: string) => {
			const bridge = window.agentBrowser;
			if (!bridge) return;
			let fullText = text;
			if (pageAttached) {
				fullText = `Current page: ${pageAttached}\n\n${text}`;
				setPageAttached(null);
			}
			setMessages((prev) => [...prev, { kind: "user", text: fullText }]);
			setRunning(true);
			try {
				const id = await bridge.agent.prompt(fullText);
				setTaskId(id);
			} catch (err) {
				setMessages((prev) => [
					...prev,
					{
						kind: "error",
						message: err instanceof Error ? err.message : String(err),
					},
				]);
				setRunning(false);
			}
		},
		[pageAttached],
	);

	const handleCancel = useCallback(() => {
		const bridge = window.agentBrowser;
		if (!bridge || !taskId) return;
		void bridge.agent.cancel(taskId);
	}, [taskId]);

	const handleIncludePage = useCallback(async () => {
		const bridge = window.agentBrowser;
		if (!bridge) return;
		const url = await bridge.tab.snapshotCurrent();
		if (url) setPageAttached(url);
	}, []);

	const handleSwitchPersona = useCallback(async (slug: string) => {
		const bridge = window.agentBrowser;
		if (!bridge) return;
		await bridge.persona.switch(slug);
		const fresh = await bridge.persona.list();
		setPersonas(fresh);
	}, []);

	const activePersona = personas.find((p) => p.active);

	return (
		<aside className="sidebar">
			<div className="sidebar-header">
				<div className="sidebar-title">Agent</div>
				{personas.length > 0 ? (
					<select
						className="sidebar-persona"
						value={activePersona?.slug ?? ""}
						onChange={(e) => void handleSwitchPersona(e.target.value)}
					>
						{personas.map((p) => (
							<option key={p.slug} value={p.slug}>
								{p.name}
							</option>
						))}
					</select>
				) : null}
			</div>
			<div className="sidebar-body" ref={scrollRef}>
				{messages.length === 0 ? (
					<div className="sidebar-empty">
						{activePersona
							? `Persona: ${activePersona.name} — ${activePersona.description}`
							: "No persona loaded."}
					</div>
				) : (
					<MessageList messages={messages} />
				)}
				{pageAttached ? (
					<div className="sidebar-page-attached">
						Page attached: <code>{pageAttached}</code>
					</div>
				) : null}
			</div>
			<Composer
				running={running}
				onSubmit={handleSubmit}
				onCancel={handleCancel}
				onIncludePage={handleIncludePage}
			/>
		</aside>
	);
}

function applyChunk(
	prev: SidebarMessage[],
	chunk: AgentStreamChunk,
): SidebarMessage[] {
	if (chunk.type === "text") {
		const last = prev[prev.length - 1];
		if (last && last.kind === "assistant" && last.streaming) {
			const updated: SidebarMessage = {
				...last,
				text: last.text + chunk.delta,
			};
			return [...prev.slice(0, -1), updated];
		}
		return [...prev, { kind: "assistant", text: chunk.delta, streaming: true }];
	}
	if (chunk.type === "tool_call") {
		return [
			...finalizeStreaming(prev),
			{ kind: "tool_call", id: chunk.id, name: chunk.name, args: chunk.args },
		];
	}
	if (chunk.type === "tool_result") {
		return [
			...finalizeStreaming(prev),
			{
				kind: "tool_result",
				id: chunk.id,
				name: chunk.name,
				result: chunk.result,
				denied: chunk.denied,
				error: chunk.error,
			},
		];
	}
	if (chunk.type === "error") {
		return [
			...finalizeStreaming(prev),
			{ kind: "error", message: chunk.message },
		];
	}
	if (chunk.type === "done") {
		return finalizeStreaming(prev);
	}
	return prev;
}

function finalizeStreaming(prev: SidebarMessage[]): SidebarMessage[] {
	const last = prev[prev.length - 1];
	if (last && last.kind === "assistant" && last.streaming) {
		return [...prev.slice(0, -1), { ...last, streaming: false }];
	}
	return prev;
}
