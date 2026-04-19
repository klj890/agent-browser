/**
 * TabManager — owns the BrowserView pool and tab lifecycle.
 *
 * Per附录 K (PLAN.md):
 *  - Main window holds ONE foreground BrowserView at a time; background tabs
 *    stay detached (removeBrowserView) to save compositor overhead.
 *  - Switching tabs = setBrowserView(targetView), not rebuild.
 *  - Closed tabs retained in a stack (last 10) so undoClose can restore.
 *
 * Note on BrowserView vs WebContentsView: BrowserView is marked deprecated in
 * Electron 30+ but still works in 33.x. We use it here for API simplicity; if
 * API breakage shows up in a future upgrade, swap to WebContentsView (same
 * conceptual model: attach/detach a webContents-backed view to a BaseWindow).
 */
import { RefRegistry } from "@agent-browser/browser-tools";
import { BrowserView, type BrowserWindow, type WebContents } from "electron";
import { nanoid } from "nanoid";
import { CdpAdapter } from "./cdp-adapter.js";

export type TabState = "loading" | "idle" | "suspended" | "crashed";

export interface TabSummary {
	id: string;
	url: string;
	title: string;
	favicon?: string;
	state: TabState;
	active: boolean;
	pinned: boolean;
	openedByAgent: boolean;
}

export interface Tab {
	id: string;
	groupId?: string;
	view: BrowserViewLike;
	state: TabState;
	url: string;
	title: string;
	favicon?: string;
	lastActiveAt: number;
	partition: string;
	pinned: boolean;
	openedByAgent: boolean;
	/** Allocated lazily on first Agent use (getTabCdp). Never during create(). */
	cdp?: CdpAdapter;
	/** RefRegistry scoped to this tab's page lifetime; cleared on nav/reload/close. */
	registry: RefRegistry;
}

export interface CreateTabOpts {
	partition?: string;
	openedByAgent?: boolean;
	background?: boolean;
}

interface ClosedTabRecord {
	url: string;
	partition: string;
	openedByAgent: boolean;
}

const CHROME_HEIGHT = 72; // tabstrip (32) + addressbar (40) approx
const SIDEBAR_WIDTH = 320;
const CLOSED_STACK_LIMIT = 10;

/**
 * Factory injected for testability. In production we use Electron's BrowserView.
 * In tests we inject a stub that mimics the subset of APIs TabManager touches.
 */
export interface BrowserViewLike {
	webContents: {
		loadURL: (url: string) => Promise<void>;
		getURL: () => string;
		getTitle: () => string;
		goBack: () => void;
		goForward: () => void;
		reload: () => void;
		close: () => void;
		on: (event: string, listener: (...args: unknown[]) => void) => void;
		isDestroyed: () => boolean;
		/** Optional — only present when running on real Electron (not mocks). */
		debugger?: unknown;
	};
	setBounds: (b: {
		x: number;
		y: number;
		width: number;
		height: number;
	}) => void;
	setAutoResize: (o: {
		width?: boolean;
		height?: boolean;
		horizontal?: boolean;
		vertical?: boolean;
	}) => void;
}

export interface TabManagerDeps {
	window: BrowserWindow;
	createView?: (partition: string) => BrowserViewLike;
}

export class TabManager {
	private readonly window: BrowserWindow;
	private readonly createView: (partition: string) => BrowserViewLike;
	private readonly tabs = new Map<string, Tab>();
	private activeTabId?: string;
	private readonly closedStack: ClosedTabRecord[] = [];
	private destroyed = false;

	constructor(deps: TabManagerDeps) {
		this.window = deps.window;
		this.createView = deps.createView ?? defaultCreateView;
	}

	/** Create a tab; by default it is activated (brought to foreground). */
	create(url: string, opts: CreateTabOpts = {}): string {
		if (this.destroyed) throw new Error("TabManager destroyed");
		const id = nanoid();
		const partition = opts.partition ?? "persist:default";
		const view = this.createView(partition);
		const tab: Tab = {
			id,
			view,
			state: "loading",
			url,
			title: url,
			lastActiveAt: Date.now(),
			partition,
			pinned: false,
			openedByAgent: opts.openedByAgent ?? false,
			registry: new RefRegistry(),
		};
		this.wireEvents(tab);
		this.tabs.set(id, tab);
		// Kick off load; we do not await — state transitions via events.
		void tab.view.webContents.loadURL(url).catch(() => {
			tab.state = "crashed";
		});
		if (!opts.background) this.focus(id);
		return id;
	}

	close(id: string): void {
		const tab = this.tabs.get(id);
		if (!tab) return;
		this.closedStack.push({
			url: tab.url,
			partition: tab.partition,
			openedByAgent: tab.openedByAgent,
		});
		if (this.closedStack.length > CLOSED_STACK_LIMIT) this.closedStack.shift();

		if (this.activeTabId === id) {
			// detach from window before destroying
			this.detachActive();
			this.activeTabId = undefined;
		}
		try {
			tab.cdp?.detach();
		} catch {
			/* ignore */
		}
		tab.registry.resetLifetime();
		try {
			if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
		} catch {
			// webContents may already be gone; ignore
		}
		this.tabs.delete(id);

		// Promote another tab if any remain and none is active.
		if (!this.activeTabId) {
			const next = this.tabs.keys().next();
			if (!next.done) this.focus(next.value);
		}
	}

