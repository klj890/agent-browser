/**
 * e2e #13 — ref snapshot token efficiency (PLAN scenario 12).
 *
 * Build a fake AX tree with 200+ nodes (mix of interactive + text + decorative).
 * Compare:
 *   - full JSON.stringify of the raw AX tree
 *   - snapshot({interactive_only: true}) output
 *
 * Acceptance (per PLAN): the ref snapshot is < 30% of the raw tree's bytes.
 */
import { describe, expect, it } from "vitest";
import {
	RefRegistry,
	type SnapshotCdp,
	type SnapshotCtx,
	snapshot,
} from "../packages/browser-tools/src/index.js";

function fakeCdp(nodes: unknown[]): SnapshotCdp {
	return {
		async send<T = unknown>(method: string): Promise<T> {
			if (method === "Accessibility.getFullAXTree")
				return { nodes } as unknown as T;
			throw new Error(`unexpected CDP method ${method}`);
		},
	};
}

function mkNode(
	nodeId: string,
	role: string,
	name: string,
	parentId?: string,
	childIds?: string[],
) {
	// Add some filler properties to make "raw" tree realistically large.
	const properties = [
		{ name: "classList", value: { value: "a b c d e f" } },
		{ name: "id", value: { value: `dom-${nodeId}` } },
		{ name: "dataTracker", value: { value: "tracker-pixel-hash-aaaa-bbbb" } },
	];
	return {
		nodeId,
		parentId,
		childIds: childIds ?? [],
		role: { value: role },
		name: { value: name },
		properties,
		backendDOMNodeId: Number(nodeId),
	};
}

function buildTree(interactiveCount: number, decorativeCount: number) {
	const nodes: unknown[] = [];
	const rootChildren: string[] = [];
	let next = 2;
	for (let i = 0; i < interactiveCount; i++) {
		const id = String(next++);
		rootChildren.push(id);
		const roles = ["button", "link", "textbox", "checkbox"];
		nodes.push(mkNode(id, roles[i % 4] ?? "button", `Item ${i}`, "1"));
	}
	for (let i = 0; i < decorativeCount; i++) {
		const id = String(next++);
		rootChildren.push(id);
		nodes.push(mkNode(id, "generic", `decoration-${i}`.repeat(3), "1"));
	}
	nodes.unshift(
		mkNode("1", "RootWebArea", "Demo page", undefined, rootChildren),
	);
	return nodes;
}

describe("e2e/ref-snapshot-token-efficiency: interactive_only is compact", () => {
	it("interactive_only output is < 30% of the raw AX tree byte size", async () => {
		const nodes = buildTree(50, 200); // 250 nodes total, 50 interactive
		const raw = JSON.stringify(nodes);
		const rawBytes = Buffer.byteLength(raw, "utf8");

		const ctx: SnapshotCtx = {
			cdp: fakeCdp(nodes),
			registry: new RefRegistry(),
		};
		const result = await snapshot(ctx, {
			interactive_only: true,
			include_text: false,
		});
		const outBytes = Buffer.byteLength(result.text, "utf8");

		// Guardrail from PLAN.
		const ratio = outBytes / rawBytes;
		expect(ratio).toBeLessThan(0.3);
		// Sanity: we still emitted refs for the interactive nodes.
		expect(result.refsCount).toBeGreaterThan(0);
	});
});
