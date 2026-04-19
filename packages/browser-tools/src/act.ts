/**
 * act.ts — implements the CDP execution chain in PLAN 附录 H.
 *
 * Stages:
 *   1. Resolve target node: ref → DOM.resolveNode  OR  locator → Runtime.evaluate
 *   2. Introspect target meta via Runtime.callFunctionOn → flagHighRisk
 *   3. Dispatch the action (click/hover/scroll/fill/press/select/check/uncheck)
 *
 * This module does NOT ask the user for confirmation. It returns
 * `highRiskFlags` and lets the caller (agent-host in Stage 5) decide.
 * `fill` preserves `{{vault:xxx}}` placeholders verbatim — vault substitution
 * happens upstream in agent-host, before act is invoked.
 */
import { z } from "zod";
import type { RefRegistry } from "./ref-registry.js";

export const ActInput = z
	.object({
		action: z.enum([
			"click",
			"fill",
			"select",
			"hover",
			"scroll",
			"press",
			"check",
			"uncheck",
		]),
		ref: z
			.string()
			.regex(/^@e\d+$/)
			.optional(),
		locator: z
			.object({
				role: z.string(),
				name: z.string().optional(),
				text: z.string().optional(),
			})
			.optional(),
		value: z.string().optional(),
		options: z
			.object({
				modifiers: z
					.array(z.enum(["Alt", "Control", "Meta", "Shift"]))
					.default([]),
				clickCount: z.number().int().min(1).max(3).default(1),
				delayMs: z.number().int().min(0).max(5000).default(0),
			})
			.default({}),
	})
	.refine((d) => d.ref !== undefined || d.locator !== undefined, {
		message: "ref or locator required",
	});
export type ActInput = z.infer<typeof ActInput>;

export interface ActCdp {
	send<T = unknown>(method: string, params?: object): Promise<T>;
}

export interface ActCtx {
	cdp: ActCdp;
	registry: RefRegistry;
	/** current main-frame URL, used to detect cross-origin navigations */
	pageUrl?: string;
}

export type HighRiskAction =
	| "password_field_write"
	| "form_submit"
	| "cross_origin_navigate"
	| "payment_field_write";

export interface TargetMeta {
	tag?: string;
	type?: string;
	isPassword?: boolean;
	isFormSubmit?: boolean;
	autocomplete?: string;
	href?: string;
	checked?: boolean;
}

export type ActResult =
	| {
			ok: true;
			action: string;
			ref?: string;
			meta: TargetMeta;
			highRiskFlags: HighRiskAction[];
	  }
	| {
			ok: false;
			reason:
				| "ref_invalid"
				| "locator_not_found"
				| "cdp_error"
				| "value_required";
			detail?: string;
	  };

// ---- helpers ----

const MODIFIER_BITS: Record<string, number> = {
	Alt: 1,
	Control: 2,
	Meta: 4,
	Shift: 8,
};

function computeModifiers(mods: readonly string[]): number {
	let bits = 0;
	for (const m of mods) bits |= MODIFIER_BITS[m] ?? 0;
	return bits;
}

/** AX query: walk DOM and return first element matching role+name+text. */
function buildAxQueryExpr(loc: {
	role: string;
	name?: string;
	text?: string;
}): string {
	const role = JSON.stringify(loc.role);
	const name = loc.name != null ? JSON.stringify(loc.name) : "null";
	const text = loc.text != null ? JSON.stringify(loc.text) : "null";
	return `(() => {
  const role_ = ${role};
  const name_ = ${name};
  const text_ = ${text};
  const all = document.querySelectorAll('button, a, input, textarea, select, [role]');
  for (const el of all) {
    const r = el.getAttribute('role') || el.tagName.toLowerCase();
    const n = el.getAttribute('aria-label') || (el.textContent || '').trim();
    const t = (el.textContent || '').trim();
    if (r !== role_) continue;
    if (name_ !== null && n !== name_) continue;
    if (text_ !== null && !t.includes(text_)) continue;
    return el;
  }
  return null;
})()`;
}

function crossOrigin(
	targetHref: string | undefined,
	currentUrl: string | undefined,
): boolean {
	if (!targetHref) return false;
	try {
		const t = new URL(targetHref, currentUrl);
		if (!currentUrl) return false;
		const c = new URL(currentUrl);
		return t.origin !== c.origin;
	} catch {
		return false;
	}
}

