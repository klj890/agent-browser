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

	it("appends Ollama to the chain when OLLAMA_BASE_URL is set (no key needed)", () => {
		const chain = buildProviderChain({
			GEMINI_API_KEY: "g",
			OLLAMA_BASE_URL: "http://localhost:11434/v1",
		});
		expect(chain.map((p) => p.name)).toEqual(["gemini", "ollama"]);
	});

	it("appends LM Studio only when both URL and model are configured", () => {
		// URL alone is insufficient — LM Studio has no sensible default model.
		expect(
			buildProviderChain({ LMSTUDIO_BASE_URL: "http://localhost:1234/v1" }).map(
				(p) => p.name,
			),
		).toEqual([]);
		// With both, provider joins the chain.
		expect(
			buildProviderChain({
				LMSTUDIO_BASE_URL: "http://localhost:1234/v1",
				LMSTUDIO_MODEL: "Meta-Llama-3.1-8B-Instruct",
			}).map((p) => p.name),
		).toEqual(["lmstudio"]);
	});

	it("local providers trail remote providers in the fallback order", () => {
		const chain = buildProviderChain({
			GEMINI_API_KEY: "g",
			ANTHROPIC_API_KEY: "a",
			DEEPSEEK_API_KEY: "d",
			DASHSCOPE_API_KEY: "q",
			LMSTUDIO_BASE_URL: "http://localhost:1234/v1",
			LMSTUDIO_MODEL: "x",
			OLLAMA_BASE_URL: "http://localhost:11434/v1",
		});
		expect(chain.map((p) => p.name)).toEqual([
			"gemini",
			"anthropic",
			"deepseek",
			"qwen",
			"lmstudio",
			"ollama",
		]);
	});
});

describe("OpenAiCompatProvider — local mode (no apiKey)", () => {
	it("omits Authorization header when apiKey is undefined", async () => {
		const captured: Array<{ headers: Headers | Record<string, string> }> = [];
		const fakeFetch: typeof fetch = async (_url, init) => {
			captured.push({
				headers: (init?.headers as Record<string, string>) ?? {},
			});
			// Minimal valid SSE response: one data: [DONE].
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};
		const { OpenAiCompatProvider } = await import(
			"../llm/openai-compatible.js"
		);
		const p = new OpenAiCompatProvider({
			name: "local",
			baseUrl: "http://localhost:11434/v1",
			model: "llama3.1",
			fetchImpl: fakeFetch,
		});
		for await (const _c of p.stream({
			messages: [{ role: "user", content: "hi" }],
			tools: [],
		})) {
			/* drain */
		}
		expect(captured).toHaveLength(1);
		const hdr = captured[0]?.headers as Record<string, string>;
		expect(hdr.Authorization).toBeUndefined();
	});

	it("still sends Authorization when apiKey is provided", async () => {
		const captured: Array<Record<string, string>> = [];
		const fakeFetch: typeof fetch = async (_url, init) => {
			captured.push((init?.headers as Record<string, string>) ?? {});
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};
		const { OpenAiCompatProvider } = await import(
			"../llm/openai-compatible.js"
		);
		const p = new OpenAiCompatProvider({
			name: "remote",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-xyz",
			model: "gpt-test",
			fetchImpl: fakeFetch,
		});
		for await (const _c of p.stream({
			messages: [{ role: "user", content: "hi" }],
			tools: [],
		})) {
			/* drain */
		}
		expect(captured[0]?.Authorization).toBe("Bearer sk-xyz");
	});

	it("treats apiKey='' same as undefined (no Authorization header)", async () => {
		const captured: Array<Record<string, string>> = [];
		const fakeFetch: typeof fetch = async (_url, init) => {
			captured.push((init?.headers as Record<string, string>) ?? {});
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};
		const { OpenAiCompatProvider } = await import(
			"../llm/openai-compatible.js"
		);
		const p = new OpenAiCompatProvider({
			name: "local",
			baseUrl: "http://localhost:11434/v1",
			apiKey: "",
			model: "llama3.1",
			fetchImpl: fakeFetch,
		});
		for await (const _c of p.stream({
			messages: [{ role: "user", content: "hi" }],
			tools: [],
		})) {
			/* drain */
		}
		expect(captured[0]?.Authorization).toBeUndefined();
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
