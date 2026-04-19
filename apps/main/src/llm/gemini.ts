/**
 * Google Gemini streaming provider.
 *
 * Uses the `streamGenerateContent?alt=sse` endpoint which emits `data:`
 * frames of `GenerateContentResponse` JSON. Each frame has
 * `candidates[0].content.parts[]` where `parts` may contain either `text` or
 * `functionCall: { name, args }`.
 *
 * Text deltas accumulate. Function calls appear as a single part (not
 * streamed partial-JSON like Anthropic), so we collect them and emit once.
 */

import type { ToolCall } from "../agent-host.js";
import {
	LlmAuthError,
	LlmContextTooLongError,
	LlmProviderError,
	LlmRateLimitError,
} from "./errors.js";
import { parseSseStream } from "./sse.js";
import type { LlmProvider, LlmRequest, LlmStreamChunk } from "./types.js";

export interface GeminiOpts {
	name?: string;
	apiKey: string;
	model: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	baseUrl?: string;
}

interface GeminiPart {
	text?: string;
	functionCall?: {
		name: string;
		args?: Record<string, unknown>;
	};
}

interface GeminiCandidate {
	content?: { parts?: GeminiPart[]; role?: string };
	finishReason?: string;
}

interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
}

interface GeminiResponse {
	candidates?: GeminiCandidate[];
	usageMetadata?: GeminiUsageMetadata;
	error?: { code?: number; message?: string; status?: string };
}

export class GeminiProvider implements LlmProvider {
	readonly name: string;
	private readonly apiKey: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;

	constructor(opts: GeminiOpts) {
		this.name = opts.name ?? "gemini";
		this.apiKey = opts.apiKey;
		this.model = opts.model;
		this.timeoutMs = opts.timeoutMs ?? 60_000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.baseUrl = (
			opts.baseUrl ?? "https://generativelanguage.googleapis.com"
		).replace(/\/+$/, "");
	}

	async *stream(
		request: LlmRequest,
		signal?: AbortSignal,
	): AsyncIterable<LlmStreamChunk> {
		const { systemInstruction, contents } = toGeminiContents(request.messages);

		const body: Record<string, unknown> = { contents };
		if (systemInstruction) {
			body.systemInstruction = { parts: [{ text: systemInstruction }] };
		}
		if (request.tools && request.tools.length > 0) {
			body.tools = [
				{
					functionDeclarations: request.tools.map((t) => ({
						name: t.name,
						description: t.description,
						parameters: {
							type: "object",
							properties: {},
						},
					})),
				},
			];
		}
		if (request.maxTokens != null) {
			body.generationConfig = { maxOutputTokens: request.maxTokens };
		}

		const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;

		const timeoutCtrl = new AbortController();
		const timer = setTimeout(() => timeoutCtrl.abort(), this.timeoutMs);
		const mergedSignal = mergeSignals(signal, timeoutCtrl.signal);

		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify(body),
				signal: mergedSignal,
			});
		} catch (err) {
			clearTimeout(timer);
			throw new LlmProviderError(
				this.name,
				`fetch failed: ${errMessage(err)}`,
				err,
			);
		}

		if (!res.ok) {
			clearTimeout(timer);
			const text = await safeReadText(res);
			throw classifyHttpError(this.name, res.status, text);
		}
		if (!res.body) {
			clearTimeout(timer);
			throw new LlmProviderError(this.name, "response has no body");
		}

		const toolCalls: ToolCall[] = [];
		let totalTokens: number | undefined;
		let callCounter = 0;

		try {
			for await (const evt of parseSseStream(res.body, mergedSignal)) {
				if (!evt.data) continue;
				let parsed: GeminiResponse;
				try {
					parsed = JSON.parse(evt.data) as GeminiResponse;
				} catch {
					continue;
				}
				if (parsed.error) {
					throw classifyHttpError(
						this.name,
						parsed.error.code ?? 0,
						parsed.error.message ?? "gemini error",
					);
				}
				const cand = parsed.candidates?.[0];
				const parts = cand?.content?.parts ?? [];
				for (const p of parts) {
					if (typeof p.text === "string" && p.text.length > 0) {
						yield { type: "text", delta: p.text };
					}
					if (p.functionCall) {
						callCounter += 1;
						toolCalls.push({
							id: `call_${callCounter}`,
							name: p.functionCall.name,
							args: p.functionCall.args ?? {},
						});
					}
				}
				if (parsed.usageMetadata?.totalTokenCount != null) {
					totalTokens = parsed.usageMetadata.totalTokenCount;
				}
			}
		} finally {
			clearTimeout(timer);
		}

		if (toolCalls.length > 0) {
			yield { type: "tool_calls", calls: toolCalls };
		}
		if (totalTokens != null) {
			yield { type: "usage", totalTokens };
		}
	}
}

function toGeminiContents(
	msgs: Array<{
		role: string;
		content: string;
		tool_call_id?: string;
		tool_calls?: ToolCall[];
	}>,
): {
	systemInstruction?: string;
	contents: Array<Record<string, unknown>>;
} {
	const systemParts: string[] = [];
	const contents: Array<Record<string, unknown>> = [];
	// Track tool_call_id -> name so we can emit functionResponse with the
	// right name (Gemini requires it).
	const callNameById = new Map<string, string>();

	for (const m of msgs) {
		if (m.role === "system") {
			systemParts.push(m.content);
			continue;
		}
		if (m.role === "tool") {
			const name = callNameById.get(m.tool_call_id ?? "") ?? "unknown";
			contents.push({
				role: "user",
				parts: [
					{
						functionResponse: {
							name,
							response: safeParseJson(m.content),
						},
					},
				],
			});
			continue;
		}
		if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
			const parts: Array<Record<string, unknown>> = [];
			if (m.content) parts.push({ text: m.content });
			for (const tc of m.tool_calls) {
				parts.push({
					functionCall: { name: tc.name, args: tc.args ?? {} },
				});
				callNameById.set(tc.id, tc.name);
			}
			contents.push({ role: "model", parts });
			continue;
		}
		contents.push({
			role: m.role === "assistant" ? "model" : "user",
			parts: [{ text: m.content }],
		});
	}
	return {
		systemInstruction:
			systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
		contents,
	};
}

function safeParseJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return { raw: s };
	}
}

function classifyHttpError(
	provider: string,
	status: number,
	body: string,
): LlmProviderError {
	const lower = body.toLowerCase();
	if (
		status === 401 ||
		status === 403 ||
		lower.includes("api key") ||
		lower.includes("permission_denied")
	) {
		return new LlmAuthError(provider, body || `http ${status}`);
	}
	if (
		status === 429 ||
		lower.includes("rate_limit") ||
		lower.includes("rate limit") ||
		lower.includes("resource_exhausted") ||
		lower.includes("quota")
	) {
		return new LlmRateLimitError(provider, body || `http ${status}`);
	}
	if (
		lower.includes("context length") ||
		lower.includes("too long") ||
		lower.includes("token limit") ||
		lower.includes("exceeds the maximum")
	) {
		return new LlmContextTooLongError(provider, body || `http ${status}`);
	}
	return new LlmProviderError(provider, body || `http ${status}`);
}

async function safeReadText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
	const defined = signals.filter((s): s is AbortSignal => s !== undefined);
	if (defined.length === 1) {
		const only = defined[0];
		if (only) return only;
	}
	const ctrl = new AbortController();
	for (const s of defined) {
		if (s.aborted) {
			ctrl.abort();
			break;
		}
		s.addEventListener("abort", () => ctrl.abort(), { once: true });
	}
	return ctrl.signal;
}
