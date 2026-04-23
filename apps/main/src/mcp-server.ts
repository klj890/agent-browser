/**
 * MCP Server (P2 Stage 17) — exposes a curated subset of browser ops as
 * Model Context Protocol tools so external clients (Claude Desktop, Cursor,
 * etc.) can drive this browser.
 *
 * Security stance:
 *   - Disabled by default. User toggles on in Settings → MCP.
 *   - Binds loopback only (127.0.0.1). No network exposure.
 *   - Bearer-token auth required on every request. Token is random 32 bytes
 *     hex-encoded; regenerable from the UI. Displayed to the user once when
 *     they enable; external MCP clients put it in their config.
 *   - Every tool call emits an audit log event (`tool.call` with a special
 *     `persona` tag like `mcp:external`).
 *   - MVP tools are read-mostly: list_tabs / open_tab / close_tab /
 *     search_history / list_bookmarks / read_article. Richer tools (form
 *     fill, snapshot etc.) are deferred until a proper MCP-side permission
 *     model lands.
 *
 * Architecture:
 *   McpServerHost owns a Node http.Server. On enable() it constructs a
 *   McpServer (from @modelcontextprotocol/sdk), registers tools that delegate
 *   to TabManager/HistoryStore/BookmarksStore, and attaches a
 *   StreamableHTTPServerTransport. The HTTP handler enforces the Bearer
 *   check before routing to the transport.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	createServer as createHttpServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AuditLog } from "./audit-log.js";
import type { Bookmark, BookmarksStore } from "./bookmarks.js";
import type { HistoryStore } from "./history.js";
import type { TabManager } from "./tab-manager.js";

export interface McpConfig {
	enabled: boolean;
	port: number;
	/** base64url-encoded random token; clients send `Authorization: Bearer <token>`. */
	token: string;
}

export const DEFAULT_MCP_CONFIG: McpConfig = {
	enabled: false,
	port: 17890,
	token: "",
};

export interface McpConfigStore {
	load(): McpConfig;
	save(cfg: McpConfig): void;
}

export interface McpServerStatus {
	enabled: boolean;
	running: boolean;
	port: number;
	/** loopback URL clients should connect to, or null if not running. */
	endpoint: string | null;
	/** Present only when enabled — surface to UI so user can copy into client config. */
	token: string | null;
}

export interface McpServerHostDeps {
	configStore: McpConfigStore;
	tabs: TabManager;
	history: HistoryStore;
	bookmarks: BookmarksStore;
	auditLog?: AuditLog;
	/**
	 * Listen address. Defaults to 127.0.0.1; tests use 127.0.0.1 on an
	 * ephemeral port. DO NOT expose on 0.0.0.0 — the token is not strong
	 * enough to survive a hostile network.
	 */
	host?: string;
}

/** Generate a URL-safe random 32-byte token. */
function generateToken(): string {
	return randomBytes(32).toString("base64url");
}

/** Constant-time bearer compare. Both strings must be ASCII. */
function tokensMatch(candidate: string, expected: string): boolean {
	if (candidate.length !== expected.length) return false;
	// SHA-256 both sides and compare — sidesteps timing leak on unequal-length
	// strings even though we already guard that above.
	const a = createHash("sha256").update(candidate).digest();
	const b = createHash("sha256").update(expected).digest();
	return a.equals(b);
}

function extractBearer(req: IncomingMessage): string | null {
	const header = req.headers.authorization;
	if (!header) return null;
	const m = /^Bearer\s+(.+)$/i.exec(header);
	return m ? (m[1] as string) : null;
}

export class McpServerHost {
	private cfg: McpConfig;
	private httpServer: HttpServer | null = null;
	private mcpServer: McpServer | null = null;
	private transport: StreamableHTTPServerTransport | null = null;
	private readonly host: string;

	constructor(private readonly deps: McpServerHostDeps) {
		this.cfg = this.deps.configStore.load();
		this.host = deps.host ?? "127.0.0.1";
		// Seed a token on first construction so `status()` has something useful
		// to surface even before the user toggles the server on.
		if (!this.cfg.token) {
			this.cfg.token = generateToken();
			this.deps.configStore.save(this.cfg);
		}
	}

	status(): McpServerStatus {
		return {
			enabled: this.cfg.enabled,
			running: this.httpServer !== null,
			port: this.cfg.port,
			endpoint: this.httpServer
				? `http://${this.host}:${this.cfg.port}/mcp`
				: null,
			token: this.cfg.enabled ? this.cfg.token : null,
		};
	}

	async enable(port?: number): Promise<McpServerStatus> {
		if (this.httpServer) return this.status();
		if (port !== undefined && port !== this.cfg.port) {
			this.cfg.port = port;
		}
		this.cfg.enabled = true;
		this.deps.configStore.save(this.cfg);
		await this.startHttp();
		return this.status();
	}

	async disable(): Promise<McpServerStatus> {
		this.cfg.enabled = false;
		this.deps.configStore.save(this.cfg);
		await this.stopHttp();
		return this.status();
	}

	async regenerateToken(): Promise<McpServerStatus> {
		this.cfg.token = generateToken();
		this.deps.configStore.save(this.cfg);
		return this.status();
	}

