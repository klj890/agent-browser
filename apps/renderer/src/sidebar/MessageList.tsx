import { renderMarkdown } from "./markdown";

export type SidebarMessage =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; streaming?: boolean }
	| {
			kind: "tool_call";
			id: string;
			name: string;
			args: Record<string, unknown>;
	  }
	| {
			kind: "tool_result";
			id: string;
			name: string;
			result?: unknown;
			denied?: boolean;
			error?: string;
	  }
	| { kind: "error"; message: string };

export interface MessageListProps {
	messages: SidebarMessage[];
}

function renderArgs(args: Record<string, unknown>): string {
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

export function MessageList({ messages }: MessageListProps) {
	return (
		<div className="msg-list">
			{messages.map((m, idx) => {
				if (m.kind === "user") {
					return (
						<div
							key={`u-${idx}-${m.text.slice(0, 8)}`}
							className="msg msg-user"
						>
							<div className="msg-role">You</div>
							<div className="msg-body">{m.text}</div>
						</div>
					);
				}
				if (m.kind === "assistant") {
					return (
						<div
							key={`a-${idx}-${m.text.slice(0, 8)}`}
							className={`msg msg-assistant${m.streaming ? " streaming" : ""}`}
						>
							<div className="msg-role">Agent</div>
							<div
								className="msg-body md"
								// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes HTML
								dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
							/>
						</div>
					);
				}
				if (m.kind === "tool_call") {
					return (
						<div key={`tc-${m.id}`} className="msg msg-tool-call">
							<div className="msg-role">Tool: {m.name}</div>
							<pre className="msg-body">{renderArgs(m.args)}</pre>
						</div>
					);
				}
				if (m.kind === "tool_result") {
					const label = m.denied ? "denied" : m.error ? "error" : "ok";
					return (
						<div key={`tr-${m.id}`} className={`msg msg-tool-result ${label}`}>
							<div className="msg-role">
								Tool result: {m.name} ({label})
							</div>
							<pre className="msg-body">
								{m.error ??
									(m.result
										? renderArgs(m.result as Record<string, unknown>)
										: "")}
							</pre>
						</div>
					);
				}
				return (
					<div
						key={`e-${idx}-${m.message.slice(0, 12)}`}
						className="msg msg-error"
					>
						<div className="msg-role">Error</div>
						<div className="msg-body">{m.message}</div>
					</div>
				);
			})}
		</div>
	);
}
