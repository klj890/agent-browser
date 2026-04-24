/**
 * OpenAI-compatible chat-completions streaming provider.
 *
 * Works with OpenRouter, DeepSeek, Qwen/DashScope (OpenAI-compat endpoint),
 * and any other service speaking `POST /chat/completions?stream=true`.
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

export interface OpenAiCompatOpts {
	name: string;
	baseUrl: string;
	/**
	 * Bearer token. Leave blank/undefined for local providers (Ollama,
	 * LM Studio) that expect an unauthenticated request — we skip the
	 * `Authorization` header entirely rather than sending `Bearer ` with
	 * an empty value, which some OpenAI-compat servers reject with 401.
	 */
	apiKey?: string;
	model: string;
	timeoutMs?: number;
	/**
	 * Optional override for `fetch`. Allows tests to inject a fake response
	 * without hitting the network.
	 */
	fetchImpl?: typeof fetch;
	/** Extra headers (e.g. OpenRouter's HTTP-Referer / X-Title). */
	headers?: Record<string, string>;
}

interface OpenAiToolCallDelta {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

interface OpenAiStreamDelta {
	content?: string | null;
	tool_calls?: OpenAiToolCallDelta[];
}

interface OpenAiStreamChoice {
	delta?: OpenAiStreamDelta;
	finish_reason?: string | null;
}

interface OpenAiStreamChunk {
	choices?: OpenAiStreamChoice[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
	error?: { message?: string; type?: string; code?: string };
}

export class OpenAiCompatProvider implements LlmProvider {
	readonly name: string;
	private readonly baseUrl: string;
	private readonly apiKey: string | undefined;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly headers: Record<string, string>;

	constructor(opts: OpenAiCompatOpts) {
		this.name = opts.name;
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
		// Empty string normalises to undefined so the header-omit branch
		// triggers for both `apiKey: ""` and `apiKey: undefined` callers.
		this.apiKey = opts.apiKey || undefined;
		this.model = opts.model;
		this.timeoutMs = opts.timeoutMs ?? 60_000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.headers = opts.headers ?? {};
	}

	async *stream(
		request: LlmRequest,
		signal?: AbortSignal,
	): AsyncIterable<LlmStreamChunk> {
		const body = {
			model: this.model,
			stream: true,
			messages: request.messages.map(toOpenAiMessage),
			...(request.tools && request.tools.length > 0
				? {
						tools: request.tools.map((t) => ({
							type: "function",
							function: {
								name: t.name,
								description: t.description,
								parameters: {
									type: "object",
									additionalProperties: true,
								},
							},
						})),
					}
				: {}),
			...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
		};

		const timeoutCtrl = new AbortController();
		const timer = setTimeout(() => timeoutCtrl.abort(), this.timeoutMs);
		const mergedSignal = mergeSignals(signal, timeoutCtrl.signal);

		let res: Response;
		try {
			// Omit `Authorization` entirely when no apiKey is configured —
			// local servers (Ollama / LM Studio) return 401 on `Bearer `
			// with an empty value rather than treating it as anonymous.
			const requestHeaders: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...this.headers,
			};
			if (this.apiKey) {
				requestHeaders.Authorization = `Bearer ${this.apiKey}`;
			}
			res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: requestHeaders,
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

		// Track per-index tool calls as they stream in.
		const calls = new Map<number, MutableToolCall>();
		let totalTokens: number | undefined;

		try {
			for await (const evt of parseSseStream(res.body, mergedSignal)) {
				if (evt.data === "[DONE]") break;
				let parsed: OpenAiStreamChunk;
				try {
					parsed = JSON.parse(evt.data) as OpenAiStreamChunk;
				} catch {
					// Non-JSON frames (e.g. ping) are ignored.
					continue;
				}

				if (parsed.error) {
					throw classifyHttpError(
						this.name,
						0,
						parsed.error.message ?? "provider error",
					);
				}

				const choice = parsed.choices?.[0];
				const delta = choice?.delta;
				if (delta?.content) {
					yield { type: "text", delta: delta.content };
				}
				if (delta?.tool_calls) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						let mut = calls.get(idx);
						if (!mut) {
							mut = {
								id: tc.id ?? `call_${idx}`,
								name: tc.function?.name ?? "",
								argsJson: "",
							};
							calls.set(idx, mut);
						}
						if (tc.id) mut.id = tc.id;
						if (tc.function?.name) mut.name = tc.function.name;
						if (tc.function?.arguments) {
							mut.argsJson += tc.function.arguments;
						}
					}
				}
				if (parsed.usage?.total_tokens != null) {
					totalTokens = parsed.usage.total_tokens;
				}
			}
		} finally {
			clearTimeout(timer);
		}

		if (calls.size > 0) {
			const final: ToolCall[] = [];
			// Emit in index order.
			for (const idx of [...calls.keys()].sort((a, b) => a - b)) {
				const mut = calls.get(idx);
				if (!mut) continue;
				let args: Record<string, unknown> = {};
				if (mut.argsJson.trim().length > 0) {
					try {
						args = JSON.parse(mut.argsJson) as Record<string, unknown>;
					} catch {
						// Malformed args — forward as a string payload so the
						// agent can see the problem instead of silently losing it.
						args = { _raw: mut.argsJson };
					}
				}
				final.push({ id: mut.id, name: mut.name, args });
			}
			yield { type: "tool_calls", calls: final };
		}

		if (totalTokens != null) {
			yield { type: "usage", totalTokens };
		}
	}
}

interface MutableToolCall {
	id: string;
	name: string;
	argsJson: string;
}

function toOpenAiMessage(m: {
	role: string;
	content: string;
	tool_call_id?: string;
	tool_calls?: ToolCall[];
}): Record<string, unknown> {
	if (m.role === "tool") {
		return {
			role: "tool",
			tool_call_id: m.tool_call_id,
			content: m.content,
		};
	}
	if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
		return {
			role: "assistant",
			content: m.content,
			tool_calls: m.tool_calls.map((tc) => ({
				id: tc.id,
				type: "function",
				function: {
					name: tc.name,
					arguments: JSON.stringify(tc.args ?? {}),
				},
			})),
		};
	}
	return { role: m.role, content: m.content };
}

function classifyHttpError(
	provider: string,
	status: number,
	body: string,
): LlmProviderError {
	const lower = body.toLowerCase();
	if (status === 401 || status === 403) {
		return new LlmAuthError(provider, body || `http ${status}`);
	}
	if (
		status === 429 ||
		lower.includes("rate_limit") ||
		lower.includes("rate limit")
	) {
		return new LlmRateLimitError(provider, body || `http ${status}`);
	}
	if (
		lower.includes("context_length") ||
		lower.includes("context length") ||
		lower.includes("maximum context") ||
		lower.includes("too long") ||
		lower.includes("token limit")
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
