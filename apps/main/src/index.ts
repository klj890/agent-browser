import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	app,
	BrowserWindow,
	dialog,
	globalShortcut,
	ipcMain,
	session,
	shell,
} from "electron";
import {
	type AdminPolicy,
	AdminPolicyStore,
	DEFAULT_POLICY,
} from "./admin-policy.js";
import type { AgentHost, StreamChunk } from "./agent-host.js";
import { createAgentHostForTab } from "./agent-host-factory.js";
import { AuditLog } from "./audit-log.js";
import { AuthVault } from "./auth-vault.js";
import { BookmarksStore } from "./bookmarks.js"
import { ConfirmationHandler } from "./confirmation.js";
import { DownloadManager } from "./download.js";
import { registerEmergencyStop } from "./emergency-stop.js";
import { HistoryStore } from "./history.js";
import {
	type AgentOrchestrator,
	registerAgentIpc,
	registerBookmarksIpc,
	registerDownloadsIpc,
	registerHistoryIpc,
	registerPersonaIpc,
	registerPolicyIpc,
	registerTabIpc,
	registerTraceIpc,
	registerVaultIpc,
} from "./ipc.js";
import { PersonaManager } from "./persona-manager.js";
import { syncPersonasOnce } from "./persona-sync.js";
import { createDefaultSlashRegistry } from "./slash-commands.js";
import { getAppDatabase } from "./storage/sqlite.js";
import type { TabManager as TabManagerType } from "./tab-manager.js";
import { TabManager } from "./tab-manager.js";
import { TaskStateStore } from "./task-state.js";
import { ToolResultStorage } from "./tool-result-storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Minimal PolicyProvider exposed to other Stage modules. Holds the latest
 * loaded AdminPolicy in memory (Stage 5.2 read-only access). Stage 5.3+ can
 * swap in a refresh-on-update flow; for now, loaded once at boot.
 */
export interface PolicyProvider {
	store: AdminPolicyStore;
	get(): AdminPolicy;
	refresh(): Promise<AdminPolicy>;
}

declare global {
	// eslint-disable-next-line no-var
	var __policyProvider: PolicyProvider | undefined;
}

async function initPolicyProvider(): Promise<PolicyProvider> {
	const store = new AdminPolicyStore();
	let cached: AdminPolicy = DEFAULT_POLICY;
	try {
		cached = await store.load();
	} catch (err) {
		console.warn("[admin-policy] load failed, using DEFAULT_POLICY:", err);
	}
	const provider: PolicyProvider = {
		store,
		get: () => cached,
		refresh: async () => {
			cached = await store.load();
			return cached;
		},
	};
	globalThis.__policyProvider = provider;
	return provider;
}

async function initPersonaManager(): Promise<PersonaManager> {
	const pm = new PersonaManager();
	const dir = path.join(__dirname, "..", "personas");
	try {
		await pm.loadFromDir(dir);
	} catch (err) {
		console.warn("[persona-manager] loadFromDir failed:", err);
	}
	return pm;
}

/**
 * Minimal orchestrator: one live task at a time (per window). New prompts
 * while a task runs are queued behind the current one via simple serialisation.
 * Multi-tab concurrency is a Stage 4+ concern.
 */
