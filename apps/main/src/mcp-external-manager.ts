/**
 * McpExternalManager (P2 §2.6) — owns the set of external MCP clients,
 * hands AgentHost a flat list of skills, and contains failures per-server
 * so one broken feed can't sink the Agent.
 *
 * Responsibilities split with `McpExternalClient`:
 *   - McpExternalClient: single remote server's lifecycle (connect, list,
 *     call, disconnect) — knows the protocol, doesn't know about Skills.
 *   - McpExternalManager: many clients, skill conversion, routing a prefixed
 *     tool call back to the client that owns it — knows about Skills,
 *     doesn't know about the protocol.
 *
 * Skill adapter: external tools come with a JSON Schema that arrives over
 * the wire. We can't compile that into a Zod object at boot (too much
 * complexity for what is effectively a passthrough), so we use
 * `z.unknown()` as the input schema and trust the remote server to
 * reject malformed args. Tool results stream through unchanged —
 * AgentHost's RedactionPipeline runs on outbound prompts, not on
 * tool-return content, so we don't have to filter here.
 */
import type { Skill } from "@agent-browser/browser-tools";
import { z } from "zod";
import type { ExternalMcpServer } from "./external-mcp-config.js";
import { McpExternalClient } from "./mcp-external-client.js";

export interface McpExternalManagerDeps {
	servers: ExternalMcpServer[];
	/** Test hook — swap the client factory. */
	clientFactory?: (spec: ExternalMcpServer) => McpExternalClient;
}

export interface McpExternalManagerStatus {
	id: string;
	name: string;
	enabled: boolean;
	connected: boolean;
	toolCount: number;
	error?: string;
}

export class McpExternalManager {
	private readonly clients: McpExternalClient[] = [];
	private readonly statuses = new Map<string, McpExternalManagerStatus>();
	private readonly specById = new Map<string, ExternalMcpServer>();
	private readonly clientFactory: (
		spec: ExternalMcpServer,
	) => McpExternalClient;

	constructor(deps: McpExternalManagerDeps) {
		this.clientFactory =
			deps.clientFactory ?? ((spec) => new McpExternalClient({ spec }));
		for (const spec of deps.servers) {
			if (this.specById.has(spec.id)) {
				// Duplicate id in config: we keep the FIRST and ignore the rest
				// because the per-server timeout / prefix / token differs and
				// overwriting would silently reshape behaviour. Warn so the
				// user can fix the config file.
				console.warn(
					`[mcp-external] duplicate server id '${spec.id}' ignored; ` +
						"remove the later entry from mcp-clients.json",
				);
				continue;
			}
			this.specById.set(spec.id, spec);
			this.statuses.set(spec.id, {
				id: spec.id,
				name: spec.name,
				enabled: spec.enabled,
				connected: false,
				toolCount: 0,
			});
			if (!spec.enabled) continue;
			this.clients.push(this.clientFactory(spec));
		}
	}

	/**
	 * Connect every enabled client in parallel. A single client's failure
	 * doesn't abort the others — it surfaces via `status().error` and its
	 * skills are simply absent from `skills()`. Same pattern as
	 * `syncPersonasFromAllSources` in P2-19.
	 */
	async start(defaultTimeoutMs = 10_000): Promise<void> {
		await Promise.all(
			this.clients.map(async (c) => {
				// Prefer the per-server timeout so admins can bump a known-slow
				// server without weakening the safety margin for everything else.
				const spec = this.specById.get(c.id);
				const timeoutMs = spec?.timeoutMs ?? defaultTimeoutMs;
				try {
					await this.withTimeout(c.connect(), timeoutMs);
					const status = this.statuses.get(c.id);
					if (status) {
						status.connected = true;
						status.toolCount = c.listTools().length;
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const status = this.statuses.get(c.id);
					if (status) status.error = msg;
				}
			}),
		);
	}

	async stop(): Promise<void> {
		await Promise.all(
			this.clients.map(async (c) => {
				try {
					await c.disconnect();
				} catch {
					/* best-effort */
				}
			}),
		);
	}

	/**
	 * Flat list of skills across every successfully-connected client. Name
	 * collisions are prevented by client-side prefix; if two servers share
	 * the same prefix (shouldn't happen — config validator rejects it in
	 * a later PR) the later registration wins as Map.set does.
	 */
	skills(): Skill[] {
		const skills: Skill[] = [];
		for (const client of this.clients) {
			if (!client.isConnected()) continue;
			for (const tool of client.listTools()) {
				skills.push({
					name: tool.name,
					// Append the remote's JSON Schema to the description so
					// the LLM sees the expected shape even though our Zod
					// input is deliberately permissive. Runtime-compiling
					// arbitrary JSON Schema to Zod is out of scope here;
					// the remote server already validates the final args.
					description: embedSchemaInDescription(
						tool.description,
						tool.inputSchema,
					),
					// `.passthrough()` accepts any object, which mirrors the
					// MCP spec (arguments is `object`). We don't use
					// `z.unknown()` because Skill callers expect a record.
					inputSchema: z.object({}).passthrough(),
					execute: async (input) => {
						const args =
							input && typeof input === "object"
								? (input as Record<string, unknown>)
								: {};
						const result = await client.callTool(tool.name, args);
						if (result.isError) {
							// Surface as a rejection with the remote's content
							// summary so the LLM sees the actual reason (auth
							// failure, argument validation, rate limit, etc.)
							// and can retry / adjust / give up accordingly.
							// AgentHost's audit hook records the throw too.
							throw new Error(
								`mcp-external '${client.id}' tool '${tool.remoteName}' returned isError:true — ${summariseContent(result.content)}`,
							);
						}
						return result.content;
					},
				});
			}
		}
		return skills;
	}

	status(): McpExternalManagerStatus[] {
		return Array.from(this.statuses.values()).map((s) => ({ ...s }));
	}

	private async withTimeout<Tp>(p: Promise<Tp>, ms: number): Promise<Tp> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutP = new Promise<Tp>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`mcp-external connect timed out after ${ms}ms`)),
				ms,
			);
		});
		// Attach a no-op catch to the inner promise so a late rejection —
		// after timeoutP has already won the race — doesn't surface as an
		// `unhandledRejection` in the event loop. The swallowed result is
		// irrelevant; the caller has already received the timeout error.
		p.catch(() => {});
		// `finally` clears the timer whether `p` won or threw — otherwise the
		// handle would keep the event loop alive past the winner's settlement.
		return Promise.race([p, timeoutP]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	}
}

