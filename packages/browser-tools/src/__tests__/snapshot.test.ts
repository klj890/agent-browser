/**
 * snapshot.ts unit tests — drive with a fake CDP that returns a canned AX tree.
 * Covers PLAN 附录 E test matrix.
 */
import { describe, expect, it } from "vitest";
import { RefRegistry } from "../ref-registry.js";
import { type AxNode, type AxTreeResponse, snapshot } from "../snapshot.js";

interface FakeTree {
	nodes: AxNode[];
}

function fakeCdp(tree: FakeTree) {
	return {
		send: async <T>(method: string): Promise<T> => {
			if (method === "Accessibility.getFullAXTree") {
				return tree as unknown as T;
			}
			if (method === "DOM.getDocument") {
				return { root: { nodeId: 1 } } as unknown as T;
			}
			if (method === "DOM.querySelector") {
				return { nodeId: 0 } as unknown as T;
			}
			if (method === "DOM.describeNode") {
				return { node: { backendNodeId: undefined } } as unknown as T;
			}
			return {} as T;
		},
	};
}

function node(
	id: string,
	role: string,
	name = "",
	overrides: Partial<AxNode> = {},
): AxNode {
	return {
		nodeId: id,
		role: { type: "role", value: role },
		name: { type: "string", value: name },
		...overrides,
	};
}

function link(
	id: string,
	parentId: string | undefined,
	name: string,
	backend: number,
): AxNode {
	return {
		nodeId: id,
		parentId,
		role: { type: "role", value: "link" },
		name: { type: "string", value: name },
		backendDOMNodeId: backend,
	};
}

function basicTree(): AxTreeResponse {
	return {
		nodes: [
			node("1", "WebArea", "Page", { childIds: ["2", "3"] }),
			{
				...node("2", "main", "", { parentId: "1", childIds: ["4"] }),
			},
			{
				...node("3", "navigation", "", { parentId: "1", childIds: ["5"] }),
			},
			link("4", "2", "Docs", 100),
			link("5", "3", "Home", 101),
		],
	};
}

