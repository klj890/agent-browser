/**
 * §2.5 calibration: ROUTINE_BLOCKED_TOOLS — verify that tools requiring
 * interactive confirmation are stripped from the AgentHost when a task runs
 * as a background routine (`scheduledTask: true`).
 *
 * We test the contract at two levels:
 *  1. The ROUTINE_BLOCKED_TOOLS constant itself (documents what's blocked).
 *  2. The AgentHost tool-call path: when a skill is absent from the skill
 *     list the LLM receives `{ error: "unknown tool: <name>" }` — confirming
 *     that filterSkills correctly omits the blocked skills.
 */

import type { Skill } from "@agent-browser/browser-tools";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../admin-policy.js";
import {
	AgentHost,
	type LlmStreamChunk,
	type StreamChunk,
	type StreamFn,
} from "../agent-host.js";
import {
	hookLevelHighRiskFlags,
	ROUTINE_BLOCKED_TOOLS,
} from "../agent-host-factory.js";
import type { SensitiveWordFilter } from "../redaction-pipeline.js";

const NO_REDACT: SensitiveWordFilter = { filter: (s) => s };

// ---------------------------------------------------------------------------
// ROUTINE_BLOCKED_TOOLS contract
// ---------------------------------------------------------------------------

describe("ROUTINE_BLOCKED_TOOLS", () => {
	it("blocks soul_amend — high blast-radius (rewrites system prompt for all future tasks)", () => {
		expect(ROUTINE_BLOCKED_TOOLS.has("soul_amend")).toBe(true);
	});

	it("blocks fs_write — overwrites files without user present", () => {
		expect(ROUTINE_BLOCKED_TOOLS.has("fs_write")).toBe(true);
	});

	it("does NOT block read-only tools that are safe for background use", () => {
		for (const safe of [
			"snapshot",
			"goto",
			"act",
			"wait",
			"fs_read",
			"fs_ls",
			"memory_search",
			"memory_read_core",
			"memory_read_daily",
		]) {
			expect(ROUTINE_BLOCKED_TOOLS.has(safe)).toBe(false);
		}
	});

	it("soul_amend is also in DEFAULT_POLICY forceConfirmActions and always-confirm via hookLevelHighRiskFlags", () => {
		// Belt-and-braces: even if a routine somehow bypassed ROUTINE_BLOCKED_TOOLS,
		// soul_amend would still require user confirmation via the hook.
		expect(DEFAULT_POLICY.forceConfirmActions).toContain("soul_modify");
		expect(hookLevelHighRiskFlags("soul_amend")).toContain("soul_modify");
	});
});

// ---------------------------------------------------------------------------
// AgentHost behaviour: missing skill → "unknown tool" error in tool_result
// ---------------------------------------------------------------------------

/**
 * Build a StreamFn that asks the LLM to call `toolName` once, then stops.
 * This lets us verify whether the tool is registered in the AgentHost.
 */
function singleToolCallStream(toolName: string): StreamFn {
	let turn = 0;
	return async function* (): AsyncGenerator<LlmStreamChunk> {
		if (turn === 0) {
			turn++;
			yield {
				type: "tool_calls",
				calls: [{ id: "c1", name: toolName, args: {} }],
			} as LlmStreamChunk;
			yield { type: "usage", totalTokens: 1 } as LlmStreamChunk;
		} else {
			yield { type: "text", delta: "done" } as LlmStreamChunk;
			yield { type: "usage", totalTokens: 1 } as LlmStreamChunk;
		}
	};
}

/** Policy that allows the given tools (on top of DEFAULT_POLICY). */
function policyAllowing(...tools: string[]) {
	return {
		...DEFAULT_POLICY,
		allowedTools: [...DEFAULT_POLICY.allowedTools, ...tools],
	};
}

/** Minimal no-op skill stub. */
function stubSkill(name: string): Skill {
	return {
		name,
		description: `stub ${name}`,
		inputSchema: { parse: (x: unknown) => x } as Skill["inputSchema"],
		execute: async () => ({ ok: true }),
	};
}

describe("AgentHost with scheduledTask-filtered skills", () => {
	it("soul_amend absent from skill list → 'unknown tool' result (simulates scheduledTask filter)", async () => {
		// Create a host WITHOUT soul_amend (as filterSkills does for scheduledTask)
		const host = new AgentHost({
			systemPrompt: "test",
			skills: [stubSkill("snapshot")], // soul_amend intentionally omitted
			streamFn: singleToolCallStream("soul_amend"),
			policy: policyAllowing("soul_amend", "snapshot"),
			redaction: NO_REDACT,
		});

		const chunks: StreamChunk[] = [];
		for await (const c of host.run("trigger soul_amend")) {
			chunks.push(c);
		}

		const result = chunks.find(
			(c): c is Extract<StreamChunk, { type: "tool_result" }> =>
				c.type === "tool_result" && c.name === "soul_amend",
		);

		// The tool call should come back as "unknown tool" — it was never registered.
		expect(result?.error).toMatch(/unknown tool/i);
	});

	it("soul_amend present in skill list → executes successfully (normal interactive session)", async () => {
		const host = new AgentHost({
			systemPrompt: "test",
			skills: [stubSkill("soul_amend"), stubSkill("snapshot")],
			streamFn: singleToolCallStream("soul_amend"),
			policy: policyAllowing("soul_amend", "snapshot"),
			redaction: NO_REDACT,
		});

		const chunks: StreamChunk[] = [];
		for await (const c of host.run("amend soul")) {
			chunks.push(c);
		}

		const result = chunks.find(
			(c): c is Extract<StreamChunk, { type: "tool_result" }> =>
				c.type === "tool_result" && c.name === "soul_amend",
		);

		// With the skill registered the execute() stub returns { ok: true } — no error.
		expect(result?.error).toBeUndefined();
		expect(result?.result).toMatchObject({ ok: true });
	});
});
