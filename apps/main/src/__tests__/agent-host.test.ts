/**
 * AgentHost unit tests (Stage 3.1 + 附录 L single-unit coverage).
 */

import type { Skill } from "@agent-browser/browser-tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AdminPolicy, DEFAULT_POLICY } from "../admin-policy.js";
import {
	AgentHost,
	BudgetExceededError,
	type LlmStreamChunk,
	type StreamChunk,
	type StreamFn,
	ToolDenied,
	ToolResultTooLargeError,
} from "../agent-host.js";
import type { SensitiveWordFilter } from "../redaction-pipeline.js";

const NO_REDACT: SensitiveWordFilter = { filter: (s) => s };

function policy(overrides: Partial<AdminPolicy> = {}): AdminPolicy {
	return {
		...DEFAULT_POLICY,
		...overrides,
		costGuard: { ...DEFAULT_POLICY.costGuard, ...(overrides.costGuard ?? {}) },
	};
}

function textOnlyStream(text: string): StreamFn {
	return async function* () {
		yield { type: "text", delta: text } as LlmStreamChunk;
		yield { type: "usage", totalTokens: 5 } as LlmStreamChunk;
	};
}

function echoSkill(): Skill {
	return {
		name: "echo",
		description: "Echo back input",
		inputSchema: z.object({ value: z.string() }),
		execute: async (input: unknown) => {
			const { value } = input as { value: string };
			return { echoed: value };
		},
	};
}

function scriptedStream(turns: LlmStreamChunk[][]): StreamFn {
	let i = 0;
	return async function* () {
		const turn = turns[i] ?? [];
		i++;
		for (const c of turn) yield c;
	};
}

async function collect(
	iter: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const c of iter) out.push(c);
	return out;
}

describe("AgentHost — text streaming", () => {
	it("emits text deltas and a done chunk when no tool call", async () => {
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [],
			streamFn: textOnlyStream("hello"),
			policy: policy(),
			redaction: NO_REDACT,
		});
		const chunks = await collect(host.run("hi"));
		expect(chunks.some((c) => c.type === "text")).toBe(true);
		expect(chunks[chunks.length - 1]).toEqual({
			type: "done",
			reason: "completed",
		});
	});

	it("runs multiple delta fragments in order", async () => {
		const streamFn: StreamFn = async function* () {
			yield { type: "text", delta: "a" };
			yield { type: "text", delta: "b" };
			yield { type: "text", delta: "c" };
			yield { type: "usage", totalTokens: 1 };
		};
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [],
			streamFn,
			policy: policy(),
			redaction: NO_REDACT,
		});
		const chunks = await collect(host.run("hi"));
		const texts = chunks.filter((c) => c.type === "text");
		expect(texts.map((c) => (c as { delta: string }).delta).join("")).toBe(
			"abc",
		);
	});
});

