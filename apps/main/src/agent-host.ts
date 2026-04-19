/**
 * AgentHost (Stage 3.1 + 附录 L) — orchestrates the LLM stream ↔ tool loop.
 *
 * This is a self-contained facade: CogniRefract's `createRefractionAgent` is
 * NOT yet installed in this repo, and its API is in flux. We preserve every
 * hook name from 附录 L (`pre-llm-call` / `post-llm-call` / `pre-tool-call` /
 * `post-tool-call`) and the overall control flow (budget + redaction + abort)
 * so Stage 6/7 can register hooks directly and a future swap to the upstream
 * agent is mechanical.
 *
 * Streaming protocol (`StreamChunk`):
 *   - { type: 'text', delta: string }          — assistant text increment
 *   - { type: 'tool_call', id, name, args }    — LLM requested a tool call
 *   - { type: 'tool_result', id, name, result, denied?, error? }
 *   - { type: 'error', message, reason }
 *   - { type: 'done', reason: 'completed' | 'killed' | 'budget_exceeded' | 'failed' }
 *
 * `streamFn` is pluggable: the default production implementation (future) will
 * call a real LLM; today we ship a `mockEchoStream` that's enough to wire
 * e2e without API keys.
 */

import type { Skill } from "@agent-browser/browser-tools";
import { nanoid } from "nanoid";
import type { AdminPolicy } from "./admin-policy.js";
import { checkCostBudget } from "./admin-policy.js";
import type { SensitiveWordFilter } from "./redaction-pipeline.js";
import { resolveArgs, type VaultLookup } from "./vault-resolver.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
	role: Role;
	content: string;
	/** Set on tool-result messages. */
	tool_call_id?: string;
	/** Set on assistant tool-call messages — echoes the call for history. */
	tool_calls?: ToolCall[];
}

export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export type StreamChunk =
	| { type: "text"; delta: string }
	| {
			type: "tool_call";
			id: string;
			name: string;
			args: Record<string, unknown>;
	  }
	| {
			type: "tool_result";
			id: string;
			name: string;
			result?: unknown;
			denied?: boolean;
			error?: string;
	  }
	| { type: "error"; message: string; reason: TaskEndReason }
	| { type: "done"; reason: TaskEndReason };

export type TaskEndReason =
	| "completed"
	| "killed"
	| "budget_exceeded"
	| "failed";

/**
 * Incremental chunks the LLM streamFn yields. `tool_calls` appears at the end
 * of a turn (i.e. after all text deltas). `usage` is optional per-turn.
 */
export type LlmStreamChunk =
	| { type: "text"; delta: string }
	| { type: "tool_calls"; calls: ToolCall[] }
	| { type: "usage"; totalTokens: number; usd?: number };

export interface StreamFnInput {
	messages: ChatMessage[];
	tools: Array<{ name: string; description: string }>;
	signal?: AbortSignal;
}

export type StreamFn = (input: StreamFnInput) => AsyncIterable<LlmStreamChunk>;

// ---- hooks ----

export type HookName =
	| "pre-llm-call"
	| "post-llm-call"
	| "pre-tool-call"
	| "post-tool-call";

export interface PreLlmCallCtx {
	messages: ChatMessage[];
	step: number;
	task: TaskState;
}

export interface PostLlmCallCtx {
	step: number;
	task: TaskState;
	usage?: { totalTokens: number; usd?: number };
	text: string;
	toolCalls: ToolCall[];
}

export interface PreToolCallCtx {
	call: ToolCall;
	task: TaskState;
	/**
	 * Mutate `call.args` to rewrite arguments (e.g. vault placeholder resolve).
	 * Throw `ToolDenied` to block the call (LLM will receive a denial result).
	 */
}

export interface PostToolCallCtx {
	call: ToolCall;
	task: TaskState;
	result: unknown;
}

export interface PostToolCallResult {
	/** If set, REPLACES the tool result that is handed back to the LLM. */
	result?: unknown;
}

export type Hook<TCtx, TRet = void> = (
	ctx: TCtx,
) => TRet | Promise<TRet> | void | Promise<void>;

