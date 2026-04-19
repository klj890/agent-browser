/**
 * screenshot.ts — full-page or per-element capture via CDP.
 *
 * Per PLAN Stage 2.11: no Node-side post-processing (no sharp). When a `ref`
 * is passed, we resolve its bounding box via DOM.getBoxModel and feed the
 * rectangle into Page.captureScreenshot's `clip` parameter — Chromium does
 * the cropping for us.
 */
import { z } from "zod";
import type { RefRegistry } from "./ref-registry.js";

export const ScreenshotInput = z.object({
	ref: z.string().optional(),
	format: z.enum(["png", "jpeg"]).default("png"),
	quality: z.number().int().min(0).max(100).optional(),
});
export type ScreenshotInput = z.infer<typeof ScreenshotInput>;

export interface ScreenshotCdp {
	send<T = unknown>(method: string, params?: object): Promise<T>;
}

export interface ScreenshotCtx {
	cdp: ScreenshotCdp;
	registry: RefRegistry;
}

export type ScreenshotResult =
	| {
			ok: true;
			base64: string;
			mime: "image/png" | "image/jpeg";
			bytes: number;
	  }
	| { ok: false; reason: "ref_invalid" | "cdp_error"; detail?: string };

export async function screenshot(
	ctx: ScreenshotCtx,
	rawInput: unknown,
): Promise<ScreenshotResult> {
	const input = ScreenshotInput.parse(rawInput ?? {});
	const params: Record<string, unknown> = {
		format: input.format,
		captureBeyondViewport: false,
	};
	if (input.format === "jpeg" && typeof input.quality === "number") {
		params.quality = input.quality;
	}

	if (input.ref) {
		const entry = ctx.registry.get(input.ref);
		if (!entry) {
			return { ok: false, reason: "ref_invalid", detail: input.ref };
		}
		let box: { x: number; y: number; width: number; height: number };
		try {
			const bm = await ctx.cdp.send<{
				model?: { content?: number[] };
			}>("DOM.getBoxModel", { backendNodeId: entry.backendNodeId });
			const c = bm?.model?.content;
			if (!c || c.length < 8) {
				return { ok: false, reason: "ref_invalid", detail: "no box model" };
			}
			const xs = [c[0], c[2], c[4], c[6]] as number[];
			const ys = [c[1], c[3], c[5], c[7]] as number[];
			const x = Math.min(...xs);
			const y = Math.min(...ys);
			const width = Math.max(...xs) - x;
			const height = Math.max(...ys) - y;
			box = { x, y, width, height };
		} catch (err) {
			return {
				ok: false,
				reason: "cdp_error",
				detail: `boxmodel: ${(err as Error)?.message ?? err}`,
			};
		}
		params.clip = { ...box, scale: 1 };
	}

	try {
		const r = await ctx.cdp.send<{ data: string }>(
			"Page.captureScreenshot",
			params,
		);
		const base64 = r?.data ?? "";
		return {
			ok: true,
			base64,
			mime: input.format === "png" ? "image/png" : "image/jpeg",
			bytes: Math.floor((base64.length * 3) / 4),
		};
	} catch (err) {
		return {
			ok: false,
			reason: "cdp_error",
			detail: (err as Error)?.message ?? String(err),
		};
	}
}
