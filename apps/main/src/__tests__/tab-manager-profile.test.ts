/**
 * TabManager incognito + profile routing (P1-12).
 */
import { describe, expect, it, vi } from "vitest";
import {
	type BrowserViewLike,
	TabManager,
	type TabManagerDeps,
} from "../tab-manager.js";

function makeView(): BrowserViewLike {
	return {
		webContents: {
			loadURL: vi.fn(async () => {}),
			getURL: () => "",
			getTitle: () => "",
			goBack: vi.fn(),
			goForward: vi.fn(),
			reload: vi.fn(),
			close: vi.fn(),
			isDestroyed: () => false,
			on: vi.fn(),
		},
		setBounds: vi.fn(),
		setAutoResize: vi.fn(),
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

function setup(extra: Partial<TabManagerDeps> = {}): {
	tm: TabManager;
	partitions: string[];
	onIncognitoEmpty: ReturnType<typeof vi.fn>;
} {
	const partitions: string[] = [];
	const onIncognitoEmpty = vi.fn();
	const deps: TabManagerDeps = {
		window: makeWin() as never,
		createView: (p: string) => {
			partitions.push(p);
			return makeView();
		},
		onIncognitoPartitionEmpty: onIncognitoEmpty,
		...extra,
	};
	return { tm: new TabManager(deps), partitions, onIncognitoEmpty };
}

describe("TabManager incognito + profile", () => {
	it("incognito: true generates an incognito partition", () => {
		const { tm, partitions } = setup();
		tm.create("https://a.example/", { incognito: true });
		expect(partitions).toHaveLength(1);
		expect(partitions[0]?.startsWith("incognito:")).toBe(true);
		const s = tm.list()[0];
		expect(s?.isIncognito).toBe(true);
		expect(s?.profileId).toBeUndefined();
	});

	it("profileId resolves through resolveProfilePartition", () => {
		const resolve = vi.fn((id: string) =>
			id === "work" ? "persist:profile-work" : undefined,
		);
		const { tm, partitions } = setup({ resolveProfilePartition: resolve });
		tm.create("https://a/", { profileId: "work" });
		expect(partitions[0]).toBe("persist:profile-work");
		expect(tm.list()[0]?.profileId).toBe("work");
		expect(resolve).toHaveBeenCalledWith("work");
	});

	it("falls back to persist:default when no profileId and no resolver", () => {
		const { tm, partitions } = setup();
		tm.create("https://a/");
		expect(partitions[0]).toBe("persist:default");
		expect(tm.list()[0]?.isIncognito).toBe(false);
	});

	it("throws if both incognito and profileId are given", () => {
		const { tm } = setup();
		expect(() =>
			tm.create("https://a/", { incognito: true, profileId: "work" }),
		).toThrow();
	});

	it("onIncognitoPartitionEmpty fires only when the last incognito tab closes", () => {
		const { tm, onIncognitoEmpty } = setup();
		const a = tm.create("https://a/", { incognito: true });
		// Force both incognito tabs into the SAME partition by passing partition through.
		const sharedPartition = tm.list()[0]?.partition;
		expect(sharedPartition).toBeDefined();
		if (!sharedPartition) return;
		const b = tm.create("https://b/", { partition: sharedPartition });
		expect(tm.list()[1]?.isIncognito).toBe(true);
		tm.close(a);
		expect(onIncognitoEmpty).not.toHaveBeenCalled();
		tm.close(b);
		expect(onIncognitoEmpty).toHaveBeenCalledWith(sharedPartition);
	});

	it("non-incognito tab close does not invoke the hook", () => {
		const { tm, onIncognitoEmpty } = setup();
		const id = tm.create("https://a/");
		tm.close(id);
		expect(onIncognitoEmpty).not.toHaveBeenCalled();
	});
});

describe("TabManager navigationHook gets incognito context", () => {
	it("includes isIncognito + profileId in ctx", () => {
		const onNavigate = vi.fn();
		const view = makeView();
		const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
		view.webContents.on = (event: string, cb: (...args: unknown[]) => void) => {
			const arr = listeners.get(event) ?? [];
			arr.push(cb);
			listeners.set(event, arr);
		};
		const deps: TabManagerDeps = {
			window: makeWin() as never,
			createView: () => view,
			navigationHook: { onNavigate },
		};
		const tm = new TabManager(deps);
		tm.create("https://a/", { incognito: true });
		for (const l of listeners.get("did-navigate") ?? []) l();
		expect(onNavigate).toHaveBeenCalledTimes(1);
		const ctx = onNavigate.mock.calls[0]?.[3] as {
			isIncognito: boolean;
			profileId?: string;
		};
		expect(ctx.isIncognito).toBe(true);
	});
});
