import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_EXTERNAL_MCP_CONFIG,
	ExternalMcpConfigFileStore,
	ExternalMcpConfigMemoryStore,
	ExternalMcpServerSchema,
} from "../external-mcp-config.js";

describe("ExternalMcpServerSchema", () => {
	it("accepts a minimal HTTP server spec", () => {
		const s = ExternalMcpServerSchema.parse({
			id: "gmail",
			name: "Gmail via Klavis",
			transport: "http",
			url: "https://mcp.example.com/gmail",
		});
		expect(s.enabled).toBe(true); // default
		expect(s.authorization).toBeUndefined();
	});

	it("rejects bad url", () => {
		expect(() =>
			ExternalMcpServerSchema.parse({
				id: "x",
				name: "x",
				transport: "http",
				url: "not a url",
			}),
		).toThrow();
	});

	it("rejects unknown transport", () => {
		expect(() =>
			ExternalMcpServerSchema.parse({
				id: "x",
				name: "x",
				transport: "stdio",
				url: "http://x/y",
			}),
		).toThrow();
	});

	it("rejects prefix with invalid characters", () => {
		expect(() =>
			ExternalMcpServerSchema.parse({
				id: "x",
				name: "x",
				transport: "http",
				url: "http://x/y",
				prefix: "bad prefix",
			}),
		).toThrow();
	});
});

describe("ExternalMcpConfigFileStore", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "mcp-ext-cfg-"));
		file = path.join(dir, "mcp-clients.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns DEFAULT when file missing", () => {
		const store = new ExternalMcpConfigFileStore(file);
		expect(store.load()).toEqual(DEFAULT_EXTERNAL_MCP_CONFIG);
	});

	it("round-trips save → load", () => {
		const store = new ExternalMcpConfigFileStore(file);
		const cfg = {
			servers: [
				{
					id: "gh",
					name: "GitHub",
					transport: "http" as const,
					url: "https://mcp.example.com/gh",
					authorization: "Bearer sk-test",
					enabled: true,
				},
			],
		};
		store.save(cfg);
		const onDisk = readFileSync(file, "utf8");
		expect(onDisk).toContain("GitHub");
		const reloaded = store.load();
		expect(reloaded.servers).toHaveLength(1);
		expect(reloaded.servers[0]?.authorization).toBe("Bearer sk-test");
	});

	it("returns DEFAULT when file contains malformed JSON (don't brick boot)", () => {
		writeFileSync(file, "}{ bad json", "utf8");
		const store = new ExternalMcpConfigFileStore(file);
		expect(store.load()).toEqual(DEFAULT_EXTERNAL_MCP_CONFIG);
	});

	it("returns DEFAULT when outer JSON shape is wrong (no servers array)", () => {
		writeFileSync(file, JSON.stringify({ notServers: [] }), "utf8");
		const store = new ExternalMcpConfigFileStore(file);
		expect(store.load()).toEqual(DEFAULT_EXTERNAL_MCP_CONFIG);
	});

	it("per-entry filter: drops invalid rows, keeps valid ones", () => {
		writeFileSync(
			file,
			JSON.stringify({
				servers: [
					{ id: 123, transport: "stdio" }, // invalid: bad id + bad transport
					{
						id: "good",
						name: "Good",
						transport: "http",
						url: "https://mcp.example.com",
					},
					{ id: "nourl" }, // invalid: missing required fields
				],
			}),
			"utf8",
		);
		const store = new ExternalMcpConfigFileStore(file);
		const cfg = store.load();
		expect(cfg.servers).toHaveLength(1);
		expect(cfg.servers[0]?.id).toBe("good");
	});

	it("save() rejects invalid config before touching disk", () => {
		const store = new ExternalMcpConfigFileStore(file);
		expect(() =>
			// deliberately malformed — caller bug, not user data
			store.save({
				servers: [{ id: "", name: "x", transport: "http", url: "" }],
			} as unknown as ReturnType<typeof store.load>),
		).toThrow();
	});

	it("memory store round-trip", () => {
		const store = new ExternalMcpConfigMemoryStore();
		expect(store.load().servers).toEqual([]);
		store.save({
			servers: [
				{
					id: "a",
					name: "A",
					transport: "http",
					url: "http://x/y",
					enabled: false,
				},
			],
		});
		expect(store.load().servers).toHaveLength(1);
		expect(store.load().servers[0]?.enabled).toBe(false);
	});
});