describe("AgentHost — tool call loop", () => {
	it("executes a tool call then continues to next turn", async () => {
		const streamFn = scriptedStream([
			[
				{ type: "text", delta: "calling echo" },
				{
					type: "tool_calls",
					calls: [{ id: "c1", name: "echo", args: { value: "hi" } }],
				},
				{ type: "usage", totalTokens: 5 },
			],
			[
				{ type: "text", delta: "done" },
				{ type: "usage", totalTokens: 5 },
			],
		]);
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [echoSkill()],
			streamFn,
			policy: policy({ allowedTools: ["echo"] }),
			redaction: NO_REDACT,
		});
		const chunks = await collect(host.run("hi"));
		const tc = chunks.find((c) => c.type === "tool_call");
		const tr = chunks.find((c) => c.type === "tool_result");
		expect(tc).toBeTruthy();
		expect(tr).toBeTruthy();
		expect((tr as { result?: unknown }).result).toEqual({ echoed: "hi" });
		expect(chunks[chunks.length - 1]).toEqual({
			type: "done",
			reason: "completed",
		});
	});

	it("pre-tool-call hook can rewrite args", async () => {
		const streamFn = scriptedStream([
			[
				{
					type: "tool_calls",
					calls: [{ id: "c1", name: "echo", args: { value: "orig" } }],
				},
				{ type: "usage", totalTokens: 1 },
			],
			[
				{ type: "text", delta: "end" },
				{ type: "usage", totalTokens: 1 },
			],
		]);
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [echoSkill()],
			streamFn,
			policy: policy({ allowedTools: ["echo"] }),
			redaction: NO_REDACT,
			hooks: {
				"pre-tool-call": [
					(ctx) => {
						ctx.call.args = { value: "rewritten" };
					},
				],
			},
		});
		const chunks = await collect(host.run("hi"));
		const tr = chunks.find((c) => c.type === "tool_result") as
			| { result?: { echoed: string } }
			| undefined;
		expect(tr?.result).toEqual({ echoed: "rewritten" });
	});

	it("pre-tool-call ToolDenied blocks execution and yields denial", async () => {
		let executed = false;
		const skill: Skill = {
			...echoSkill(),
			execute: async (input: unknown) => {
				executed = true;
				return { echoed: (input as { value: string }).value };
			},
		};
		const streamFn = scriptedStream([
			[
				{
					type: "tool_calls",
					calls: [{ id: "c1", name: "echo", args: { value: "x" } }],
				},
				{ type: "usage", totalTokens: 1 },
			],
			[
				{ type: "text", delta: "ok" },
				{ type: "usage", totalTokens: 1 },
			],
		]);
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [skill],
			streamFn,
			policy: policy({ allowedTools: ["echo"] }),
			redaction: NO_REDACT,
			hooks: {
				"pre-tool-call": [
					() => {
						throw new ToolDenied("policy");
					},
				],
			},
		});
		const chunks = await collect(host.run("hi"));
		expect(executed).toBe(false);
		const tr = chunks.find((c) => c.type === "tool_result") as
			| { denied?: boolean }
			| undefined;
		expect(tr?.denied).toBe(true);
	});

	it("post-tool-call hook can replace the result", async () => {
		const streamFn = scriptedStream([
			[
				{
					type: "tool_calls",
					calls: [{ id: "c1", name: "echo", args: { value: "x" } }],
				},
				{ type: "usage", totalTokens: 1 },
			],
			[
				{ type: "text", delta: "ok" },
				{ type: "usage", totalTokens: 1 },
			],
		]);
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [echoSkill()],
			streamFn,
			policy: policy({ allowedTools: ["echo"] }),
			redaction: NO_REDACT,
			hooks: {
				"post-tool-call": [() => ({ result: { ref_id: "r1" } })],
			},
		});
		const chunks = await collect(host.run("hi"));
		const tr = chunks.find((c) => c.type === "tool_result") as
			| { result?: unknown }
			| undefined;
		expect(tr?.result).toEqual({ ref_id: "r1" });
	});

	it("post-tool-call ToolResultTooLargeError becomes tool error", async () => {
		const streamFn = scriptedStream([
			[
				{
					type: "tool_calls",
					calls: [{ id: "c1", name: "echo", args: { value: "x" } }],
				},
				{ type: "usage", totalTokens: 1 },
			],
			[
				{ type: "text", delta: "end" },
				{ type: "usage", totalTokens: 1 },
			],
		]);
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [echoSkill()],
			streamFn,
			policy: policy({ allowedTools: ["echo"] }),
			redaction: NO_REDACT,
			hooks: {
				"post-tool-call": [
					() => {
						throw new ToolResultTooLargeError(9999);
					},
				],
			},
		});
		const chunks = await collect(host.run("hi"));
		const tr = chunks.find((c) => c.type === "tool_result") as
			| { error?: string }
			| undefined;
		expect(tr?.error).toMatch(/too large/i);
	});
});

