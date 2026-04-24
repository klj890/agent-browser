/**
 * tabs.ts — multi-tab Agent coordination (P2-18).
 *
 * Exposes five skills so an Agent can open, list, close, and switch tabs
 * in addition to the per-page snapshot/act/read/goto/screenshot primitives.
 *
 * Boundaries (附录 K "Agent 可调用 API"):
 *   - `tabs_open`: new tab is flagged `openedByAgent=true`; URL is gated by
 *     the same NavigationPolicy used by `goto` so a persona's `allowedDomains`
 *     cannot be side-stepped via tab creation.
 *   - `tabs_close`: only tabs with `openedByAgent=true` are closable through
 *     this interface; closing a user tab requires an explicit user action.
 *   - `tabs_switch`: changes the Agent's *logical* active tab — the tab that
 *     subsequent snapshot/act/read/screenshot calls target. Does NOT bring
 *     the tab to foreground in the user's UI (that would be disruptive);
 *     the Agent just reads/acts on the backgrounded tab via its own CDP.
 *   - `tabs_wait_load`: block until a tab finishes its current navigation,
 *     for the common "open, wait, snapshot" pattern.
 *
 * The Skill layer delegates to a `TabController` interface the agent-host
 * supplies. Keeping it an interface (not a direct TabManager reference) means
 * tests can plug in a minimal fake, and the browser-tools package stays free
 * of Electron-side deps.
 */
import { z } from "zod";
import { checkUrlAllowed, type NavigationPolicy } from "./goto.js";
import type { Skill } from "./index.js";

export interface TabInfo {
	id: string;
	url: string;
	title: string;
	openedByAgent: boolean;
	/** True when this is the Agent's current logical active tab (not the user's foreground). */
	agentActive: boolean;
}

export interface TabController {
	list(): TabInfo[];
	/** Open a new tab; returns the new tab id. URL must already have passed policy. */
	open(url: string): string;
	/** Close a tab (caller is responsible for the openedByAgent check via `canClose`). */
	close(id: string): void;
	/** True if the tab exists and was opened by the Agent. */
	canClose(id: string): boolean;
	/** True if the tab exists at all. */
	exists(id: string): boolean;
	/** Change the logical active-agent tab. */
	setAgentActive(id: string): void;
	getAgentActiveId(): string;
	/**
	 * Resolve when the tab reaches `idle` state (or timeout). Implementations
	 * may poll or subscribe to TabManager events.
	 */
	waitLoad(
		id: string,
		timeoutMs: number,
	): Promise<"idle" | "timeout" | "crashed" | "not_found">;
}

export const TabsListInput = z.object({}).passthrough();
export type TabsListInput = z.infer<typeof TabsListInput>;

export const TabsOpenInput = z.object({
	url: z.string(),
	switch: z
		.boolean()
		.optional()
		.describe(
			"If true, also make this the Agent's active tab so subsequent snapshot/act target it. Default true.",
		),
});
export type TabsOpenInput = z.infer<typeof TabsOpenInput>;

export const TabsCloseInput = z.object({
	tabId: z.string(),
});
export type TabsCloseInput = z.infer<typeof TabsCloseInput>;

export const TabsSwitchInput = z.object({
	tabId: z.string(),
});
export type TabsSwitchInput = z.infer<typeof TabsSwitchInput>;

export const TabsWaitLoadInput = z.object({
	tabId: z.string().optional().describe("Defaults to the Agent active tab."),
	timeoutMs: z.number().int().positive().max(60_000).default(15_000),
});
export type TabsWaitLoadInput = z.infer<typeof TabsWaitLoadInput>;

export type OpenReason =
	| "scheme_blocked"
	| "domain_blocked"
	| "domain_not_allowed"
	| "invalid_url";

export type TabsOpenResult =
	| { ok: true; tabId: string; agentActive: boolean }
	| { ok: false; reason: OpenReason; detail?: string };

export type TabsCloseResult =
	| { ok: true }
	| {
			ok: false;
			reason: "not_found" | "not_agent_owned";
	  };

export type TabsSwitchResult =
	| { ok: true; tabId: string }
	| { ok: false; reason: "not_found" };

export type TabsWaitLoadResult =
	| { ok: true; state: "idle" }
	| { ok: false; reason: "not_found" | "timeout" | "crashed" };

export interface TabsCtx {
	controller: TabController;
	policy?: NavigationPolicy;
}

export function createTabsSkills(ctx: TabsCtx): Skill[] {
	return [
		{
			name: "tabs_list",
			description:
				"List all open tabs with id/url/title/openedByAgent flag and the Agent's current active tab.",
			inputSchema: TabsListInput,
			execute: async () => {
				return { tabs: ctx.controller.list() };
			},
		},
		{
			name: "tabs_open",
			description:
				"Open a new tab at the given URL (flagged openedByAgent). Optionally make it the Agent's active tab. Gated by NavigationPolicy.",
			inputSchema: TabsOpenInput,
			execute: async (rawInput) => {
				const input = TabsOpenInput.parse(rawInput);
				const check = checkUrlAllowed(input.url, ctx.policy);
				if (!check.allowed) {
					const result: TabsOpenResult = {
						ok: false,
						reason: check.reason as OpenReason,
						detail: input.url,
					};
					return result;
				}
				const tabId = ctx.controller.open(input.url);
				const wantsSwitch = input.switch ?? true;
				if (wantsSwitch) ctx.controller.setAgentActive(tabId);
				const result: TabsOpenResult = {
					ok: true,
					tabId,
					agentActive: wantsSwitch,
				};
				return result;
			},
		},
		{
			name: "tabs_close",
			description:
				"Close a tab. Only tabs opened by the Agent (openedByAgent=true) can be closed via this tool.",
			inputSchema: TabsCloseInput,
			execute: async (rawInput) => {
				const input = TabsCloseInput.parse(rawInput);
				if (!ctx.controller.exists(input.tabId)) {
					return { ok: false, reason: "not_found" } satisfies TabsCloseResult;
				}
				if (!ctx.controller.canClose(input.tabId)) {
					return {
						ok: false,
						reason: "not_agent_owned",
					} satisfies TabsCloseResult;
				}
				ctx.controller.close(input.tabId);
				return { ok: true } satisfies TabsCloseResult;
			},
		},
		{
			name: "tabs_switch",
			description:
				"Change the Agent's active tab — subsequent snapshot/act/read/screenshot calls target this tab. Does not change the user's foreground tab.",
			inputSchema: TabsSwitchInput,
			execute: async (rawInput) => {
				const input = TabsSwitchInput.parse(rawInput);
				if (!ctx.controller.exists(input.tabId)) {
					return { ok: false, reason: "not_found" } satisfies TabsSwitchResult;
				}
				ctx.controller.setAgentActive(input.tabId);
				return { ok: true, tabId: input.tabId } satisfies TabsSwitchResult;
			},
		},
		{
			name: "tabs_wait_load",
			description:
				"Wait for a tab to finish its current navigation (reach idle state).",
			inputSchema: TabsWaitLoadInput,
			execute: async (rawInput) => {
				const input = TabsWaitLoadInput.parse(rawInput);
				const tabId = input.tabId ?? ctx.controller.getAgentActiveId();
				if (!ctx.controller.exists(tabId)) {
					return {
						ok: false,
						reason: "not_found",
					} satisfies TabsWaitLoadResult;
				}
				const state = await ctx.controller.waitLoad(tabId, input.timeoutMs);
				if (state === "idle") {
					return { ok: true, state } satisfies TabsWaitLoadResult;
				}
				return { ok: false, reason: state } satisfies TabsWaitLoadResult;
			},
		},
	];
}
