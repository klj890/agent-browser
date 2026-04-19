/**
 * GeminiProvider unit tests (Stage 3.4).
 */

import { describe, expect, it } from "vitest";
import type { LlmStreamChunk } from "../agent-host.js";
import {
	LlmAuthError,
	LlmContextTooLongError,
	LlmRateLimitError,
} from "../llm/errors.js";
import { GeminiProvider } from "../llm/gemini.js";
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

function make(fetchImpl: typeof fetch): GeminiProvider {
	return new GeminiProvider({
		apiKey: "g-test",
		model: "gemini-test",
		fetchImpl,
		timeoutMs: 1000,
	});
}

describe("GeminiProvider", () => {
	it("yields text from candidates.content.parts[].text", async () => {
		const body = [
			'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}]}',
			"",
			'data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"}}],"usageMetadata":{"totalTokenCount":9}}',
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
		expect(texts).toBe("Hello world");
		expect(chunks.find((c) => c.type === "usage")).toEqual({
			type: "usage",
			totalTokens: 9,
		});
	});

	it("captures a functionCall and emits tool_calls", async () => {
		const body = [
			'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"snapshot","args":{"interactive_only":true}}}],"role":"model"}}]}',
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
		const calls = chunks.find((c) => c.type === "tool_calls");
		expect(calls).toMatchObject({
			type: "tool_calls",
			calls: [{ name: "snapshot", args: { interactive_only: true } }],
		});
	});

	it("maps 403 (API key) to LlmAuthError", async () => {
		const provider = make(
			fakeFetch("API key not valid. PERMISSION_DENIED.", { status: 403 }),
		);
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmAuthError);
	});

	it("maps 429/quota to LlmRateLimitError", async () => {
		const provider = make(
			fakeFetch("RESOURCE_EXHAUSTED: quota exceeded", { status: 429 }),
		);
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmRateLimitError);
	});

	it("maps context-length errors to LlmContextTooLongError", async () => {
		const provider = make(
			fakeFetch("Input exceeds the maximum token limit for this model", {
				status: 400,
			}),
		);
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmContextTooLongError);
	});

	it("sends systemInstruction for system messages", async () => {
		let captured: unknown;
		const fetchImpl: typeof fetch = async (_url, init) => {
			captured = JSON.parse(String(init?.body ?? "{}"));
			return new Response(stringToByteStream(""), { status: 200 });
		};
		const provider = make(fetchImpl);
		await collect(
			provider.stream({
				messages: [
					{ role: "system", content: "you are X" },
					{ role: "user", content: "hi" },
				],
			}),
		);
		expect(captured).toMatchObject({
			systemInstruction: { parts: [{ text: "you are X" }] },
		});
	});

	it("maps inline error payload to rate-limit when quota", async () => {
		const body = [
			'data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}',
			"",
			"",
		].join("\n");
		const provider = make(fakeFetch(body));
		await expect(
			collect(provider.stream({ messages: [{ role: "user", content: "x" }] })),
		).rejects.toBeInstanceOf(LlmRateLimitError);
	});
});
