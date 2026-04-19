/**
 * snapshot.ts — implements the algorithm in PLAN 附录 E.
 *
 * Flow:
 *   1. CDP Accessibility.getFullAXTree
 *   2. optional `scope` CSS selector → sub-tree root
 *   3. DFS with max_depth cutoff; classify nodes INTERACTIVE / LANDMARK / TEXT / CONTAINER
 *   4. hard-coded input redaction (password, hidden, cc-, one-time-code)
 *   5. allocate refs for interactive nodes via RefRegistry
 *   6. serialize to flat list with landmark section markers
 *   7. budget trim (TEXT names → 40c; then distant-viewport interactives)
 *   8. wrap with content-boundary
 */
import { z } from "zod";
import { wrapUntrusted } from "./content-boundary.js";
import type { RefRegistry } from "./ref-registry.js";

export const SnapshotInput = z.object({
	interactive_only: z.boolean().default(true),
	max_depth: z.number().int().positive().default(20),
	scope: z.string().optional(),
	include_text: z.boolean().default(true),
	include_landmarks: z.boolean().default(true),
	budget_bytes: z.number().int().positive().default(60_000),
});
export type SnapshotInput = z.infer<typeof SnapshotInput>;

export interface SnapshotResult {
	text: string;
	boundary: string;
	refsCount: number;
	bytesAfterBudget: number;
	truncated: boolean;
}

/** Minimal CDP surface snapshot needs. */
export interface SnapshotCdp {
	send<T = unknown>(method: string, params?: object): Promise<T>;
}

export interface SnapshotCtx {
	cdp: SnapshotCdp;
	registry: RefRegistry;
	pageUrl?: string;
	pageTitle?: string;
}

// ---- AX tree shape (subset) ----

interface AxProperty {
	name: string;
	value?: { type?: string; value?: unknown };
}

export interface AxNode {
	nodeId: string;
	backendDOMNodeId?: number;
	parentId?: string;
	childIds?: string[];
	role?: { type?: string; value?: unknown };
	name?: { type?: string; value?: unknown };
	value?: { type?: string; value?: unknown };
	description?: { type?: string; value?: unknown };
	ignored?: boolean;
	ignoredReasons?: unknown;
	properties?: AxProperty[];
}

export interface AxTreeResponse {
	nodes: AxNode[];
}

// ---- Role classification ----

const INTERACTIVE_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"checkbox",
	"radio",
	"menuitem",
	"tab",
	"switch",
	"searchbox",
	"slider",
]);

const LANDMARK_ROLES = new Set([
	"main",
	"navigation",
	"banner",
	"contentinfo",
	"complementary",
	"search",
	"form",
]);

const TEXT_ROLES = new Set(["heading", "paragraph", "StaticText", "text"]);

const PRESENTATION_ROLES = new Set(["presentation", "none"]);

type Category = "INTERACTIVE" | "LANDMARK" | "TEXT" | "CONTAINER" | "HEADING";

function categorize(role: string): Category {
	if (INTERACTIVE_ROLES.has(role)) return "INTERACTIVE";
	if (LANDMARK_ROLES.has(role)) return "LANDMARK";
	if (role === "heading") return "HEADING";
	if (TEXT_ROLES.has(role)) return "TEXT";
	return "CONTAINER";
}

// ---- Prop helpers ----

function strVal(v: AxNode["role"] | AxNode["name"]): string {
	const raw = v?.value;
	return typeof raw === "string" ? raw : "";
}

function propValue(node: AxNode, propName: string): unknown {
	for (const p of node.properties ?? []) {
		if (p.name === propName) return p.value?.value;
	}
	return undefined;
}

function propBool(node: AxNode, propName: string): boolean {
	return propValue(node, propName) === true;
}

// ---- Redaction detection ----

interface RedactionDecision {
	action: "keep" | "drop" | "password" | "payment";
}

function classifyInputRedaction(node: AxNode, role: string): RedactionDecision {
	const autoc = String(propValue(node, "autocomplete") ?? "").toLowerCase();
	// inputType prop varies across CDP builds; some pages expose it via properties.type
	const inputType = String(
		propValue(node, "inputType") ?? propValue(node, "type") ?? "",
	).toLowerCase();

	if (inputType === "hidden") return { action: "drop" };
	if (
		inputType === "password" ||
		(role === "textbox" && autoc === "current-password")
	) {
		return { action: "password" };
	}
	if (
		autoc === "cc-number" ||
		autoc === "cc-csc" ||
		autoc === "cc-exp" ||
		autoc === "one-time-code"
	) {
		return { action: "payment" };
	}
	return { action: "keep" };
}

// ---- Landmark section label ----

