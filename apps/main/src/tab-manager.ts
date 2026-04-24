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
	/** True when the tab runs in an ephemeral incognito partition (P1-12). */
	isIncognito: boolean;
	/** Persistent profile id if the tab is bound to one; undefined for default/incognito. */
	profileId?: string;
	/** Electron session partition name — surfaced so renderer can group tabs by profile. */
	partition: string;
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
	isIncognito: boolean;
	profileId?: string;
	/** Allocated lazily on first Agent use (getTabCdp). Never during create(). */
	cdp?: CdpAdapter;
	/** RefRegistry scoped to this tab's page lifetime; cleared on nav/reload/close. */
	registry: RefRegistry;
}

export interface CreateTabOpts {
	partition?: string;
	/** Mutually exclusive with profileId — routes tab into a fresh incognito partition. */
	incognito?: boolean;
	/** Route tab into a named persistent profile partition. */
	profileId?: string;
	openedByAgent?: boolean;
	background?: boolean;
}

interface ClosedTabRecord {
	url: string;
	partition: string;
	openedByAgent: boolean;
	isIncognito: boolean;
	profileId?: string;
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
		/** Optional — used by reading-mode.extractArticle (P1-13). */
		executeJavaScript?: (
			code: string,
			userGesture?: boolean,
		) => Promise<unknown>;
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

export interface TabNavigationContext {
	isIncognito: boolean;
	profileId?: string;
	partition: string;
}

export interface TabNavigationHook {
	onNavigate?: (
		tabId: string,
		url: string,
		title: string,
		ctx: TabNavigationContext,
	) => void;
}

export interface TabManagerDeps {
	window: BrowserWindow;
	createView?: (partition: string) => BrowserViewLike;
	/** Optional nav hook — used by history + persona auto-switch. */
	navigationHook?: TabNavigationHook;
	/**
	 * Called when the last tab of an incognito partition closes. Implementers
	 * should clear Electron session storage for that partition so no cookies
	 * or localStorage survive in memory / on disk (P1-12).
	 */
	onIncognitoPartitionEmpty?: (partition: string) => void;
	/**
	 * Called the FIRST time a given partition is used by this TabManager.
	 * index.ts uses it to register per-session will-download listeners so
	 * non-default profiles and incognito downloads route through the
	 * DownloadManager instead of Electron's silent default pipeline.
	 */
	onPartitionSeen?: (
		partition: string,
		ctx: { isIncognito: boolean; profileId?: string },
	) => void;
	/**
	 * Default profile id. When create() receives neither incognito nor profileId,
	 * the tab inherits this profile (defaults to persist:default).
	 */
	defaultProfileId?: string;
	/** Resolve a profileId → partition string. Injected by index.ts using ProfileStore. */
	resolveProfilePartition?: (profileId: string) => string | undefined;
}

export class TabManager {
	private readonly window: BrowserWindow;
	private readonly createView: (partition: string) => BrowserViewLike;
	private readonly navigationHook?: TabNavigationHook;
	private readonly onIncognitoPartitionEmpty?: (partition: string) => void;
	private readonly onPartitionSeen?: (
		partition: string,
		ctx: { isIncognito: boolean; profileId?: string },
	) => void;
	private readonly seenPartitions = new Set<string>();
	private readonly defaultProfileId: string;
	private readonly resolveProfilePartition?: (
		profileId: string,
	) => string | undefined;
	private readonly tabs = new Map<string, Tab>();
	private activeTabId?: string;
	private readonly closedStack: ClosedTabRecord[] = [];
	private destroyed = false;

	constructor(deps: TabManagerDeps) {
		this.window = deps.window;
		this.createView = deps.createView ?? defaultCreateView;
		this.navigationHook = deps.navigationHook;
		this.onIncognitoPartitionEmpty = deps.onIncognitoPartitionEmpty;
		this.onPartitionSeen = deps.onPartitionSeen;
		this.defaultProfileId = deps.defaultProfileId ?? "default";
		this.resolveProfilePartition = deps.resolveProfilePartition;
	}