	private async startHttp(): Promise<void> {
		const mcp = new McpServer({
			name: "agent-browser",
			version: "0.1.0",
		});
		this.registerTools(mcp);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await mcp.connect(transport);
		this.mcpServer = mcp;
		this.transport = transport;

		const http = createHttpServer((req, res) => {
			void this.handleRequest(req, res);
		});
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				http.off("error", onError);
				reject(err);
			};
			http.once("error", onError);
			http.listen(this.cfg.port, this.host, () => {
				http.off("error", onError);
				resolve();
			});
		});
		this.httpServer = http;
	}

	private async stopHttp(): Promise<void> {
		if (this.httpServer) {
			await new Promise<void>((resolve) => {
				this.httpServer?.close(() => resolve());
			});
			this.httpServer = null;
		}
		if (this.transport) {
			try {
				await this.transport.close();
			} catch {
				/* idempotent */
			}
			this.transport = null;
		}
		if (this.mcpServer) {
			try {
				await this.mcpServer.close();
			} catch {
				/* idempotent */
			}
			this.mcpServer = null;
		}
	}

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		// Only POST / GET (MCP transport uses both) allowed. DELETE could be
		// used for session cleanup; we run stateless so skip.
		if (req.method !== "POST" && req.method !== "GET") {
			res.statusCode = 405;
			res.end();
			return;
		}
		// Path gate: single endpoint /mcp. Anything else 404s so port scanners
		// can't probe details.
		const url = req.url ?? "";
		if (!url.startsWith("/mcp")) {
			res.statusCode = 404;
			res.end();
			return;
		}
		// Bearer token check. Missing/mismatched → 401 Unauthorized.
		const bearer = extractBearer(req);
		if (!bearer || !tokensMatch(bearer, this.cfg.token)) {
			res.statusCode = 401;
			res.setHeader("WWW-Authenticate", "Bearer");
			res.end("Unauthorized");
			return;
		}
		if (!this.transport) {
			res.statusCode = 503;
			res.end();
			return;
		}
		await this.transport.handleRequest(req, res);
	}

	private registerTools(mcp: McpServer): void {
		const audit = (tool: string, args: unknown) => {
			if (!this.deps.auditLog) return;
			void this.deps.auditLog
				.append({
					event: "tool.call",
					ts: Date.now(),
					task_id: "mcp:external",
					tool: `mcp:${tool}`,
					args_hash: createHash("sha256")
						.update(JSON.stringify(args))
						.digest("hex"),
					result_ref: null,
					byte_size: 0,
					high_risk_flags: [],
				})
				.catch(() => undefined);
		};

		mcp.registerTool(
			"list_tabs",
			{
				title: "List open browser tabs",
				description:
					"Returns a summary of every open tab in the browser: id, url, title, and whether the tab is currently active.",
				inputSchema: {},
			},
			async () => {
				audit("list_tabs", {});
				const tabs = this.deps.tabs.list().map((t) => ({
					id: t.id,
					url: t.url,
					title: t.title,
					active: t.active,
					isIncognito: t.isIncognito,
				}));
				return {
					content: [{ type: "text", text: JSON.stringify(tabs, null, 2) }],
				};
			},
		);

		mcp.registerTool(
			"open_tab",
			{
				title: "Open a new browser tab",
				description:
					"Opens a new tab to the given URL and returns the new tab id. The tab is opened in the default profile (no incognito via MCP).",
				inputSchema: {
					url: z.string().url().describe("Absolute URL to load in the new tab"),
				},
			},
			async ({ url }) => {
				audit("open_tab", { url });
				const id = this.deps.tabs.create(url, { openedByAgent: true });
				return { content: [{ type: "text", text: `opened tab ${id}` }] };
			},
		);

		mcp.registerTool(
			"close_tab",
			{
				title: "Close an agent-opened tab",
				description:
					"Closes the tab with the given id. Only tabs opened via open_tab (openedByAgent=true) are closable through this interface to avoid disrupting the user's own tabs.",
				inputSchema: {
					id: z.string().describe("Tab id returned by open_tab or list_tabs"),
				},
			},
			async ({ id }) => {
				audit("close_tab", { id });
				const tab = this.deps.tabs.list().find((t) => t.id === id);
				if (!tab) {
					return {
						content: [{ type: "text", text: `no such tab: ${id}` }],
						isError: true,
					};
				}
				if (!tab.openedByAgent) {
					return {
						content: [
							{
								type: "text",
								text: "refused: only agent-opened tabs may be closed via MCP",
							},
						],
						isError: true,
					};
				}
				this.deps.tabs.close(id);
				return { content: [{ type: "text", text: `closed ${id}` }] };
			},
		);

		mcp.registerTool(
			"search_history",
			{
				title: "Search browser history",
				description:
					"Full-text search across browser history titles and URLs, returning up to `limit` matches ordered by relevance.",
				inputSchema: {
					query: z.string().describe("Search query string"),
					limit: z
						.number()
						.int()
						.positive()
						.max(200)
						.default(20)
						.describe("Maximum matches to return"),
				},
			},
			async ({ query, limit }) => {
				audit("search_history", { query });
				const rows = this.deps.history.fullTextSearch(query, limit ?? 20);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								rows.map((r) => ({
									url: r.url,
									title: r.title,
									visited_at: r.visited_at,
								})),
								null,
								2,
							),
						},
					],
				};
			},
		);

		mcp.registerTool(
			"list_bookmarks",
			{
				title: "List browser bookmarks",
				description:
					"Returns bookmarks, optionally filtered to a single folder. Folders are flat; position is relative within a folder.",
				inputSchema: {
					folder: z
						.string()
						.optional()
						.describe("Folder to filter by; omit for all folders"),
				},
			},
			async ({ folder }) => {
				audit("list_bookmarks", { folder });
				const rows: Bookmark[] = this.deps.bookmarks.list(folder);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								rows.map((b) => ({
									url: b.url,
									title: b.title,
									folder: b.folder,
									position: b.position,
								})),
								null,
								2,
							),
						},
					],
				};
			},
		);
	}
}
