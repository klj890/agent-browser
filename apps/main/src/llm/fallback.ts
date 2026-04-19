/**
 * Multi-provider fallback chain (Stage 3.4).
 *
 * Produces a `StreamFn` that tries each provider in order. On
 * `LlmAuthError` / `LlmRateLimitError` / network errors we move to the next;
 * on `LlmContextTooLongError` we re-throw (the caller needs to compact the
 * conversation — no other provider will help). If every provider fails, we
 * throw `AllProvidersFailedError`.
 *
 * Important: fallback only happens BEFORE the first chunk is yielded. If a
 * provider has already streamed text and then fails mid-stream, switching to
 * another provider would corrupt the transcript. We surface the mid-stream
 * error as-is.
 */

import { AllProvidersFailedError, LlmContextTooLongError } from "./errors.js";
import type {
	LlmProvider,
	LlmStreamChunk,
	StreamFn,
	StreamFnInput,
} from "./types.js";

export function createFallbackStreamFn(providers: LlmProvider[]): StreamFn {
	if (providers.length === 0) {
		throw new Error("createFallbackStreamFn requires at least one provider");
	}
	return async function* stream(
		input: StreamFnInput,
	): AsyncIterable<LlmStreamChunk> {
		const errors: Array<{ provider: string; error: unknown }> = [];
		let committed: AsyncIterator<LlmStreamChunk> | undefined;
		let firstValue: LlmStreamChunk | undefined;
		let firstDone = false;
		let committedName = "";

		for (let i = 0; i < providers.length; i++) {
			const provider = providers[i];
			if (!provider) continue;

			// Startup phase — failures here trigger fallback.
			let it: AsyncIterator<LlmStreamChunk>;
			let first: IteratorResult<LlmStreamChunk>;
			try {
				it = provider
					.stream(
						{ messages: input.messages, tools: input.tools },
						input.signal,
					)
					[Symbol.asyncIterator]();
				first = await it.next();
			} catch (err) {
				if (err instanceof LlmContextTooLongError) throw err;
				errors.push({ provider: provider.name, error: err });
				continue;
			}
			committed = it;
			firstValue = first.value;
			firstDone = first.done ?? false;
			committedName = provider.name;
			break;
		}

		if (!committed) {
			throw new AllProvidersFailedError(errors);
		}

		// Commit phase — propagate chunks and errors as-is (no further fallback).
		try {
			if (!firstDone && firstValue !== undefined) {
				yield firstValue;
			}
			while (true) {
				const { done, value } = await committed.next();
				if (done) return;
				yield value;
			}
		} catch (err) {
			// Preserve original error; annotate with committed provider for logs.
			if (err instanceof Error) {
				err.message = `[${committedName}] ${err.message}`;
			}
			throw err;
		}
	};
}