	focus(id: string): void {
		const tab = this.tabs.get(id);
		if (!tab) return;
		if (this.activeTabId === id) return;
		this.detachActive();
		this.activeTabId = id;
		tab.lastActiveAt = Date.now();
		// setBrowserView is a no-op on headless/mocked windows in tests
		try {
			this.window.setBrowserView(tab.view as unknown as BrowserView);
		} catch {
			/* ignore */
		}
		this.applyBounds(tab.view);
	}

	list(): TabSummary[] {
		return Array.from(this.tabs.values()).map((t) => ({
			id: t.id,
			url: t.url,
			title: t.title,
			favicon: t.favicon,
			state: t.state,
			active: t.id === this.activeTabId,
			pinned: t.pinned,
			openedByAgent: t.openedByAgent,
		}));
	}

	getActiveId(): string | undefined {
		return this.activeTabId;
	}

	undoClose(): string | undefined {
		const rec = this.closedStack.pop();
		if (!rec) return undefined;
		return this.create(rec.url, {
			partition: rec.partition,
			openedByAgent: rec.openedByAgent,
		});
	}

	navigate(id: string, url: string): void {
		const tab = this.tabs.get(id);
		if (!tab) return;
		tab.url = url;
		tab.state = "loading";
		// Defensive: also clear registry here so agents can't see stale refs
		// before Electron's did-navigate event fires.
		tab.registry.resetLifetime();
		void tab.view.webContents.loadURL(url).catch(() => {
			tab.state = "crashed";
		});
	}

	goBack(id: string): void {
		this.tabs.get(id)?.view.webContents.goBack();
	}

	goForward(id: string): void {
		this.tabs.get(id)?.view.webContents.goForward();
	}

	reload(id: string): void {
		this.tabs.get(id)?.view.webContents.reload();
	}

	/** Call on window resize to keep the foreground view sized right. */
	handleResize(): void {
		if (!this.activeTabId) return;
		const tab = this.tabs.get(this.activeTabId);
		if (tab) this.applyBounds(tab.view);
	}

	/**
	 * Return (and lazily allocate) a CdpAdapter for the tab. Called by the
	 * agent-host when it first needs to snapshot / act on a tab. Attaching is
	 * deferred to here on purpose — tabs the agent never touches should not
	 * pay CDP overhead.
	 */
	getTabCdp(id: string): CdpAdapter | undefined {
		const tab = this.tabs.get(id);
		if (!tab) return undefined;
		if (!tab.cdp) {
			const wc = tab.view.webContents as unknown as WebContents;
			// Only attach when we have a real Electron webContents.debugger.
			if (
				wc &&
				typeof (wc as unknown as { debugger: unknown }).debugger === "object"
			) {
				try {
					tab.cdp = new CdpAdapter(wc);
				} catch {
					return undefined;
				}
			}
		}
		return tab.cdp;
	}

	/** Return the per-tab RefRegistry. Stable across snapshot calls until nav. */
	getTabRegistry(id: string): RefRegistry | undefined {
		return this.tabs.get(id)?.registry;
	}

	destroy(): void {
		this.destroyed = true;
		for (const tab of this.tabs.values()) {
			try {
				tab.cdp?.detach();
			} catch {
				/* ignore */
			}
			try {
				if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
			} catch {
				/* ignore */
			}
		}
		this.tabs.clear();
		this.activeTabId = undefined;
		this.closedStack.length = 0;
	}

	// TODO(附录 K 步骤 3): auto-suspend tabs inactive > 10min (non-pinned).
	// Skipped in Stage 1.3; to be added alongside tab-group + pinned UX.

	// ---- internals ----

	private wireEvents(tab: Tab): void {
		const wc = tab.view.webContents;
		wc.on("did-finish-load", () => {
			tab.state = "idle";
			try {
				tab.url = wc.getURL();
				tab.title = wc.getTitle();
			} catch {
				/* ignore */
			}
		});
		// Clear ref registry whenever the page lifetime turns over. We listen for
		// both Electron's did-navigate AND the CDP-equivalent page-frame-navigated
		// to match PLAN 附录 E's resetLifetime contract.
		wc.on("did-navigate", () => {
			tab.registry.resetLifetime();
		});
		wc.on("page-frame-navigated", () => {
			tab.registry.resetLifetime();
		});
		wc.on("page-title-updated", (..._args: unknown[]) => {
			const title = _args[1];
			if (typeof title === "string") tab.title = title;
		});
		wc.on("page-favicon-updated", (..._args: unknown[]) => {
			const favicons = _args[1];
			if (Array.isArray(favicons) && typeof favicons[0] === "string") {
				tab.favicon = favicons[0];
			}
		});
		wc.on("render-process-gone", () => {
			tab.state = "crashed";
		});
	}

	private detachActive(): void {
		if (!this.activeTabId) return;
		const active = this.tabs.get(this.activeTabId);
		if (!active) return;
		try {
			this.window.removeBrowserView(active.view as unknown as BrowserView);
		} catch {
			/* ignore */
		}
	}

	private applyBounds(view: BrowserViewLike): void {
		try {
			const [w, h] = this.window.getContentSize();
			view.setBounds({
				x: 0,
				y: CHROME_HEIGHT,
				width: Math.max(0, (w ?? 0) - SIDEBAR_WIDTH),
				height: Math.max(0, (h ?? 0) - CHROME_HEIGHT),
			});
			view.setAutoResize({ width: true, height: true });
		} catch {
			/* test windows without bounds — ignore */
		}
	}
}

function defaultCreateView(partition: string): BrowserViewLike {
	const view = new BrowserView({
		webPreferences: {
			partition,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	return view as unknown as BrowserViewLike;
}
