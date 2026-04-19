/**
 * Factory + agent-host-factory integration tests (Stage 3.4).
 *
 * These tests exercise the "default StreamFn" wiring:
 *   - With no API keys, we must fall back to `mockEchoStream()`.
 *   - With keys, we must build the Gemini → Claude → DeepSeek → Qwen order.
 */

import { describe, expect, it } from "vitest";
import type { LlmStreamChunk } from "../agent-host.js";
import { buildProviderChain, createDefaultStreamFn } from "../llm/factory.js";

async function collect(
	iter: AsyncIterable<LlmStreamChunk>,
): Promise<LlmStreamChunk[]> {
	const out: LlmStreamChunk[] = [];
	for await (const c of iter) out.push(c);
	return out;
}

describe("createDefaultStreamFn", () => {
	it("returns mockEchoStream when no env keys are set", async () => {
		const fn = createDefaultStreamFn({ env: {} });
		const chunks = await collect(
			fn({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}),
		);
		// mockEchoStream emits `echo: hi` + a usage chunk.
		const texts = chunks
			.filter((c) => c.type === "text")
			.map((c) => (c as { delta: string }).delta)
			.join("");
		expect(texts).toContain("echo: hi");
	});

	it("is synchronous (does not return a Promise)", () => {
		// Critical: app startup must not await network I/O during factory init.
		const fn = createDefaultStreamFn({ env: {} });
		expect(typeof fn).toBe("function");
		// Must not be a thenable — returning a Promise would require the
		// caller to `await` during Electron app startup.
		expect(typeof (fn as unknown as { then?: unknown }).then).toBe("undefined");
	});
});

describe("buildProviderChain", () => {
	it("returns an empty chain when no keys are present", () => {
		expect(buildProviderChain({})).toEqual([]);
	});

	it("orders providers: Gemini, Anthropic, DeepSeek, Qwen", () => {
		const chain = buildProviderChain({
			GEMINI_API_KEY: "g",
			ANTHROPIC_API_KEY: "a",
			DEEPSEEK_API_KEY: "d",
			DASHSCOPE_API_KEY: "q",
		});
		expect(chain.map((p) => p.name)).toEqual([
			"gemini",
			"anthropic",
			"deepseek",
			"qwen",
		]);
	});

	it("includes only providers whose keys are set", () => {
		const chain = buildProviderChain({
			ANTHROPIC_API_KEY: "a",
			DASHSCOPE_API_KEY: "q",
		});
		expect(chain.map((p) => p.name)).toEqual(["anthropic", "qwen"]);
	});

	it("builds a single Gemini provider with default model", () => {
		const chain = buildProviderChain({ GEMINI_API_KEY: "g" });
		expect(chain).toHaveLength(1);
		expect(chain[0]?.name).toBe("gemini");
	});

	it("builds a single Anthropic provider with default model", () => {
		const chain = buildProviderChain({ ANTHROPIC_API_KEY: "a" });
		expect(chain).toHaveLength(1);
		expect(chain[0]?.name).toBe("anthropic");
	});
});

// Optional live-network smoke tests — default-skipped when API keys are not
// present. These are the ONLY tests in the suite that talk to real LLMs;
// they exist so a developer can export a key and verify end-to-end.
describe.skipIf(!process.env.GEMINI_API_KEY)("GeminiProvider (live)", () => {
	it("streams a short reply from the real API", async () => {
		const fn = createDefaultStreamFn({
			env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY },
		});
		const chunks = await collect(
			fn({
				messages: [{ role: "user", content: "Say OK and nothing else." }],
				tools: [],
			}),
		);
		expect(chunks.some((c) => c.type === "text")).toBe(true);
	});
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
	"AnthropicProvider (live)",
	() => {
		it("streams a short reply from the real API", async () => {
			const fn = createDefaultStreamFn({
				env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
			});
			const chunks = await collect(
				fn({
					messages: [{ role: "user", content: "Say OK and nothing else." }],
					tools: [],
				}),
			);
			expect(chunks.some((c) => c.type === "text")).toBe(true);
		});
	},
);
