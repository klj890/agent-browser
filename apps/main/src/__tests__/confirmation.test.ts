/**
 * ConfirmationHandler unit tests — Stage 7.3.
 */
import { describe, expect, it, vi } from "vitest";
import { type AdminPolicy, DEFAULT_POLICY } from "../admin-policy.js";
import { hookLevelHighRiskFlags } from "../agent-host-factory.js";
import {
	ConfirmationHandler,
	type ConfirmationRequest,
	isReadOnlyTool,
	needsConfirmation,
} from "../confirmation.js";

function policyWith(patch: Partial<AdminPolicy>): AdminPolicy {
	return { ...DEFAULT_POLICY, ...patch };
}

const BASE_REQ: ConfirmationRequest = {
	tool: "act",
	args: { action: "click", ref: "@e1" },
	highRiskFlags: [],
	tabUrl: "https://example.com",
};

describe("isReadOnlyTool", () => {
	it("recognises snapshot / read / screenshot as read-only", () => {
		expect(isReadOnlyTool("snapshot")).toBe(true);
		expect(isReadOnlyTool("read")).toBe(true);
		expect(isReadOnlyTool("screenshot")).toBe(true);
		expect(isReadOnlyTool("act")).toBe(false);
		expect(isReadOnlyTool("goto")).toBe(false);
		expect(isReadOnlyTool("unknown")).toBe(false);
	});
});

describe("needsConfirmation (pure matrix)", () => {
	it("manual autonomy asks about read-only tools too", () => {
		const p = policyWith({ autonomy: "manual" });
		expect(needsConfirmation(p, "snapshot", [])).toBe(true);
		expect(needsConfirmation(p, "act", [])).toBe(true);
	});

	it("confirm-each + read-only tool is auto-approved", () => {
		const p = policyWith({ autonomy: "confirm-each" });
		expect(needsConfirmation(p, "snapshot", [])).toBe(false);
		expect(needsConfirmation(p, "read", [])).toBe(false);
		expect(needsConfirmation(p, "screenshot", [])).toBe(false);
	});

	it("confirm-each + write tool asks", () => {
		const p = policyWith({ autonomy: "confirm-each" });
		expect(needsConfirmation(p, "act", [])).toBe(true);
		expect(needsConfirmation(p, "goto", [])).toBe(true);
	});

	it("autonomous + no flag is auto-approved", () => {
		const p = policyWith({ autonomy: "autonomous" });
		expect(needsConfirmation(p, "act", [])).toBe(false);
		expect(needsConfirmation(p, "goto", [])).toBe(false);
	});

	it("autonomous + forceConfirm flag MUST ask (defensive override)", () => {
		const p = policyWith({
			autonomy: "autonomous",
			forceConfirmActions: ["form_submit"],
		});
		expect(needsConfirmation(p, "act", ["form_submit"])).toBe(true);
	});

	it("flag that is not in forceConfirmActions doesn't trigger override", () => {
		// autonomous + flag, but the flag isn't configured as force-confirm
		const p = policyWith({
			autonomy: "autonomous",
			forceConfirmActions: [], // nothing forced
		});
		expect(needsConfirmation(p, "act", ["form_submit"])).toBe(false);
	});

	it("soul_modify is in default forceConfirmActions and overrides any autonomy", () => {
		// Use the unmodified DEFAULT_POLICY so we exercise the shipped
		// default — regression guard against a future refactor that drops
		// soul_modify from the default forceConfirmActions list.
		expect(DEFAULT_POLICY.forceConfirmActions).toContain("soul_modify");
		// Even autonomous: a soul_modify flag forces the prompt.
		const p = policyWith({ autonomy: "autonomous" });
		expect(needsConfirmation(p, "soul_amend", ["soul_modify"])).toBe(true);
		expect(needsConfirmation(p, "soul_amend", [])).toBe(false);
	});
});

