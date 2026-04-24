import { describe, expect, it, vi } from "vitest";
import type { ExternalMcpServer } from "../external-mcp-config.js";
import type { McpCallResult, McpRemoteTool } from "../mcp-external-client.js";
import { McpExternalManager } from "../mcp-external-manager.js";

/**
 * FakeClient implements the McpExternalClient **public surface** we actually
 * call in the manager — no SDK, no network. Keeps manager tests off any real
 * transport.
 */
class FakeClient {
	readonly id: string;
	private readonly _tools: McpRemoteTool[];
	private readonly _connect: () => Promise<void>;
	private readonly _call?: (
		name: string,
		args: Record<string, unknown>,
	) => Promise<McpCallResult>;
	private connected = false;

	constructor(opts: {
		id: string;
		prefix?: string;
		tools?: string[];
		connect?: () => Promise<void>;
		call?: (
			name: string,
			args: Record<string, unknown>,
		) => Promise<McpCallResult>;
	}) {
		this.id = opts.id;
		const pfx = opts.prefix ?? opts.id;
		this._tools = (opts.tools ?? []).map((t) => ({
			name: `${pfx}__${t}`,
			remoteName: t,
			description: `${t} tool`,
			inputSchema: { type: "object" },
		}));
		this._connect = opts.connect ?? (async () => {});
		this._call = opts.call;
	}
	prefix(): string {
		return this.id;
	}
	isConnected(): boolean {
		return this.connected;
	}
	listTools(): McpRemoteTool[] {
		return this.connected ? [...this._tools] : [];
	}
	async connect(): Promise<void> {
		await this._connect();
		this.connected = true;
	}
	async callTool(name: string, args: Record<string, unknown>) {
		if (this._call) return this._call(name, args);
		return { content: [{ type: "text", text: "ok" }], isError: false };
	}
	async disconnect(): Promise<void> {
		this.connected = false;
	}
}

function spec(
	id: string,
	overrides: Partial<ExternalMcpServer> = {},
): ExternalMcpServer {
	return {
		id,
		name: id,
		transport: "http",
		url: `https://mcp.example.com/${id}`,
		enabled: true,
		...overrides,
	};
}

