/**
 * e2e #1 — Basic browse acceptance.
 *
 * Drive TabManager with mock BrowserViews to verify the state machine from
 * PLAN.md scenario 1 (create 5 tabs, switch, close, undoClose). This is a
 * pure state-machine exercise; we do not launch a real Electron window.
 */

import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { BrowserViewLike } from "../apps/main/src/tab-manager.js";
import { TabManager } from "../apps/main/src/tab-manager.js";

function stubView(): BrowserViewLike {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	let url = "about:blank";
	return {
		webContents: {
			loadURL: async (u: string) => {
				url = u;
			},
			getURL: () => url,
			getTitle: () => "t",
			goBack: vi.fn(),
			goForward: vi.fn(),
			reload: vi.fn(),
			close: vi.fn(),
			on: (event, listener) => {
				listeners.set(event, listener);
			},
			isDestroyed: () => false,
		},
		setBounds: vi.fn(),
		setAutoResize: vi.fn(),
	};
}

function stubWindow(): BrowserWindow {
	return {
		setBrowserView: vi.fn(),
		removeBrowserView: vi.fn(),
		getContentSize: () => [1200, 800],
	} as unknown as BrowserWindow;
}

describe("e2e/basic-browse: 5 tabs, switch, close, undoClose", () => {
	it("creates 5 tabs and tracks the active one", () => {
		const mgr = new TabManager({
			window: stubWindow(),
			createView: () => stubView(),
		});
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push(mgr.create(`https://e${i}.example/`));
		expect(mgr.list()).toHaveLength(5);
		expect(mgr.getActiveId()).toBe(ids[4]);
	});

	it("switches active tab via focus()", () => {
		const mgr = new TabManager({
			window: stubWindow(),
			createView: () => stubView(),
		});
		const a = mgr.create("https://a/");
		const b = mgr.create("https://b/");
		mgr.focus(a);
		expect(mgr.getActiveId()).toBe(a);
		mgr.focus(b);
		expect(mgr.getActiveId()).toBe(b);
	});

	it("closes active tab and promotes another", () => {
		const mgr = new TabManager({
			window: stubWindow(),
			createView: () => stubView(),
		});
		const a = mgr.create("https://a/");
		const b = mgr.create("https://b/");
		mgr.close(b);
		expect(mgr.list().map((t) => t.id)).toEqual([a]);
		expect(mgr.getActiveId()).toBe(a);
	});

	it("undoClose restores the last closed tab's URL", () => {
		const mgr = new TabManager({
			window: stubWindow(),
			createView: () => stubView(),
		});
		const a = mgr.create("https://alpha/");
		mgr.close(a);
		expect(mgr.list()).toHaveLength(0);
		const restored = mgr.undoClose();
		expect(restored).toBeDefined();
		const list = mgr.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.url).toBe("https://alpha/");
	});
});
