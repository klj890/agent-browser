/**
 * LLM provider error taxonomy (Stage 3.4).
 *
 * The fallback chain uses these classes to decide whether to try the next
 * provider. Anything not in this hierarchy is treated as a transient network
 * error and triggers fallback.
 */

export class LlmProviderError extends Error {
	constructor(
		public readonly provider: string,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(`[${provider}] ${message}`);
		this.name = "LlmProviderError";
	}
}

/** Provider hit its rate limit. Fallback chain should try the next provider. */
export class LlmRateLimitError extends LlmProviderError {
	constructor(provider: string, message = "rate limited", cause?: unknown) {
		super(provider, message, cause);
		this.name = "LlmRateLimitError";
	}
}

/** Invalid/missing API key. Fallback chain should try the next provider. */
export class LlmAuthError extends LlmProviderError {
	constructor(provider: string, message = "auth failed", cause?: unknown) {
		super(provider, message, cause);
		this.name = "LlmAuthError";
	}
}

/**
 * Input exceeds the provider's context window. This is a *strategy* problem —
 * the caller needs to trim/compact messages — not a provider problem. The
 * fallback chain does NOT try another provider for this; it re-throws.
 */
export class LlmContextTooLongError extends LlmProviderError {
	constructor(provider: string, message = "context too long", cause?: unknown) {
		super(provider, message, cause);
		this.name = "LlmContextTooLongError";
	}
}

/**
 * Raised by `createFallbackStreamFn` when every provider in the chain failed.
 * `errors` preserves the per-provider failure for diagnostics.
 */
export class AllProvidersFailedError extends Error {
	constructor(
		public readonly errors: Array<{ provider: string; error: unknown }>,
	) {
		const parts = errors.map(
			({ provider, error }) =>
				`${provider}: ${error instanceof Error ? error.message : String(error)}`,
		);
		super(`all LLM providers failed: ${parts.join(" | ")}`);
		this.name = "AllProvidersFailedError";
	}
}
