/**
 * act.ts unit tests — mock CDP; verify call sequences + high-risk flags.
 */
import { describe, expect, it } from "vitest";
import { act, flagHighRisk } from "../act.js";
import { RefRegistry } from "../ref-registry.js";

interface CallLog {
	method: string;
	params?: object;
}

function mockCdp(
	impl: Partial<
		Record<string, (params?: object) => unknown | Promise<unknown>>
	> = {},
) {
	const calls: CallLog[] = [];
	return {
		calls,
		cdp: {
			send: async <T>(method: string, params?: object): Promise<T> => {
				calls.push({ method, params });
				const fn = impl[method];
				if (fn) {
					return (await Promise.resolve(fn(params))) as T;
				}
				// sensible defaults
				if (method === "DOM.resolveNode") {
					return { object: { objectId: "obj-1" } } as unknown as T;
				}
				if (method === "Runtime.callFunctionOn") {
					return { result: { value: {} } } as unknown as T;
				}
				if (method === "DOM.getBoxModel") {
					return {
						model: { content: [10, 20, 110, 20, 110, 50, 10, 50] },
					} as unknown as T;
				}
				if (method === "Runtime.evaluate") {
					return { result: { objectId: "obj-2" } } as unknown as T;
				}
				return {} as T;
			},
		},
	};
}

function setupRegistry(): RefRegistry {
	const r = new RefRegistry();
	r.allocate({ backendNodeId: 100, role: "button", name: "Go" });
	return r;
}

