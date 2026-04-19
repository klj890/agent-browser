/**
 * Shared LLM provider types (Stage 3.4).
 *
 * These types deliberately re-export the AgentHost-facing protocol so the
 * fallback chain can plug in as a `StreamFn` without adapter code.
 */

import type {
	ChatMessage,
	LlmStreamChunk,
	StreamFn,
	StreamFnInput,
} from "../agent-host.js";

export type { ChatMessage, LlmStreamChunk, StreamFn, StreamFnInput };

/**
 * Tool descriptor as passed to an `LlmProvider`. Mirrors the `tools` field on
 * `StreamFnInput` — name + description only. Provider implementations convert
 * this to their native function/tool schema.
 */
export interface LlmTool {
	name: string;
	description: string;
}

export interface LlmRequest {
	messages: ChatMessage[];
	tools?: LlmTool[];
	/** Optional upper bound on response tokens. Providers clamp to their own limits. */
	maxTokens?: number;
}

export interface LlmProvider {
	/** Short human-readable name, used in logs + fallback error messages. */
	readonly name: string;
	/** Stream a request. The iterable MUST yield `LlmStreamChunk`s compatible with `AgentHost`. */
	stream(
		request: LlmRequest,
		signal?: AbortSignal,
	): AsyncIterable<LlmStreamChunk>;
}