describe("snapshot", () => {
	it("emits boundary wrapper with url/title", async () => {
		const registry = new RefRegistry();
		const r = await snapshot(
			{
				cdp: fakeCdp(basicTree()),
				registry,
				pageUrl: "https://e.com",
				pageTitle: "E",
			},
			{},
		);
		expect(r.text).toContain('<untrusted_page_content boundary="');
		expect(r.text).toContain("url: https://e.com");
		expect(r.text).toContain("title: E");
	});

	it("landmarks render as section markers --- MAIN ---", async () => {
		const registry = new RefRegistry();
		const r = await snapshot(
			{ cdp: fakeCdp(basicTree()), registry, pageUrl: "u", pageTitle: "t" },
			{},
		);
		expect(r.text).toContain("--- MAIN ---");
		expect(r.text).toContain("--- NAVIGATION ---");
	});

	it("password input is redacted: value gone, name replaced", async () => {
		const registry = new RefRegistry();
		const tree: AxTreeResponse = {
			nodes: [
				node("1", "WebArea", "", { childIds: ["2"] }),
				{
					nodeId: "2",
					parentId: "1",
					role: { type: "role", value: "textbox" },
					name: { type: "string", value: "Password" },
					value: { type: "string", value: "hunter2" },
					backendDOMNodeId: 10,
					properties: [
						{ name: "inputType", value: { type: "string", value: "password" } },
					],
				},
			],
		};
		const r = await snapshot(
			{ cdp: fakeCdp(tree), registry, pageUrl: "u", pageTitle: "t" },
			{},
		);
		expect(r.text).not.toContain("hunter2");
		expect(r.text).toContain("[password field]");
	});

	it("hidden input is dropped entirely", async () => {
		const registry = new RefRegistry();
		const tree: AxTreeResponse = {
			nodes: [
				node("1", "WebArea", "", { childIds: ["2", "3"] }),
				{
					nodeId: "2",
					parentId: "1",
					role: { type: "role", value: "textbox" },
					name: { type: "string", value: "csrf-secret" },
					backendDOMNodeId: 20,
					properties: [
						{ name: "inputType", value: { type: "string", value: "hidden" } },
					],
				},
				link("3", "1", "visible", 21),
			],
		};
		const r = await snapshot(
			{ cdp: fakeCdp(tree), registry, pageUrl: "u", pageTitle: "t" },
			{},
		);
		expect(r.text).not.toContain("csrf-secret");
		expect(r.text).toContain("visible");
	});

	it("cc-number autocomplete becomes [credit card field]", async () => {
		const registry = new RefRegistry();
		const tree: AxTreeResponse = {
			nodes: [
				node("1", "WebArea", "", { childIds: ["2"] }),
				{
					nodeId: "2",
					parentId: "1",
					role: { type: "role", value: "textbox" },
					name: { type: "string", value: "Card" },
					backendDOMNodeId: 30,
					properties: [
						{
							name: "autocomplete",
							value: { type: "string", value: "cc-number" },
						},
					],
				},
			],
		};
		const r = await snapshot(
			{ cdp: fakeCdp(tree), registry, pageUrl: "u", pageTitle: "t" },
			{},
		);
		expect(r.text).toContain("[credit card field]");
		expect(r.text).not.toContain('"Card"');
	});

	it("max_depth cuts off deeper nodes and marks truncated", async () => {
		const registry = new RefRegistry();
		// Build a linear chain 50 deep, each holding a button.
		const nodes: AxNode[] = [];
		for (let i = 0; i < 50; i++) {
			nodes.push({
				nodeId: String(i + 1),
				parentId: i === 0 ? undefined : String(i),
				role: {
					type: "role",
					value: i % 3 === 0 ? "button" : "generic",
				},
				name: { type: "string", value: `lvl${i}` },
				childIds: i < 49 ? [String(i + 2)] : [],
				backendDOMNodeId: 1000 + i,
			});
		}
		const r = await snapshot(
			{
				cdp: fakeCdp({ nodes }),
				registry,
				pageUrl: "u",
				pageTitle: "t",
			},
			{ max_depth: 5 },
		);
		expect(r.truncated).toBe(true);
		// Shallow buttons appear, deep ones don't.
		expect(r.text).toContain("lvl0");
		expect(r.text).not.toContain("lvl48");
	});

	it("budget trimming drops distant interactives and leaves trailing note", async () => {
		const registry = new RefRegistry();
		const nodes: AxNode[] = [
			node("1", "WebArea", "", { childIds: [] as string[] }),
		];
		const kids: string[] = [];
		for (let i = 0; i < 200; i++) {
			const nid = String(i + 2);
			kids.push(nid);
			nodes.push({
				nodeId: nid,
				parentId: "1",
				role: { type: "role", value: "button" },
				name: { type: "string", value: `BTN-${i}-${"x".repeat(20)}` },
				backendDOMNodeId: 5000 + i,
				properties: [
					{
						name: "bounds",
						value: {
							type: "object",
							value: { y: i * 100, height: 20 },
						},
					},
				],
			});
		}
		(nodes[0] as AxNode).childIds = kids;
		const r = await snapshot(
			{
				cdp: fakeCdp({ nodes }),
				registry,
				pageUrl: "u",
				pageTitle: "t",
			},
			{ budget_bytes: 2000 },
		);
		expect(r.bytesAfterBudget).toBeLessThanOrEqual(3000);
		expect(r.truncated).toBe(true);
		expect(r.text).toMatch(/more elements|use scope/);
	});

	it("boundary tokens are unique across 100 calls", async () => {
		const seen = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const registry = new RefRegistry();
			const r = await snapshot(
				{
					cdp: fakeCdp(basicTree()),
					registry,
					pageUrl: "u",
					pageTitle: "t",
				},
				{},
			);
			expect(seen.has(r.boundary)).toBe(false);
			seen.add(r.boundary);
		}
		expect(seen.size).toBe(100);
	});

	it("interactive_only=true drops plain text content", async () => {
		const registry = new RefRegistry();
		const tree: AxTreeResponse = {
			nodes: [
				node("1", "WebArea", "", { childIds: ["2", "3"] }),
				{
					nodeId: "2",
					parentId: "1",
					role: { type: "role", value: "StaticText" },
					name: { type: "string", value: "plain paragraph text" },
				},
				link("3", "1", "click me", 99),
			],
		};
		const r = await snapshot(
			{ cdp: fakeCdp(tree), registry, pageUrl: "u", pageTitle: "t" },
			{ interactive_only: true, include_text: true },
		);
		expect(r.text).toContain("click me");
		expect(r.text).not.toContain("plain paragraph text");
	});

	it("interactive_only=false + include_text=true keeps text", async () => {
		const registry = new RefRegistry();
		const tree: AxTreeResponse = {
			nodes: [
				node("1", "WebArea", "", { childIds: ["2", "3"] }),
				{
					nodeId: "2",
					parentId: "1",
					role: { type: "role", value: "StaticText" },
					name: { type: "string", value: "story text body" },
				},
				link("3", "1", "click me", 99),
			],
		};
		const r = await snapshot(
			{ cdp: fakeCdp(tree), registry, pageUrl: "u", pageTitle: "t" },
			{ interactive_only: false, include_text: true },
		);
		expect(r.text).toContain("story text body");
		expect(r.text).toContain("click me");
	});

	it("allocates refs on interactive nodes and reuses them on re-snapshot", async () => {
		const registry = new RefRegistry();
		const tree = basicTree();
		const r1 = await snapshot(
			{ cdp: fakeCdp(tree), registry, pageUrl: "u", pageTitle: "t" },
			{},
		);
		const r2 = await snapshot(
			{ cdp: fakeCdp(tree), registry, pageUrl: "u", pageTitle: "t" },
			{},
		);
		expect(r1.refsCount).toBe(2);
		expect(r2.refsCount).toBe(2);
		// Same backend nodes → same refs across calls
		const refs1 = (r1.text.match(/@e\d+/g) ?? []).sort();
		const refs2 = (r2.text.match(/@e\d+/g) ?? []).sort();
		expect(refs1).toEqual(refs2);
	});

	it("respects scope selector when CDP resolves it", async () => {
		const registry = new RefRegistry();
		const tree: AxTreeResponse = {
			nodes: [
				node("1", "WebArea", "", { childIds: ["2", "3"] }),
				{
					nodeId: "2",
					parentId: "1",
					role: { type: "role", value: "main" },
					name: { type: "string", value: "" },
					backendDOMNodeId: 500,
					childIds: ["4"],
				},
				link("3", "1", "outside", 600),
				link("4", "2", "inside", 700),
			],
		};
		const cdp = {
			send: async <T>(method: string): Promise<T> => {
				if (method === "Accessibility.getFullAXTree") {
					return tree as unknown as T;
				}
				if (method === "DOM.getDocument") {
					return { root: { nodeId: 1 } } as unknown as T;
				}
				if (method === "DOM.querySelector") {
					return { nodeId: 12 } as unknown as T;
				}
				if (method === "DOM.describeNode") {
					return { node: { backendNodeId: 500 } } as unknown as T;
				}
				return {} as T;
			},
		};
		const r = await snapshot(
			{ cdp, registry, pageUrl: "u", pageTitle: "t" },
			{ scope: ".main" },
		);
		expect(r.text).toContain("inside");
		expect(r.text).not.toContain("outside");
	});
});
