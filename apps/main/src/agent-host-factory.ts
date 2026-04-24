/**
 * Factory that wires an AgentHost for a given tab.
 *
 * Responsibilities:
 *   - Resolve the tab's CDP adapter + RefRegistry from TabManager.
 *   - Build browser-tools skills bound to that tab context.
 *   - Filter skills by persona's allowedTools ∩ policy.allowedTools.
 *   - Apply policy-driven redaction pipeline to outbound messages.
 *   - Register default hooks:
 *       * vault placeholder resolver (TODO P1-9 — for now a no-op that logs).
 *       * tool-result size guard (>4KB → ToolResultTooLargeError; Stage 6.5
 *         will swap this for an actual tool-result-storage write).
 *
 * The factory is deliberately small — it's a dep-assembly function, not a
 * business logic home. Tests unit-test each collaborator separately.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BrowserToolsCtx,
	createBrowserToolsSkills,
	createTabsSkills,
	type Skill,
	type TabController,
	type TabInfo,
} from "@agent-browser/browser-tools";
import type { AdminPolicy } from "./admin-policy.js";
import {
	AgentHost,
	type HookMap,
	type StreamFn,
	ToolDenied,
	ToolResultTooLargeError,
} from "./agent-host.js";
import type { AuditLog } from "./audit-log.js";
import type { AuthVault } from "./auth-vault.js";
import type { ConfirmationHandler } from "./confirmation.js";
import { createDefaultStreamFn } from "./llm/factory.js";
import type { Persona, PersonaManager } from "./persona-manager.js";
import { renderTemplate } from "./prompts/render.js";
import {
	createRedactionPipelineFromPolicy,
	type SensitiveWordFilter,
} from "./redaction-pipeline.js";
import type { TabManager } from "./tab-manager.js";
import type { TaskStateStore } from "./task-state.js";
import {
	createReadResultSkill,
	type ToolResultStorage,
} from "./tool-result-storage.js";

export interface FactoryDeps {
	tabManager: TabManager;
	policy: AdminPolicy;
	personaManager: PersonaManager;
	/**
	 * Override for tests. Production default: `createDefaultStreamFn()` which
	 * reads env vars (GEMINI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY /
	 * DASHSCOPE_API_KEY) and builds a Gemini → Claude → DeepSeek → Qwen
	 * fallback chain; if no keys are set it falls back to `mockEchoStream()`.
	 */
	streamFn?: StreamFn;
	/** Path to the system prompt template; default: apps/main/src/prompts/system.md */
	systemPromptPath?: string;
	/** Optional Stage 6.4 integration: appends events through hooks. */
	auditLog?: AuditLog;
	/** Optional Stage 6.5 integration: spills large tool results to SQLite. */
	toolResultStorage?: ToolResultStorage;
	/** Optional Stage 7.3 integration: gates pre-tool-call through user confirmation. */
	confirmation?: ConfirmationHandler;
	/** Optional Stage 7.1 integration: creates and tracks a Task per run. */
	taskStore?: TaskStateStore;
	/** Optional P1 Stage 9 integration: resolves `{{vault:*}}` in tool args. */
	vault?: AuthVault;
}

export interface CreateAgentHostOpts {
	tabId: string;
	persona: Persona;
}

const DEFAULT_SYSTEM_PROMPT_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"system.md",
);

const MAX_TOOL_RESULT_BYTES = 4096;

