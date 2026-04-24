/**
 * Unit tests for the TabController adapter that wraps TabManager for the
 * Agent. Uses a minimal in-memory fake of the TabManager public surface so
 * the test stays off Electron.
 */
import { describe, expect, it } from "vitest";
import { createTabControllerForAgent } from "../agent-host-factory.js";
import type { TabManager } from "../tab-manager.js";

interface FakeTabRow {
	id: string;
	url: string;
	title: string;
	openedByAgent: boolean;
	state: "loading" | "idle" | "crashed" | "suspended";
}

function fakeTabManager(rows: FakeTabRow[]): TabManager {
	const store = new Map<string, FakeTabRow>();
	for (const r of rows) store.set(r.id, r);
	let nextId = 100;
	return {
		list: () =>
			Array.from(store.values()).map((t) => ({
				id: t.id,
				url: t.url,
				title: t.title,
				state: t.state,
				active: false,
				pinned: false,
				openedByAgent: t.openedByAgent,
				isIncognito: false,
				partition: "persist:default",
			})),
		create: (url: string) => {
			const id = `t${nextId++}`;
			store.set(id, {
				id,
				url,
				title: url,
				openedByAgent: true,
				state: "idle",
			});
			return id;
		},
		close: (id: string) => {
			store.delete(id);
		},
	} as unknown as TabManager;
}

describe("createTabControllerForAgent", () => {
	it("close() re-anchors activeAgentTab to another agent-owned tab when the active one is closed", () => {
		const tm = fakeTabManager([
			{
				id: "user",
				url: "u",
				title: "u",
				openedByAgent: false,
				state: "idle",
			},
			{ id: "a1", url: "a1", title: "a1", openedByAgent: true, state: "idle" },
			{ id: "a2", url: "a2", title: "a2", openedByAgent: true, state: "idle" },
		]);
		const ref = { id: "a1" };
		const ctrl = createTabControllerForAgent(tm, ref);
		ctrl.close("a1");
		expect(ref.id).toBe("a2"); // prefer another openedByAgent tab
	});

	it("close() falls back to any remaining tab when no agent tab survives", () => {
		const tm = fakeTabManager([
			{
				id: "user",
				url: "u",
				title: "u",
				openedByAgent: false,
				state: "idle",
			},
			{ id: "a1", url: "a1", title: "a1", openedByAgent: true, state: "idle" },
		]);
		const ref = { id: "a1" };
		const ctrl = createTabControllerForAgent(tm, ref);
		ctrl.close("a1");
		expect(ref.id).toBe("user"); // last resort
	});

	it("close() of a non-active tab leaves activeAgentTab unchanged", () => {
		const tm = fakeTabManager([
			{ id: "a1", url: "a1", title: "a1", openedByAgent: true, state: "idle" },
			{ id: "a2", url: "a2", title: "a2", openedByAgent: true, state: "idle" },
		]);
		const ref = { id: "a1" };
		const ctrl = createTabControllerForAgent(tm, ref);
		ctrl.close("a2");
		expect(ref.id).toBe("a1");
	});

	it("close() leaves the ref alone when no tabs remain (next tool call will surface the error)", () => {
		const tm = fakeTabManager([
			{ id: "a1", url: "a1", title: "a1", openedByAgent: true, state: "idle" },
		]);
		const ref = { id: "a1" };
		const ctrl = createTabControllerForAgent(tm, ref);
		ctrl.close("a1");
		expect(ref.id).toBe("a1");
	});

	it("waitLoad resolves 'not_found' when the tab disappears mid-poll", async () => {
		const tm = fakeTabManager([
			{
				id: "a1",
				url: "a1",
				title: "a1",
				openedByAgent: true,
				state: "loading",
			},
		]);
		const ref = { id: "a1" };
		const ctrl = createTabControllerForAgent(tm, ref);
		const promise = ctrl.waitLoad("a1", 2_000);
		// Remove it before the first poll tick completes.
		setTimeout(() => tm.close("a1"), 50);
		await expect(promise).resolves.toBe("not_found");
	});
});
