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
import {
	mkdir,
	readdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BrowserToolsCtx,
	createBrowserToolsSkills,
	createFsSkills,
	createTabsSkills,
	type FsDriver,
	type Skill,
	type TabController,
	type TabInfo,
} from "@agent-browser/browser-tools";
import { z } from "zod";
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
import type { McpExternalManager } from "./mcp-external-manager.js";
import type { MemoryStore } from "./memory.js";
import type { Persona, PersonaManager } from "./persona-manager.js";
import { renderTemplate } from "./prompts/render.js";
import {
	createRedactionPipelineFromPolicy,
	type SensitiveWordFilter,
} from "./redaction-pipeline.js";
import { appendSoulToPrompt, type SoulProvider } from "./soul.js";
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
	/**
	 * Optional P2 §2.2 integration: appends the user's SOUL.md to the
	 * system prompt after persona body. Undefined → no soul injection
	 * (e.g. in unit tests that care only about tool wiring).
	 */
	soul?: SoulProvider;
	/**
	 * Optional P2 §2.6 integration: external MCP servers whose tools get
	 * merged into the Agent skill set (gmail / slack / github adapters).
	 * Undefined → Agent runs with only our own browser-tools.
	 */
	externalMcp?: McpExternalManager;
	/**
	 * Optional P2 §2.1 integration: two-layer memory (CORE.md +
	 * daily/YYYY-MM-DD.md). When present, a CORE summary rides along in
	 * the system prompt and `memory_search`/`memory_read_*` skills are
	 * registered so the Agent can pull specific facts on demand. Write
	 * skills are deliberately NOT exposed here — Agent-initiated writes
	 * belong to a follow-up PR with confirmation + AuditLog wiring.
	 */
	memory?: MemoryStore;
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
	const externalSkills = deps.externalMcp?.skills() ?? [];
	// Filesystem skills (P2 §2.7). Always built so the LLM sees they exist
	// even when `fsSandboxDirs` is empty — callers get a clean
	// `not_in_sandbox` rejection rather than "tool not found", which is
	// easier for the LLM to recover from (it can ask the user to grant
	// a folder).
	const fsSkills = createFsSkills({
		allowedDirs: policy.fsSandboxDirs.map((d) => path.resolve(d)),
		driver: nodeFsDriver,
		resolve: (p) => path.resolve(p),
		dirname: (p) => path.dirname(p),
		sep: path.sep,
	});
	const memorySkills = deps.memory ? createMemorySkills(deps.memory) : [];
	const allSkills = [
		...createBrowserToolsSkills(ctx),
		...createTabsSkills({
			controller: tabController,
			policy: navigationPolicy,
		}),
		...fsSkills,
		...memorySkills,
		// External MCP tools go LAST so an externally-configured tool
		// can never shadow a built-in by sharing its name — filterSkills
		// later keeps only names in policy.allowedTools anyway.
		...externalSkills,
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
	// Order at the prompt tail:
	//   base prompt → persona body → CORE memory facts → SOUL behaviour
	// Memory sits between persona (role-specific) and SOUL (user-wide
	// behaviour) because CORE facts are factual scaffolding the LLM should
	// read before applying SOUL's style rules to them.
	let afterPersona = appendPersonaBody(systemPrompt, persona.contentMd);
	if (deps.memory) {
		try {
			const core = await deps.memory.coreSummary();
			if (core) {
				afterPersona = `${afterPersona.trimEnd()}\n\n<!-- memory:core -->\n${core}\n<!-- memory:core:end -->\n`;
			}
		} catch (err) {
			console.warn(
				`[agent-host-factory] memory.coreSummary failed, continuing without CORE: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	// SOUL is appended LAST so its boundaries/preferences override persona
	// style (persona = "what role now", SOUL = "how I always want you to act").
	//
	// Fail-closed on read errors (security-high): FileSoulProvider already
	// returns the default body for ENOENT, so any error bubbling up here
	// means a configured SOUL file exists but cannot be read (EACCES,
	// corrupted, oversize…). Silently dropping it would run the Agent
	// without the user's declared hard boundaries — exactly the scenario
	// the feature exists to prevent. Let it throw; the session fails to
	// start, the user sees the cause and fixes the file.
	let finalSystemPrompt = afterPersona;
	if (deps.soul) {
		const soulBody = await deps.soul.load();
		finalSystemPrompt = appendSoulToPrompt(afterPersona, soulBody);
	}

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
			return tabManager.getSummary(id)?.openedByAgent === true;
		},
		exists(id) {
			return tabManager.getSummary(id) !== undefined;
		},
		setAgentActive(id) {
			if (!tabManager.getSummary(id)) return;
			activeAgentTab.id = id;
		},
		getAgentActiveId() {
			return activeAgentTab.id;
		},
		waitLoad(id, timeoutMs, signal) {
			return new Promise((resolve) => {
				let unsub: (() => void) | undefined;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let settled = false;
				const settle = (r: Parameters<typeof resolve>[0]) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					unsub?.();
					signal?.removeEventListener("abort", onAbort);
					resolve(r);
				};
				const onAbort = () => settle("aborted");
				if (signal) {
					if (signal.aborted) return settle("aborted");
					signal.addEventListener("abort", onAbort, { once: true });
				}
				// Terminal-state check: if already idle/crashed/missing, don't
				// even bother subscribing.
				const probe = () => {
					const tab = tabManager.getSummary(id);
					if (!tab) return settle("not_found");
					if (tab.state === "idle") return settle("idle");
					if (tab.state === "crashed") return settle("crashed");
				};
				probe();
				if (settled) return;
				// Event-driven: wake up the moment state flips (did-finish-load /
				// render-process-gone) or the tab is removed. No 100ms polling.
				unsub = tabManager.addTabEventListener(id, (event) => {
					if (event === "removed") return settle("not_found");
					probe();
				});
				timer = setTimeout(() => settle("timeout"), timeoutMs);
			});
		},
	};
}

/**
 * Tool names of the form `<prefix>__<remote>` are externally-defined
 * (P2 §2.6 MCP client) — configured out-of-band by the user, not enumerable
 * in AdminPolicy.allowedTools. The separator is `__`; first-party tools
 * that need an underscore use a single one (e.g. `tabs_open`).
 */
/**
 * Node-backed FsDriver used in production. Wraps the node:fs/promises
 * subset the skill layer calls — small enough that we don't need a
 * separate driver module.
 */
const nodeFsDriver: FsDriver = {
	async readFile(p) {
		const buf = await readFile(p);
		// Node Buffer extends Uint8Array, but we return a plain view so the
		// skill layer's Uint8Array-only contract holds if the driver is
		// ever reused in a non-Node environment.
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	},
	async writeFile(p, data, opts) {
		// Pass the `flag` through so fs_write's `createOnly` ⇒ `wx`
		// piggybacks on the OS-level atomic "fail if exists" behaviour.
		await writeFile(p, data, { flag: opts?.flag ?? "w" });
	},
	async readdirDetailed(p) {
		const dirents = await readdir(p, { withFileTypes: true });
		// Parallelise stat-for-size (Dirent carries no size, so one stat
		// per entry stays necessary). Sequential loop was O(N) wall-clock
		// for large directories; Promise.all keeps throughput FS-bound.
		// Use path.join (not string interp) so Windows backslash paths
		// work.
		//
		// Symlink policy: we intentionally use `stat` (which follows the
		// link) rather than the `Dirent.isFile/isDirectory` booleans
		// (which describe the link itself, not its target). Rationale —
		// the Agent's next step after ls is usually fs_read or fs_write,
		// and those operations follow the link too; reporting the
		// target's type keeps the three tools consistent. Broken links
		// (stat throws) are dropped via the catch, same as a vanished
		// entry, so the Agent just doesn't see them.
		const results = await Promise.all(
			dirents.map(async (d) => {
				try {
					const s = await stat(path.join(p, d.name));
					return {
						name: d.name,
						isFile: s.isFile(),
						isDirectory: s.isDirectory(),
						size: s.size,
					};
				} catch {
					return undefined;
				}
			}),
		);
		return results.filter((r): r is NonNullable<typeof r> => r !== undefined);
	},
	async stat(p) {
		const s = await stat(p);
		return {
			isFile: s.isFile(),
			isDirectory: s.isDirectory(),
			size: s.size,
		};
	},
	async mkdir(p, opts) {
		await mkdir(p, opts);
	},
	async realpath(p) {
		return realpath(p);
	},
};

/**
 * Read-only Memory skills. Writes are NOT here — Agent self-write to
 * persistent memory will ride through the same confirmation path that
 * §2.2's SOUL.md auto-evolution uses when that ships.
 */
const MemorySearchInput = z.object({
	query: z.string().min(1),
	limit: z.number().int().positive().max(50).optional(),
});
const MemoryReadDailyInput = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function createMemorySkills(memory: MemoryStore): Skill[] {
	return [
		{
			name: "memory_search",
			description:
				"Search the user's memory (CORE.md + daily notes) for lines matching given keywords. Returns up to 10 hits with source/section/line. Keywords are AND-matched case-insensitively.",
			inputSchema: MemorySearchInput,
			execute: async (input) => {
				// input already ran through AgentHost's Zod gate, so we don't
				// re-parse here — re-parsing duplicated the schema in two
				// places and drifted silently in review iterations.
				const parsed = input as z.infer<typeof MemorySearchInput>;
				return { hits: await memory.search(parsed.query, parsed.limit) };
			},
		},
		{
			name: "memory_read_core",
			description:
				"Read the full CORE.md — the user's permanent facts file. Use when the Agent needs comprehensive context at task start.",
			inputSchema: z.object({}).passthrough(),
			execute: async () => ({ content: await memory.readCore() }),
		},
		{
			name: "memory_read_daily",
			description:
				"Read one day's notes file by ISO date (YYYY-MM-DD). Returns an empty string if that day has no entries.",
			inputSchema: MemoryReadDailyInput,
			execute: async (input) => {
				const parsed = input as z.infer<typeof MemoryReadDailyInput>;
				return { content: await memory.readDaily(parsed.date) };
			},
		},
	];
}

export function isExternalMcpSkillName(name: string): boolean {
	return name.includes("__");
}

/**
 * Extract the server-prefix portion of an external tool name. Returns
 * undefined when the name isn't external. `gh__star_repo` → `"gh"`.
 */
export function externalMcpPrefixOf(name: string): string | undefined {
	const i = name.indexOf("__");
	return i > 0 ? name.slice(0, i) : undefined;
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
	// External prefix allowlist: undefined = accept-all (opt-in), [] = block-all,
	// ["gh", "slack"] = only those prefixes. See AdminPolicy doc.
	const externalAllowed =
		policy.allowedExternalMcpPrefixes != null
			? new Set(policy.allowedExternalMcpPrefixes)
			: null; // null sentinel → unrestricted
	return all.filter((s) => {
		if (isExternalMcpSkillName(s.name)) {
			// External tool: policy.allowedTools is bypassed (admin can't
			// enumerate external tool names), but the prefix allowlist
			// still applies when admin has opted in.
			if (externalAllowed) {
				const prefix = externalMcpPrefixOf(s.name);
				if (prefix == null || !externalAllowed.has(prefix)) return false;
			}
		} else if (!policyAllowed.has(s.name)) {
			return false;
		}
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
