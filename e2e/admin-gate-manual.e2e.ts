/**
 * e2e #5 — admin gate (manual autonomy).
 *
 * PLAN scenario 5 — "manual → Agent 尝试 page.click → 被拦截".
 *
 * We construct an AgentHost with `policy.autonomy = 'manual'`, wire a
 * ConfirmationHandler that always denies, and drive the host with a streamFn
 * that requests a `click` tool. The tool result must be `{ denied: true }`.
 */

import type { Skill } from "@agent-browser/browser-tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type AdminPolicy,
	DEFAULT_POLICY,
} from "../apps/main/src/admin-policy.js";
import {
	AgentHost,
	type LlmStreamChunk,
	type StreamFn,
	ToolDenied,
} from "../apps/main/src/agent-host.js";
import { ConfirmationHandler } from "../apps/main/src/confirmation.js";

const NO_REDACT = { filter: (s: string) => s };

function policy(o: Partial<AdminPolicy> = {}): AdminPolicy {
	return {
		...DEFAULT_POLICY,
		...o,
		costGuard: { ...DEFAULT_POLICY.costGuard, ...(o.costGuard ?? {}) },
	};
}

function clickSkill(): Skill {
	return {
		name: "click",
		description: "click an element",
		inputSchema: z.object({ ref: z.string() }),
		execute: async () => ({ ok: true }),
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

describe("e2e/admin-gate-manual: manual autonomy blocks write tools", () => {
	it("denies click via ConfirmationHandler", async () => {
		const pol = policy({
			autonomy: "manual",
			allowedTools: ["click"],
		});
		const confirmation = new ConfirmationHandler({
			policy: pol,
			askUser: async () => "denied",
			timeoutMs: 500,
		});
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [clickSkill()],
			streamFn: scriptedStream([
				[
					{
						type: "tool_calls",
						calls: [{ id: "c1", name: "click", args: { ref: "@e1" } }],
					},
					{ type: "usage", totalTokens: 10 },
				],
				// If the denial triggers a follow-up turn, the LLM sees the denial and stops.
				[
					{ type: "text", delta: "understood — stopping." },
					{ type: "usage", totalTokens: 5 },
				],
			]),
			policy: pol,
			redaction: NO_REDACT,
			hooks: {
				"pre-tool-call": [
					async (ctx) => {
						const decision = await confirmation.decide({
							tool: ctx.call.name,
							args: ctx.call.args,
							highRiskFlags: [],
							tabUrl: "https://example.com/",
						});
						if (decision !== "approved") throw new ToolDenied(decision);
					},
				],
			},
		});

		const chunks: Array<{ type: string; denied?: boolean; name?: string }> = [];
		for await (const c of host.run("please click @e1")) {
			chunks.push(c as { type: string; denied?: boolean; name?: string });
		}
		const denied = chunks.find(
			(c) => c.type === "tool_result" && c.name === "click",
		) as { denied?: boolean } | undefined;
		expect(denied).toBeDefined();
		expect(denied?.denied).toBe(true);
		expect(chunks[chunks.length - 1]).toEqual({
			type: "done",
			reason: "completed",
		});
	});
});
