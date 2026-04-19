/**
 * Barrel export for the LLM subsystem (Stage 3.4).
 */

export { type AnthropicOpts, AnthropicProvider } from "./anthropic.js";
export {
	AllProvidersFailedError,
	LlmAuthError,
	LlmContextTooLongError,
	LlmProviderError,
	LlmRateLimitError,
} from "./errors.js";
export {
	buildProviderChain,
	createDefaultStreamFn,
	type DefaultStreamFnOpts,
} from "./factory.js";
export { createFallbackStreamFn } from "./fallback.js";
export { type GeminiOpts, GeminiProvider } from "./gemini.js";
export {
	type OpenAiCompatOpts,
	OpenAiCompatProvider,
} from "./openai-compatible.js";
export { parseSseStream, type SseEvent, stringToByteStream } from "./sse.js";
export type {
	LlmProvider,
	LlmRequest,
	LlmTool,
} from "./types.js";
