/**
 * AdminPolicy — Stage 5.1/5.2: schema + encrypted storage + read-only access.
 *
 * See PLAN.md 附录 A for the authoritative schema. This module intentionally
 * does NOT wire any agent gating logic — Stage 5.3+ will read from the loaded
 * policy via the helpers exported here.
 *
 * Storage strategy:
 *   - Policy JSON lives in OS keychain under service='agent-browser',
 *     account='admin-policy' (via keytar).
 *   - Admin password is stored as a scrypt hash (format: "scrypt$<saltHex>$<hashHex>")
 *     under account='admin-password-hash'. We use Node's built-in crypto.scrypt
 *     to avoid introducing argon2 as a new dep (the hash is only ever compared
 *     with user input entered in the admin UI, so scrypt is sufficient).
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const scrypt = promisify(scryptCb) as (
	password: string | Buffer,
	salt: string | Buffer,
	keylen: number,
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Zod schema (verbatim from PLAN.md 附录 A)
// ---------------------------------------------------------------------------

export const AutonomyLevel = z.enum(["manual", "confirm-each", "autonomous"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const HighRiskAction = z.enum([
	"form_submit",
	"file_download",
	"file_upload",
	"cross_origin_navigate",
	"password_field_read",
	"password_field_write",
	"clipboard_write",
	"geolocation_read",
]);
export type HighRiskAction = z.infer<typeof HighRiskAction>;

export const CostGuard = z.object({
	maxTokensPerTask: z.number().int().positive().default(200_000),
	maxUsdPerTask: z.number().positive().default(2.0),
	maxUsdPerDay: z.number().positive().default(20.0),
	maxStepsPerTask: z.number().int().positive().default(30),
});
export type CostGuard = z.infer<typeof CostGuard>;

export const UrlScheme = z.enum(["http", "https", "data", "blob", "file"]);
export type UrlScheme = z.infer<typeof UrlScheme>;

export const AdminPolicySchema = z.object({
	version: z.literal(1),
	autonomy: AutonomyLevel.default("confirm-each"),
	allowedTools: z
		.array(z.string())
		.default([
			"snapshot",
			"read",
			"goto",
			"act",
			"screenshot",
			"tabs_list",
			"tabs_open",
			"tabs_close",
			"tabs_switch",
			"tabs_wait_load",
		]),
	allowedDomains: z.array(z.string()).default([]),
	allowedUrlSchemes: z.array(UrlScheme).default(["http", "https"]),
	blockedDomains: z.array(z.string()).default([]),
	forceConfirmActions: z
		.array(HighRiskAction)
		.default([
			"form_submit",
			"file_download",
			"file_upload",
			"cross_origin_navigate",
			"password_field_write",
		]),
	costGuard: CostGuard,
	redaction: z.object({
		enableDefaultRules: z.boolean().default(true),
		customPatterns: z
			.array(
				z.object({
					name: z.string(),
					pattern: z.string(),
					flags: z.string().default("gi"),
				}),
			)
			.default([]),
	}),
	egress: z.object({
		blockNonAllowedInAutonomous: z.boolean().default(true),
		auditAllRequests: z.boolean().default(false),
	}),
	extension: z.object({
		allowMv3: z.boolean().default(true),
		allowedExtensionIds: z.array(z.string()).default([]),
	}),
});

export type AdminPolicy = z.infer<typeof AdminPolicySchema>;

export const DEFAULT_POLICY: AdminPolicy = AdminPolicySchema.parse({
	version: 1,
	costGuard: {},
	redaction: {},
	egress: {},
	extension: {},
});

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PolicyValidationError extends Error {
	public readonly issues: z.ZodIssue[];
	constructor(issues: z.ZodIssue[]) {
		super(`AdminPolicy validation failed: ${JSON.stringify(issues)}`);
		this.name = "PolicyValidationError";
		this.issues = issues;
	}
}

// ---------------------------------------------------------------------------
// Keytar-like storage abstraction (real keytar by default; mockable in tests)
// ---------------------------------------------------------------------------

export interface KeytarLike {
	getPassword(service: string, account: string): Promise<string | null>;
	setPassword(service: string, account: string, value: string): Promise<void>;
	deletePassword(service: string, account: string): Promise<boolean>;
}

const SERVICE = "agent-browser";
const ACCOUNT_POLICY = "admin-policy";
const ACCOUNT_PASSWORD = "admin-password-hash";
const SCRYPT_KEYLEN = 64;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		Object.getPrototypeOf(v) === Object.prototype
	);
}

/**
 * Deep-merge `patch` into `base`. Plain objects are merged recursively; arrays
 * and scalars are replaced wholesale (we don't want to accidentally concat
 * allowedDomains etc. — explicit replace matches user intent).
 */
function deepMerge<T>(base: T, patch: Partial<T>): T {
	if (!isPlainObject(base) || !isPlainObject(patch)) {
		return (patch === undefined ? base : (patch as T)) as T;
	}
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		const cur = out[k];
		if (isPlainObject(cur) && isPlainObject(v)) {
			out[k] = deepMerge(cur, v);
		} else {
			out[k] = v;
		}
	}
	return out as T;
}

