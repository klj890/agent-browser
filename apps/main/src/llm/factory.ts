/**
 * Default production `StreamFn` factory (Stage 3.4).
 *
 * Reads API keys from environment and builds the CogniRefract-style fallback
 * chain: **Gemini → Claude → DeepSeek → Qwen → LM Studio → Ollama** (附录 G
 * default order, with local fallbacks appended per BrowserOS §2.8 ruleset).
 * If nothing is configured (dev environment, CI, unit tests), we fall back
 * to `mockEchoStream()` so the app still boots and `pnpm test` stays green.
 *
 * Local providers trail the chain because network-hosted models are usually
 * stronger for agentic workloads; Ollama/LM Studio kick in only when every
 * remote hop has failed (offline dev, egress block, provider outage).
 *
 * Default models (2026-04 vintage; tunable via env vars):
 *   - Gemini    : `gemini-2.0-flash-exp`
 *   - Claude    : `claude-sonnet-4-6`
 *   - DeepSeek  : `deepseek-chat`
 *   - Qwen      : `qwen-plus`
 *   - LM Studio : (user-selected, no default — must set `LMSTUDIO_MODEL`)
 *   - Ollama    : `llama3.1` (tune via `OLLAMA_MODEL`)
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

	// Local OpenAI-compatible endpoints. Opt-in: only if the user set the
	// base URL env var (they run the daemon themselves). No API key is sent;
	// OpenAiCompatProvider omits the Authorization header when apiKey is
	// blank so local daemons don't 401 on `Bearer `.
	// All env reads .trim() so a trailing newline from a sloppy `.env`
	// copy-paste doesn't ship whitespace into URLs/model names (same
	// motivation as the apiKey trim in OpenAiCompatProvider).
	const lmStudioUrl = env.LMSTUDIO_BASE_URL?.trim();
	const lmStudioModel = env.LMSTUDIO_MODEL?.trim();
	if (lmStudioUrl && lmStudioModel) {
		// LM Studio requires the user to pick a loaded model name — there's
		// no sensible default, so we only enable this provider when both
		// URL + model are configured.
		providers.push(
			new OpenAiCompatProvider({
				name: "lmstudio",
				baseUrl: lmStudioUrl,
				model: lmStudioModel,
				fetchImpl,
			}),
		);
	}

	const ollamaUrl = env.OLLAMA_BASE_URL?.trim();
	if (ollamaUrl) {
		providers.push(
			new OpenAiCompatProvider({
				name: "ollama",
				baseUrl: ollamaUrl,
				// `||` (not `??`) so that `OLLAMA_MODEL=""` or whitespace-only
				// falls back too — empty env vars shouldn't reach the
				// provider as a model name.
				model: env.OLLAMA_MODEL?.trim() || "llama3.1",
				fetchImpl,
			}),
		);
	}

	return providers;
}
