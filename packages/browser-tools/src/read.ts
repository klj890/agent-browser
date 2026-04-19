/**
 * read.ts — fetch outerHTML of a node, strip to plain text, wrap in boundary.
 *
 * Deliberately tiny: we don't pull in jsdom / readability here. A minimal
 * tag-strip + entity-decode is enough for an agent to quote text without
 * being fooled by HTML structure masquerading as instruction.
 */
import { z } from "zod";
import { wrapUntrusted } from "./content-boundary.js";
import type { RefRegistry } from "./ref-registry.js";

export const ReadInput = z
	.object({
		ref: z.string().optional(),
		selector: z.string().optional(),
		maxChars: z.number().int().positive().default(4000),
	})
	.refine((d) => d.ref !== undefined || d.selector !== undefined, {
		message: "ref or selector required",
	});
export type ReadInput = z.infer<typeof ReadInput>;

export interface ReadCdp {
	send<T = unknown>(method: string, params?: object): Promise<T>;
}

export interface ReadCtx {
	cdp: ReadCdp;
	registry: RefRegistry;
	pageUrl?: string;
	pageTitle?: string;
}

export interface ReadResult {
	ok: boolean;
	text: string;
	boundary: string;
	truncated: boolean;
	bytes: number;
	reason?: "ref_invalid" | "selector_not_found" | "cdp_error";
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	hellip: "…",
	mdash: "—",
	ndash: "–",
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_m, ent: string) => {
		if (ent.startsWith("#x") || ent.startsWith("#X")) {
			const cp = Number.parseInt(ent.slice(2), 16);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
		}
		if (ent.startsWith("#")) {
			const cp = Number.parseInt(ent.slice(1), 10);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
		}
		return NAMED_ENTITIES[ent.toLowerCase()] ?? _m;
	});
}

export function htmlToText(html: string): string {
	// 1. drop <script>…</script>, <style>…</style> wholesale (case-insensitive, multi-line).
	let s = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
	s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
	// 2. replace <br> / <p> / <div> / <li> with newlines before stripping.
	s = s.replace(/<\s*(br|hr)\s*\/?\s*>/gi, "\n");
	s = s.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n");
	// 3. strip all remaining tags
	s = s.replace(/<[^>]+>/g, "");
	// 4. decode entities
	s = decodeEntities(s);
	// 5. collapse whitespace
	s = s.replace(/\r\n?/g, "\n");
	s = s.replace(/[ \t\f\v]+/g, " ");
	s = s.replace(/\n[ \t]+/g, "\n");
	s = s.replace(/\n{3,}/g, "\n\n");
	return s.trim();
}

export async function read(
	ctx: ReadCtx,
	rawInput: unknown,
): Promise<ReadResult> {
	const input = ReadInput.parse(rawInput);

	let objectId: string | undefined;
	if (input.ref) {
		const entry = ctx.registry.get(input.ref);
		if (!entry) {
			const empty = wrapUntrusted("", {
				url: ctx.pageUrl,
				title: ctx.pageTitle,
			});
			return {
				ok: false,
				text: empty.text,
				boundary: empty.boundary,
				truncated: false,
				bytes: 0,
				reason: "ref_invalid",
			};
		}
		try {
			const resolved = await ctx.cdp.send<{ object: { objectId?: string } }>(
				"DOM.resolveNode",
				{ backendNodeId: entry.backendNodeId },
			);
			objectId = resolved?.object?.objectId;
		} catch (err) {
			return failure(ctx, "cdp_error", (err as Error).message);
		}
		if (!objectId) return failure(ctx, "ref_invalid");
	} else if (input.selector) {
		try {
			const doc = await ctx.cdp.send<{ root: { nodeId: number } }>(
				"DOM.getDocument",
				{ depth: 0 },
			);
			const q = await ctx.cdp.send<{ nodeId: number }>("DOM.querySelector", {
				nodeId: doc.root.nodeId,
				selector: input.selector,
			});
			if (!q?.nodeId) return failure(ctx, "selector_not_found");
			const resolved = await ctx.cdp.send<{ object: { objectId?: string } }>(
				"DOM.resolveNode",
				{ nodeId: q.nodeId },
			);
			objectId = resolved?.object?.objectId;
			if (!objectId) return failure(ctx, "selector_not_found");
		} catch (err) {
			return failure(ctx, "cdp_error", (err as Error).message);
		}
	}

	let html = "";
	try {
		const r = await ctx.cdp.send<{ result: { value?: string } }>(
			"Runtime.callFunctionOn",
			{
				objectId,
				functionDeclaration: "function(){ return this.outerHTML || ''; }",
				returnByValue: true,
			},
		);
		html = r?.result?.value ?? "";
	} catch (err) {
		return failure(ctx, "cdp_error", (err as Error).message);
	}

	let body = htmlToText(html);
	let truncated = false;
	if (body.length > input.maxChars) {
		const extra = body.length - input.maxChars;
		body = `${body.slice(0, input.maxChars)} (+${extra} chars)`;
		truncated = true;
	}

	const { text, boundary } = wrapUntrusted(body, {
		url: ctx.pageUrl,
		title: ctx.pageTitle,
	});
	return {
		ok: true,
		text,
		boundary,
		truncated,
		bytes: Buffer.byteLength(text, "utf8"),
	};
}

function failure(
	ctx: ReadCtx,
	reason: ReadResult["reason"],
	detail?: string,
): ReadResult {
	const { text, boundary } = wrapUntrusted(detail ?? "", {
		url: ctx.pageUrl,
		title: ctx.pageTitle,
	});
	return {
		ok: false,
		text,
		boundary,
		truncated: false,
		bytes: 0,
		reason,
	};
}