function createOrchestrator(deps: {
	tabManager: TabManager;
	policy: PolicyProvider;
	personaManager: PersonaManager;
	getActiveSlug: () => string | undefined;
	auditLog: AuditLog;
	toolResultStorage: ToolResultStorage;
	confirmation: ConfirmationHandler;
	taskStore: TaskStateStore;
	vault: AuthVault;
}): AgentOrchestrator {
	let activeHost: AgentHost | undefined;
	let activeTaskId: string | undefined;
	return {
		async startTask(prompt: string, target: (chunk: StreamChunk) => void) {
			const tabId = deps.tabManager.getActiveId();
			if (!tabId) throw new Error("no active tab");
			const slug = deps.getActiveSlug();
			const persona = slug ? deps.personaManager.getBySlug(slug) : undefined;
			const first = deps.personaManager.list()[0];
			const use = persona ?? first;
			if (!use) throw new Error("no persona registered");
			const host = await createAgentHostForTab(
				{
					tabManager: deps.tabManager,
					policy: deps.policy.get(),
					personaManager: deps.personaManager,
					auditLog: deps.auditLog,
					toolResultStorage: deps.toolResultStorage,
					confirmation: deps.confirmation,
					taskStore: deps.taskStore,
					vault: deps.vault,
				},
				{ tabId, persona: use },
			);
			activeHost = host;
			const task = deps.taskStore.create({
				prompt,
				persona: use.slug,
				tabId,
			});
			const taskId = task.id;
			activeTaskId = taskId;
			void deps.auditLog.append({
				event: "task.start",
				ts: Date.now(),
				task_id: taskId,
				user_prompt_hash: String(prompt.length),
				persona: use.slug,
				tab_url: deps.tabManager.list().find((t) => t.id === tabId)?.url ?? "",
			});
			deps.taskStore.transition(taskId, "running");
			// Drive the stream in background; caller returns immediately with taskId.
			void (async () => {
				let endReason: "completed" | "failed" | "killed" | "budget_exceeded" =
					"completed";
				try {
					for await (const chunk of host.run(
						prompt,
						task.abortController.signal,
					)) {
						target(chunk);
						if (chunk.type === "done") endReason = chunk.reason;
					}
				} catch (err) {
					endReason = "failed";
					target({
						type: "error",
						message: err instanceof Error ? err.message : String(err),
						reason: "failed",
					});
					target({ type: "done", reason: "failed" });
				} finally {
					try {
						deps.taskStore.transition(taskId, endReason);
					} catch {
						// already terminal (e.g. aborted → killed)
					}
					const finalTask = deps.taskStore.get(taskId);
					const endStatus:
						| "completed"
						| "failed"
						| "killed"
						| "budget_exceeded" =
						finalTask.status === "pending" || finalTask.status === "running"
							? "failed"
							: finalTask.status;
					void deps.auditLog.append({
						event: "task.end",
						ts: Date.now(),
						task_id: taskId,
						status: endStatus,
						steps: finalTask.step ?? 0,
						total_usd: finalTask.totalUsd ?? 0,
						total_tokens: finalTask.totalTokens ?? 0,
					});
					if (activeTaskId === taskId) {
						activeHost = undefined;
						activeTaskId = undefined;
					}
				}
			})();
			return taskId;
		},
		cancel(taskId: string) {
			if (activeTaskId === taskId) activeHost?.cancel();
			try {
				deps.taskStore.abort(taskId);
			} catch {
				// already terminal
			}
		},
		getHost() {
			return activeHost;
		},
	};
}

interface WindowInfra {
	auditLog: AuditLog;
	toolResultStorage: ToolResultStorage;
	taskStore: TaskStateStore;
	confirmation: ConfirmationHandler;
	slashRegistry: ReturnType<typeof createDefaultSlashRegistry>;
	vault: AuthVault;
}

function createWindowInfra(policy: PolicyProvider): WindowInfra {
	const userDataDir = app.getPath("userData");
	const auditLog = new AuditLog({
		dir: path.join(userDataDir, "agent-browser", "audit"),
	});
	const toolResultStorage = new ToolResultStorage({
		dbPath: path.join(userDataDir, "agent-browser", "tool-results.sqlite"),
	});
	const taskStore = new TaskStateStore();
	// Bridge task state changes to audit log.
	const lastStatus = new Map<string, string>();
	taskStore.onChange((task) => {
		const prev = lastStatus.get(task.id) ?? "pending";
		lastStatus.set(task.id, task.status);
		void auditLog.append({
			event: "task.state-change",
			ts: Date.now(),
			task_id: task.id,
			from: prev,
			to: task.status,
		});
	});
	// Confirmation: until a real modal UI lands, default to auto-deny when the
	// policy forces confirmation (fail-safe). Renderer-side dialog is Stage 5.8.
	const confirmation = new ConfirmationHandler({
		policy: policy.get(),
		askUser: async () => "denied",
	});
	const slashRegistry = createDefaultSlashRegistry();
	const vault = new AuthVault({
		filePath: path.join(userDataDir, "agent-browser", "vault.json"),
	});
	return {
		auditLog,
		toolResultStorage,
		taskStore,
		confirmation,
		slashRegistry,
		vault,
	};
}

