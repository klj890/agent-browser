/**
 * e2e #10 — multi-LLM fallback (PLAN scenario 9).
 *
 * Use the real `createFallbackStreamFn` with 3 fake providers:
 *   provider A — throws immediately (simulates Gemini down)
 *   provider B — throws immediately (simulates Claude down)
 *   provider C — streams a clean response
 *
 * Acceptance: the consumer sees provider C's text only, once.
 */
import { describe, expect, it } from "vitest";
import {
	AllProvidersFailedError,
	LlmAuthError,
} from "../apps/main/src/llm/errors.js";
import { createFallbackStreamFn } from "../apps/main/src/llm/fallback.js";
import type {
	LlmProvider,
	LlmStreamChunk,
} from "../apps/main/src/llm/types.js";

function okProvider(name: string, text: string): LlmProvider {
	return {
		name,
		async *stream() {
			yield { type: "text", delta: text } as LlmStreamChunk;
			yield { type: "usage", totalTokens: 1 } as LlmStreamChunk;
		},
	};
}

function failingProvider(name: string): LlmProvider {
	return {
		name,
		async *stream() {
			throw new LlmAuthError(name, "auth failed");
			// unreachable; generator needs the yield type
			// biome-ignore lint/correctness/noUnreachable: <typecheck>
			yield { type: "text", delta: "" } as LlmStreamChunk;
		},
	};
}

describe("e2e/multi-llm-fallback: chain walks to first healthy provider", () => {
	it("skips two failing providers and streams the third", async () => {
		const chain = createFallbackStreamFn([
			failingProvider("gemini"),
			failingProvider("claude"),
			okProvider("deepseek", "hello-from-deepseek"),
		]);
		const out: string[] = [];
		for await (const c of chain({
			messages: [{ role: "user", content: "hi" }],
			tools: [],
		})) {
			if (c.type === "text") out.push(c.delta);
		}
		expect(out.join("")).toBe("hello-from-deepseek");
	});

	it("throws AllProvidersFailedError when every provider fails", async () => {
		const chain = createFallbackStreamFn([
			failingProvider("a"),
			failingProvider("b"),
		]);
		await expect(async () => {
			let count = 0;
			for await (const _c of chain({
				messages: [{ role: "user", content: "x" }],
				tools: [],
			})) {
				count++;
			}
			return count;
		}).rejects.toBeInstanceOf(AllProvidersFailedError);
	});
});
