/**
 * IPC wiring for tab:* / policy:* / agent:* / persona:* channels.
 *
 * Renderer never sees Electron/Node APIs directly — everything flows through
 * preload → ipcMain.handle here → TabManager / PolicyProvider / AgentHost.
 */
import { ipcMain, type WebContents } from "electron";
import type { AdminPolicy } from "./admin-policy.js";
import type { AgentHost, StreamChunk } from "./agent-host.js";
import type { AuditEvent, AuditLog, TaskTraceSummary } from "./audit-log.js";
import type { AuthVault } from "./auth-vault.js";
import type { BookmarksStore } from "./bookmarks.js";
import type { DownloadManager } from "./download.js";
import type { ExtensionHost, InstalledExtension } from "./extension-host.js";
import type { HistoryStore } from "./history.js";
import { LOCALE_PREFS } from "./locale.js";
import type { McpServerHost } from "./mcp-server.js";
import type { Persona, PersonaManager } from "./persona-manager.js";
import type { ProfileRecord, ProfileStore } from "./profile-store.js";
import {
	extractArticle,
	type ReadingArticle,
	ReadingExtractionError,
} from "./reading-mode.js";
import type { Routine, RoutinesEngine } from "./routines.js";
import type { SyncEngine } from "./sync-engine.js";
import type { CreateTabOpts, TabManager } from "./tab-manager.js";

function parseCreateTabOpts(raw: unknown): CreateTabOpts | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object") throw new Error("tab:open opts must be object");
	const o = raw as Record<string, unknown>;
	const out: CreateTabOpts = {};
	if (typeof o.incognito === "boolean") out.incognito = o.incognito;
	if (typeof o.profileId === "string") out.profileId = o.profileId;
	if (typeof o.background === "boolean") out.background = o.background;
	// partition / openedByAgent are internal — not exposed to renderer.
	return out;
}

export function registerTabIpc(tm: TabManager): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		[
			"tab:open",
			(_e, url: unknown, opts: unknown) => {
				if (typeof url !== "string")
					throw new Error("tab:open needs string url");
				const parsed = parseCreateTabOpts(opts);
				return tm.create(url, parsed);
			},
		],
		[
			"tab:close",
			(_e, id: unknown) => {
				if (typeof id !== "string")
					throw new Error("tab:close needs string id");
				tm.close(id);
				return true;
			},
		],
		[
			"tab:focus",
			(_e, id: unknown) => {
				if (typeof id !== "string")
					throw new Error("tab:focus needs string id");
				tm.focus(id);
				return true;
			},
		],
		["tab:list", () => tm.list()],
		[
			"tab:navigate",
			(_e, id: unknown, url: unknown) => {
				if (typeof id !== "string" || typeof url !== "string") {
					throw new Error("tab:navigate needs (id, url)");
				}
				tm.navigate(id, url);
				return true;
			},
		],
		[
			"tab:back",
			(_e, id: unknown) => {
				if (typeof id !== "string") throw new Error("tab:back needs string id");
				tm.goBack(id);
				return true;
			},
		],
		[
			"tab:forward",
			(_e, id: unknown) => {
				if (typeof id !== "string")
					throw new Error("tab:forward needs string id");
				tm.goForward(id);
				return true;
			},
		],
		[
			"tab:reload",
			(_e, id: unknown) => {
				if (typeof id !== "string")
					throw new Error("tab:reload needs string id");
				tm.reload(id);
				return true;
			},
		],
		["tab:undoClose", () => tm.undoClose() ?? null],
	];

	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);

	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

/**
 * Read-only IPC for AdminPolicy (Stage 5.2). Renderer can display current
 * policy but cannot mutate it through this channel; edits will flow through a
 * dedicated authenticated channel in Stage 5.4+.
 */
export interface PolicyProviderLike {
	get(): AdminPolicy;
}

export function registerPolicyIpc(provider: PolicyProviderLike): () => void {
	const channel = "policy:get";
	ipcMain.handle(channel, () => provider.get());
	return () => ipcMain.removeHandler(channel);
}