describe("McpExternalManager", () => {
	it("skips disabled servers during start() and in skills()", async () => {
		const factory = vi.fn(
			(s: ExternalMcpServer) => new FakeClient({ id: s.id, tools: ["x"] }),
		);
		const mgr = new McpExternalManager({
			servers: [spec("on"), spec("off", { enabled: false })],
			clientFactory: factory as unknown as ConstructorParameters<
				typeof McpExternalManager
			>[0]["clientFactory"],
		});
		await mgr.start();
		expect(factory).toHaveBeenCalledTimes(1); // only "on"
		const skills = mgr.skills();
		expect(skills.map((s) => s.name)).toEqual(["on__x"]);
	});

	it("isolates failures: one client crashing does not block others", async () => {
		const goodClient = new FakeClient({ id: "good", tools: ["do"] });
		const badClient = new FakeClient({
			id: "bad",
			tools: ["never"],
			connect: async () => {
				throw new Error("DNS lookup fail");
			},
		});
		const mgr = new McpExternalManager({
			servers: [spec("good"), spec("bad")],
			clientFactory: ((s: ExternalMcpServer) =>
				s.id === "good"
					? goodClient
					: badClient) as unknown as ConstructorParameters<
				typeof McpExternalManager
			>[0]["clientFactory"],
		});
		await mgr.start();
		const statuses = mgr.status();
		expect(statuses.find((s) => s.id === "good")?.connected).toBe(true);
		expect(statuses.find((s) => s.id === "bad")?.connected).toBe(false);
		expect(statuses.find((s) => s.id === "bad")?.error).toMatch(/DNS/);
		const names = mgr.skills().map((s) => s.name);
		expect(names).toEqual(["good__do"]);
	});

	it("start() enforces connect timeout; slow servers end up in 'cache'/error state", async () => {
		const slow = new FakeClient({
			id: "slow",
			connect: () => new Promise(() => {}), // never resolves
		});
		const mgr = new McpExternalManager({
			servers: [spec("slow")],
			clientFactory: (() => slow) as unknown as ConstructorParameters<
				typeof McpExternalManager
			>[0]["clientFactory"],
		});
		await mgr.start(30); // 30ms timeout
		expect(mgr.status()[0]?.connected).toBe(false);
		expect(mgr.status()[0]?.error).toMatch(/timed out/);
	});

	it("skill.execute routes to the owning client and returns its content", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const client = new FakeClient({
			id: "gh",
			tools: ["star_repo"],
			call: async (name, args) => {
				calls.push({ name, args });
				return { content: [{ type: "text", text: "starred" }], isError: false };
			},
		});
		const mgr = new McpExternalManager({
			servers: [spec("gh")],
			clientFactory: (() => client) as unknown as ConstructorParameters<
				typeof McpExternalManager
			>[0]["clientFactory"],
		});
		await mgr.start();
		const skill = mgr.skills().find((s) => s.name === "gh__star_repo");
		expect(skill).toBeDefined();
		const result = (await skill?.execute({ owner: "x", repo: "y" })) as {
			type: string;
			text: string;
		}[];
		expect(result[0]?.text).toBe("starred");
		expect(calls[0]).toEqual({
			name: "gh__star_repo",
			args: { owner: "x", repo: "y" },
		});
	});

	it("skill.execute rejects when remote returns isError:true", async () => {
		const client = new FakeClient({
			id: "gh",
			tools: ["tool"],
			call: async () => ({
				content: [{ type: "text", text: "rate limited" }],
				isError: true,
			}),
		});
		const mgr = new McpExternalManager({
			servers: [spec("gh")],
			clientFactory: (() => client) as unknown as ConstructorParameters<
				typeof McpExternalManager
			>[0]["clientFactory"],
		});
		await mgr.start();
		const skill = mgr.skills().find((s) => s.name === "gh__tool");
		await expect(skill?.execute({})).rejects.toThrow(/isError:true/);
	});

	it("stop() disconnects every client and future skills() is empty", async () => {
		const client = new FakeClient({ id: "a", tools: ["t"] });
		const mgr = new McpExternalManager({
			servers: [spec("a")],
			clientFactory: (() => client) as unknown as ConstructorParameters<
				typeof McpExternalManager
			>[0]["clientFactory"],
		});
		await mgr.start();
		expect(mgr.skills()).toHaveLength(1);
		await mgr.stop();
		expect(mgr.skills()).toHaveLength(0);
	});

	it("skill description embeds the remote JSON Schema so LLM knows arg shape", async () => {
		// Build a minimal stand-in that matches McpExternalClient's public
		// surface but emits a tool with a real JSON Schema. Using a bare
		// object avoids polluting FakeClient with a schema knob the other
		// tests don't need.
		const schemaClient = {
			id: "s",
			prefix: () => "s",
			isConnected: () => true,
			listTools: (): McpRemoteTool[] => [
				{
					name: "s__send",
					remoteName: "send",
					description: "Send a message",
					inputSchema: {
						type: "object",
						properties: { to: { type: "string" } },
						required: ["to"],
					},
				},
			],
			connect: async () => {},
			callTool: async (): Promise<McpCallResult> => ({
				content: [],
				isError: false,
			}),
			disconnect: async () => {},
		};
		const mgr = new McpExternalManager({
			servers: [spec("s")],
			clientFactory: (() =>
				schemaClient as unknown as import("../mcp-external-client.js").McpExternalClient) as unknown as ConstructorParameters<
				typeof McpExternalManager
			>[0]["clientFactory"],
		});
		await mgr.start();
		const skill = mgr.skills()[0];
		expect(skill?.description).toContain("Send a message");
		expect(skill?.description).toContain("Arguments schema");
		expect(skill?.description).toContain('"required":["to"]');
	});
});

describe("McpExternalClient transport safeguards", () => {
	it("refuses to build SSE transport when global EventSource is missing", async () => {
		const { McpExternalClient } = await import("../mcp-external-client.js");
		const hadEventSource =
			typeof (globalThis as { EventSource?: unknown }).EventSource ===
			"function";
		const saved = (globalThis as { EventSource?: unknown }).EventSource;
		// biome-ignore lint/performance/noDelete: test needs the reference gone
		delete (globalThis as { EventSource?: unknown }).EventSource;
		try {
			const c = new McpExternalClient({
				spec: {
					id: "x",
					name: "x",
					transport: "sse",
					url: "https://x.example.com/sse",
					enabled: true,
				},
			});
			await expect(c.connect()).rejects.toThrow(/EventSource/);
		} finally {
			if (hadEventSource) {
				(globalThis as { EventSource?: unknown }).EventSource = saved;
			}
		}
	});
});

describe("isExternalMcpSkillName", () => {
	it("recognises `prefix__tool` names as external", async () => {
		const { isExternalMcpSkillName } = await import("../agent-host-factory.js");
		expect(isExternalMcpSkillName("gh__star_repo")).toBe(true);
		expect(isExternalMcpSkillName("klavis-main__send_mail")).toBe(true);
	});

	it("treats built-in tool names as NOT external", async () => {
		const { isExternalMcpSkillName } = await import("../agent-host-factory.js");
		expect(isExternalMcpSkillName("snapshot")).toBe(false);
		expect(isExternalMcpSkillName("act")).toBe(false);
		expect(isExternalMcpSkillName("tabs_open")).toBe(false); // single underscore
		expect(isExternalMcpSkillName("tabs_wait_load")).toBe(false);
	});
});
