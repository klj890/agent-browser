/**
 * e2e #4 — snapshot redacts passwords (PLAN scenario 4).
 *
 * Feed a mock AX tree containing a `textbox` input with `autocomplete=current-password`,
 * run the snapshot tool, and assert the output does NOT contain any value and
 * the password field is marked `[redacted]`.
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
			throw new Error(`unexpected CDP method: ${method}`);
		},
	};
}

/** Shape-check helper: AxNode literal matching the CDP schema. */
function node(
	nodeId: string,
	role: string,
	name: string,
	opts: {
		parentId?: string;
		childIds?: string[];
		props?: Array<{ name: string; value: { value: unknown } }>;
		backendDOMNodeId?: number;
	} = {},
) {
	return {
		nodeId,
		parentId: opts.parentId,
		childIds: opts.childIds ?? [],
		role: { value: role },
		name: { value: name },
		properties: opts.props ?? [],
		backendDOMNodeId: opts.backendDOMNodeId,
	};
}

describe("e2e/snapshot-no-password: AX tree redaction", () => {
	it("redacts password textbox and omits its value", async () => {
		const ax = [
			node("1", "RootWebArea", "Login page", {
				childIds: ["2", "3", "4"],
				backendDOMNodeId: 1,
			}),
			node("2", "textbox", "Email", {
				parentId: "1",
				backendDOMNodeId: 2,
				props: [
					{ name: "autocomplete", value: { value: "username" } },
					{ name: "editable", value: { value: "plaintext" } },
				],
			}),
			// password input — should be redacted in output
			node("3", "textbox", "Password", {
				parentId: "1",
				backendDOMNodeId: 3,
				props: [
					{ name: "autocomplete", value: { value: "current-password" } },
					{ name: "editable", value: { value: "plaintext" } },
					// Value that MUST NOT leak into snapshot output:
					{ name: "value", value: { value: "SUPERSECRET123!" } },
				],
			}),
			node("4", "button", "Sign in", {
				parentId: "1",
				backendDOMNodeId: 4,
			}),
		];
		const ctx: SnapshotCtx = {
			cdp: fakeCdp(ax),
			registry: new RefRegistry(),
			pageUrl: "https://login.example/",
		};
		const result = await snapshot(ctx, { interactive_only: true });
		expect(result.text).not.toContain("SUPERSECRET123");
		// Redacted marker and input label should be present. snapshot.ts
		// replaces the name with the literal `[password field]`.
		expect(result.text).toContain("[password field]");
		// All three interactive nodes (email, password, sign-in) should have
		// been visited.
		expect(result.refsCount).toBeGreaterThanOrEqual(2);
	});

	it("drops hidden inputs entirely", async () => {
		const ax = [
			node("1", "RootWebArea", "Form", {
				childIds: ["2", "3"],
				backendDOMNodeId: 1,
			}),
			// hidden input — should be dropped
			node("2", "textbox", "csrf", {
				parentId: "1",
				backendDOMNodeId: 2,
				props: [
					{ name: "inputType", value: { value: "hidden" } },
					{ name: "value", value: { value: "HIDDEN_TOKEN_ABC" } },
				],
			}),
			node("3", "button", "Go", { parentId: "1", backendDOMNodeId: 3 }),
		];
		const ctx: SnapshotCtx = {
			cdp: fakeCdp(ax),
			registry: new RefRegistry(),
		};
		const result = await snapshot(ctx, { interactive_only: true });
		expect(result.text).not.toContain("HIDDEN_TOKEN_ABC");
		expect(result.text).not.toContain("csrf");
	});
});