/**
 * Extract a terse human-readable reason from MCP `content` blocks.
 * MCP content is an array of typed blocks ({type:"text", text:"..."}, ...).
 * We pull the first text block, fall back to a JSON snapshot. Truncated to
 * keep the thrown Error message manageable for logs and audit entries.
 */
const ISERROR_SUMMARY_MAX = 512;
function summariseContent(content: unknown): string {
	if (Array.isArray(content)) {
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				"type" in block &&
				(block as { type: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				const text = (block as { text: string }).text;
				return text.length > ISERROR_SUMMARY_MAX
					? `${text.slice(0, ISERROR_SUMMARY_MAX)}…(truncated)`
					: text;
			}
		}
	}
	try {
		const j = JSON.stringify(content);
		return j.length > ISERROR_SUMMARY_MAX
			? `${j.slice(0, ISERROR_SUMMARY_MAX)}…(truncated)`
			: j;
	} catch {
		return "<non-serialisable content>";
	}
}

/**
 * Append the remote tool's JSON Schema to the description so the LLM can
 * read it and emit well-typed args even though our Skill-level Zod is a
 * permissive passthrough. For schemas that fit under the char budget we
 * inline the whole JSON; for oversize ones we degrade to a valid summary
 * (property names + types) rather than a string-truncated — and therefore
 * syntactically invalid — JSON blob that LLMs may hallucinate around.
 */
const SCHEMA_MAX_CHARS = 1024;
function embedSchemaInDescription(base: string, schema: unknown): string {
	if (schema == null || typeof schema !== "object") return base;
	let serialised: string;
	try {
		serialised = JSON.stringify(schema);
	} catch {
		return base;
	}
	if (serialised.length <= SCHEMA_MAX_CHARS) {
		return `${base}\n\nArguments schema (JSON Schema):\n${serialised}`;
	}
	// Oversize schema — fall back to a human-readable summary so we never
	// put truncated (invalid) JSON in the prompt.
	const summary = summariseSchema(schema);
	return `${base}\n\nArguments schema (summary — full JSON omitted, >${SCHEMA_MAX_CHARS} chars):\n${summary}`;
}

/**
 * Normalise a JSON Schema `type` value to a printable string. Per the
 * spec `type` can be a single string or an array of strings (union
 * types, e.g. `["string", "null"]` for nullable fields). Returning
 * "unknown" for arrays hides a valid and common pattern.
 */
function formatSchemaType(t: unknown): string {
	if (typeof t === "string") return t;
	if (Array.isArray(t)) {
		const parts = t.filter((x): x is string => typeof x === "string");
		if (parts.length > 0) return parts.join(" | ");
	}
	return "unknown";
}

function summariseSchema(schema: unknown): string {
	if (!schema || typeof schema !== "object") return "<opaque>";
	const s = schema as {
		type?: unknown;
		properties?: Record<string, { type?: unknown; description?: unknown }>;
		required?: unknown;
	};
	const lines: string[] = [];
	const topType = formatSchemaType(s.type);
	if (topType !== "unknown") lines.push(`type: ${topType}`);
	if (s.properties && typeof s.properties === "object") {
		const required = Array.isArray(s.required)
			? new Set(s.required.map(String))
			: new Set<string>();
		lines.push("properties:");
		for (const [key, val] of Object.entries(s.properties)) {
			const typeStr = formatSchemaType(val?.type);
			const req = required.has(key) ? " (required)" : "";
			lines.push(`  - ${key}: ${typeStr}${req}`);
		}
	}
	return lines.join("\n") || "<opaque>";
}
