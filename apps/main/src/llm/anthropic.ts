/**
 * Anthropic Messages streaming provider.
 *
 * API reference: https://docs.anthropic.com/en/api/messages-streaming
 *
 * Event types we handle:
 *   - `message_start` — ignored, just signals turn start.
 *   - `content_block_start` — `content_block.type` is `text` or `tool_use`;
 *     for `tool_use` we capture the id + name, and start accumulating args.
 *   - `content_block_delta` — `delta.type` is `text_delta` (yield text) or
 *     `input_json_delta` (append to the current tool call's arg JSON).
 *   - `content_block_stop` — ignored (we flush at message_stop).
 *   - `message_delta` — `usage.output_tokens` update.
 *   - `message_stop` — flush tool_calls and usage.
 *   - `error` — classify and throw.
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

export interface AnthropicOpts {
	name?: string;
	apiKey: string;
	model: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	baseUrl?: string;
	anthropicVersion?: string;
}

interface AnthropicContentBlock {
	type: string;
	id?: string;
	name?: string;
	text?: string;
}

interface AnthropicEventPayload {
	type: string;
	index?: number;
	content_block?: AnthropicContentBlock;
	delta?: {
		type?: string;
		text?: string;
		partial_json?: string;
		stop_reason?: string;
	};
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
	message?: {
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	error?: { type?: string; message?: string };
}

export class AnthropicProvider implements LlmProvider {
	readonly name: string;
	private readonly apiKey: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;
	private readonly anthropicVersion: string;

	constructor(opts: AnthropicOpts) {
		this.name = opts.name ?? "anthropic";
		this.apiKey = opts.apiKey;
		this.model = opts.model;
		this.timeoutMs = opts.timeoutMs ?? 60_000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(
			/\/+$/,
			"",
		);
		this.anthropicVersion = opts.anthropicVersion ?? "2023-06-01";
	}

	async *stream(
		request: LlmRequest,
		signal?: AbortSignal,
	): AsyncIterable<LlmStreamChunk> {
		const { system, messages } = toAnthropicMessages(request.messages);

		const body: Record<string, unknown> = {
			model: this.model,
			messages,
			stream: true,
			max_tokens: request.maxTokens ?? 4096,
		};
		if (system) body.system = system;
		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: {
					type: "object",
					additionalProperties: true,
				},
			}));
		}

		const timeoutCtrl = new AbortController();
		const timer = setTimeout(() => timeoutCtrl.abort(), this.timeoutMs);
		const mergedSignal = mergeSignals(signal, timeoutCtrl.signal);

		let res: Response;
		try {
			res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.apiKey,
					"anthropic-version": this.anthropicVersion,
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

		const blocks = new Map<number, MutableBlock>();
		let totalTokens: number | undefined;
		let inputTokens = 0;
		let outputTokens = 0;

		try {
			for await (const evt of parseSseStream(res.body, mergedSignal)) {
				if (!evt.data) continue;
				let parsed: AnthropicEventPayload;
				try {
					parsed = JSON.parse(evt.data) as AnthropicEventPayload;
				} catch {
					continue;
				}
				const kind = evt.event ?? parsed.type;
				if (parsed.error || kind === "error") {
					const msg =
						parsed.error?.message ??
						`anthropic error: ${parsed.error?.type ?? "unknown"}`;
					throw classifyHttpError(this.name, 0, msg);
				}

				if (kind === "message_start") {
					const u = parsed.message?.usage;
					if (u?.input_tokens != null) inputTokens = u.input_tokens;
					continue;
				}
				if (kind === "content_block_start") {
					const idx = parsed.index ?? 0;
					const cb = parsed.content_block;
					if (cb?.type === "tool_use") {
						blocks.set(idx, {
							kind: "tool_use",
							id: cb.id ?? `call_${idx}`,
							name: cb.name ?? "",
							argsJson: "",
						});
					} else if (cb?.type === "text") {
						blocks.set(idx, { kind: "text" });
						if (cb.text) {
							yield { type: "text", delta: cb.text };
						}
					}
					continue;
				}
				if (kind === "content_block_delta") {
					const idx = parsed.index ?? 0;
					const d = parsed.delta;
					if (!d) continue;
					if (d.type === "text_delta" && d.text) {
						yield { type: "text", delta: d.text };
					} else if (d.type === "input_json_delta" && d.partial_json) {
						const mut = blocks.get(idx);
						if (mut && mut.kind === "tool_use") {
							mut.argsJson += d.partial_json;
						}
					}
					continue;
				}
				if (kind === "message_delta") {
					if (parsed.usage?.output_tokens != null) {
						outputTokens = parsed.usage.output_tokens;
					}
					continue;
				}
				if (kind === "message_stop") {
					break;
				}
			}
		} finally {
			clearTimeout(timer);
		}

		totalTokens = inputTokens + outputTokens || undefined;

		const finalCalls: ToolCall[] = [];
		for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
			const b = blocks.get(idx);
			if (!b || b.kind !== "tool_use") continue;
			let args: Record<string, unknown> = {};
			if (b.argsJson.trim().length > 0) {
				try {
					args = JSON.parse(b.argsJson) as Record<string, unknown>;
				} catch {
					args = { _raw: b.argsJson };
				}
			}
			finalCalls.push({ id: b.id, name: b.name, args });
		}
		if (finalCalls.length > 0) {
			yield { type: "tool_calls", calls: finalCalls };
		}
		if (totalTokens != null) {
			yield { type: "usage", totalTokens };
		}
	}
}

type MutableBlock =
	| { kind: "text" }
	| { kind: "tool_use"; id: string; name: string; argsJson: string };

function toAnthropicMessages(
	msgs: Array<{
		role: string;
		content: string;
		tool_call_id?: string;
		tool_calls?: ToolCall[];
	}>,
): {
	system?: string;
	messages: Array<Record<string, unknown>>;
} {
	const systemParts: string[] = [];
	const out: Array<Record<string, unknown>> = [];
	for (const m of msgs) {
		if (m.role === "system") {
			systemParts.push(m.content);
			continue;
		}
		if (m.role === "tool") {
			// Anthropic expects tool results inside a user message as a
			// `tool_result` content block.
			out.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: m.tool_call_id ?? "",
						content: m.content,
					},
				],
			});
			continue;
		}
		if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
			const content: Array<Record<string, unknown>> = [];
			if (m.content) {
				content.push({ type: "text", text: m.content });
			}
			for (const tc of m.tool_calls) {
				content.push({
					type: "tool_use",
					id: tc.id,
					name: tc.name,
					input: tc.args ?? {},
				});
			}
			out.push({ role: "assistant", content });
			continue;
		}
		out.push({ role: m.role, content: m.content });
	}
	return {
		system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
		messages: out,
	};
}

function classifyHttpError(
	provider: string,
	status: number,
	body: string,
): LlmProviderError {
	const lower = body.toLowerCase();
	if (status === 401 || status === 403 || lower.includes("authentication")) {
		return new LlmAuthError(provider, body || `http ${status}`);
	}
	if (
		status === 429 ||
		lower.includes("rate_limit") ||
		lower.includes("rate limit") ||
		lower.includes("overloaded")
	) {
		return new LlmRateLimitError(provider, body || `http ${status}`);
	}
	if (
		lower.includes("context_length") ||
		lower.includes("context length") ||
		lower.includes("too long") ||
		lower.includes("maximum context") ||
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