export interface HookMap {
	"pre-llm-call": Hook<PreLlmCallCtx>;
	"post-llm-call": Hook<PostLlmCallCtx>;
	"pre-tool-call": Hook<PreToolCallCtx>;
	"post-tool-call": Hook<PostToolCallCtx, PostToolCallResult | undefined>;
}

// ---- errors ----

export class ToolDenied extends Error {
	constructor(public readonly reason = "denied") {
		super(`tool call denied: ${reason}`);
		this.name = "ToolDenied";
	}
}

export class BudgetExceededError extends Error {
	constructor(public readonly reason: string) {
		super(`budget exceeded: ${reason}`);
		this.name = "BudgetExceededError";
	}
}

export class ToolResultTooLargeError extends Error {
	constructor(public readonly byteSize: number) {
		super(`tool result too large: ${byteSize} bytes`);
		this.name = "ToolResultTooLargeError";
	}
}

// ---- task state ----

export interface TaskState {
	id: string;
	steps: number;
	totalTokens: number;
	totalUsd: number;
	status: TaskEndReason | "running";
}

// ---------------------------------------------------------------------------
// AgentHost
// ---------------------------------------------------------------------------

export interface AgentHostOpts {
	systemPrompt: string;
	skills: Skill[];
	streamFn: StreamFn;
	policy: AdminPolicy;
	redaction: SensitiveWordFilter;
	hooks?: Partial<{
		[K in HookName]: Array<HookMap[K]>;
	}>;
	/**
	 * Optional vault used to resolve `{{vault:<key>}}` placeholders in tool-call
	 * string args before dispatch. Resolution happens right after `pre-tool-call`
	 * hooks so the LLM never sees the secret.
	 */
	vault?: VaultLookup;
}

/**
 * Core agent runtime. One instance per (tab, task) is fine — it keeps a
 * conversation list internally.
 */
export class AgentHost {
	private readonly systemPrompt: string;
	private readonly skillMap: Map<string, Skill>;
	private readonly skills: Skill[];
	private readonly streamFn: StreamFn;
	private readonly policy: AdminPolicy;
	private readonly redaction: SensitiveWordFilter;
	private readonly vault?: VaultLookup;
	private readonly hooks: {
		[K in HookName]: Array<HookMap[K]>;
	};

	private readonly messages: ChatMessage[];
	private currentAbort?: AbortController;

	constructor(opts: AgentHostOpts) {
		this.systemPrompt = opts.systemPrompt;
		this.skills = opts.skills;
		this.skillMap = new Map(opts.skills.map((s) => [s.name, s]));
		this.streamFn = opts.streamFn;
		this.policy = opts.policy;
		this.redaction = opts.redaction;
		this.vault = opts.vault;
		this.hooks = {
			"pre-llm-call": [...(opts.hooks?.["pre-llm-call"] ?? [])],
			"post-llm-call": [...(opts.hooks?.["post-llm-call"] ?? [])],
			"pre-tool-call": [...(opts.hooks?.["pre-tool-call"] ?? [])],
			"post-tool-call": [...(opts.hooks?.["post-tool-call"] ?? [])],
		};
		this.messages = [{ role: "system", content: this.systemPrompt }];
	}

	/**
	 * Register a hook and return an `off()` to remove it.
	 */
	registerHook<K extends HookName>(name: K, hook: HookMap[K]): () => void {
		this.hooks[name].push(hook);
		return () => {
			const arr = this.hooks[name];
			const idx = arr.indexOf(hook);
			if (idx >= 0) arr.splice(idx, 1);
		};
	}

	cancel(): void {
		this.currentAbort?.abort();
	}

