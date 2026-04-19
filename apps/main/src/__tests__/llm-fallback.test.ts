/**
 * Fallback-chain unit tests (Stage 3.4).
 */

import { describe, expect, it } from "vitest";
import type { LlmStreamChunk } from "../agent-host.js";
import {
	AllProvidersFailedError,
	LlmAuthError,
	LlmContextTooLongError,
	LlmProviderError,
	LlmRateLimitError,
} from "../llm/errors.js";
import { createFallbackStreamFn } from "../llm/fallback.js";
import type { LlmProvider, StreamFnInput } from "../llm/types.js";

function textProvider(
	name: string,
	text: string,
	totalTokens = 5,
): LlmProvider {
	return {
		name,
		async *stream() {
			yield { type: "text", delta: text } as LlmStreamChunk;
			yield { type: "usage", totalTokens } as LlmStreamChunk;
		},
	};
}

function failingProvider(name: string, err: Error): LlmProvider {
	return {
		name,
		async *stream() {
			throw err;
			// biome-ignore lint/correctness/noUnreachable: keeps return type narrow
			yield { type: "text", delta: "" } as LlmStreamChunk;
		},
	};
}

async function collect(
	iter: AsyncIterable<LlmStreamChunk>,
): Promise<LlmStreamChunk[]> {
	const out: LlmStreamChunk[] = [];
	for await (const c of iter) out.push(c);
	return out;
}

const INPUT: StreamFnInput = {
	messages: [{ role: "user", content: "hi" }],
	tools: [],
};

describe("createFallbackStreamFn", () => {
	it("uses the first provider when it succeeds", async () => {
		const fn = createFallbackStreamFn([
			textProvider("a", "from-a"),
			textProvider("b", "from-b"),
		]);
		const chunks = await collect(fn(INPUT));
		expect(chunks.find((c) => c.type === "text")).toEqual({
			type: "text",
			delta: "from-a",
		});
	});

	it("falls back to the second provider on auth error", async () => {
		const fn = createFallbackStreamFn([
			failingProvider("a", new LlmAuthError("a", "bad key")),
			textProvider("b", "from-b"),
		]);
		const chunks = await collect(fn(INPUT));
		expect(chunks.find((c) => c.type === "text")).toEqual({
			type: "text",
			delta: "from-b",
		});
	});

	it("falls back on rate-limit error", async () => {
		const fn = createFallbackStreamFn([
			failingProvider("a", new LlmRateLimitError("a")),
			textProvider("b", "ok"),
		]);
		const chunks = await collect(fn(INPUT));
		expect((chunks[0] as { delta: string }).delta).toBe("ok");
	});

	it("falls back on generic network errors (LlmProviderError)", async () => {
		const fn = createFallbackStreamFn([
			failingProvider("a", new LlmProviderError("a", "ECONNREFUSED")),
			textProvider("b", "ok"),
		]);
		const chunks = await collect(fn(INPUT));
		expect((chunks[0] as { delta: string }).delta).toBe("ok");
	});

	it("does NOT fall back on LlmContextTooLongError — re-throws immediately", async () => {
		const fn = createFallbackStreamFn([
			failingProvider("a", new LlmContextTooLongError("a", "context too long")),
			textProvider("b", "should-not-reach"),
		]);
		await expect(collect(fn(INPUT))).rejects.toBeInstanceOf(
			LlmContextTooLongError,
		);
	});

	it("throws AllProvidersFailedError when every provider fails", async () => {
		const fn = createFallbackStreamFn([
			failingProvider("a", new LlmAuthError("a")),
			failingProvider("b", new LlmRateLimitError("b")),
			failingProvider("c", new Error("boom")),
		]);
		const err = await collect(fn(INPUT)).catch((e) => e);
		expect(err).toBeInstanceOf(AllProvidersFailedError);
		const all = err as AllProvidersFailedError;
		expect(all.errors.map((e) => e.provider)).toEqual(["a", "b", "c"]);
	});

	it("requires at least one provider", () => {
		expect(() => createFallbackStreamFn([])).toThrow();
	});

	it("propagates abort signal to providers", async () => {
		let sawSignal: AbortSignal | undefined;
		const hanger: LlmProvider = {
			name: "hanger",
			async *stream(_req, signal) {
				sawSignal = signal;
				yield { type: "text", delta: "x" };
				// Wait indefinitely, resolved by abort.
				await new Promise<void>((resolve) => {
					if (signal?.aborted) return resolve();
					signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
			},
		};
		const fn = createFallbackStreamFn([hanger]);
		const ctrl = new AbortController();
		const iter = fn({ ...INPUT, signal: ctrl.signal })[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toMatchObject({ type: "text", delta: "x" });
		expect(sawSignal).toBeDefined();
		ctrl.abort();
		const done = await iter.next();
		expect(done.done).toBe(true);
	});

	it("does NOT fall back once the first provider has yielded a chunk", async () => {
		// Provider that emits one text chunk then throws — we must NOT retry.
		const partial: LlmProvider = {
			name: "partial",
			async *stream() {
				yield { type: "text", delta: "partial" };
				throw new LlmAuthError("partial", "mid-stream auth?");
			},
		};
		const fn = createFallbackStreamFn([
			partial,
			textProvider("b", "should-not-reach"),
		]);
		const err = await collect(fn(INPUT)).catch((e) => e);
		expect(err).toBeInstanceOf(LlmAuthError);
	});
});