describe("AgentHost — budget", () => {
	it("throws BudgetExceeded when exceeding maxStepsPerTask", async () => {
		// Each turn emits a tool_call so loop keeps going.
		const streamFn: StreamFn = async function* () {
			yield {
				type: "tool_calls",
				calls: [
					{ id: `c${Math.random()}`, name: "echo", args: { value: "x" } },
				],
			};
			yield { type: "usage", totalTokens: 1 };
		};
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [echoSkill()],
			streamFn,
			policy: policy({
				allowedTools: ["echo"],
				costGuard: {
					...DEFAULT_POLICY.costGuard,
					maxStepsPerTask: 3,
				},
			}),
			redaction: NO_REDACT,
		});
		const chunks = await collect(host.run("hi"));
		expect(chunks[chunks.length - 1]).toEqual({
			type: "done",
			reason: "budget_exceeded",
		});
	});

	it("BudgetExceededError is exported and used for token overrun", async () => {
		const streamFn: StreamFn = async function* () {
			yield {
				type: "tool_calls",
				calls: [{ id: "c1", name: "echo", args: { value: "x" } }],
			};
			// Blow token budget in a single turn.
			yield { type: "usage", totalTokens: 9_999_999 };
		};
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [echoSkill()],
			streamFn,
			policy: policy({
				allowedTools: ["echo"],
				costGuard: { ...DEFAULT_POLICY.costGuard, maxTokensPerTask: 100 },
			}),
			redaction: NO_REDACT,
		});
		const chunks = await collect(host.run("hi"));
		const err = chunks.find((c) => c.type === "error") as
			| { reason: string; message: string }
			| undefined;
		expect(err?.reason).toBe("budget_exceeded");
		expect(BudgetExceededError).toBeTruthy();
	});
});

describe("AgentHost — abort", () => {
	it("external AbortSignal aborts the run with reason=killed", async () => {
		const ac = new AbortController();
		// Slow stream — we'll abort mid-flight.
		const streamFn: StreamFn = async function* () {
			yield { type: "text", delta: "a" };
			await new Promise((r) => setTimeout(r, 50));
			yield { type: "text", delta: "b" };
			yield { type: "usage", totalTokens: 1 };
		};
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [],
			streamFn,
			policy: policy(),
			redaction: NO_REDACT,
		});
		setTimeout(() => ac.abort(), 10);
		const chunks = await collect(host.run("hi", ac.signal));
		const done = chunks[chunks.length - 1];
		expect(done).toEqual({ type: "done", reason: "killed" });
	});

	it("cancel() aborts the run", async () => {
		const streamFn: StreamFn = async function* () {
			await new Promise((r) => setTimeout(r, 50));
			yield { type: "text", delta: "late" };
			yield { type: "usage", totalTokens: 1 };
		};
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [],
			streamFn,
			policy: policy(),
			redaction: NO_REDACT,
		});
		const runPromise = collect(host.run("hi"));
		setTimeout(() => host.cancel(), 10);
		const chunks = await runPromise;
		const done = chunks[chunks.length - 1];
		expect(done).toEqual({ type: "done", reason: "killed" });
	});
});

describe("AgentHost — miscellany", () => {
	it("registerHook returns an off() that removes the hook", async () => {
		const calls: string[] = [];
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [],
			streamFn: textOnlyStream("x"),
			policy: policy(),
			redaction: NO_REDACT,
		});
		const off = host.registerHook("pre-llm-call", () => {
			calls.push("a");
		});
		await collect(host.run("hi"));
		expect(calls).toEqual(["a"]);
		off();
		await collect(host.run("hi2"));
		expect(calls).toEqual(["a"]); // still just 1
	});

	it("redaction.filter is applied to user prompt", async () => {
		let seenUser = "";
		const streamFn: StreamFn = async function* (input) {
			const user = [...input.messages].reverse().find((m) => m.role === "user");
			seenUser = user?.content ?? "";
			yield { type: "text", delta: "ok" };
			yield { type: "usage", totalTokens: 1 };
		};
		const redact: SensitiveWordFilter = {
			filter: (s) => s.replace(/secret/g, "[REDACTED]"),
		};
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [],
			streamFn,
			policy: policy(),
			redaction: redact,
		});
		await collect(host.run("my secret key"));
		expect(seenUser).toBe("my [REDACTED] key");
	});

	it("unknown tool name yields a tool error", async () => {
		const streamFn = scriptedStream([
			[
				{
					type: "tool_calls",
					calls: [{ id: "c1", name: "nope", args: {} }],
				},
				{ type: "usage", totalTokens: 1 },
			],
			[
				{ type: "text", delta: "end" },
				{ type: "usage", totalTokens: 1 },
			],
		]);
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [echoSkill()],
			streamFn,
			policy: policy({ allowedTools: ["echo"] }),
			redaction: NO_REDACT,
		});
		const chunks = await collect(host.run("hi"));
		const tr = chunks.find((c) => c.type === "tool_result") as
			| { error?: string }
			| undefined;
		expect(tr?.error).toMatch(/unknown tool/i);
	});
});