	/**
	 * Run one user turn. Yields StreamChunks. On normal completion emits a
	 * `done` chunk; on abort/budget/error emits an `error` + `done` pair.
	 */
	async *run(
		userPrompt: string,
		externalSignal?: AbortSignal,
	): AsyncIterable<StreamChunk> {
		const controller = new AbortController();
		this.currentAbort = controller;
		if (externalSignal) {
			if (externalSignal.aborted) controller.abort();
			else externalSignal.addEventListener("abort", () => controller.abort());
		}

		// Redact outbound user content.
		const safePrompt = this.redaction.filter(userPrompt);
		this.messages.push({ role: "user", content: safePrompt });

		const task: TaskState = {
			id: nanoid(),
			steps: 0,
			totalTokens: 0,
			totalUsd: 0,
			status: "running",
		};
		const maxSteps = this.policy.costGuard.maxStepsPerTask;

		try {
			// LLM ↔ tool loop. Each iteration is one LLM turn.
			for (;;) {
				if (controller.signal.aborted) throw new AbortError();
				task.steps += 1;

				// Budget check BEFORE the call (spec: guardBudget in pre-llm-call).
				const budget = checkCostBudget(
					{
						totalTokens: task.totalTokens,
						totalUsd: task.totalUsd,
						steps: task.steps,
					},
					this.policy,
				);
				if (!budget.ok) {
					throw new BudgetExceededError(budget.reason ?? "unknown");
				}
				if (task.steps > maxSteps) {
					throw new BudgetExceededError("steps");
				}

				await this.runHooks("pre-llm-call", {
					messages: this.messages,
					step: task.steps,
					task,
				});

				let accumulatedText = "";
				let toolCalls: ToolCall[] = [];
				let usage: { totalTokens: number; usd?: number } | undefined;

				const iter = this.streamFn({
					messages: this.messages,
					tools: this.skills.map((s) => ({
						name: s.name,
						description: s.description,
					})),
					signal: controller.signal,
				});
				for await (const chunk of iter) {
					if (controller.signal.aborted) throw new AbortError();
					if (chunk.type === "text") {
						accumulatedText += chunk.delta;
						yield { type: "text", delta: chunk.delta };
					} else if (chunk.type === "tool_calls") {
						toolCalls = chunk.calls;
					} else if (chunk.type === "usage") {
						usage = { totalTokens: chunk.totalTokens, usd: chunk.usd };
					}
				}

				if (usage) {
					task.totalTokens += usage.totalTokens;
					if (typeof usage.usd === "number") task.totalUsd += usage.usd;
				}

				// Record assistant turn.
				this.messages.push({
					role: "assistant",
					content: accumulatedText,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				});

				await this.runHooks("post-llm-call", {
					step: task.steps,
					task,
					usage,
					text: accumulatedText,
					toolCalls,
				});

				if (toolCalls.length === 0) {
					task.status = "completed";
					yield { type: "done", reason: "completed" };
					return;
				}

				// Execute each tool call.
				for (const call of toolCalls) {
					if (controller.signal.aborted) throw new AbortError();
					const outcome = await this.executeToolCall(call, task);
					yield {
						type: "tool_call",
						id: call.id,
						name: call.name,
						args: call.args,
					};
					yield {
						type: "tool_result",
						id: call.id,
						name: call.name,
						...outcome,
					};
					this.messages.push({
						role: "tool",
						tool_call_id: call.id,
						content: serializeToolResult(outcome),
					});
				}
				// Loop back for next LLM turn with tool results in history.
			}
		} catch (err) {
			const reason = classifyError(err);
			const msg = err instanceof Error ? err.message : String(err);
			task.status = reason;
			yield { type: "error", message: msg, reason };
			yield { type: "done", reason };
		} finally {
			this.currentAbort = undefined;
		}
	}

	// ----- internals -----

	private async runHooks<K extends HookName>(
		name: K,
		ctx: Parameters<HookMap[K]>[0],
	): Promise<void> {
		for (const h of this.hooks[name]) {
			// biome-ignore lint/suspicious/noExplicitAny: hook variance is handled by HookMap
			await (h as any)(ctx);
		}
	}

	private async runPostToolHooks(ctx: PostToolCallCtx): Promise<unknown> {
		let current = ctx.result;
		for (const h of this.hooks["post-tool-call"]) {
			const ret = await h({ ...ctx, result: current });
			if (ret && typeof ret === "object" && "result" in ret) {
				current = ret.result;
			}
		}
		return current;
	}

