import { describe, expect, it } from "vitest";
import { htmlToText, read } from "../read.js";
import { RefRegistry } from "../ref-registry.js";

function makeCdp(html: string, opts: { selector?: boolean } = {}) {
	return {
		send: async <T>(method: string): Promise<T> => {
			if (method === "DOM.resolveNode") {
				return { object: { objectId: "obj-1" } } as unknown as T;
			}
			if (method === "Runtime.callFunctionOn") {
				return { result: { value: html } } as unknown as T;
			}
			if (method === "DOM.getDocument") {
				return { root: { nodeId: 1 } } as unknown as T;
			}
			if (method === "DOM.querySelector") {
				return { nodeId: opts.selector ? 2 : 0 } as unknown as T;
			}
			return {} as T;
		},
	};
}

describe("htmlToText", () => {
	it("strips tags and decodes entities", () => {
		const r = htmlToText("<p>Hello &amp; <b>world</b></p>");
		expect(r).toBe("Hello & world");
	});
	it("drops scripts and styles", () => {
		const r = htmlToText(
			"<p>keep</p><script>window.alert('x');</script><style>p{color:red}</style>",
		);
		expect(r).toContain("keep");
		expect(r).not.toContain("alert");
		expect(r).not.toContain("color");
	});
	it("numeric entity decodes", () => {
		expect(htmlToText("&#x1F600;")).toBe("😀");
		expect(htmlToText("&#65;")).toBe("A");
	});
});

describe("read", () => {
	it("ref path returns plain text wrapped in boundary", async () => {
		const reg = new RefRegistry();
		reg.allocate({ backendNodeId: 1, role: "heading", name: "H" });
		const cdp = makeCdp("<h1>Hello &amp; World</h1>");
		const r = await read(
			{ cdp, registry: reg, pageUrl: "u", pageTitle: "t" },
			{ ref: "@e1" },
		);
		expect(r.ok).toBe(true);
		expect(r.text).toContain("Hello & World");
		expect(r.text).toContain('<untrusted_page_content boundary="');
	});

	it("selector path resolves via DOM.querySelector", async () => {
		const reg = new RefRegistry();
		const cdp = makeCdp("<div>body text</div>", { selector: true });
		const r = await read(
			{ cdp, registry: reg, pageUrl: "u", pageTitle: "t" },
			{ selector: ".content" },
		);
		expect(r.ok).toBe(true);
		expect(r.text).toContain("body text");
	});

	it("ref_invalid when ref not in registry", async () => {
		const reg = new RefRegistry();
		const cdp = makeCdp("<p>x</p>");
		const r = await read(
			{ cdp, registry: reg, pageUrl: "u", pageTitle: "t" },
			{ ref: "@e42" },
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("ref_invalid");
	});

	it("selector_not_found when DOM.querySelector returns 0", async () => {
		const reg = new RefRegistry();
		const cdp = makeCdp("<p>x</p>", { selector: false });
		const r = await read(
			{ cdp, registry: reg, pageUrl: "u", pageTitle: "t" },
			{ selector: ".nope" },
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("selector_not_found");
	});

	it("truncates long text and annotates (+N chars)", async () => {
		const reg = new RefRegistry();
		reg.allocate({ backendNodeId: 1, role: "article", name: "A" });
		const big = `<p>${"x".repeat(5000)}</p>`;
		const cdp = makeCdp(big);
		const r = await read(
			{ cdp, registry: reg, pageUrl: "u", pageTitle: "t" },
			{ ref: "@e1", maxChars: 100 },
		);
		expect(r.ok).toBe(true);
		expect(r.truncated).toBe(true);
		expect(r.text).toMatch(/\+\d+ chars/);
	});
});
