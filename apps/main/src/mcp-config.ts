/**
 * Persistent MCP server config (P2-17). Stored as plain JSON under userData.
 * Token is a random 32B base64url — not a secret to the device owner but
 * still treat as sensitive (share == remote control of the browser).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	DEFAULT_MCP_CONFIG,
	type McpConfig,
	type McpConfigStore,
} from "./mcp-server.js";

export class McpConfigFileStore implements McpConfigStore {
	constructor(private readonly filePath: string) {}

	load(): McpConfig {
		if (!existsSync(this.filePath)) return { ...DEFAULT_MCP_CONFIG };
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			const parsed = JSON.parse(raw) as Partial<McpConfig>;
			return { ...DEFAULT_MCP_CONFIG, ...parsed };
		} catch {
			return { ...DEFAULT_MCP_CONFIG };
		}
	}

	save(cfg: McpConfig): void {
		const dir = path.dirname(this.filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(cfg, null, 2));
	}
}

/** Test/in-memory impl. */
export class McpConfigMemoryStore implements McpConfigStore {
	private cfg: McpConfig;
	constructor(initial: Partial<McpConfig> = {}) {
		this.cfg = { ...DEFAULT_MCP_CONFIG, ...initial };
	}
	load(): McpConfig {
		return { ...this.cfg };
	}
	save(cfg: McpConfig): void {
		this.cfg = { ...cfg };
	}
}