export function flagHighRisk(
	meta: TargetMeta,
	input: ActInput,
	currentUrl?: string,
): HighRiskAction[] {
	const flags: HighRiskAction[] = [];
	if (input.action === "fill" && meta.isPassword) {
		flags.push("password_field_write");
	}
	if (input.action === "click" && meta.isFormSubmit) {
		flags.push("form_submit");
	}
	if (
		input.action === "click" &&
		meta.href &&
		crossOrigin(meta.href, currentUrl)
	) {
		flags.push("cross_origin_navigate");
	}
	if (
		input.action === "fill" &&
		typeof meta.autocomplete === "string" &&
		meta.autocomplete.toLowerCase().startsWith("cc-")
	) {
		flags.push("payment_field_write");
	}
	return flags;
}

// ---- main entry ----

export async function act(ctx: ActCtx, rawInput: unknown): Promise<ActResult> {
	const input = ActInput.parse(rawInput);

	// 1. resolve to objectId
	let objectId: string | undefined;
	if (input.ref) {
		const entry = ctx.registry.get(input.ref);
		if (!entry) {
			return { ok: false, reason: "ref_invalid", detail: input.ref };
		}
		try {
			const resolved = await ctx.cdp.send<{
				object: { objectId?: string };
			}>("DOM.resolveNode", { backendNodeId: entry.backendNodeId });
			objectId = resolved?.object?.objectId;
		} catch (err) {
			return {
				ok: false,
				reason: "cdp_error",
				detail: `resolveNode failed: ${(err as Error)?.message ?? err}`,
			};
		}
		if (!objectId) {
			return { ok: false, reason: "ref_invalid", detail: input.ref };
		}
	} else if (input.locator) {
		const expr = buildAxQueryExpr(input.locator);
		try {
			const r = await ctx.cdp.send<{
				result: { subtype?: string; objectId?: string };
			}>("Runtime.evaluate", {
				expression: expr,
				returnByValue: false,
				includeCommandLineAPI: false,
			});
			if (r?.result?.subtype === "null" || !r?.result?.objectId) {
				return {
					ok: false,
					reason: "locator_not_found",
					detail: JSON.stringify(input.locator),
				};
			}
			objectId = r.result.objectId;
		} catch (err) {
			return {
				ok: false,
				reason: "cdp_error",
				detail: `locator evaluate failed: ${(err as Error)?.message ?? err}`,
			};
		}
	}

	if (!objectId) {
		return { ok: false, reason: "ref_invalid" };
	}

	// 2. introspect meta for high-risk detection
	let meta: TargetMeta = {};
	try {
		const introspectFn = `function() {
  const el = this;
  return {
    tag: el.tagName ? el.tagName.toLowerCase() : undefined,
    type: el.type,
    isPassword: el.type === 'password',
    isFormSubmit: el.type === 'submit' || (el.tagName === 'BUTTON' && !!el.form),
    autocomplete: el.autocomplete,
    href: el.href,
    checked: el.checked,
  };
}`;
		const r = await ctx.cdp.send<{
			result: { value?: TargetMeta };
		}>("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: introspectFn,
			returnByValue: true,
		});
		meta = r?.result?.value ?? {};
	} catch (err) {
		return {
			ok: false,
			reason: "cdp_error",
			detail: `introspect failed: ${(err as Error)?.message ?? err}`,
		};
	}

	const highRiskFlags = flagHighRisk(meta, input, ctx.pageUrl);

	// 3. execute action
	try {
		await executeAction(ctx, objectId, input, meta);
	} catch (err) {
		return {
			ok: false,
			reason: "cdp_error",
			detail: `${input.action} failed: ${(err as Error)?.message ?? err}`,
		};
	}

	return {
		ok: true,
		action: input.action,
		ref: input.ref,
		meta,
		highRiskFlags,
	};
}

