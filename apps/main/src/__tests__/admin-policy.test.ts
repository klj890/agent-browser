/**
 * AdminPolicy unit tests — Stage 5.1 / 5.2.
 * A mock keytar replaces the OS keychain so tests don't touch it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	type AdminPolicy,
	AdminPolicySchema,
	AdminPolicyStore,
	checkCostBudget,
	DEFAULT_POLICY,
	filterAllowedTools,
	isHighRiskAction,
	type KeytarLike,
	PolicyValidationError,
} from "../admin-policy.js";

function makeMockKeytar(): KeytarLike & {
	store: Map<string, string>;
} {
	const store = new Map<string, string>();
	const key = (s: string, a: string) => `${s}::${a}`;
	return {
		store,
		async getPassword(service, account) {
			return store.get(key(service, account)) ?? null;
		},
		async setPassword(service, account, value) {
			store.set(key(service, account), value);
		},
		async deletePassword(service, account) {
			return store.delete(key(service, account));
		},
	};
}

describe("AdminPolicy schema", () => {
	it("DEFAULT_POLICY passes Zod validation", () => {
		const r = AdminPolicySchema.safeParse(DEFAULT_POLICY);
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.version).toBe(1);
			expect(r.data.autonomy).toBe("confirm-each");
			expect(r.data.costGuard.maxTokensPerTask).toBe(200_000);
			expect(r.data.forceConfirmActions).toContain("file_download");
		}
	});
});

describe("AdminPolicyStore.load", () => {
	it("returns DEFAULT_POLICY when keychain is empty", async () => {
		const keytar = makeMockKeytar();
		const store = new AdminPolicyStore({ keytar });
		const p = await store.load();
		expect(p).toEqual(DEFAULT_POLICY);
	});

	it("returns DEFAULT when keychain contains garbage", async () => {
		const keytar = makeMockKeytar();
		keytar.store.set("agent-browser::admin-policy", "not-json-at-all");
		const store = new AdminPolicyStore({ keytar });
		const p = await store.load();
		expect(p).toEqual(DEFAULT_POLICY);
	});
});

describe("AdminPolicyStore.update", () => {
	let keytar: ReturnType<typeof makeMockKeytar>;
	let store: AdminPolicyStore;

	beforeEach(async () => {
		keytar = makeMockKeytar();
		store = new AdminPolicyStore({ keytar });
		await store.setAdminPassword(null, "hunter2");
	});

	it("write-then-read roundtrips the policy", async () => {
		const updated = await store.update("hunter2", {
			autonomy: "autonomous",
			allowedDomains: ["example.com"],
		});
		expect(updated.autonomy).toBe("autonomous");
		expect(updated.allowedDomains).toEqual(["example.com"]);
		const loaded = await store.load();
		expect(loaded.autonomy).toBe("autonomous");
		expect(loaded.allowedDomains).toEqual(["example.com"]);
	});

	it("rejects when admin password is wrong", async () => {
		await expect(
			store.update("WRONG", { autonomy: "autonomous" }),
		).rejects.toThrow(/invalid admin password/);
	});

	it("deep-merges nested objects (costGuard.maxUsdPerTask only)", async () => {
		const updated = await store.update("hunter2", {
			costGuard: { maxUsdPerTask: 5.5 } as AdminPolicy["costGuard"],
		});
		expect(updated.costGuard.maxUsdPerTask).toBe(5.5);
		// Other costGuard fields preserved
		expect(updated.costGuard.maxTokensPerTask).toBe(
			DEFAULT_POLICY.costGuard.maxTokensPerTask,
		);
		expect(updated.costGuard.maxUsdPerDay).toBe(
			DEFAULT_POLICY.costGuard.maxUsdPerDay,
		);
		expect(updated.costGuard.maxStepsPerTask).toBe(
			DEFAULT_POLICY.costGuard.maxStepsPerTask,
		);
		// Unrelated top-level fields preserved too
		expect(updated.autonomy).toBe(DEFAULT_POLICY.autonomy);
	});

	it("throws PolicyValidationError on invalid values", async () => {
		await expect(
			store.update("hunter2", {
				costGuard: { maxUsdPerTask: -1 } as AdminPolicy["costGuard"],
			}),
		).rejects.toBeInstanceOf(PolicyValidationError);
	});
});

describe("AdminPolicyStore admin-password flow", () => {
	it("setAdminPassword: first-time set then change", async () => {
		const keytar = makeMockKeytar();
		const store = new AdminPolicyStore({ keytar });
		await store.setAdminPassword(null, "first");
		expect(await store.verifyAdminPassword("first")).toBe(true);
		await store.setAdminPassword("first", "second");
		expect(await store.verifyAdminPassword("first")).toBe(false);
		expect(await store.verifyAdminPassword("second")).toBe(true);
		// Wrong old pwd rejected
		await expect(store.setAdminPassword("WRONG", "third")).rejects.toThrow(
			/old password does not match/,
		);
	});

	it("verifyAdminPassword returns false when no pwd set", async () => {
		const keytar = makeMockKeytar();
		const store = new AdminPolicyStore({ keytar });
		expect(await store.verifyAdminPassword("anything")).toBe(false);
	});

	it("verifyAdminPassword: correct vs incorrect", async () => {
		const keytar = makeMockKeytar();
		const store = new AdminPolicyStore({ keytar });
		await store.setAdminPassword(null, "correct horse battery staple");
		expect(
			await store.verifyAdminPassword("correct horse battery staple"),
		).toBe(true);
		expect(await store.verifyAdminPassword("wrong")).toBe(false);
	});
});

describe("AdminPolicyStore.reset", () => {
	it("wipes both policy and password entries", async () => {
		const keytar = makeMockKeytar();
		const store = new AdminPolicyStore({ keytar });
		await store.setAdminPassword(null, "pw");
		await store.update("pw", { autonomy: "autonomous" });
		expect(keytar.store.size).toBe(2);
		await store.reset();
		expect(keytar.store.size).toBe(0);
		// load still works and returns default
		expect(await store.load()).toEqual(DEFAULT_POLICY);
	});
});

describe("isHighRiskAction", () => {
	it("hits configured high-risk actions", () => {
		expect(isHighRiskAction("file_download", DEFAULT_POLICY)).toBe(true);
		expect(isHighRiskAction("form_submit", DEFAULT_POLICY)).toBe(true);
	});
	it("misses actions not in forceConfirmActions", () => {
		expect(isHighRiskAction("clipboard_write", DEFAULT_POLICY)).toBe(false);
		expect(isHighRiskAction("password_field_read", DEFAULT_POLICY)).toBe(false);
	});
});

describe("filterAllowedTools", () => {
	it("keeps only tools present in policy.allowedTools", () => {
		const out = filterAllowedTools(
			["snapshot", "evil_shell", "goto", "act", "unknown"],
			DEFAULT_POLICY,
		);
		expect(out).toEqual(["snapshot", "goto", "act"]);
	});
});

describe("checkCostBudget", () => {
	it("passes under all limits", () => {
		const r = checkCostBudget(
			{ totalTokens: 100, totalUsd: 0.1, steps: 2 },
			DEFAULT_POLICY,
			0,
		);
		expect(r.ok).toBe(true);
	});
	it("trips tokens", () => {
		const r = checkCostBudget(
			{ totalTokens: 999_999, totalUsd: 0.1, steps: 2 },
			DEFAULT_POLICY,
		);
		expect(r).toEqual({ ok: false, reason: "tokens" });
	});
	it("trips usd", () => {
		const r = checkCostBudget(
			{ totalTokens: 100, totalUsd: 99.0, steps: 2 },
			DEFAULT_POLICY,
		);
		expect(r).toEqual({ ok: false, reason: "usd" });
	});
	it("trips steps", () => {
		const r = checkCostBudget(
			{ totalTokens: 100, totalUsd: 0.1, steps: 99999 },
			DEFAULT_POLICY,
		);
		expect(r).toEqual({ ok: false, reason: "steps" });
	});
	it("trips day_budget when todayUsdSpent > maxUsdPerDay", () => {
		const r = checkCostBudget(
			{ totalTokens: 100, totalUsd: 0.1, steps: 2 },
			DEFAULT_POLICY,
			99.0,
		);
		expect(r).toEqual({ ok: false, reason: "day_budget" });
	});
	it("ignores day_budget when todayUsdSpent is undefined", () => {
		const r = checkCostBudget(
			{ totalTokens: 100, totalUsd: 0.1, steps: 2 },
			DEFAULT_POLICY,
		);
		expect(r.ok).toBe(true);
	});
});
