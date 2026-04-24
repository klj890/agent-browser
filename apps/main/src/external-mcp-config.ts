/**
 * External MCP server registry (P2 §2.6).
 *
 * Distinct from `mcp-server.ts` which makes *us* an MCP server for
 * external clients (Claude Code, Cursor). This file is the mirror image:
 * a list of external MCP servers we connect to *as a client*, merging
 * their tools into the Agent's skill list.
 *
 * Storage: plain JSON under userData. Tokens in `authorization` are
 * **treated like cookies** — never leaked into prompts, never synced to
 * cloud, never logged verbatim. They travel only to the declared URL.
 *
 * Transport scope: `http` (streamable HTTP) and `sse` only. stdio and
 * websocket are deferred until we need a desktop-app-hosted local MCP
 * that isn't already covered by our own Agent tools.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ExternalMcpServerSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	transport: z.enum(["http", "sse"]),
	url: z.string().url(),
	/**
	 * Full Authorization header value (e.g. `Bearer sk-xxx`, `Basic …`).
	 * We do not auto-prefix `Bearer ` so admins can plug in non-Bearer
	 * schemes (OAuth DPoP, X-API-Key via headers field, etc.) without
	 * fighting the shape. Empty/undefined = anonymous request.
	 */
	authorization: z.string().optional(),
	enabled: z.boolean().default(true),
	/**
	 * Tool-name prefix used when merging external tools into AgentHost.
	 * Prevents collisions with our five browser-tools (snapshot/act/etc.)
	 * and between multiple external servers. Default = `id`.
	 */
	prefix: z
		.string()
		.regex(/^[a-zA-Z0-9_-]+$/)
		.optional(),
	/** Optional per-server connect/call timeout (ms). Default 10 000. */
	timeoutMs: z.number().int().positive().max(60_000).optional(),
});
export type ExternalMcpServer = z.infer<typeof ExternalMcpServerSchema>;

export const ExternalMcpConfigSchema = z.object({
	servers: z.array(ExternalMcpServerSchema).default([]),
});
export type ExternalMcpConfig = z.infer<typeof ExternalMcpConfigSchema>;

export const DEFAULT_EXTERNAL_MCP_CONFIG: ExternalMcpConfig = { servers: [] };

export interface ExternalMcpConfigStore {
	load(): ExternalMcpConfig;
	save(cfg: ExternalMcpConfig): void;
}

export class ExternalMcpConfigFileStore implements ExternalMcpConfigStore {
	constructor(private readonly filePath: string) {}

	load(): ExternalMcpConfig {
		if (!existsSync(this.filePath)) return { ...DEFAULT_EXTERNAL_MCP_CONFIG };
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			const parsed = ExternalMcpConfigSchema.safeParse(JSON.parse(raw));
			// On schema failure we prefer "run without external MCP" over
			// "refuse to boot". A single bad row shouldn't break the Agent —
			// the UI layer surfaces the validation error separately.
			if (!parsed.success) return { ...DEFAULT_EXTERNAL_MCP_CONFIG };
			return parsed.data;
		} catch {
			return { ...DEFAULT_EXTERNAL_MCP_CONFIG };
		}
	}

	save(cfg: ExternalMcpConfig): void {
		// Validate before write so a caller that fabricates bad config
		// doesn't corrupt the file silently.
		ExternalMcpConfigSchema.parse(cfg);
		const dir = path.dirname(this.filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(cfg, null, 2), "utf-8");
	}
}

export class ExternalMcpConfigMemoryStore implements ExternalMcpConfigStore {
	private cfg: ExternalMcpConfig;
	constructor(initial: Partial<ExternalMcpConfig> = {}) {
		this.cfg = { ...DEFAULT_EXTERNAL_MCP_CONFIG, ...initial };
	}
	load(): ExternalMcpConfig {
		return { ...this.cfg };
	}
	save(cfg: ExternalMcpConfig): void {
		this.cfg = { ...cfg };
	}
}