export async function createAgentHostForTab(
	deps: FactoryDeps,
	opts: CreateAgentHostOpts,
): Promise<AgentHost> {
	const { tabManager, policy, streamFn } = deps;
	const { tabId, persona } = opts;

	// Smoke-check: the starting tab must have CDP wired. Subsequent tabs
	// (opened via tabs_open) allocate lazily on first tool use.
	if (!tabManager.getTabCdp(tabId) || !tabManager.getTabRegistry(tabId)) {
		throw new Error(`tab '${tabId}' has no CDP/registry (not yet loaded?)`);
	}

	// The Agent's "logical active tab" — decoupled from the user's foreground
	// tab so the Agent can background-research in a tab it opened without
	// disrupting the user. Multi-tab tools (tabs_switch) mutate this ref.
	const activeAgentTab = { id: tabId };
	// Use the O(1) TabManager.getSummary lookup here. list().find() was a
	// scan per getter access, noticeable when snapshot/act read pageUrl
	// multiple times inside a single execute().
	const findSummary = (id: string) => tabManager.getSummary(id);
	// Build a ctx whose cdp/registry/pageUrl/pageTitle resolve *per call* to
	// whichever tab the Agent currently has focused. Using getters keeps the
	// five original tools' execute() bodies unchanged.
	const ctx: BrowserToolsCtx = {
		get cdp() {
			const c = tabManager.getTabCdp(activeAgentTab.id);
			if (!c) {
				throw new Error(
					`agent active tab '${activeAgentTab.id}' has no CDP (tab closed?)`,
				);
			}
			return c;
		},
		get registry() {
			const r = tabManager.getTabRegistry(activeAgentTab.id);
			if (!r) {
				throw new Error(
					`agent active tab '${activeAgentTab.id}' has no registry (tab closed?)`,
				);
			}
			return r;
		},
		get pageUrl() {
			return findSummary(activeAgentTab.id)?.url;
		},
		get pageTitle() {
			return findSummary(activeAgentTab.id)?.title;
		},
	};
	const navigationPolicy = {
		allowedUrlSchemes: policy.allowedUrlSchemes,
		allowedDomains: policy.allowedDomains,
		blockedDomains: policy.blockedDomains,
	};
	const tabController = createTabControllerForAgent(tabManager, activeAgentTab);
	const allSkills = [
		...createBrowserToolsSkills(ctx),
		...createTabsSkills({
			controller: tabController,
			policy: navigationPolicy,
		}),
	];
	const skills = filterSkills(allSkills, policy, persona);

	const systemPrompt = await renderTemplate(
		deps.systemPromptPath ?? DEFAULT_SYSTEM_PROMPT_PATH,
		{
			persona_name: persona.name,
			persona_description: persona.description,
			autonomy: policy.autonomy,
			maxStepsPerTask: policy.costGuard.maxStepsPerTask,
			maxUsdPerTask: policy.costGuard.maxUsdPerTask,
		},
	);

	const redaction: SensitiveWordFilter =
		createRedactionPipelineFromPolicy(policy);
	const finalSystemPrompt = appendPersonaBody(systemPrompt, persona.contentMd);

	// If tool-result-storage is wired, add the meta-skill so the LLM can
	// rehydrate spilled results on demand. The typed meta-skill widens to
	// Skill<unknown, unknown> when handed to AgentHost, which treats skills
	// generically.
	const finalSkills: Skill[] = deps.toolResultStorage
		? [...skills, createReadResultSkill(deps.toolResultStorage) as Skill]
		: skills;

	const preToolHooks: Array<HookMap["pre-tool-call"]> = [];
	if (deps.confirmation) {
		preToolHooks.push(
			buildConfirmationHook(deps.confirmation, () => currentTabUrl()),
		);
	}

	const postToolHooks: Array<HookMap["post-tool-call"]> = [];
	if (deps.toolResultStorage) {
		postToolHooks.push(
			buildToolResultSpillHook(deps.toolResultStorage, () => currentTaskId()),
		);
	} else {
		postToolHooks.push(toolResultSizeHook);
	}

	let currentTaskIdRef: string | undefined;
	const currentTaskId = () => currentTaskIdRef ?? "unknown";
	// Resolve the URL of the Agent's *current* logical tab at call time, so
	// confirmation prompts correctly attribute the origin after tabs_switch
	// or in-tab navigation. Static capture would freeze it at construction.
	const currentTabUrl = () =>
		findSummary(activeAgentTab.id)?.url ?? "about:blank";

	const preLlmHooks: Array<HookMap["pre-llm-call"]> = [];
	const postLlmHooks: Array<HookMap["post-llm-call"]> = [];
	if (deps.auditLog) {
		const auditLog = deps.auditLog;
		preLlmHooks.push((ctx) => {
			currentTaskIdRef = ctx.task.id;
			void auditLog.append({
				event: "llm.call.pre",
				ts: Date.now(),
				task_id: ctx.task.id,
				model: "mock",
				provider: "mock",
				input_tokens_est: 0,
				redaction_hits: {},
				persona: persona.slug,
				autonomy: policy.autonomy,
			});
		});
		postLlmHooks.push((ctx) => {
			void auditLog.append({
				event: "llm.call.post",
				ts: Date.now(),
				task_id: ctx.task.id,
				model: "mock",
				input_tokens: 0,
				output_tokens: ctx.usage?.totalTokens ?? 0,
				usd_cost: ctx.usage?.usd ?? 0,
				finish_reason: "stop",
				duration_ms: 0,
			});
		});
		preToolHooks.push((ctx) => {
			void auditLog.append({
				event: "tool.call",
				ts: Date.now(),
				task_id: ctx.task.id,
				tool: ctx.call.name,
				args_hash: hashArgs(ctx.call.args),
				result_ref: "",
				byte_size: 0,
				high_risk_flags: [],
			});
		});
	}

	const host = new AgentHost({
		systemPrompt: finalSystemPrompt,
		skills: finalSkills,
		streamFn: streamFn ?? createDefaultStreamFn(),
		policy,
		redaction,
		hooks: {
			"pre-llm-call": preLlmHooks,
			"post-llm-call": postLlmHooks,
			"pre-tool-call": preToolHooks,
			"post-tool-call": postToolHooks,
		},
		vault: deps.vault,
	});

	return host;
}

function buildConfirmationHook(
	confirmation: ConfirmationHandler,
	getTabUrl: () => string,
): HookMap["pre-tool-call"] {
	return async (ctx) => {
		const decision = await confirmation.decide({
			tool: ctx.call.name,
			args: ctx.call.args,
			highRiskFlags: [], // browser-tools flagHighRisk runs inside act.execute; hook-level flags are empty until Stage 7.3 extends the context
			tabUrl: getTabUrl(),
		});
		if (decision !== "approved") {
			throw new ToolDenied(decision);
		}
	};
}