async function executeAction(
	ctx: ActCtx,
	objectId: string,
	input: ActInput,
	meta: TargetMeta,
): Promise<void> {
	const modifiers = computeModifiers(input.options.modifiers);
	switch (input.action) {
		case "click":
		case "hover": {
			const center = await boxCenter(ctx, objectId);
			await ctx.cdp.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: center.x,
				y: center.y,
				modifiers,
			});
			if (input.action === "hover") return;
			await ctx.cdp.send("Input.dispatchMouseEvent", {
				type: "mousePressed",
				x: center.x,
				y: center.y,
				button: "left",
				buttons: 1,
				clickCount: input.options.clickCount,
				modifiers,
			});
			await ctx.cdp.send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: center.x,
				y: center.y,
				button: "left",
				buttons: 0,
				clickCount: input.options.clickCount,
				modifiers,
			});
			return;
		}
		case "scroll": {
			// Bring into view; if value given, treat as pixel delta.
			await ctx.cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration:
					"function(){ this.scrollIntoView({block:'center', inline:'center'}); }",
				returnByValue: true,
			});
			if (input.value != null) {
				const deltaY = Number(input.value);
				if (!Number.isNaN(deltaY)) {
					const center = await boxCenter(ctx, objectId);
					await ctx.cdp.send("Input.dispatchMouseWheelEvent", {
						type: "mouseWheel",
						x: center.x,
						y: center.y,
						deltaX: 0,
						deltaY,
					});
				}
			}
			return;
		}
		case "fill": {
			if (input.value == null) {
				throw new Error("value required for fill");
			}
			await ctx.cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: "function(){ this.focus(); }",
				returnByValue: true,
			});
			// Clear first: select all then delete
			await ctx.cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration:
					"function(){ if (this.select) this.select(); this.value = ''; this.dispatchEvent(new Event('input', {bubbles:true})); }",
				returnByValue: true,
			});
			await ctx.cdp.send("Input.insertText", { text: input.value });
			// dispatch change to match DOM expectations
			await ctx.cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration:
					"function(){ this.dispatchEvent(new Event('change', {bubbles:true})); }",
				returnByValue: true,
			});
			return;
		}
		case "press": {
			if (input.value == null) throw new Error("value required for press");
			const key = input.value;
			await ctx.cdp.send("Input.dispatchKeyEvent", {
				type: "rawKeyDown",
				key,
				modifiers,
			});
			if (key.length === 1) {
				await ctx.cdp.send("Input.dispatchKeyEvent", {
					type: "char",
					text: key,
					modifiers,
				});
			}
			await ctx.cdp.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key,
				modifiers,
			});
			return;
		}
		case "select": {
			if (input.value == null) throw new Error("value required for select");
			await ctx.cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration:
					"function(v){ this.value = v; this.dispatchEvent(new Event('change', {bubbles:true})); }",
				arguments: [{ value: input.value }],
				returnByValue: true,
			});
			return;
		}
		case "check":
		case "uncheck": {
			const wantChecked = input.action === "check";
			if (meta.checked === wantChecked) return; // already in desired state
			// toggle via click semantics
			const center = await boxCenter(ctx, objectId);
			await ctx.cdp.send("Input.dispatchMouseEvent", {
				type: "mousePressed",
				x: center.x,
				y: center.y,
				button: "left",
				buttons: 1,
				clickCount: 1,
				modifiers,
			});
			await ctx.cdp.send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: center.x,
				y: center.y,
				button: "left",
				buttons: 0,
				clickCount: 1,
				modifiers,
			});
			return;
		}
	}
}

async function boxCenter(
	ctx: ActCtx,
	objectId: string,
): Promise<{ x: number; y: number }> {
	const bm = await ctx.cdp.send<{
		model?: { content?: number[] };
	}>("DOM.getBoxModel", { objectId });
	const content = bm?.model?.content;
	if (!content || content.length < 8) {
		// Fallback: compute via getBoundingClientRect on JS side
		const r = await ctx.cdp.send<{
			result: { value?: { x: number; y: number } };
		}>("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration:
				"function(){ const r = this.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
			returnByValue: true,
		});
		return r?.result?.value ?? { x: 0, y: 0 };
	}
	// content is [x1,y1, x2,y2, x3,y3, x4,y4]
	const x0 = content[0] ?? 0;
	const y0 = content[1] ?? 0;
	const x1 = content[2] ?? 0;
	const y1 = content[3] ?? 0;
	const x2 = content[4] ?? 0;
	const y2 = content[5] ?? 0;
	const x3 = content[6] ?? 0;
	const y3 = content[7] ?? 0;
	return { x: (x0 + x1 + x2 + x3) / 4, y: (y0 + y1 + y2 + y3) / 4 };
}