describe("act", () => {
	it("click dispatches mouseMoved, mousePressed, mouseReleased at box center", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp({
			"Runtime.callFunctionOn": () => ({ result: { value: { tag: "a" } } }),
		});
		const r = await act(
			{ cdp, registry: reg, pageUrl: "https://e.com" },
			{ action: "click", ref: "@e1" },
		);
		expect(r.ok).toBe(true);
		const methods = calls.map((c) => c.method);
		expect(methods).toContain("DOM.resolveNode");
		expect(methods).toContain("DOM.getBoxModel");
		expect(
			methods.filter((m) => m === "Input.dispatchMouseEvent"),
		).toHaveLength(3);
	});

	it("hover stops after mouseMoved", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp();
		const r = await act(
			{ cdp, registry: reg },
			{ action: "hover", ref: "@e1" },
		);
		expect(r.ok).toBe(true);
		const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent");
		expect(mouse).toHaveLength(1);
	});

	it("fill focuses, clears, insertText, dispatches change", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp({
			"Runtime.callFunctionOn": () => ({
				result: { value: { tag: "input", type: "text" } },
			}),
		});
		const r = await act(
			{ cdp, registry: reg },
			{ action: "fill", ref: "@e1", value: "hello" },
		);
		expect(r.ok).toBe(true);
		const insert = calls.find((c) => c.method === "Input.insertText");
		expect(insert?.params).toEqual({ text: "hello" });
	});

	it("fill preserves {{vault:xxx}} placeholder verbatim (no replacement here)", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp();
		const r = await act(
			{ cdp, registry: reg },
			{ action: "fill", ref: "@e1", value: "{{vault:github.password}}" },
		);
		expect(r.ok).toBe(true);
		const insert = calls.find((c) => c.method === "Input.insertText");
		expect(insert?.params).toEqual({ text: "{{vault:github.password}}" });
	});

	it("select uses Runtime.callFunctionOn with value arg", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp();
		const r = await act(
			{ cdp, registry: reg },
			{ action: "select", ref: "@e1", value: "opt-b" },
		);
		expect(r.ok).toBe(true);
		const fn = calls.find(
			(c) =>
				c.method === "Runtime.callFunctionOn" &&
				(c.params as Record<string, unknown> | undefined)?.arguments !==
					undefined,
		);
		expect(fn).toBeDefined();
	});

	it("press sends rawKeyDown → char → keyUp for single-char keys", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp();
		const r = await act(
			{ cdp, registry: reg },
			{ action: "press", ref: "@e1", value: "a" },
		);
		expect(r.ok).toBe(true);
		const types = calls
			.filter((c) => c.method === "Input.dispatchKeyEvent")
			.map((c) => (c.params as Record<string, unknown>).type);
		expect(types).toEqual(["rawKeyDown", "char", "keyUp"]);
	});

	it("press Enter skips char event (named key)", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp();
		const r = await act(
			{ cdp, registry: reg },
			{ action: "press", ref: "@e1", value: "Enter" },
		);
		expect(r.ok).toBe(true);
		const types = calls
			.filter((c) => c.method === "Input.dispatchKeyEvent")
			.map((c) => (c.params as Record<string, unknown>).type);
		expect(types).toEqual(["rawKeyDown", "keyUp"]);
	});

	it("scroll calls scrollIntoView via Runtime.callFunctionOn", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp();
		const r = await act(
			{ cdp, registry: reg },
			{ action: "scroll", ref: "@e1" },
		);
		expect(r.ok).toBe(true);
		expect(
			calls.some(
				(c) =>
					c.method === "Runtime.callFunctionOn" &&
					String(
						(c.params as Record<string, unknown>).functionDeclaration,
					).includes("scrollIntoView"),
			),
		).toBe(true);
	});

	it("check on an unchecked box triggers press+release", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp({
			"Runtime.callFunctionOn": () => ({
				result: { value: { tag: "input", type: "checkbox", checked: false } },
			}),
		});
		const r = await act(
			{ cdp, registry: reg },
			{ action: "check", ref: "@e1" },
		);
		expect(r.ok).toBe(true);
		const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent");
		expect(mouse.length).toBeGreaterThanOrEqual(2);
	});

	it("check on already-checked box is a no-op (no mouse events)", async () => {
		const reg = setupRegistry();
		const { cdp, calls } = mockCdp({
			"Runtime.callFunctionOn": () => ({
				result: { value: { tag: "input", type: "checkbox", checked: true } },
			}),
		});
		const r = await act(
			{ cdp, registry: reg },
			{ action: "check", ref: "@e1" },
		);
		expect(r.ok).toBe(true);
		const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent");
		expect(mouse).toHaveLength(0);
	});

	it("ref_invalid when registry has no entry", async () => {
		const reg = new RefRegistry();
		const { cdp } = mockCdp();
		const r = await act(
			{ cdp, registry: reg },
			{ action: "click", ref: "@e99" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("ref_invalid");
	});

	it("locator_not_found when Runtime.evaluate returns null subtype", async () => {
		const reg = new RefRegistry();
		const { cdp } = mockCdp({
			"Runtime.evaluate": () => ({ result: { subtype: "null" } }),
		});
		const r = await act(
			{ cdp, registry: reg },
			{
				action: "click",
				locator: { role: "button", name: "Missing" },
			},
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("locator_not_found");
	});

	it("locator path resolves via Runtime.evaluate when given role+name", async () => {
		const reg = new RefRegistry();
		const { cdp, calls } = mockCdp();
		const r = await act(
			{ cdp, registry: reg },
			{
				action: "click",
				locator: { role: "button", name: "Submit" },
			},
		);
		expect(r.ok).toBe(true);
		expect(calls.some((c) => c.method === "Runtime.evaluate")).toBe(true);
	});
});

describe("flagHighRisk", () => {
	const base = {
		action: "click" as const,
		options: { modifiers: [], clickCount: 1, delayMs: 0 },
	};

	it("returns password_field_write for fill on password", () => {
		const flags = flagHighRisk(
			{ isPassword: true },
			{
				...base,
				action: "fill",
				value: "x",
			},
		);
		expect(flags).toContain("password_field_write");
	});

	it("returns form_submit for click on submit button", () => {
		const flags = flagHighRisk({ isFormSubmit: true }, base);
		expect(flags).toContain("form_submit");
	});

	it("returns cross_origin_navigate on click with cross-origin href", () => {
		const flags = flagHighRisk(
			{ href: "https://evil.com/" },
			base,
			"https://good.com/page",
		);
		expect(flags).toContain("cross_origin_navigate");
	});

	it("same-origin href does not flag cross_origin_navigate", () => {
		const flags = flagHighRisk(
			{ href: "https://good.com/other" },
			base,
			"https://good.com/page",
		);
		expect(flags).not.toContain("cross_origin_navigate");
	});

	it("returns payment_field_write for fill on cc-number autocomplete", () => {
		const flags = flagHighRisk(
			{ autocomplete: "cc-number" },
			{
				...base,
				action: "fill",
				value: "4242424242424242",
			},
		);
		expect(flags).toContain("payment_field_write");
	});
});