// ---------------------------------------------------------------------------
// Locale IPC (Stage 21)
// ---------------------------------------------------------------------------

export interface LocaleIpcDeps {
	/** Returns the current resolution given the live admin policy. */
	getResolution(): {
		effective: "zh" | "en";
		source: "admin" | "user" | "system";
		user: "auto" | "zh" | "en";
		system: "zh" | "en";
		admin: "auto" | "zh" | "en" | null;
	};
	setUserPref(value: "auto" | "zh" | "en"): Promise<void>;
}

export function registerLocaleIpc(deps: LocaleIpcDeps): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		["locale:get", () => deps.getResolution()],
		[
			"locale:setUser",
			async (_e, value: unknown) => {
				// Use LOCALE_PREFS as the single source of truth so adding a
				// language doesn't require touching this validator separately.
				if (
					typeof value !== "string" ||
					!(LOCALE_PREFS as readonly string[]).includes(value)
				) {
					throw new Error("locale:setUser needs 'auto' | 'zh' | 'en'");
				}
				await deps.setUserPref(value as "auto" | "zh" | "en");
				return deps.getResolution();
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// Agent IPC (Stage 3.2)
// ---------------------------------------------------------------------------

export interface AgentOrchestrator {
	/** Start a new task; returns the taskId. */
	startTask(
		prompt: string,
		target: (chunk: StreamChunk) => void,
	): Promise<string>;
	/** Cancel the task by id (no-op if already done). */
	cancel(taskId: string): void;
	/** Return the live AgentHost — used by snapshot prefill IPC. */
	getHost(): AgentHost | undefined;
}

/** Marshal a payload (AgentHost streams) to the renderer via webContents.send. */
export function registerAgentIpc(
	orchestrator: AgentOrchestrator,
	getRenderer: () => WebContents | undefined,
): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		[
			"agent:prompt",
			async (_e, text: unknown) => {
				if (typeof text !== "string") {
					throw new Error("agent:prompt needs string text");
				}
				const send = (chunk: StreamChunk) => {
					const wc = getRenderer();
					if (wc && !wc.isDestroyed()) {
						wc.send("agent:stream", chunk);
					}
				};
				return orchestrator.startTask(text, send);
			},
		],
		[
			"agent:cancel",
			(_e, taskId: unknown) => {
				if (typeof taskId !== "string") {
					throw new Error("agent:cancel needs string taskId");
				}
				orchestrator.cancel(taskId);
				return true;
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// Persona IPC (Stage 3.6)
// ---------------------------------------------------------------------------

export interface PersonaIpcDeps {
	personaManager: PersonaManager;
	getActiveSlug: () => string | undefined;
	setActiveSlug: (slug: string) => void;
}

export interface PersonaSummary {
	slug: string;
	name: string;
	description: string;
	domains: string[];
	active: boolean;
}

function summarize(p: Persona, activeSlug: string | undefined): PersonaSummary {
	return {
		slug: p.slug,
		name: p.name,
		description: p.description,
		domains: p.frontmatter.domains,
		active: p.slug === activeSlug,
	};
}

// ---------------------------------------------------------------------------
// Vault IPC (P1 Stage 9)
// ---------------------------------------------------------------------------

/**
 * Expose the AuthVault to the renderer. `vault:get` is intentionally NOT
 * exposed — the renderer must never fetch plaintext secrets. `list` returns
 * key names only; tool calls resolve placeholders in the main process.
 */
export function registerVaultIpc(vault: AuthVault): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		[
			"vault:set",
			async (_e, key: unknown, secret: unknown) => {
				if (typeof key !== "string" || typeof secret !== "string") {
					throw new Error("vault:set needs (key, secret)");
				}
				await vault.set(key, secret);
				return true;
			},
		],
		["vault:list", () => vault.list()],
		[
			"vault:delete",
			async (_e, key: unknown) => {
				if (typeof key !== "string") {
					throw new Error("vault:delete needs string key");
				}
				return vault.delete(key);
			},
		],
		[
			"vault:clear",
			async () => {
				await vault.clear();
				return true;
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// History IPC (Stage 1.5)
// ---------------------------------------------------------------------------

export function registerHistoryIpc(store: HistoryStore): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		[
			"history:list",
			(_e, limit: unknown, offset: unknown) => {
				const l = typeof limit === "number" ? limit : 50;
				const o = typeof offset === "number" ? offset : 0;
				return store.list(l, o);
			},
		],
		[
			"history:search",
			(_e, q: unknown, limit: unknown) => {
				if (typeof q !== "string")
					throw new Error("history:search needs string q");
				const l = typeof limit === "number" ? limit : 50;
				return store.search(q, l);
			},
		],
		[
			"history:fullTextSearch",
			(_e, q: unknown, limit: unknown) => {
				if (typeof q !== "string")
					throw new Error("history:fullTextSearch needs string q");
				const l = typeof limit === "number" ? limit : 50;
				return store.fullTextSearch(q, l);
			},
		],
		[
			"history:semanticSearch",
			async (_e, q: unknown, limit: unknown) => {
				if (typeof q !== "string")
					throw new Error("history:semanticSearch needs string q");
				const l = typeof limit === "number" ? limit : 20;
				return store.semanticSearch(q, l);
			},
		],
		[
			"history:clear",
			() => {
				store.clear();
				return true;
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// Bookmarks IPC (Stage 1.5)
// ---------------------------------------------------------------------------

export function registerBookmarksIpc(store: BookmarksStore): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		[
			"bookmarks:add",
			(_e, input: unknown) => {
				if (!input || typeof input !== "object") {
					throw new Error("bookmarks:add needs {url,title?,folder?}");
				}
				return store.add(
					input as { url: string; title?: string; folder?: string },
				);
			},
		],
		[
			"bookmarks:remove",
			(_e, id: unknown) => {
				if (typeof id !== "number")
					throw new Error("bookmarks:remove needs number id");
				return store.remove(id);
			},
		],
		[
			"bookmarks:list",
			(_e, folder: unknown) => {
				return store.list(typeof folder === "string" ? folder : undefined);
			},
		],
		[
			"bookmarks:reorder",
			(_e, folder: unknown, ids: unknown) => {
				if (typeof folder !== "string" || !Array.isArray(ids)) {
					throw new Error("bookmarks:reorder needs (folder, ids[])");
				}
				store.reorder(folder, ids.map(Number));
				return true;
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// Downloads IPC (Stage 1.6)
// ---------------------------------------------------------------------------

export function registerDownloadsIpc(dm: DownloadManager): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		["downloads:list", () => dm.list()],
		[
			"downloads:cancel",
			(_e, id: unknown) => {
				if (typeof id !== "string")
					throw new Error("downloads:cancel needs string id");
				return dm.cancel(id);
			},
		],
		[
			"downloads:open-folder",
			(_e, id: unknown) => {
				if (typeof id !== "string")
					throw new Error("downloads:open-folder needs string id");
				return dm.openFolder(id);
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// Sync IPC (P1 Stage 16)
// ---------------------------------------------------------------------------

export function registerSyncIpc(engine: SyncEngine): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		["sync:status", () => engine.status()],
		[
			"sync:configure",
			async (_e, passphrase: unknown, serverUrl: unknown) => {
				if (typeof passphrase !== "string")
					throw new Error("sync:configure needs string passphrase");
				const url = typeof serverUrl === "string" ? serverUrl : undefined;
				await engine.configure(passphrase, url);
				return engine.status();
			},
		],
		[
			"sync:unlock",
			async (_e, passphrase: unknown) => {
				if (typeof passphrase !== "string")
					throw new Error("sync:unlock needs string passphrase");
				const ok = await engine.unlock(passphrase);
				return { ok, status: engine.status() };
			},
		],
		[
			"sync:lock",
			() => {
				engine.lock();
				return engine.status();
			},
		],
		[
			"sync:disable",
			() => {
				engine.disable();
				return engine.status();
			},
		],
		["sync:pushNow", async () => engine.pushNow()],
		["sync:pullNow", async () => engine.pullNow()],
		[
			"sync:updateServerUrl",
			(_e, serverUrl: unknown) => {
				const u =
					typeof serverUrl === "string" && serverUrl.length > 0
						? serverUrl
						: null;
				return engine.updateServerUrl(u);
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// MCP server IPC (P2 Stage 17)
// ---------------------------------------------------------------------------

export function registerMcpIpc(host: McpServerHost): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		["mcp:status", () => host.status()],
		[
			"mcp:enable",
			async (_e, port: unknown) => {
				const p =
					typeof port === "number" && Number.isFinite(port) ? port : undefined;
				return host.enable(p);
			},
		],
		["mcp:disable", async () => host.disable()],
		["mcp:regenerateToken", async () => host.regenerateToken()],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// Extensions IPC (P1 Stage 15)
// ---------------------------------------------------------------------------

export interface ExtensionsIpcDeps {
	host: ExtensionHost;
	/** Opens a system folder picker. Injected by index.ts using Electron dialog. */
	pickFolder?: () => Promise<string | null>;
}

function summarizeExt(e: InstalledExtension) {
	return {
		id: e.id,
		name: e.name,
		version: e.version,
		path: e.path,
		enabled: e.enabled,
		manifestVersion: e.manifestVersion,
	};
}

export function registerExtensionsIpc(deps: ExtensionsIpcDeps): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		["extensions:list", () => deps.host.list().map(summarizeExt)],
		[
			"extensions:install",
			async (_e, folder: unknown) => {
				let p: string | null = null;
				if (typeof folder === "string" && folder.length > 0) {
					p = folder;
				} else if (deps.pickFolder) {
					p = await deps.pickFolder();
				}
				if (!p) return null;
				return summarizeExt(await deps.host.install(p));
			},
		],
		[
			"extensions:remove",
			(_e, id: unknown) => {
				if (typeof id !== "string")
					throw new Error("extensions:remove needs string id");
				return deps.host.remove(id);
			},
		],
		[
			"extensions:setEnabled",
			async (_e, id: unknown, enabled: unknown) => {
				if (typeof id !== "string" || typeof enabled !== "boolean") {
					throw new Error("extensions:setEnabled needs (id, enabled)");
				}
				return summarizeExt(await deps.host.setEnabled(id, enabled));
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// Reading-mode IPC (P1 Stage 13)
// ---------------------------------------------------------------------------

export function registerReadingIpc(tm: TabManager): () => void {
	const channel = "reading:extract";
	ipcMain.handle(channel, async (_e, tabId: unknown) => {
		if (typeof tabId !== "string") {
			throw new Error("reading:extract needs string tabId");
		}
		const runner = tm.getTabRunner(tabId);
		if (!runner) {
			return null;
		}
		try {
			const article: ReadingArticle | null = await extractArticle(runner);
			return article;
		} catch (err) {
			// Surface as plain Error so the renderer sees a helpful message.
			if (err instanceof ReadingExtractionError) {
				throw new Error(err.message);
			}
			throw err;
		}
	});
	return () => ipcMain.removeHandler(channel);
}

// ---------------------------------------------------------------------------
// Profiles IPC (P1 Stage 12)
// ---------------------------------------------------------------------------

export interface ProfilesIpcDeps {
	onProfileRemoved?: (partition: string) => void;
}

function summarizeProfile(p: ProfileRecord): {
	id: string;
	name: string;
	partition: string;
	createdAt: number;
	removable: boolean;
} {
	return {
		id: p.id,
		name: p.name,
		partition: p.partition,
		createdAt: p.createdAt,
		removable: p.id !== "default",
	};
}

export function registerProfilesIpc(
	store: ProfileStore,
	deps: ProfilesIpcDeps = {},
): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		["profiles:list", () => store.list().map(summarizeProfile)],
		[
			"profiles:create",
			(_e, name: unknown) => {
				if (typeof name !== "string")
					throw new Error("profiles:create needs string name");
				return summarizeProfile(store.create(name));
			},
		],
		[
			"profiles:rename",
			(_e, id: unknown, name: unknown) => {
				if (typeof id !== "string" || typeof name !== "string")
					throw new Error("profiles:rename needs (id, name)");
				return summarizeProfile(store.rename(id, name));
			},
		],
		[
			"profiles:remove",
			(_e, id: unknown) => {
				if (typeof id !== "string")
					throw new Error("profiles:remove needs string id");
				const existing = store.getById(id);
				if (!existing) return false;
				const removed = store.remove(id);
				if (removed) {
					try {
						deps.onProfileRemoved?.(existing.partition);
					} catch (err) {
						console.warn("[profiles] onProfileRemoved threw:", err);
					}
				}
				return removed;
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

export function registerPersonaIpc(deps: PersonaIpcDeps): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		[
			"persona:list",
			() => {
				const active = deps.getActiveSlug();
				return deps.personaManager.list().map((p) => summarize(p, active));
			},
		],
		[
			"persona:switch",
			(_e, slug: unknown) => {
				if (typeof slug !== "string") {
					throw new Error("persona:switch needs string slug");
				}
				const found = deps.personaManager.getBySlug(slug);
				if (!found) throw new Error(`no such persona: ${slug}`);
				deps.setActiveSlug(slug);
				return summarize(found, slug);
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// Trace IPC (P1 Stage 14)
// ---------------------------------------------------------------------------

export function registerTraceIpc(auditLog: AuditLog): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		[
			"trace:listTasks",
			(_e, limit: unknown) => {
				const n = typeof limit === "number" ? limit : 50;
				return auditLog.listTasks(n) as TaskTraceSummary[];
			},
		],
		[
			"trace:getTaskEvents",
			(_e, taskId: unknown) => {
				if (typeof taskId !== "string")
					throw new Error("trace:getTaskEvents needs string taskId");
				const events = auditLog.list({ taskId, limit: 10_000 });
				return events.reverse() as AuditEvent[];
			},
		],
		[
			"trace:clear",
			async () => {
				await auditLog.clear();
				return true;
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}

// ---------------------------------------------------------------------------
// Routines IPC (P1 Stage 10)
// ---------------------------------------------------------------------------

function toRoutine(raw: unknown): Routine {
	if (!raw || typeof raw !== "object")
		throw new Error("routine must be object");
	const o = raw as Record<string, unknown>;
	if (typeof o.name !== "string" || o.name === "")
		throw new Error("routine.name required");
	if (typeof o.schedule !== "string" || o.schedule === "")
		throw new Error("routine.schedule required");
	if (typeof o.prompt !== "string" || o.prompt === "")
		throw new Error("routine.prompt required");
	const out: Routine = {
		name: o.name,
		schedule: o.schedule,
		prompt: o.prompt,
		enabled: o.enabled === true,
	};
	if (typeof o.description === "string") out.description = o.description;
	if (typeof o.persona === "string") out.persona = o.persona;
	return out;
}

export function registerRoutinesIpc(engine: RoutinesEngine): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		["routines:list", () => engine.list()],
		[
			"routines:create",
			(_e, routine: unknown) => engine.create(toRoutine(routine)),
		],
		[
			"routines:update",
			(_e, name: unknown, routine: unknown) => {
				if (typeof name !== "string") throw new Error("name must be string");
				return engine.update(name, toRoutine(routine));
			},
		],
		[
			"routines:delete",
			async (_e, name: unknown) => {
				if (typeof name !== "string") throw new Error("name must be string");
				await engine.remove(name);
				return true;
			},
		],
		[
			"routines:enable",
			(_e, name: unknown, enabled: unknown) => {
				if (typeof name !== "string") throw new Error("name must be string");
				if (typeof enabled !== "boolean")
					throw new Error("enabled must be boolean");
				return engine.setEnabled(name, enabled);
			},
		],
		[
			"routines:runNow",
			async (_e, name: unknown) => {
				if (typeof name !== "string") throw new Error("name must be string");
				await engine.runNow(name);
				return true;
			},
		],
	];
	for (const [ch, fn] of handlers) ipcMain.handle(ch, fn);
	return () => {
		for (const [ch] of handlers) ipcMain.removeHandler(ch);
	};
}
