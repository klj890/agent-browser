/**
 * Slash commands unit tests — Stage 7.4.
 */
import { describe, expect, it, vi } from "vitest";
import {
	BUILTIN_SLASH_COMMANDS,
	createDefaultSlashRegistry,
	type SlashCommandCtx,
	SlashCommandRegistry,
} from "../slash-commands.js";
import { TaskStateStore } from "../task-state.js";

describe("SlashCommandRegistry.parse", () => {
	const reg = createDefaultSlashRegistry();

	it("parses '/stop' → {cmd:'stop', args:''}", () => {
		expect(reg.parse("/stop")).toEqual({ cmd: "stop", args: "" });
	});

	it("parses '/stop foo bar' → {cmd:'stop', args:'foo bar'}", () => {
		expect(reg.parse("/stop foo bar")).toEqual({
			cmd: "stop",
			args: "foo bar",
		});
	});

	it("returns null for non-slash input", () => {
		expect(reg.parse("not a slash")).toBeNull();
		expect(reg.parse("")).toBeNull();
		expect(reg.parse(" /stop")).toBeNull(); // leading space disqualifies
	});

	it("returns null for unregistered slash", () => {
		expect(reg.parse("/unknown-command")).toBeNull();
	});

	it("returns null for bare '/'", () => {
		expect(reg.parse("/")).toBeNull();
	});
});

describe("SlashCommandRegistry.register/list", () => {
	it("register adds a custom command that parse() can resolve", () => {
		const reg = new SlashCommandRegistry();
		reg.register({
			name: "hello",
			description: "says hi",
			async execute() {
				return { kind: "text", content: "hi" };
			},
		});
		expect(reg.parse("/hello world")).toEqual({
			cmd: "hello",
			args: "world",
		});
		expect(reg.list()).toHaveLength(1);
	});
});

describe("built-in: /stop", () => {
	it("aborts the current task via taskStore", async () => {
		const reg = createDefaultSlashRegistry();
		const store = new TaskStateStore();
		const t = store.create({ prompt: "p", persona: "default", tabId: "t1" });
		store.transition(t.id, "running");
		const res = await reg.execute(
			{ taskStore: store, currentTaskId: t.id },
			"/stop",
		);
		expect(res).toEqual({ kind: "text", content: "stopped." });
		expect(store.get(t.id).status).toBe("killed");
	});

	it("returns 'no active task' when currentTaskId is missing", async () => {
		const reg = createDefaultSlashRegistry();
		const res = await reg.execute({}, "/stop");
		expect(res.kind).toBe("text");
		expect(res.content).toMatch(/no active task/);
	});
});

describe("built-in: /screenshot", () => {
	it("calls tools.screenshot({}) and returns base64 under kind=screenshot", async () => {
		const reg = createDefaultSlashRegistry();
		const screenshot = vi.fn(async () => ({
			base64: "AAAA",
			mime: "image/png",
		}));
		const res = await reg.execute({ tools: { screenshot } }, "/screenshot");
		expect(screenshot).toHaveBeenCalledWith({});
		expect(res).toEqual({ kind: "screenshot", content: "AAAA" });
	});

	it("returns a text error when no tool is available", async () => {
		const reg = createDefaultSlashRegistry();
		const res = await reg.execute({}, "/screenshot");
		expect(res.kind).toBe("text");
		expect(res.content).toMatch(/not available/);
	});
});

describe("built-in: /export-trace", () => {
	it("serializes audit events as jsonl", async () => {
		const reg = createDefaultSlashRegistry();
		const events = [
			{ ts: 1, event: "task.start" },
			{ ts: 2, event: "tool.call" },
		];
		const listByTask = vi.fn(async () => events);
		const ctx: SlashCommandCtx = {
			currentTaskId: "task-1",
			auditLog: { listByTask },
		};
		const res = await reg.execute(ctx, "/export-trace");
		expect(listByTask).toHaveBeenCalledWith("task-1");
		expect(res.kind).toBe("trace");
		expect(res.content).toBe(
			`${JSON.stringify(events[0])}\n${JSON.stringify(events[1])}`,
		);
	});

	it("returns explicit 'not configured' when auditLog is missing", async () => {
		const reg = createDefaultSlashRegistry();
		const res = await reg.execute({ currentTaskId: "task-1" }, "/export-trace");
		expect(res).toEqual({
			kind: "text",
			content: "audit log not configured",
		});
	});
});

describe("built-in: /clear-vault", () => {
	it("returns placeholder message (vault is P1-9)", async () => {
		const reg = createDefaultSlashRegistry();
		const res = await reg.execute({}, "/clear-vault");
		expect(res.kind).toBe("text");
		expect(res.content).toMatch(/vault not implemented/i);
	});
});

describe("built-in: /dom-tree", () => {
	it("calls tools.snapshot({interactive_only:false, include_text:true}) and returns text", async () => {
		const reg = createDefaultSlashRegistry();
		const snapshot = vi.fn(async () => ({
			refs: [{ id: "@e1", role: "button" }],
		}));
		const res = await reg.execute({ tools: { snapshot } }, "/dom-tree");
		expect(snapshot).toHaveBeenCalledWith({
			interactive_only: false,
			include_text: true,
		});
		expect(res.kind).toBe("text");
		expect(res.content).toContain("@e1");
	});
});

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("ships exactly the 5 commands from PLAN Stage 7.4", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name).sort();
		expect(names).toEqual(
			["clear-vault", "dom-tree", "export-trace", "screenshot", "stop"].sort(),
		);
	});
});