	/** Create a tab; by default it is activated (brought to foreground). */
	create(url: string, opts: CreateTabOpts = {}): string {
		if (this.destroyed) throw new Error("TabManager destroyed");
		if (opts.incognito && opts.profileId) {
			throw new Error("tab cannot be both incognito and bound to a profile");
		}
		const id = nanoid();
		const { partition, profileId, isIncognito } = this.resolvePartition(opts);
		// Notify on first use of a partition so hosts (DownloadManager) can
		// wire per-session listeners. Fires BEFORE createView so the
		// will-download handler is live when Electron dispatches events from
		// the new Session.
		if (!this.seenPartitions.has(partition)) {
			this.seenPartitions.add(partition);
			try {
				this.onPartitionSeen?.(partition, { isIncognito, profileId });
			} catch (err) {
				console.warn("[tab-manager] onPartitionSeen threw:", err);
			}
		}
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
			isIncognito,
			profileId,
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

	private resolvePartition(opts: CreateTabOpts): {
		partition: string;
		profileId?: string;
		isIncognito: boolean;
	} {
		if (opts.partition) {
			const isIncognito = opts.partition.startsWith("incognito:");
			return {
				partition: opts.partition,
				profileId: opts.profileId,
				isIncognito,
			};
		}
		if (opts.incognito) {
			return {
				partition: `incognito:${nanoid(8)}`,
				isIncognito: true,
			};
		}
		const profileId = opts.profileId ?? this.defaultProfileId;
		const resolved = this.resolveProfilePartition?.(profileId);
		const partition = resolved ?? "persist:default";
		return { partition, profileId, isIncognito: false };
	}

	close(id: string): void {
		const tab = this.tabs.get(id);
		if (!tab) return;
		this.closedStack.push({
			url: tab.url,
			partition: tab.partition,
			openedByAgent: tab.openedByAgent,
			isIncognito: tab.isIncognito,
			profileId: tab.profileId,
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

		// Incognito cleanup: if this was the last tab for its partition, ask host
		// to clear the Electron session so cookies/localStorage don't linger.
		if (tab.isIncognito && !this.partitionInUse(tab.partition)) {
			try {
				this.onIncognitoPartitionEmpty?.(tab.partition);
			} catch (err) {
				console.warn("[tab-manager] onIncognitoPartitionEmpty threw:", err);
			}
		}

		// Promote another tab if any remain and none is active.
		if (!this.activeTabId) {
			const next = this.tabs.keys().next();
			if (!next.done) this.focus(next.value);
		}
	}

	private partitionInUse(partition: string): boolean {
		for (const t of this.tabs.values()) {
			if (t.partition === partition) return true;
		}
		return false;
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
		return Array.from(this.tabs.values()).map((t) => this.toSummary(t));
	}

	/**
	 * O(1) lookup by id — preferred over `list().find(...)` on hot paths
	 * (e.g. BrowserToolsCtx getters invoked from snapshot/act).
	 */
	getSummary(id: string): TabSummary | undefined {
		const t = this.tabs.get(id);
		return t ? this.toSummary(t) : undefined;
	}

	private toSummary(t: Tab): TabSummary {
		return {
			id: t.id,
			url: t.url,
			title: t.title,
			favicon: t.favicon,
			state: t.state,
			active: t.id === this.activeTabId,
			pinned: t.pinned,
			openedByAgent: t.openedByAgent,
			isIncognito: t.isIncognito,
			profileId: t.profileId,
			partition: t.partition,
		};
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
			profileId: rec.profileId,
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

	/**
	 * Return a minimal runner for the tab's main-world JS context, used by
	 * reading-mode.extractArticle. Returns undefined when the tab is missing
	 * or the injected BrowserViewLike doesn't expose executeJavaScript (mocks).
	 */
	getTabRunner(id: string):
		| {
				executeJavaScript(
					code: string,
					userGesture?: boolean,
				): Promise<unknown>;
		  }
		| undefined {
		const tab = this.tabs.get(id);
		const exec = tab?.view.webContents.executeJavaScript;
		if (!tab || !exec) return undefined;
		return {
			executeJavaScript: (code: string, userGesture?: boolean) =>
				exec.call(tab.view.webContents, code, userGesture),
		};
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
		wc.on("did-navigate", (..._args: unknown[]) => {
			tab.registry.resetLifetime();
			try {
				tab.url = wc.getURL();
				tab.title = wc.getTitle();
			} catch {
				/* ignore */
			}
			try {
				this.navigationHook?.onNavigate?.(tab.id, tab.url, tab.title, {
					isIncognito: tab.isIncognito,
					profileId: tab.profileId,
					partition: tab.partition,
				});
			} catch (err) {
				console.warn("[tab-manager] navigation hook threw:", err);
			}
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
