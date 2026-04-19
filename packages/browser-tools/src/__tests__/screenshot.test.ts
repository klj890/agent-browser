import { describe, expect, it } from "vitest";
import { RefRegistry } from "../ref-registry.js";
import { screenshot } from "../screenshot.js";

function makeCdp(opts: { box?: number[]; data?: string; fail?: string } = {}) {
	const calls: Array<{ method: string; params?: object }> = [];
	const cdp = {
		send: async <T>(method: string, params?: object): Promise<T> => {
			calls.push({ method, params });
			if (opts.fail === method) throw new Error("boom");
			if (method === "DOM.getBoxModel") {
				return {
					model: { content: opts.box ?? [0, 0, 100, 0, 100, 50, 0, 50] },
				} as unknown as T;
			}
			if (method === "Page.captureScreenshot") {
				return { data: opts.data ?? "ZmFrZQ==" } as unknown as T;
			}
			return {} as T;
		},
	};
	return { cdp, calls };
}

describe("screenshot", () => {
	it("full-page capture returns base64 PNG", async () => {
		const reg = new RefRegistry();
		const { cdp, calls } = makeCdp({});
		const r = await screenshot({ cdp, registry: reg }, {});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.mime).toBe("image/png");
			expect(r.base64).toBe("ZmFrZQ==");
		}
		// did NOT ask for boxModel
		expect(calls.some((c) => c.method === "DOM.getBoxModel")).toBe(false);
	});

	it("ref capture passes clip rectangle to captureScreenshot", async () => {
		const reg = new RefRegistry();
		reg.allocate({ backendNodeId: 42, role: "button", name: "x" });
		const { cdp, calls } = makeCdp({
			box: [10, 20, 110, 20, 110, 70, 10, 70],
		});
		const r = await screenshot(
			{ cdp, registry: reg },
			{ ref: "@e1", format: "jpeg", quality: 80 },
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.mime).toBe("image/jpeg");
		const cap = calls.find((c) => c.method === "Page.captureScreenshot");
		expect(cap).toBeDefined();
		const p = cap?.params as Record<string, unknown>;
		expect(p.format).toBe("jpeg");
		expect(p.quality).toBe(80);
		expect(p.clip).toEqual({ x: 10, y: 20, width: 100, height: 50, scale: 1 });
	});

	it("ref_invalid when registry has no entry", async () => {
		const reg = new RefRegistry();
		const { cdp } = makeCdp({});
		const r = await screenshot({ cdp, registry: reg }, { ref: "@e9" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("ref_invalid");
	});

	it("cdp_error when Page.captureScreenshot throws", async () => {
		const reg = new RefRegistry();
		const { cdp } = makeCdp({ fail: "Page.captureScreenshot" });
		const r = await screenshot({ cdp, registry: reg }, {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("cdp_error");
	});
});
