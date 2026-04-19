/**
 * ConfirmationHandler — Stage 7.3.
 *
 * Decides whether a tool call needs user confirmation, and obtains it.
 * Called by the AgentHost `pre-tool-call` hook (PLAN 附录 L):
 *
 *   const decision = await confirmationHandler.decide({
 *     tool: call.name,
 *     args: call.args,
 *     highRiskFlags: flagHighRisk(meta, input, pageUrl),
 *     tabUrl: ctx.tab.url,
 *   });
 *   if (decision !== 'approved') throw new ToolDenied();
 *
 * Decision matrix (highest-precedence rule wins, evaluated top → bottom):
 *
 *   1. Any high-risk flag ∩ policy.forceConfirmActions  → ASK USER
 *      (applies even in autonomous; per PLAN Stage 7.3 defensive decision D3)
 *   2. autonomy = 'manual'                              → ASK USER
 *   3. autonomy = 'confirm-each' + read-only tool       → AUTO APPROVED
 *   4. autonomy = 'confirm-each'                        → ASK USER
 *   5. autonomy = 'autonomous' + no high-risk flag      → AUTO APPROVED
 *
 * A user timeout is treated as `timeout` (the caller must map to denied;
 * we keep the distinction in the type so audit log can record it).
 */
import type { AdminPolicy, HighRiskAction } from "./admin-policy.js";

export interface ConfirmationRequest {
	tool: string;
	args: unknown;
	/** Strings rather than the enum — browser-tools' flagHighRisk returns
	 * a string union that overlaps with AdminPolicy's HighRiskAction but is
	 * not identical. We accept the superset and match by string equality. */
	highRiskFlags: readonly string[];
	tabUrl: string;
}

export type ConfirmationDecision = "approved" | "denied" | "timeout";

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"snapshot",
	"read",
	"screenshot",
]);

export function isReadOnlyTool(name: string): boolean {
	return READ_ONLY_TOOLS.has(name);
}

/**
 * Pure predicate: given a policy, tool name, and detected high-risk flags,
 * decide whether confirmation is required. Exported so audit logging, UI
 * previews, and tests can share the same truth.
 */
export function needsConfirmation(
	policy: AdminPolicy,
	tool: string,
	flags: readonly string[],
): boolean {
	// Rule 1: force-confirm actions always prompt (even autonomous).
	if (hasForceConfirmOverlap(policy.forceConfirmActions, flags)) return true;
	// Rule 2: manual autonomy asks about everything.
	if (policy.autonomy === "manual") return true;
	// Rule 3/4: confirm-each asks unless the tool is read-only.
	if (policy.autonomy === "confirm-each") {
		return !isReadOnlyTool(tool);
	}
	// Rule 5: autonomous + no high-risk flag → no confirmation.
	return false;
}

function hasForceConfirmOverlap(
	force: readonly HighRiskAction[],
	flags: readonly string[],
): boolean {
	if (flags.length === 0) return false;
	const set = new Set<string>(force);
	for (const f of flags) {
		if (set.has(f)) return true;
	}
	return false;
}

export interface ConfirmationHandlerOpts {
	policy: AdminPolicy;
	askUser: (req: ConfirmationRequest) => Promise<ConfirmationDecision>;
	/** Default 60_000 ms per PLAN Stage 7.3 implicit sensible default. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class ConfirmationHandler {
	private readonly policy: AdminPolicy;
	private readonly askUser: (
		req: ConfirmationRequest,
	) => Promise<ConfirmationDecision>;
	private readonly timeoutMs: number;

	constructor(opts: ConfirmationHandlerOpts) {
		this.policy = opts.policy;
		this.askUser = opts.askUser;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async decide(req: ConfirmationRequest): Promise<ConfirmationDecision> {
		if (!needsConfirmation(this.policy, req.tool, req.highRiskFlags)) {
			return "approved";
		}
		// Race the user's decision against a timeout.
		return raceWithTimeout(
			this.askUser(req),
			this.timeoutMs,
			"timeout" as const,
		);
	}
}

function raceWithTimeout<T>(
	p: Promise<T>,
	ms: number,
	timeoutValue: T,
): Promise<T> {
	return new Promise<T>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(timeoutValue);
		}, ms);
		// Unref if available so the timer never keeps Node alive in tests.
		(timer as unknown as { unref?: () => void }).unref?.();
		p.then(
			(v) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(v);
			},
			() => {
				// askUser rejecting is treated as denied — the caller has no
				// better signal and we must not leak exceptions through the
				// pre-tool-call hook.
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve("denied" as T);
			},
		);
	});
}
