/**
 * @agent-browser/browser-tools — Agent-facing CDP tools (Stage 2).
 *
 * `createBrowserToolsSkills(ctx)` returns a flat array of Skill objects the
 * agent-host will register with the LLM. The Skill shape here is our own
 * minimal contract; Stage 3 will align this with CogniRefract's SkillManager
 * if/when that integration lands. Keeping the shape local means no upstream
 * coupling yet.
 */
import type { z } from "zod";
import { ActInput, act } from "./act.js";
import type { NavigationPolicy } from "./goto.js";
import { GotoInput, goto } from "./goto.js";
import { ReadInput, read } from "./read.js";
import type { RefRegistry } from "./ref-registry.js";
import { ScreenshotInput, screenshot } from "./screenshot.js";
import { SnapshotInput, snapshot } from "./snapshot.js";

export type {
	ActCdp,
	ActCtx,
	ActResult,
	HighRiskAction,
	TargetMeta,
} from "./act.js";
export { ActInput, act, flagHighRisk } from "./act.js";
export { wrapUntrusted } from "./content-boundary.js";
export type {
	GotoCdp,
	GotoCtx,
	GotoReason,
	GotoResult,
	NavigationPolicy,
} from "./goto.js";
export { checkUrlAllowed, GotoInput, goto } from "./goto.js";
export type { ReadCdp, ReadCtx, ReadResult } from "./read.js";
export { htmlToText, ReadInput, read } from "./read.js";
export type { RefEntry } from "./ref-registry.js";
export { RefRegistry } from "./ref-registry.js";
export type {
	ScreenshotCdp,
	ScreenshotCtx,
	ScreenshotResult,
} from "./screenshot.js";
export { ScreenshotInput, screenshot } from "./screenshot.js";
export type {
	AxNode,
	AxTreeResponse,
	SnapshotCdp,
	SnapshotCtx,
	SnapshotResult,
} from "./snapshot.js";
export { SnapshotInput, snapshot } from "./snapshot.js";

// ---- Skill registry ----

export interface Skill<TInput = unknown, TOutput = unknown> {
	name: string;
	description: string;
	inputSchema: z.ZodType<TInput>;
	execute: (input: TInput) => Promise<TOutput>;
}

/**
 * Unified CDP interface exposing the superset used across all five tools.
 * Implementations (see apps/main CdpAdapter) provide both `send` and `on`.
 */
export interface UnifiedCdp {
	send<T = unknown>(method: string, params?: object): Promise<T>;
	on(method: string, cb: (params: unknown) => void): () => void;
}

/**
 * Context bag used by every Skill. Each tool receives a subset; `cdp` must
 * implement both request (`send`) and event (`on`) surfaces.
 */
export interface BrowserToolsCtx {
	cdp: UnifiedCdp;
	registry: RefRegistry;
	pageUrl?: string;
	pageTitle?: string;
	policy?: NavigationPolicy;
}

export function createBrowserToolsSkills(ctx: BrowserToolsCtx): Skill[] {
	return [
		{
			name: "snapshot",
			description:
				"Capture the current page's accessibility tree as a compact, redacted flat list for Agent planning. Returns refs (@eN) for interactive elements.",
			inputSchema: SnapshotInput,
			execute: (input) => snapshot(ctx, input),
		},
		{
			name: "act",
			description:
				"Perform a user action (click/fill/select/hover/scroll/press/check/uncheck) on a ref or locator.",
			inputSchema: ActInput,
			execute: (input) => act(ctx, input),
		},
		{
			name: "read",
			description:
				"Read the plain-text content of a single element identified by ref or CSS selector.",
			inputSchema: ReadInput,
			execute: (input) => read(ctx, input),
		},
		{
			name: "goto",
			description:
				"Navigate the active tab to a URL. URL scheme + domain are checked against policy before navigation.",
			inputSchema: GotoInput,
			execute: (input) => goto(ctx, input),
		},
		{
			name: "screenshot",
			description:
				"Capture a screenshot (full page by default, or a single element if `ref` is given). Returns base64.",
			inputSchema: ScreenshotInput,
			execute: (input) => screenshot(ctx, input),
		},
	];
}
