import { describe, expect, it, vi } from "vitest";
import {
	type BrowserViewLike,
	TabManager,
	type TabManagerDeps,
} from "../tab-manager.js";

function makeFakeView(): BrowserViewLike & {
	_emit: (event: string, ...args: unknown[]) => void;
} {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const state = { url: "https://initial.example/", title: "Init" };
	return {
		webContents: {
			loadURL: vi.fn(async (u: string) => {
				state.url = u;
			}),
			getURL: () => state.url,
			getTitle: () => state.title,
			goBack: vi.fn(),
			goForward: vi.fn(),
			reload: vi.fn(),
			close: vi.fn(),
			isDestroyed: () => false,
			on: (event, cb) => {
				const arr = listeners.get(event) ?? [];
				arr.push(cb);
				listeners.set(event, arr);
			},
		},
		setBounds: vi.fn(),
		setAutoResize: vi.fn(),
		_emit: (event, ...args) => {
			for (const l of listeners.get(event) ?? []) l(...args);
		},
	} as BrowserViewLike & {
		_emit: (event: string, ...args: unknown[]) => void;
	};
}

function makeWin() {
	return {
		setBrowserView: vi.fn(),
		removeBrowserView: vi.fn(),
		getContentSize: () => [1280, 800],
		on: vi.fn(),
	};
}

describe("TabManager navigationHook", () => {
	it("fires onNavigate with url/title on did-navigate", () => {
		const onNavigate = vi.fn();
		const views: Array<ReturnType<typeof makeFakeView>> = [];
		const deps: TabManagerDeps = {
			window: makeWin() as never,
			createView: () => {
				const v = makeFakeView();
				views.push(v);
				return v;
			},
			navigationHook: { onNavigate },
		};
		const tm = new TabManager(deps);
		const tabId = tm.create("https://example.com/");
		views[0]?._emit("did-navigate");
		expect(onNavigate).toHaveBeenCalledTimes(1);
		const [id, url, title] = onNavigate.mock.calls[0] ?? [];
		expect(id).toBe(tabId);
		expect(typeof url).toBe("string");
		expect(typeof title).toBe("string");
	});

	it("swallows hook exceptions", () => {
		const views: Array<ReturnType<typeof makeFakeView>> = [];
		const deps: TabManagerDeps = {
			window: makeWin() as never,
			createView: () => {
				const v = makeFakeView();
				views.push(v);
				return v;
			},
			navigationHook: {
				onNavigate: () => {
					throw new Error("boom");
				},
			},
		};
		const tm = new TabManager(deps);
		tm.create("https://example.com/");
		expect(() => views[0]?._emit("did-navigate")).not.toThrow();
	});
});