async function createMainWindow(
	policy: PolicyProvider,
	personaManager: PersonaManager,
	infra: WindowInfra,
): Promise<BrowserWindow> {
	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});

	const devUrl = process.env.RENDERER_URL;
	if (devUrl) {
		await win.loadURL(devUrl);
	} else {
		await win.loadFile(path.join(__dirname, "../../renderer/dist/index.html"));
	}

	// Persistent stores (Stage 1.5 / 1.6).
	const userDataDir = app.getPath("userData");
	const appDb = getAppDatabase(
		path.join(userDataDir, "agent-browser", "app.sqlite"),
	);
	const historyStore = new HistoryStore(appDb);
	const bookmarksStore = new BookmarksStore(appDb);
	const unregisterHistory = registerHistoryIpc(historyStore);
	const unregisterBookmarks = registerBookmarksIpc(bookmarksStore);

	let activeSlug: string | undefined = personaManager.list()[0]?.slug;
	// Lazily populated below once orchestrator is built; the hook reads through
	// this indirection so the current host can be found at nav time.
	const hostRef: { get: () => AgentHost | undefined } = {
		get: () => undefined,
	};

	const tm = new TabManager({
		window: win,
		navigationHook: {
			onNavigate: (_tabId, url, title) => {
				try {
					historyStore.record(url, title);
				} catch (err) {
					console.warn("[history] record failed:", err);
				}
				// Auto-switch persona by domain (Stage 4.7).
				try {
					const match = personaManager.matchByDomain(url);
					if (match) {
						if (activeSlug !== match.slug) activeSlug = match.slug;
						hostRef.get()?.switchPersona(match);
					}
				} catch (err) {
					console.warn("[persona-auto-switch] failed:", err);
				}
			},
		},
	});
	const unregisterTab = registerTabIpc(tm);
	tm.create("https://example.com");
	win.on("resize", () => tm.handleResize());

	// Downloads (Stage 1.6).
	const downloadsMgr = new DownloadManager({
		session: session.defaultSession,
		dialog: {
			showSaveDialog: (opts) => dialog.showSaveDialog(win, opts),
		},
		defaultDir: app.getPath("downloads"),
		broadcast: (rec) => {
			if (!win.isDestroyed()) win.webContents.send("downloads:progress", rec);
		},
		openFolder: (p) => {
			void shell.openPath(p);
		},
	});
	const unregisterDownloads = registerDownloadsIpc(downloadsMgr);
	const orchestrator = createOrchestrator({
		tabManager: tm,
		policy,
		personaManager,
		getActiveSlug: () => activeSlug,
		auditLog: infra.auditLog,
		toolResultStorage: infra.toolResultStorage,
		confirmation: infra.confirmation,
		taskStore: infra.taskStore,
		vault: infra.vault,
	});
	hostRef.get = () => orchestrator.getHost();

	const unregisterAgent = registerAgentIpc(orchestrator, () => win.webContents);
	const unregisterSlash = registerSlashIpc(infra, tm, orchestrator);
	const unregisterVault = registerVaultIpc(infra.vault);
	const unregisterTrace = registerTraceIpc(infra.auditLog);
	const unregisterPersona = registerPersonaIpc({
		personaManager,
		getActiveSlug: () => activeSlug,
		setActiveSlug: (s) => {
			activeSlug = s;
		},
	});

	// "Send current page to agent" — IPC helper for the sidebar button.
	ipcMain.handle("tab:snapshotCurrent", async () => {
		const tabId = tm.getActiveId();
		if (!tabId) return null;
		const persona = activeSlug
			? personaManager.getBySlug(activeSlug)
			: undefined;
		const use = persona ?? personaManager.list()[0];
		if (!use) return null;
		try {
			const host = await createAgentHostForTab(
				{
					tabManager: tm,
					policy: policy.get(),
					personaManager,
				},
				{ tabId, persona: use },
			);
			// Ask host for its skills via a probe — but we don't yet expose skills
			// publicly. For now return the tab URL so renderer can inline it into
			// the next prompt as a prefix. Full snapshot integration will move here
			// in Stage 6.5 when tool-result-storage lands.
			void host; // keep to validate wiring compiles — no actual snapshot yet
			const tab = tm.list().find((t) => t.id === tabId);
			return tab?.url ?? null;
		} catch {
			return null;
		}
	});

	win.on("closed", () => {
		unregisterTab();
		unregisterAgent();
		unregisterPersona();
		unregisterSlash();
		unregisterVault();
		unregisterTrace();
		unregisterHistory();
		unregisterBookmarks();
		unregisterDownloads();
		ipcMain.removeHandler("tab:snapshotCurrent");
		tm.destroy();
	});

	return win;
}

