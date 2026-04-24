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
	private readonly errors = new Map<string, string>();
	private readonly clientFactory: (
		spec: ExternalMcpServer,
	) => McpExternalClient;

	constructor(deps: McpExternalManagerDeps) {
		this.clientFactory =
			deps.clientFactory ?? ((spec) => new McpExternalClient({ spec }));
		for (const spec of deps.servers) {
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
	async start(timeoutMs = 10_000): Promise<void> {
		await Promise.all(
			this.clients.map(async (c) => {
				try {
					await this.withTimeout(c.connect(), timeoutMs);
					const status = this.statuses.get(c.id);
					if (status) {
						status.connected = true;
						status.toolCount = c.listTools().length;
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.errors.set(c.id, msg);
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
					description: tool.description,
					inputSchema: z.unknown(),
					execute: async (input) => {
						const args =
							input && typeof input === "object"
								? (input as Record<string, unknown>)
								: {};
						const result = await client.callTool(tool.name, args);
						if (result.isError) {
							// Surface as a rejection — AgentHost tool-call hook
							// audits failures, and the error message reaches the
							// LLM so it can react (retry / give up / explain).
							throw new Error(
								`mcp-external '${client.id}' tool '${tool.remoteName}' returned isError:true`,
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

	private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
		return Promise.race([
			p,
			new Promise<T>((_, reject) =>
				setTimeout(
					() =>
						reject(new Error(`mcp-external connect timed out after ${ms}ms`)),
					ms,
				),
			),
		]);
	}
}
