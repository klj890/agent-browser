/**
 * goto.ts — navigate the active frame to a URL under a policy whitelist.
 *
 * - scheme must be in policy.allowedUrlSchemes (defaults [http, https])
 * - domain must match allowedDomains (glob) and not match blockedDomains
 * - waits for Page.domContentEventFired (default) or Page.loadEventFired
 *
 * We wire one-off event subscriptions via `ctx.onCdpEvent` so we don't depend
 * on a particular CdpAdapter shape from here — callers pass a subscriber
 * (e.g. `cdp.on(method, cb)`).
 */
import { z } from "zod";

export const GotoInput = z.object({
	url: z.string(),
	waitUntil: z.enum(["load", "domcontentloaded"]).default("domcontentloaded"),
	timeoutMs: z.number().int().positive().max(120_000).default(30_000),
});
export type GotoInput = z.infer<typeof GotoInput>;

export interface NavigationPolicy {
	allowedUrlSchemes?: string[];
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export interface GotoCdp {
	send<T = unknown>(method: string, params?: object): Promise<T>;
	on(method: string, cb: (params: unknown) => void): () => void;
}

export interface GotoCtx {
	cdp: GotoCdp;
	policy?: NavigationPolicy;
}

export type GotoReason =
	| "scheme_blocked"
	| "domain_blocked"
	| "domain_not_allowed"
	| "navigate_failed"
	| "timeout"
	| "invalid_url";

export type GotoResult =
	| { ok: true; url: string; frameId?: string }
	| { ok: false; reason: GotoReason; detail?: string };

function globMatch(glob: string, host: string): boolean {
	// Tiny fnmatch: * → .* (no path separator nuance needed)
	const re = new RegExp(
		`^${glob
			.split("")
			.map((c) => {
				if (c === "*") return ".*";
				if (/[.?+^$|()[\]{}\\]/.test(c)) return `\\${c}`;
				return c;
			})
			.join("")}$`,
		"i",
	);
	return re.test(host);
}

export function checkUrlAllowed(
	url: string,
	policy: NavigationPolicy = {},
): { allowed: true } | { allowed: false; reason: GotoReason } {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { allowed: false, reason: "invalid_url" };
	}
	const schemes = (policy.allowedUrlSchemes ?? ["http", "https"]).map((s) =>
		s.replace(/:$/, "").toLowerCase(),
	);
	const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
	if (!schemes.includes(scheme)) {
		return { allowed: false, reason: "scheme_blocked" };
	}
	const host = parsed.hostname;
	if (policy.blockedDomains?.some((g) => globMatch(g, host))) {
		return { allowed: false, reason: "domain_blocked" };
	}
	if (policy.allowedDomains && policy.allowedDomains.length > 0) {
		if (!policy.allowedDomains.some((g) => globMatch(g, host))) {
			return { allowed: false, reason: "domain_not_allowed" };
		}
	}
	return { allowed: true };
}

export async function goto(
	ctx: GotoCtx,
	rawInput: unknown,
): Promise<GotoResult> {
	const input = GotoInput.parse(rawInput);
	const check = checkUrlAllowed(input.url, ctx.policy);
	if (!check.allowed) {
		return { ok: false, reason: check.reason, detail: input.url };
	}

	const eventName =
		input.waitUntil === "load"
			? "Page.loadEventFired"
			: "Page.domContentEventFired";

	// Listen first, so we don't miss a fast-firing event.
	let resolveWait: (() => void) | null = null;
	const waiter = new Promise<void>((resolve) => {
		resolveWait = resolve;
	});
	const off = ctx.cdp.on(eventName, () => {
		resolveWait?.();
	});

	let frameId: string | undefined;
	let navigateErrorText: string | undefined;
	try {
		const r = await ctx.cdp.send<{
			frameId?: string;
			errorText?: string;
		}>("Page.navigate", { url: input.url });
		frameId = r?.frameId;
		navigateErrorText = r?.errorText;
	} catch (err) {
		off();
		return {
			ok: false,
			reason: "navigate_failed",
			detail: (err as Error)?.message ?? String(err),
		};
	}

	if (navigateErrorText) {
		off();
		return { ok: false, reason: "navigate_failed", detail: navigateErrorText };
	}

	const timer = new Promise<"timeout">((resolve) =>
		setTimeout(() => resolve("timeout"), input.timeoutMs),
	);
	const raced = await Promise.race<"done" | "timeout">([
		waiter.then(() => "done" as const),
		timer,
	]);
	off();

	if (raced === "timeout") {
		return { ok: false, reason: "timeout", detail: input.url };
	}
	return { ok: true, url: input.url, frameId };
}
