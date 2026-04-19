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
import type { HistoryStore } from "./history.js";
import type { Persona, PersonaManager } from "./persona-manager.js";
import type { TabManager } from "./tab-manager.js";

export function registerTabIpc(tm: TabManager): () => void {
	const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
		[
			"tab:open",
			(_e, url: unknown) => {
				if (typeof url !== "string")
					throw new Error("tab:open needs string url");
				return tm.create(url);
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
