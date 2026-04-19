/**
 * OpenAiCompatProvider unit tests (Stage 3.4).
 *
 * All tests use a fake `fetchImpl` — no network traffic.
 */

import { describe, expect, it } from "vitest";
import type { LlmStreamChunk } from "../agent-host.js";
import {
	LlmAuthError,
	LlmContextTooLongError,
	LlmProviderError,
	LlmRateLimitError,
} from "../llm/errors.js";
import { OpenAiCompatProvider } from "../llm/openai-compatible.js";
import { stringToByteStream } from "../llm/sse.js";

function fakeFetch(
	responseBody: string,
	init: { status?: number; statusText?: string } = {},
): typeof fetch {
	return async () => {
		return new Response(stringToByteStream(responseBody), {
			status: init.status ?? 200,
			statusText: init.statusText ?? "OK",
			headers: { "Content-Type": "text/event-stream" },
		});
	};
}

function failingFetch(err: Error): typeof fetch {
	return async () => {
		throw err;
	};
}

async function collect(
	iter: AsyncIterable<LlmStreamChunk>,
): Promise<LlmStreamChunk[]> {
	const out: LlmStreamChunk[] = [];
	for await (const c of iter) out.push(c);
	return out;
}

function make(
	fetchImpl: typeof fetch,
	overrides: Partial<{ apiKey: string; model: string }> = {},
): OpenAiCompatProvider {
	return new OpenAiCompatProvider({
		name: "test-openai",
		baseUrl: "https://example.invalid/v1",
		apiKey: overrides.apiKey ?? "sk-test",
		model: overrides.model ?? "gpt-x",
		fetchImpl,
		timeoutMs: 1000,
	});
}

describe("OpenAiCompatProvider", () => {
	it("yields text deltas and usage on a simple text response", async () => {
		const body = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}',
			"",
			'data: {"choices":[{"delta":{"content":", world"}}]}',
			"",
			'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":12}}',
			"",
			"data: [DONE]",
			"",
			"",
		].join("\n");
		const provider = make(fakeFetch(body));
		const chunks = await collect(
			provider.stream({ messages: [{ role: "user", content: "hi" }] }),
		);
		const texts = chunks
			.filter((c) => c.type === "text")
			.map((c) => (c as { delta: string }).delta)
			.join("");
		expect(texts).toBe("Hello, world");
		const usage = chunks.find((c) => c.type === "usage");
		expect(usage).toEqual({ type: "usage", totalTokens: 12 });
	});

	it("assembles a streamed tool_call", async () => {
		const body = [
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"snapshot","arguments":"{\\"interactive_only\\""}}]}}]}',
			"",
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":true}"}}]}}]}',
			"",
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
			"",
			"data: [DONE]",
			"",
			"",
		].join("\n");
		const provider = make(fakeFetch(body));
		const chunks = await collect(
			provider.stream({
				messages: [{ role: "user", content: "go" }],
				tools: [{ name: "snapshot", description: "snap" }],
			}),
		);
		const call = chunks.find((c) => c.type === "tool_calls");
		expect(call).toBeDefined();
		expect(call).toMatchObject({
			type: "tool_calls",
			calls: [
				{
					id: "call_1",
					name: "snapshot",
					args: { interactive_only: true },
				},
			],
		});
	});

	it("maps HTTP 429 to LlmRateLimitError", async () => {
		const provider = make(fakeFetch("rate limit exceeded", { status: 429 }));
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmRateLimitError);
	});

	it("maps HTTP 401 to LlmAuthError", async () => {
		const provider = make(fakeFetch("invalid key", { status: 401 }));
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmAuthError);
	});

	it("maps context-length errors to LlmContextTooLongError", async () => {
		const provider = make(
			fakeFetch("context_length_exceeded: maximum context 8k", {
				status: 400,
			}),
		);
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmContextTooLongError);
	});

	it("wraps network errors as LlmProviderError", async () => {
		const provider = make(failingFetch(new Error("ECONNREFUSED")));
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmProviderError);
	});

	it("propagates abort via the signal", async () => {
		// Infinite stream — we abort before it completes.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
					),
				);
				// never close
			},
		});
		const fetchImpl: typeof fetch = async () =>
			new Response(stream, { status: 200 });
		const provider = make(fetchImpl);
		const ctrl = new AbortController();
		const iter = provider.stream(
			{ messages: [{ role: "user", content: "x" }] },
			ctrl.signal,
		);
		const it = iter[Symbol.asyncIterator]();
		const first = await it.next();
		expect(first.value).toMatchObject({ type: "text", delta: "a" });
		ctrl.abort();
		// next() returns done=true or throws — either is fine, but must terminate.
		const tail = await it
			.next()
			.catch(() => ({ done: true, value: undefined }));
		expect(tail.done).toBe(true);
	});

	it("ignores malformed JSON frames", async () => {
		const body = [
			"data: not json",
			"",
			'data: {"choices":[{"delta":{"content":"ok"}}]}',
			"",
			"data: [DONE]",
			"",
			"",
		].join("\n");
		const provider = make(fakeFetch(body));
		const chunks = await collect(
			provider.stream({ messages: [{ role: "user", content: "x" }] }),
		);
		const texts = chunks
			.filter((c) => c.type === "text")
			.map((c) => (c as { delta: string }).delta);
		expect(texts).toEqual(["ok"]);
	});
});