function buildToolResultSpillHook(
	storage: ToolResultStorage,
	getTaskId: () => string,
): HookMap["post-tool-call"] {
	return (ctx) => {
		const out = storage.put(getTaskId(), ctx.call.name, ctx.result);
		if (out.refId == null) return undefined;
		return {
			result: {
				ref_id: out.refId,
				summary: out.summary,
				byte_size: out.byteSize,
			},
		};
	};
}

function hashArgs(args: unknown): string {
	try {
		return String(JSON.stringify(args ?? null).length);
	} catch {
		return "0";
	}
}

/**
 * Build a TabController bound to a mutable "agent active tab" ref. The
 * controller enforces the P2-18 policy constraints (Agent can only close
 * tabs it opened; switching does not steal user foreground) before handing
 * off to TabManager.
 */
export function createTabControllerForAgent(
	tabManager: TabManager,
	activeAgentTab: { id: string },
): TabController {
	const toInfo = (
		t: ReturnType<TabManager["list"]>[number],
		agentActiveId: string,
	): TabInfo => ({
		id: t.id,
		url: t.url,
		title: t.title,
		openedByAgent: t.openedByAgent,
		agentActive: t.id === agentActiveId,
	});
	return {
		list() {
			const activeId = activeAgentTab.id;
			return tabManager.list().map((t) => toInfo(t, activeId));
		},
		open(url) {
			// url has already passed policy in the skill layer; TabManager will
			// flag openedByAgent so tabs_close can recognise ownership.
			return tabManager.create(url, {
				openedByAgent: true,
				background: true,
			});
		},
		close(id) {
			tabManager.close(id);
			// If we just closed the tab the Agent was logically "on", re-anchor
			// to a surviving tab so subsequent snapshot/act don't hit a dangling
			// CDP getter. Prefer another Agent-owned tab when possible (keeps the
			// Agent's working set coherent); otherwise fall back to any remaining
			// tab. Empty list is fine — next tool call will surface the error.
			if (activeAgentTab.id === id) {
				const remaining = tabManager.list();
				const fallback = remaining.find((t) => t.openedByAgent) ?? remaining[0];
				if (fallback) activeAgentTab.id = fallback.id;
			}
		},
		canClose(id) {
			const tab = tabManager.list().find((t) => t.id === id);
			return tab?.openedByAgent === true;
		},
		exists(id) {
			return tabManager.list().some((t) => t.id === id);
		},
		setAgentActive(id) {
			if (!tabManager.list().some((t) => t.id === id)) return;
			activeAgentTab.id = id;
		},
		getAgentActiveId() {
			return activeAgentTab.id;
		},
		waitLoad(id, timeoutMs, signal) {
			return new Promise((resolve) => {
				const start = Date.now();
				let handle: ReturnType<typeof setTimeout> | undefined;
				let settled = false;
				const settle = (r: Parameters<typeof resolve>[0]) => {
					if (settled) return;
					settled = true;
					if (handle) clearTimeout(handle);
					signal?.removeEventListener("abort", onAbort);
					resolve(r);
				};
				const onAbort = () => settle("aborted");
				if (signal) {
					if (signal.aborted) return settle("aborted");
					signal.addEventListener("abort", onAbort, { once: true });
				}
				const poll = () => {
					if (settled) return;
					const tab = tabManager.getSummary(id);
					// Tab vanished mid-poll (closed by user / crashed-and-cleaned):
					// surface a distinct "not_found" so the Agent can decide
					// whether to retry or give up, rather than conflate with timeout.
					if (!tab) return settle("not_found");
					if (tab.state === "idle") return settle("idle");
					if (tab.state === "crashed") return settle("crashed");
					if (Date.now() - start >= timeoutMs) return settle("timeout");
					handle = setTimeout(poll, 100);
				};
				poll();
			});
		},
	};
}

function filterSkills(
	all: Skill[],
	policy: AdminPolicy,
	persona: Persona,
): Skill[] {
	const policyAllowed = new Set(policy.allowedTools);
	const personaAllowed = persona.frontmatter.allowedTools
		? new Set(persona.frontmatter.allowedTools)
		: null;
	return all.filter((s) => {
		if (!policyAllowed.has(s.name)) return false;
		if (personaAllowed && !personaAllowed.has(s.name)) return false;
		return true;
	});
}

function appendPersonaBody(systemPrompt: string, body: string): string {
	if (!body || body.trim() === "") return systemPrompt;
	return `${systemPrompt}\n\n${body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Default hooks
// ---------------------------------------------------------------------------

/**
 * Enforce the 4KB soft limit from 附录 L. Stage 6.5 will replace this with an
 * actual tool-result-storage that returns `{ref_id, summary, byte_size}`.
 */
const toolResultSizeHook: HookMap["post-tool-call"] = (ctx) => {
	let bytes: number;
	try {
		bytes = JSON.stringify(ctx.result).length;
	} catch {
		return;
	}
	if (bytes > MAX_TOOL_RESULT_BYTES) {
		throw new ToolResultTooLargeError(bytes);
	}
};