function registerSlashIpc(
	infra: WindowInfra,
	_tm: TabManagerType,
	orchestrator: AgentOrchestrator,
): () => void {
	const ch = "slash:execute";
	// Adapter: slash-commands expects `listByTask` but AuditLog only writes.
	// Real trace export will land in Stage P1-14 (trace viewer); for now we
	// return an empty event list to keep the surface intact.
	const auditLogAdapter = {
		listByTask: async (_taskId: string) => [] as Record<string, unknown>[],
	};
	ipcMain.handle(ch, async (_e, input: unknown) => {
		if (typeof input !== "string")
			throw new Error("slash:execute needs string");
		const result = await infra.slashRegistry.execute(
			{
				taskStore: infra.taskStore,
				auditLog: auditLogAdapter,
				currentTaskId: orchestrator.getHost() ? "current" : undefined,
				vault: infra.vault,
				// tools: not wired here — slash /screenshot /dom-tree use tool invocations
				// which require an active AgentHost; Stage 3 integration left as TODO.
			},
			input,
		);
		return result;
	});
	return () => ipcMain.removeHandler(ch);
}

let globalTaskStore: TaskStateStore | undefined;

app.whenReady().then(async () => {
	const policy = await initPolicyProvider();
	registerPolicyIpc(policy);
	const personaManager = await initPersonaManager();
	const infra = createWindowInfra(policy);
	globalTaskStore = infra.taskStore;
	// Persona sync (Stage 4.5) — best effort; falls back to local cache.
	try {
		const userDataDir = app.getPath("userData");
		const appDb = getAppDatabase(
			path.join(userDataDir, "agent-browser", "app.sqlite"),
		);
		await syncPersonasOnce({ appDb, personaManager });
	} catch (err) {
		console.warn("[persona-sync] failed:", err);
	}
	// Emergency stop — global shortcut aborts all running tasks in the window.
	registerEmergencyStop({ store: infra.taskStore, globalShortcut });
	await createMainWindow(policy, personaManager, infra);
});

app.on("window-all-closed", () => {
	globalShortcut.unregisterAll();
	if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		const policy = globalThis.__policyProvider ?? (await initPolicyProvider());
		const personaManager = await initPersonaManager();
		const infra = createWindowInfra(policy);
		globalTaskStore = infra.taskStore;
		registerEmergencyStop({ store: infra.taskStore, globalShortcut });
		await createMainWindow(policy, personaManager, infra);
	}
});

// Expose for debug — allows a dev REPL to inspect task state without
// reaching into Electron internals.
Object.defineProperty(globalThis, "__taskStore", {
	get: () => globalTaskStore,
});
