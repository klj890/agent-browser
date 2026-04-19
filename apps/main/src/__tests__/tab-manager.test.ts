/**
 * TabManager unit tests — mock Electron BrowserView via injected factory.
 * Covers: create, close, focus (including auto-promote), undoClose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BrowserViewLike,
	TabManager,
	type TabManagerDeps,
} from "../tab-manager.js";

// Minimal BrowserView fake
function makeFakeView(): BrowserViewLike & {
	_emit: (event: string, ...args: unknown[]) => void;
	_destroyed: boolean;
} {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const state = { url: "", title: "", destroyed: false };
	const wc = {
		loadURL: vi.fn(async (url: string) => {
			state.url = url;
		}),
		getURL: () => state.url,
		getTitle: () => state.title,
		goBack: vi.fn(),
		goForward: vi.fn(),
		reload: vi.fn(),
		close: vi.fn(() => {
			state.destroyed = true;
		}),
		isDestroyed: () => state.destroyed,
		on: (event: string, listener: (...args: unknown[]) => void) => {
			const arr = listeners.get(event) ?? [];
			arr.push(listener);
			listeners.set(event, arr);
		},
	};
	return {
		webContents: wc,
		setBounds: vi.fn(),
		setAutoResize: vi.fn(),
		_emit: (event: string, ...args: unknown[]) => {
			for (const l of listeners.get(event) ?? []) l(...args);
		},
		get _destroyed() {
			return state.destroyed;
		},
	} as BrowserViewLike & {
		_emit: (event: string, ...args: unknown[]) => void;
		_destroyed: boolean;
	};
}

function makeFakeWindow() {
	return {
		setBrowserView: vi.fn(),
		removeBrowserView: vi.fn(),
		getContentSize: () => [1280, 800],
		on: vi.fn(),
	};
}

function setup(): {
	tm: TabManager;
	views: Array<ReturnType<typeof makeFakeView>>;
	win: ReturnType<typeof makeFakeWindow>;
} {
	const views: Array<ReturnType<typeof makeFakeView>> = [];
	const win = makeFakeWindow();
	const deps: TabManagerDeps = {
		window: win as never,
		createView: () => {
			const v = makeFakeView();
			views.push(v);
			return v;
		},
	};
	return { tm: new TabManager(deps), views, win };
}

describe("TabManager", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("create() returns a unique id, loads url, activates by default", () => {
		const { tm, views, win } = setup();
		const a = tm.create("https://a.example.com");
		const b = tm.create("https://b.example.com");
		expect(a).not.toEqual(b);
		expect(views).toHaveLength(2);
		expect(views[0]?.webContents.loadURL).toHaveBeenCalledWith(
			"https://a.example.com",
		);
		// second create should focus b (attaching it)
		expect(tm.getActiveId()).toBe(b);
		expect(win.setBrowserView).toHaveBeenCalled();
		const summary = tm.list();
		expect(summary).toHaveLength(2);
		expect(summary.find((t) => t.id === b)?.active).toBe(true);
		expect(summary.find((t) => t.id === a)?.active).toBe(false);
	});

	it("focus() swaps the active view by detaching the previous", () => {
		const { tm, win } = setup();
		const a = tm.create("https://a.example.com");
		tm.create("https://b.example.com"); // b now active
		win.removeBrowserView.mockClear();
		tm.focus(a);
		expect(tm.getActiveId()).toBe(a);
		// removeBrowserView called once to detach b before attaching a
		expect(win.removeBrowserView).toHaveBeenCalledTimes(1);
	});

	it("close() promotes another tab when the active one is closed", () => {
		const { tm } = setup();
		const a = tm.create("https://a.example.com");
		const b = tm.create("https://b.example.com"); // active
		tm.close(b);
		expect(tm.getActiveId()).toBe(a);
		expect(tm.list().map((t) => t.id)).toEqual([a]);
	});

	it("undoClose() restores the most recently closed tab", () => {
		const { tm } = setup();
		const a = tm.create("https://a.example.com");
		tm.close(a);
		expect(tm.list()).toHaveLength(0);
		const restored = tm.undoClose();
		expect(restored).toBeDefined();
		expect(tm.list()).toHaveLength(1);
		expect(tm.list()[0]?.url).toBe("https://a.example.com");
		// stack drained
		expect(tm.undoClose()).toBeUndefined();
	});

	it("event handlers update state → idle and title on did-finish-load", () => {
		const { tm, views } = setup();
		const id = tm.create("https://a.example.com");
		const view = views[0];
		expect(view).toBeDefined();
		if (!view) return;
		// state begins as loading
		expect(tm.list().find((t) => t.id === id)?.state).toBe("loading");
		view._emit("did-finish-load");
		expect(tm.list().find((t) => t.id === id)?.state).toBe("idle");
		view._emit("page-title-updated", null, "Hello Page");
		expect(tm.list().find((t) => t.id === id)?.title).toBe("Hello Page");
		view._emit("render-process-gone");
		expect(tm.list().find((t) => t.id === id)?.state).toBe("crashed");
	});

	it("navigate() re-loads the url on an existing tab", () => {
		const { tm, views } = setup();
		const id = tm.create("https://a.example.com");
		const view = views[0];
		expect(view).toBeDefined();
		if (!view) return;
		tm.navigate(id, "https://b.example.com");
		expect(view.webContents.loadURL).toHaveBeenLastCalledWith(
			"https://b.example.com",
		);
		expect(tm.list().find((t) => t.id === id)?.url).toBe(
			"https://b.example.com",
		);
	});
});