function landmarkLabel(role: string): string {
	return role.toUpperCase();
}

// ---- Serialization primitive ----

interface SerialNode {
	category: Category;
	role: string;
	name: string;
	ref?: string;
	depth: number;
	state: string[];
	viewportDistance: number; // |y - center| proxy; bigger = more trimmable
	textLength: number; // for TEXT trimming
	isText: boolean;
	isInteractive: boolean;
	// internal handle for trimming name
	_nameBox: { value: string };
}

function nodeStates(node: AxNode): string[] {
	const out: string[] = [];
	if (propBool(node, "disabled")) out.push("disabled");
	if (propBool(node, "checked")) out.push("checked");
	if (propBool(node, "expanded")) out.push("expanded");
	if (propBool(node, "selected")) out.push("selected");
	if (propBool(node, "focused")) out.push("focused");
	return out;
}

function nodeViewportDistance(node: AxNode): number {
	// We don't call DOM.getBoxModel here for perf; use a best-effort proxy.
	// Prefer bounds from AX properties if present.
	const bounds = propValue(node, "bounds") as
		| { y?: number; height?: number }
		| undefined;
	if (bounds && typeof bounds.y === "number") {
		return Math.abs(bounds.y);
	}
	return 0;
}

// ---- Main snapshot function ----

export async function snapshot(
	ctx: SnapshotCtx,
	rawInput: unknown,
): Promise<SnapshotResult> {
	const input = SnapshotInput.parse(rawInput ?? {});

	// Step 1: fetch AX tree
	const tree = await ctx.cdp.send<AxTreeResponse>(
		"Accessibility.getFullAXTree",
	);
	const nodes = tree.nodes ?? [];
	const byId = new Map<string, AxNode>();
	for (const n of nodes) byId.set(n.nodeId, n);

	// Step 2: determine root. We pick the node with no parent (or first node).
	let rootId: string | undefined;
	for (const n of nodes) {
		if (!n.parentId) {
			rootId = n.nodeId;
			break;
		}
	}
	if (!rootId && nodes.length > 0) rootId = nodes[0]?.nodeId;

	// If scope is provided, resolve via DOM.querySelector and find the matching AX node.
	if (input.scope && rootId) {
		try {
			const doc = await ctx.cdp.send<{ root: { nodeId: number } }>(
				"DOM.getDocument",
				{ depth: 0 },
			);
			const q = await ctx.cdp.send<{ nodeId: number }>("DOM.querySelector", {
				nodeId: doc.root.nodeId,
				selector: input.scope,
			});
			if (q?.nodeId) {
				// DOM.querySelector returns a DOM nodeId; AX nodes have backendDOMNodeId.
				// Resolve to backend id via DOM.describeNode.
				const d = await ctx.cdp.send<{
					node: { backendNodeId?: number };
				}>("DOM.describeNode", { nodeId: q.nodeId });
				const backend = d?.node?.backendNodeId;
				if (backend != null) {
					const match = nodes.find((n) => n.backendDOMNodeId === backend);
					if (match) rootId = match.nodeId;
				}
			}
		} catch {
			// Scope resolution is best-effort; on failure keep full tree.
		}
	}

	if (!rootId) {
		return finalize(ctx, input, [], false);
	}

	// Step 3 + 4 + 5: DFS collect serial nodes
	const serial: SerialNode[] = [];
	const seen = new Set<string>();
	let maxDepthHit = false;

	type Frame = { id: string; depth: number };
	const stack: Frame[] = [{ id: rootId, depth: 0 }];

	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) break;
		if (seen.has(frame.id)) continue;
		seen.add(frame.id);

		const node = byId.get(frame.id);
		if (!node) continue;

		const role = strVal(node.role);
		const name = strVal(node.name);
		const ignored = node.ignored === true;

		// skip presentation / ignored (but still recurse into children)
		const skipNode = PRESENTATION_ROLES.has(role) || ignored;

		if (!skipNode && role) {
			const cat = categorize(role);
			let display = true;
			const redaction = classifyInputRedaction(node, role);

			if (redaction.action === "drop") display = false;

			// depth cap
			if (frame.depth > input.max_depth) {
				display = false;
				maxDepthHit = true;
			}

			if (display) {
				// filter by interactive_only
				let keep = false;
				if (input.interactive_only) {
					keep =
						cat === "INTERACTIVE" ||
						(cat === "LANDMARK" && input.include_landmarks) ||
						cat === "HEADING";
				} else {
					keep =
						cat === "INTERACTIVE" ||
						(cat === "LANDMARK" && input.include_landmarks) ||
						cat === "HEADING" ||
						(cat === "TEXT" && input.include_text);
				}
				if (keep) {
					let displayName = name;
					if (redaction.action === "password") {
						displayName = "[password field]";
					} else if (redaction.action === "payment") {
						displayName = "[credit card field]";
					}
					const nameBox = { value: displayName };
					let ref: string | undefined;
					if (cat === "INTERACTIVE" && node.backendDOMNodeId != null) {
						ref = ctx.registry.allocate({
							backendNodeId: node.backendDOMNodeId,
							role,
							name: displayName,
						});
					}
					serial.push({
						category: cat,
						role,
						name: displayName,
						ref,
						depth: frame.depth,
						state: nodeStates(node),
						viewportDistance: nodeViewportDistance(node),
						textLength: displayName.length,
						isText: cat === "TEXT",
						isInteractive: cat === "INTERACTIVE",
						_nameBox: nameBox,
					});
				}
			}
		}

		// recurse into children (unless we hit depth cutoff)
		if (frame.depth <= input.max_depth) {
			const children = node.childIds ?? [];
			// Reverse so that pre-order traversal matches child order when popping.
			for (let i = children.length - 1; i >= 0; i--) {
				const cid = children[i];
				if (cid) stack.push({ id: cid, depth: frame.depth + 1 });
			}
		} else {
			maxDepthHit = true;
		}
	}

	// post-snapshot registry sweep
	ctx.registry.sweep(10 * 60_000);

	return finalize(ctx, input, serial, maxDepthHit);
}

