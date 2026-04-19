/**
 * AnthropicProvider unit tests (Stage 3.4).
 */

import { describe, expect, it } from "vitest";
import type { LlmStreamChunk } from "../agent-host.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import {
	LlmAuthError,
	LlmContextTooLongError,
	LlmRateLimitError,
} from "../llm/errors.js";
import { stringToByteStream } from "../llm/sse.js";

function fakeFetch(
	responseBody: string,
	init: { status?: number } = {},
): typeof fetch {
	return async () =>
		new Response(stringToByteStream(responseBody), {
			status: init.status ?? 200,
			headers: { "Content-Type": "text/event-stream" },
		});
}

async function collect(
	iter: AsyncIterable<LlmStreamChunk>,
): Promise<LlmStreamChunk[]> {
	const out: LlmStreamChunk[] = [];
	for await (const c of iter) out.push(c);
	return out;
}

function make(fetchImpl: typeof fetch): AnthropicProvider {
	return new AnthropicProvider({
		apiKey: "ak-test",
		model: "claude-test",
		fetchImpl,
		timeoutMs: 1000,
	});
}

describe("AnthropicProvider", () => {
	it("yields text deltas from content_block_delta events", async () => {
		const body = [
			"event: message_start",
			'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
			"",
			"event: content_block_start",
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
			"",
			"event: content_block_delta",
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
			"",
			"event: content_block_delta",
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}',
			"",
			"event: message_delta",
			'data: {"type":"message_delta","usage":{"output_tokens":7}}',
			"",
			"event: message_stop",
			'data: {"type":"message_stop"}',
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
		expect(texts).toBe("Hello there");
		expect(chunks.find((c) => c.type === "usage")).toEqual({
			type: "usage",
			totalTokens: 12,
		});
	});

	it("assembles a tool_use block from input_json_delta fragments", async () => {
		const body = [
			"event: content_block_start",
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"snapshot"}}',
			"",
			"event: content_block_delta",
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"interactive_only\\""}}',
			"",
			"event: content_block_delta",
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":true}"}}',
			"",
			"event: message_stop",
			'data: {"type":"message_stop"}',
			"",
			"",
		].join("\n");
		const provider = make(fakeFetch(body));
		const chunks = await collect(
			provider.stream({
				messages: [{ role: "user", content: "snap" }],
				tools: [{ name: "snapshot", description: "s" }],
			}),
		);
		const call = chunks.find((c) => c.type === "tool_calls");
		expect(call).toMatchObject({
			type: "tool_calls",
			calls: [
				{ id: "toolu_1", name: "snapshot", args: { interactive_only: true } },
			],
		});
	});

	it("maps 401 to LlmAuthError", async () => {
		const provider = make(
			fakeFetch('{"error":{"type":"authentication_error"}}', { status: 401 }),
		);
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmAuthError);
	});

	it("maps 429 to LlmRateLimitError", async () => {
		const provider = make(fakeFetch("rate_limit exceeded", { status: 429 }));
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmRateLimitError);
	});

	it("maps context-length errors to LlmContextTooLongError", async () => {
		const provider = make(
			fakeFetch("prompt too long for model context length", { status: 400 }),
		);
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmContextTooLongError);
	});

	it("surfaces inline error events", async () => {
		const body = [
			"event: error",
			'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}',
			"",
			"",
		].join("\n");
		const provider = make(fakeFetch(body));
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmRateLimitError);
	});

	it("separates system messages into `system` param", async () => {
		let captured: string | undefined;
		const fetchImpl: typeof fetch = async (_url, init) => {
			if (init?.body) {
				const body = JSON.parse(String(init.body));
				captured = body.system;
			}
			return new Response(
				stringToByteStream(
					["event: message_stop", 'data: {"type":"message_stop"}', "", ""].join(
						"\n",
					),
				),
				{ status: 200 },
			);
		};
		const provider = make(fetchImpl);
		await collect(
			provider.stream({
				messages: [
					{ role: "system", content: "be nice" },
					{ role: "user", content: "hi" },
				],
			}),
		);
		expect(captured).toBe("be nice");
	});
});