describe("hookLevelHighRiskFlags", () => {
	it("flags soul_amend with soul_modify so the confirmation hook trips force-confirm", () => {
		expect(hookLevelHighRiskFlags("soul_amend")).toEqual(["soul_modify"]);
	});

	it("returns no flags for tools whose risk is decided at runtime (e.g. act, goto)", () => {
		// `act` flags risk inside its own execute() — exposing it here
		// would double-flag form submits and surface false positives in
		// the audit log.
		expect(hookLevelHighRiskFlags("act")).toEqual([]);
		expect(hookLevelHighRiskFlags("goto")).toEqual([]);
		expect(hookLevelHighRiskFlags("snapshot")).toEqual([]);
	});
});

describe("ConfirmationHandler.decide", () => {
	function handler(opts: {
		policy: AdminPolicy;
		answer?: "approved" | "denied" | "hang";
		timeoutMs?: number;
	}) {
		const askUser = vi.fn(async (_req: ConfirmationRequest) => {
			if (opts.answer === "hang") {
				await new Promise(() => {
					/* never resolves */
				});
			}
			return (opts.answer ?? "approved") as "approved" | "denied";
		});
		const h = new ConfirmationHandler({
			policy: opts.policy,
			askUser,
			timeoutMs: opts.timeoutMs ?? 60_000,
		});
		return { h, askUser };
	}

	it("manual + snapshot → asks user and returns approved", async () => {
		const { h, askUser } = handler({
			policy: policyWith({ autonomy: "manual" }),
			answer: "approved",
		});
		const d = await h.decide({ ...BASE_REQ, tool: "snapshot" });
		expect(d).toBe("approved");
		expect(askUser).toHaveBeenCalledTimes(1);
	});

	it("confirm-each + snapshot → auto-approved, askUser not called", async () => {
		const { h, askUser } = handler({
			policy: policyWith({ autonomy: "confirm-each" }),
		});
		const d = await h.decide({ ...BASE_REQ, tool: "snapshot" });
		expect(d).toBe("approved");
		expect(askUser).not.toHaveBeenCalled();
	});

	it("confirm-each + click → asks user", async () => {
		const { h, askUser } = handler({
			policy: policyWith({ autonomy: "confirm-each" }),
			answer: "approved",
		});
		const d = await h.decide({ ...BASE_REQ, tool: "act" });
		expect(d).toBe("approved");
		expect(askUser).toHaveBeenCalledTimes(1);
	});

	it("autonomous + click (no high risk) → auto-approved", async () => {
		const { h, askUser } = handler({
			policy: policyWith({ autonomy: "autonomous" }),
		});
		const d = await h.decide({ ...BASE_REQ, tool: "act" });
		expect(d).toBe("approved");
		expect(askUser).not.toHaveBeenCalled();
	});

	it("autonomous + form_submit → MUST ask (force-confirm override)", async () => {
		const { h, askUser } = handler({
			policy: policyWith({
				autonomy: "autonomous",
				forceConfirmActions: ["form_submit"],
			}),
			answer: "approved",
		});
		const d = await h.decide({
			...BASE_REQ,
			tool: "act",
			highRiskFlags: ["form_submit"],
		});
		expect(d).toBe("approved");
		expect(askUser).toHaveBeenCalledTimes(1);
	});

	it("askUser resolves denied → decision = denied", async () => {
		const { h } = handler({
			policy: policyWith({ autonomy: "manual" }),
			answer: "denied",
		});
		const d = await h.decide({ ...BASE_REQ, tool: "act" });
		expect(d).toBe("denied");
	});

	it("askUser never resolves → timeout", async () => {
		vi.useFakeTimers();
		const { h } = handler({
			policy: policyWith({ autonomy: "manual" }),
			answer: "hang",
			timeoutMs: 1000,
		});
		const p = h.decide({ ...BASE_REQ, tool: "act" });
		await vi.advanceTimersByTimeAsync(1001);
		const d = await p;
		expect(d).toBe("timeout");
		vi.useRealTimers();
	});

	it("askUser rejects → denied (exception swallowed)", async () => {
		const askUser = vi.fn(async () => {
			throw new Error("ui crashed");
		});
		const h = new ConfirmationHandler({
			policy: policyWith({ autonomy: "manual" }),
			askUser,
		});
		const d = await h.decide({ ...BASE_REQ, tool: "act" });
		expect(d).toBe("denied");
	});
});
