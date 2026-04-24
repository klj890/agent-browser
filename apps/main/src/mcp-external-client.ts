/**
 * External MCP connector (P2 §2.6).
 *
 * Wraps the `@modelcontextprotocol/sdk` Client + one of HTTP/SSE transports
 * into a tiny Agent-facing interface:
 *     connect() → listTools() → callTool() → disconnect()
 *
 * Why wrap:
 *   - The SDK is async-everything with a broad surface; AgentHost only cares
 *     about "give me tools, call one, handle errors uniformly".
 *   - We need failure isolation at the connector boundary (one broken
 *     server shouldn't tear down the whole manager).
 *   - Tool name prefixing happens here so the manager and the skill-merge
 *     callers don't need to know about our naming convention.
 *
 * Security posture:
 *   - `authorization` is injected via `requestInit.headers`, never logged.
 *   - callTool() arguments flow *outbound* to the external server. Redaction
 *     of these args is the *caller's* responsibility — AgentHost already
 *     runs RedactionPipeline before any tool call.
 *   - The SDK handles JSON-RPC framing; we don't parse wire bytes ourselves.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExternalMcpServer } from "./external-mcp-config.js";

export interface McpRemoteTool {
	/** Fully-prefixed name delivered to AgentHost (`<prefix>__<remote-name>`). */
	name: string;
	/** Raw tool name as the remote server sees it — what we pass to `callTool`. */
	remoteName: string;
	description: string;
	inputSchema: unknown;
}

export interface McpCallResult {
	/** The remote server's structured content blocks, passed through as-is. */
	content: unknown;
	/** True when the remote reported `isError: true` in the result envelope. */
	isError: boolean;
}

export interface McpExternalClientDeps {
	spec: ExternalMcpServer;
	fetchImpl?: typeof fetch;
	/** Test hook — inject a pre-built transport instead of constructing one. */
	transportOverride?: Transport;
}

const PREFIX_SEPARATOR = "__";

export class McpExternalClient {
	private readonly spec: ExternalMcpServer;
	private readonly fetchImpl: typeof fetch;
	private readonly transportOverride?: Transport;
	private client: Client | undefined;
	private transport: Transport | undefined;
	private tools: McpRemoteTool[] = [];
	private connected = false;

	constructor(deps: McpExternalClientDeps) {
		this.spec = deps.spec;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.transportOverride = deps.transportOverride;
	}

	get id(): string {
		return this.spec.id;
	}

	prefix(): string {
		return this.spec.prefix ?? this.spec.id;
	}

	isConnected(): boolean {
		return this.connected;
	}

	listTools(): McpRemoteTool[] {
		return [...this.tools];
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		this.transport = this.transportOverride ?? this.buildTransport();
		this.client = new Client(
			{ name: "agent-browser", version: "0.1.0" },
			{ capabilities: {} },
		);
		await this.client.connect(this.transport);
		const listed = await this.client.listTools();
		this.tools = (listed.tools ?? []).map((t) => ({
			name: `${this.prefix()}${PREFIX_SEPARATOR}${t.name}`,
			remoteName: t.name,
			description: t.description ?? "",
			inputSchema: t.inputSchema,
		}));
		this.connected = true;
	}

	async callTool(
		prefixedName: string,
		args: Record<string, unknown>,
	): Promise<McpCallResult> {
		if (!this.connected || !this.client) {
			throw new Error(`mcp-external '${this.spec.id}' called before connect()`);
		}
		const expected = `${this.prefix()}${PREFIX_SEPARATOR}`;
		if (!prefixedName.startsWith(expected)) {
			// Defensive: manager routes by prefix, but if a caller slips a
			// foreign name in we refuse rather than silently forwarding
			// someone else's tool call to this server.
			throw new Error(
				`tool '${prefixedName}' does not belong to mcp-external '${this.spec.id}'`,
			);
		}
		const remoteName = prefixedName.slice(expected.length);
		// callTool timeout: a hung remote would pin the Agent step loop
		// indefinitely otherwise. Use per-spec override or 10s default.
		// SDK's RequestOptions.timeout enforces this at the protocol level.
		const result = (await this.client.callTool(
			{ name: remoteName, arguments: args },
			undefined,
			{ timeout: this.spec.timeoutMs ?? 10_000 },
		)) as { content?: unknown; isError?: boolean };
		return {
			content: result.content ?? [],
			isError: result.isError === true,
		};
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		this.connected = false;
		try {
			await this.client?.close();
		} catch {
			/* best-effort */
		}
		this.client = undefined;
		this.transport = undefined;
		this.tools = [];
	}

	private buildTransport(): Transport {
		const requestInit: RequestInit = this.spec.authorization
			? { headers: { Authorization: this.spec.authorization } }
			: {};
		if (this.spec.transport === "sse") {
			// SSEClientTransport uses the global `EventSource`. Node.js
			// didn't expose one until 22; Electron main's bundled Node
			// varies. Fail fast with an actionable message rather than
			// letting the SDK throw a cryptic reference error mid-connect.
			if (
				typeof (globalThis as { EventSource?: unknown }).EventSource !==
				"function"
			) {
				throw new Error(
					"mcp-external: 'sse' transport requires a global EventSource; " +
						"either upgrade to Node.js ≥22 or install the `eventsource` " +
						"npm package and assign it to globalThis.EventSource before boot.",
				);
			}
			return new SSEClientTransport(new URL(this.spec.url), {
				// SSE transport uses eventSourceInit for stream setup; auth
				// header comes via requestInit for the POST channel.
				eventSourceInit: { fetch: this.fetchImpl as unknown as typeof fetch },
				requestInit,
			});
		}
		return new StreamableHTTPClientTransport(new URL(this.spec.url), {
			requestInit,
			fetch: this.fetchImpl,
		});
	}
}
