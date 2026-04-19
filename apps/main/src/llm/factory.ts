/**
 * Default production `StreamFn` factory (Stage 3.4).
 *
 * Reads API keys from environment and builds the CogniRefract-style fallback
 * chain: **Gemini → Claude → DeepSeek → Qwen** (附录 G default order). If no
 * keys are set (e.g. dev environment, CI, or unit tests), we fall back to
 * `mockEchoStream()` so the app still boots and `pnpm test` stays green.
 *
 * Default models (2026-04 vintage; tunable via env vars):
 *   - Gemini   : `gemini-2.0-flash-exp`
 *   - Claude   : `claude-sonnet-4-6`
 *   - DeepSeek : `deepseek-chat`
 *   - Qwen     : `qwen-plus`
 */

import { mockEchoStream, type StreamFn } from "../agent-host.js";
import { AnthropicProvider } from "./anthropic.js";
import { createFallbackStreamFn } from "./fallback.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAiCompatProvider } from "./openai-compatible.js";
import type { LlmProvider } from "./types.js";

export interface DefaultStreamFnOpts {
	/** Override for tests. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Override for tests — avoids real network calls. */
	fetchImpl?: typeof fetch;
}

/**
 * Synchronously returns a `StreamFn` — safe to call during startup without
 * blocking on any network I/O. Provider construction is cheap (no I/O).
 */
export function createDefaultStreamFn(
	opts: DefaultStreamFnOpts = {},
): StreamFn {
	const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
	const providers = buildProviderChain(env, opts.fetchImpl);
	if (providers.length === 0) {
		return mockEchoStream();
	}
	return createFallbackStreamFn(providers);
}

/**
 * Exposed for tests: inspect which providers were configured.
 */
export function buildProviderChain(
	env: Record<string, string | undefined>,
	fetchImpl?: typeof fetch,
): LlmProvider[] {
	const providers: LlmProvider[] = [];

	// Order: Gemini → Claude → DeepSeek → Qwen (PLAN 附录 G / line 99).
	const geminiKey = env.GEMINI_API_KEY;
	if (geminiKey) {
		providers.push(
			new GeminiProvider({
				apiKey: geminiKey,
				model: env.GEMINI_MODEL ?? "gemini-2.0-flash-exp",
				fetchImpl,
			}),
		);
	}

	const anthropicKey = env.ANTHROPIC_API_KEY;
	if (anthropicKey) {
		providers.push(
			new AnthropicProvider({
				apiKey: anthropicKey,
				model: env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
				fetchImpl,
			}),
		);
	}

	const deepseekKey = env.DEEPSEEK_API_KEY;
	if (deepseekKey) {
		providers.push(
			new OpenAiCompatProvider({
				name: "deepseek",
				baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
				apiKey: deepseekKey,
				model: env.DEEPSEEK_MODEL ?? "deepseek-chat",
				fetchImpl,
			}),
		);
	}

	const qwenKey = env.DASHSCOPE_API_KEY;
	if (qwenKey) {
		providers.push(
			new OpenAiCompatProvider({
				name: "qwen",
				baseUrl:
					env.DASHSCOPE_BASE_URL ??
					"https://dashscope.aliyuncs.com/compatible-mode/v1",
				apiKey: qwenKey,
				model: env.DASHSCOPE_MODEL ?? "qwen-plus",
				fetchImpl,
			}),
		);
	}

	return providers;
}