function serializeLines(serial: SerialNode[]): string[] {
	const lines: string[] = [];
	for (const n of serial) {
		if (n.category === "LANDMARK") {
			lines.push(`--- ${landmarkLabel(n.role)} ---`);
			continue;
		}
		const indent = "  ".repeat(Math.max(0, n.depth));
		const parts: string[] = [];
		parts.push(indent);
		if (n.ref) parts.push(`${n.ref} `);
		parts.push(n.role);
		parts.push(` "${n._nameBox.value}"`);
		if (n.state.length > 0) {
			for (const s of n.state) parts.push(` [${s}]`);
		}
		lines.push(parts.join(""));
	}
	return lines;
}

function finalize(
	ctx: SnapshotCtx,
	input: SnapshotInput,
	serial: SerialNode[],
	maxDepthHit: boolean,
): SnapshotResult {
	const refCount = serial.filter((n) => n.ref).length;
	// Budget trim pass 1: shrink TEXT names to 40 chars.
	let body = serializeLines(serial).join("\n");
	const overhead = 120; // room for boundary wrapper & header
	let truncated = maxDepthHit;
	let trailingNote = "";

	const budget = input.budget_bytes;
	const byteSize = (s: string) => Buffer.byteLength(s, "utf8");

	if (byteSize(body) + overhead > budget) {
		for (const n of serial) {
			if (n.isText && n._nameBox.value.length > 40) {
				n._nameBox.value = `${n._nameBox.value.slice(0, 37)}...`;
			}
		}
		body = serializeLines(serial).join("\n");
	}

	if (byteSize(body) + overhead > budget) {
		// Budget trim pass 2: drop distant interactive nodes (by viewportDistance desc),
		// but always keep at least landmarks & headings.
		const removable = serial
			.filter((n) => n.isInteractive)
			.sort((a, b) => b.viewportDistance - a.viewportDistance);
		let removedCount = 0;
		for (const victim of removable) {
			const idx = serial.indexOf(victim);
			if (idx >= 0) {
				serial.splice(idx, 1);
				removedCount += 1;
				body = serializeLines(serial).join("\n");
				if (byteSize(body) + overhead <= budget) break;
			}
		}
		if (removedCount > 0) {
			trailingNote = `\n(+${removedCount} more elements, use scope= to narrow)`;
			truncated = true;
		}
	}

	if (byteSize(body) + overhead > budget) {
		// Hard truncate: chop the tail
		const target = budget - overhead - 60;
		const encoder = new TextEncoder();
		const encoded = encoder.encode(body);
		const cutoff =
			target > 0 && encoded.length > target
				? encoded.slice(0, target)
				: encoded;
		const decoder = new TextDecoder("utf-8", { fatal: false });
		body = decoder.decode(cutoff);
		trailingNote = "\n(+more elements, use scope= to narrow)";
		truncated = true;
	}

	const bodyWithNote = `${body}${trailingNote}`;

	const { text, boundary } = wrapUntrusted(bodyWithNote, {
		url: ctx.pageUrl,
		title: ctx.pageTitle,
	});

	return {
		text,
		boundary,
		refsCount: refCount,
		bytesAfterBudget: byteSize(text),
		truncated,
	};
}