async function hashPassword(pwd: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scrypt(pwd, salt, SCRYPT_KEYLEN);
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(pwd: string, stored: string): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length !== 3 || parts[0] !== "scrypt") return false;
	const saltHex = parts[1];
	const hashHex = parts[2];
	if (!saltHex || !hashHex) return false;
	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(saltHex, "hex");
		expected = Buffer.from(hashHex, "hex");
	} catch {
		return false;
	}
	const actual = await scrypt(pwd, salt, expected.length);
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// AdminPolicyStore
// ---------------------------------------------------------------------------

export class AdminPolicyStore {
	private readonly keytar: KeytarLike;

	constructor(opts?: { keytar?: KeytarLike }) {
		// Lazy-load real keytar only when no mock supplied. This keeps unit tests
		// free from OS-keychain dependencies.
		this.keytar = opts?.keytar ?? loadRealKeytar();
	}

	async load(): Promise<AdminPolicy> {
		const raw = await this.keytar.getPassword(SERVICE, ACCOUNT_POLICY);
		if (!raw) return DEFAULT_POLICY;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// Corrupt entry — fall back to default rather than crashing boot.
			return DEFAULT_POLICY;
		}
		const result = AdminPolicySchema.safeParse(parsed);
		if (!result.success) return DEFAULT_POLICY;
		return result.data;
	}

	async update(
		adminPwd: string,
		patch: Partial<AdminPolicy>,
	): Promise<AdminPolicy> {
		const ok = await this.verifyAdminPassword(adminPwd);
		if (!ok) throw new Error("invalid admin password");
		const current = await this.load();
		const merged = deepMerge(current, patch);
		const result = AdminPolicySchema.safeParse(merged);
		if (!result.success) throw new PolicyValidationError(result.error.issues);
		await this.keytar.setPassword(
			SERVICE,
			ACCOUNT_POLICY,
			JSON.stringify(result.data),
		);
		return result.data;
	}

	async setAdminPassword(oldPwd: string | null, newPwd: string): Promise<void> {
		if (!newPwd || newPwd.length < 1) {
			throw new Error("new password must be non-empty");
		}
		const existing = await this.keytar.getPassword(SERVICE, ACCOUNT_PASSWORD);
		if (existing) {
			if (oldPwd === null) throw new Error("old password required");
			const ok = await verifyPassword(oldPwd, existing);
			if (!ok) throw new Error("old password does not match");
		}
		const hashed = await hashPassword(newPwd);
		await this.keytar.setPassword(SERVICE, ACCOUNT_PASSWORD, hashed);
	}

	async verifyAdminPassword(pwd: string): Promise<boolean> {
		const stored = await this.keytar.getPassword(SERVICE, ACCOUNT_PASSWORD);
		if (!stored) return false;
		return verifyPassword(pwd, stored);
	}

	async reset(): Promise<void> {
		await this.keytar.deletePassword(SERVICE, ACCOUNT_POLICY);
		await this.keytar.deletePassword(SERVICE, ACCOUNT_PASSWORD);
	}
}

// Defer `import 'keytar'` — it's an optional native module at test time.
function loadRealKeytar(): KeytarLike {
	// require() via createRequire to stay in ESM without crashing when keytar's
	// native binding isn't available in a Node-only test env (tests inject mock).
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { createRequire } =
			require("node:module") as typeof import("node:module");
		const req = createRequire(import.meta.url);
		const mod = req("keytar") as KeytarLike;
		return mod;
	} catch (err) {
		// In pure-Node tests where keytar's native binding is missing, surface a
		// clear error only when the store is actually used. Callers in tests
		// should inject a mock via `opts.keytar`.
		const stub: KeytarLike = {
			async getPassword() {
				throw new Error(
					`keytar unavailable: ${(err as Error).message}. Inject opts.keytar in tests.`,
				);
			},
			async setPassword() {
				throw new Error(
					`keytar unavailable: ${(err as Error).message}. Inject opts.keytar in tests.`,
				);
			},
			async deletePassword() {
				throw new Error(
					`keytar unavailable: ${(err as Error).message}. Inject opts.keytar in tests.`,
				);
			},
		};
		return stub;
	}
}

// ---------------------------------------------------------------------------
// Read-only helpers (Stage 5.2). No gating logic here — just pure predicates
// other modules can call against an already-loaded policy.
// ---------------------------------------------------------------------------

export function isHighRiskAction(
	action: HighRiskAction,
	policy: AdminPolicy,
): boolean {
	return policy.forceConfirmActions.includes(action);
}

export function filterAllowedTools(
	available: string[],
	policy: AdminPolicy,
): string[] {
	const allowed = new Set(policy.allowedTools);
	return available.filter((t) => allowed.has(t));
}

export type CostBudgetReason = "tokens" | "usd" | "steps" | "day_budget";

export interface CostBudgetResult {
	ok: boolean;
	reason?: CostBudgetReason;
}

export function checkCostBudget(
	task: { totalTokens: number; totalUsd: number; steps: number },
	policy: AdminPolicy,
	todayUsdSpent?: number,
): CostBudgetResult {
	const g = policy.costGuard;
	if (task.totalTokens > g.maxTokensPerTask)
		return { ok: false, reason: "tokens" };
	if (task.totalUsd > g.maxUsdPerTask) return { ok: false, reason: "usd" };
	if (task.steps > g.maxStepsPerTask) return { ok: false, reason: "steps" };
	if (typeof todayUsdSpent === "number" && todayUsdSpent > g.maxUsdPerDay) {
		return { ok: false, reason: "day_budget" };
	}
	return { ok: true };
}