	private async executeToolCall(
		call: ToolCall,
		task: TaskState,
	): Promise<{
		result?: unknown;
		denied?: boolean;
		error?: string;
	}> {
		try {
			await this.runHooks("pre-tool-call", { call, task });
		} catch (err) {
			if (err instanceof ToolDenied) {
				return { denied: true, error: err.reason };
			}
			throw err;
		}

		// Resolve `{{vault:*}}` placeholders in string args (P1 Stage 9). Done
		// after pre-tool-call hooks and BEFORE tool execution so secrets never
		// appear in the audit log's args_hash (hooks see the raw template) nor
		// in any LLM-visible context.
		if (this.vault) {
			try {
				call.args = await resolveArgs(call.args, this.vault);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { error: msg };
			}
		}

		const skill = this.skillMap.get(call.name);
		if (!skill) {
			return { error: `unknown tool: ${call.name}` };
		}
		// Policy whitelist check (skills may have been pre-filtered, but be safe).
		if (!this.policy.allowedTools.includes(call.name)) {
			return { denied: true, error: "tool not in allowlist" };
		}

		let raw: unknown;
		try {
			const parsed = skill.inputSchema.parse(call.args);
			raw = await skill.execute(parsed);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { error: msg };
		}

		let finalResult: unknown;
		try {
			finalResult = await this.runPostToolHooks({ call, task, result: raw });
		} catch (err) {
			if (err instanceof ToolResultTooLargeError) {
				return { error: err.message };
			}
			throw err;
		}
		return { result: finalResult };
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class AbortError extends Error {
	constructor() {
		super("aborted");
		this.name = "AbortError";
	}
}

function classifyError(err: unknown): TaskEndReason {
	if (err instanceof AbortError) return "killed";
	if (err instanceof BudgetExceededError) return "budget_exceeded";
	return "failed";
}

function serializeToolResult(outcome: {
	result?: unknown;
	denied?: boolean;
	error?: string;
}): string {
	if (outcome.denied)
		return JSON.stringify({ denied: true, error: outcome.error });
	if (outcome.error) return JSON.stringify({ error: outcome.error });
	try {
		return JSON.stringify(outcome.result);
	} catch {
		return String(outcome.result);
	}
}

// ---------------------------------------------------------------------------
// Built-in mock streamFn (Stage 3 ships without a real LLM)
// ---------------------------------------------------------------------------

/**
 * A trivial deterministic stream used for dev + tests:
 *   - Emits a single assistant text message echoing the last user prompt.
 *   - If the user message contains the literal word `snapshot` AND a `snapshot`
 *     tool is available, emits a tool_call on the FIRST turn, and finishes on
 *     the subsequent turn with a text summary.
 *
 * This is intentionally minimal — NOT a production path.
 */
export function mockEchoStream(): StreamFn {
	return async function* stream(
		input: StreamFnInput,
	): AsyncIterable<LlmStreamChunk> {
		const lastUser = [...input.messages]
			.reverse()
			.find((m) => m.role === "user");
		const lastTool = [...input.messages]
			.reverse()
			.find((m) => m.role === "tool");
		const userText = lastUser?.content ?? "";
		const hasSnapshotTool = input.tools.some((t) => t.name === "snapshot");

		// If the last event in history was a tool result, we're on turn 2+:
		// just summarize and stop.
		if (lastTool) {
			yield { type: "text", delta: "Here is what I found on the page." };
			yield { type: "usage", totalTokens: 20 };
			return;
		}

		if (hasSnapshotTool && /\bsnapshot\b/i.test(userText)) {
			yield { type: "text", delta: "Taking a snapshot of the page..." };
			yield {
				type: "tool_calls",
				calls: [
					{
						id: `call_${Math.random().toString(36).slice(2, 10)}`,
						name: "snapshot",
						args: { interactive_only: true },
					},
				],
			};
			yield { type: "usage", totalTokens: 15 };
			return;
		}

		yield { type: "text", delta: `echo: ${userText}` };
		yield { type: "usage", totalTokens: 10 };
	};
}
