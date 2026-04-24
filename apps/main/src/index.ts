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
import { BookmarksStore } from "./bookmarks.js";
import { ConfirmationHandler } from "./confirmation.js";
import { DownloadManager } from "./download.js";
import { registerEmergencyStop } from "./emergency-stop.js";
import { ExtensionHost, type ExtensionSessionLike } from "./extension-host.js";
import { HistoryStore } from "./history.js";
import { HistoryIndex } from "./history-index.js";
import {
	type AgentOrchestrator,
	registerAgentIpc,
	registerBookmarksIpc,
	registerDownloadsIpc,
	registerExtensionsIpc,
	registerHistoryIpc,
	registerMcpIpc,
	registerPersonaIpc,
	registerPolicyIpc,
	registerProfilesIpc,
	registerReadingIpc,
	registerRoutinesIpc,
	registerSyncIpc,
	registerTabIpc,
	registerTraceIpc,
	registerVaultIpc,
} from "./ipc.js";
import { McpConfigFileStore } from "./mcp-config.js";
import { McpServerHost } from "./mcp-server.js";
import { PersonaManager } from "./persona-manager.js";
import { syncPersonasOnce } from "./persona-sync.js";
import { ProfileStore } from "./profile-store.js";
import { createRedactionPipelineFromPolicy } from "./redaction-pipeline.js";
import { RoutinesEngine } from "./routines.js";
import { createDefaultSlashRegistry } from "./slash-commands.js";
import { getAppDatabase } from "./storage/sqlite.js";
import { SyncConfigStore } from "./sync-config.js";
import { SyncEngine } from "./sync-engine.js";
import { HttpSyncTransport, NoopSyncTransport } from "./sync-transport-http.js";
import type { TabManager as TabManagerType } from "./tab-manager.js";
import { TabManager } from "./tab-manager.js";
import {
	isTerminalTaskStatus,
	TaskStateStore,
	type TaskStatus,
} from "./task-state.js";
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
interface OrchestratorDeps {
	tabManager: TabManager;
	policy: PolicyProvider;
	personaManager: PersonaManager;
	getActiveSlug: () => string | undefined;
	auditLog: AuditLog;
	toolResultStorage: ToolResultStorage;
	confirmation: ConfirmationHandler;
	taskStore: TaskStateStore;
	vault: AuthVault;
}

/**
 * Run one Agent task start-to-end against the currently active tab.
 * Returns the TaskId; drives the stream on its own. When `trackActive` is
 * non-null the caller's {host,taskId} slot receives the live values so
 * UI concerns (cancel / getHost) work — for background routines the slot
 * stays null and the task runs in isolation without clobbering any
 * user-initiated session.
 */
async function runOneTask(
	deps: OrchestratorDeps,
	prompt: string,
	target: (chunk: StreamChunk) => void,
	trackActive: { host?: AgentHost; taskId?: string } | null,
): Promise<string> {
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
	if (trackActive) trackActive.host = host;
	const task = deps.taskStore.create({
		prompt,
		persona: use.slug,
		tabId,
	});
	const taskId = task.id;
	if (trackActive) trackActive.taskId = taskId;
	void deps.auditLog.append({
		event: "task.start",
		ts: Date.now(),
		task_id: taskId,
		user_prompt_hash: String(prompt.length),
		persona: use.slug,
		tab_url: deps.tabManager.list().find((t) => t.id === tabId)?.url ?? "",
	});
	deps.taskStore.transition(taskId, "running");
	void (async () => {
		let endReason: "completed" | "failed" | "killed" | "budget_exceeded" =
			"completed";
		try {
			for await (const chunk of host.run(prompt, task.abortController.signal)) {
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
				// already terminal
			}
			const finalTask = deps.taskStore.get(taskId);
			const endStatus: "completed" | "failed" | "killed" | "budget_exceeded" =
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
			if (trackActive && trackActive.taskId === taskId) {
				trackActive.host = undefined;
				trackActive.taskId = undefined;
			}
		}
	})();
	return taskId;
}

function createOrchestrator(deps: OrchestratorDeps): AgentOrchestrator & {
	startBackgroundTask: (
		prompt: string,
		target: (chunk: StreamChunk) => void,
	) => Promise<string>;
	runBackgroundTaskToCompletion: (
		prompt: string,
		opts?: { signal?: AbortSignal; scheduledTask?: boolean },
	) => Promise<{
		taskId: string;
		endReason: "completed" | "failed" | "killed" | "budget_exceeded";
		durationMs: number;
		error?: string;
	}>;
} {
	const active: { host?: AgentHost; taskId?: string } = {};
	return {
		async startTask(prompt: string, target: (chunk: StreamChunk) => void) {
			return runOneTask(deps, prompt, target, active);
		},
		// Routines run here: no `active` slot → user's sidebar session is never
		// clobbered. cancel() / getHost() only ever see UI-origin tasks.
		async startBackgroundTask(
			prompt: string,
			target: (chunk: StreamChunk) => void,
		) {
			return runOneTask(deps, prompt, target, null);
		},
		/**
		 * Background variant that awaits a terminal TaskStateStore transition
		 * before resolving. Wires AbortSignal → taskStore.abort so a routine's
		 * stale-timeout actually kills the Agent rather than just orphaning
		 * the in-flight IIFE.
		 *
		 * `scheduledTask` flag is accepted for future use (restricted tool
		 * set for background routines) — currently unused but kept at the
		 * boundary so callers don't have to re-plumb later.
		 */
		async runBackgroundTaskToCompletion(prompt, opts) {
			const startedAt = Date.now();
			// Capture error chunks so the routine's run history can record
			// the actual failure message, not a generic 'failed'. Keep the
			// last one — for the streams runOneTask produces, only a single
			// error chunk ever fires (from the IIFE's catch block, right
			// before `done`), so last-wins and first-wins behave identically.
			// Last-wins is the more conventional stream-drain convention and
			// matches what a debugger would tail.
			let errorMessage: string | undefined;
			const capture = (c: StreamChunk) => {
				if (c.type === "error") errorMessage = c.message;
			};
			const taskId = await runOneTask(deps, prompt, capture, null);
			const onAbort = () => {
				try {
					deps.taskStore.abort(taskId);
				} catch {
					/* already terminal */
				}
			};
			if (opts?.signal) {
				if (opts.signal.aborted) {
					onAbort();
				} else {
					opts.signal.addEventListener("abort", onAbort, { once: true });
				}
			}
			// Subscribe BEFORE checking current status. Otherwise a terminal
			// transition landing between `.get()` and `onChange()` would be
			// missed (onChange only fires on new transitions, not on the
			// current state) and the promise would hang forever.
			return await new Promise((resolve) => {
				let settled = false;
				const finish = (status: TaskStatus) => {
					if (settled) return;
					settled = true;
					unsub();
					// Detach abort listener on normal completion too — the
					// { once: true } option only fires on abort, not on
					// Promise resolution, so without this the closure (and
					// taskStore reference) would pin until the caller's
					// AbortController itself is collected.
					opts?.signal?.removeEventListener("abort", onAbort);
					resolve({
						taskId,
						endReason: status as
							| "completed"
							| "failed"
							| "killed"
							| "budget_exceeded",
						durationMs: Date.now() - startedAt,
						error: errorMessage,
					});
				};
				const unsub = deps.taskStore.onChange((task) => {
					if (task.id !== taskId) return;
					if (!isTerminalTaskStatus(task.status)) return;
					finish(task.status);
				});
				// Now that we're listening, sample current state — if the task
				// already raced past us into terminal before we subscribed,
				// resolve from here.
				const current = deps.taskStore.get(taskId);
				if (isTerminalTaskStatus(current.status)) finish(current.status);
			});
		},
		cancel(taskId: string) {
			if (active.taskId === taskId) active.host?.cancel();
			try {
				deps.taskStore.abort(taskId);
			} catch {
				// already terminal
			}
		},
		getHost() {
			return active.host;
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

	// Persistent stores (Stage 1.5 / 1.6 / P1-12).
	const userDataDir = app.getPath("userData");
	const appDb = getAppDatabase(
		path.join(userDataDir, "agent-browser", "app.sqlite"),
	);
	const historyStore = new HistoryStore(appDb);
	const historyIndex = new HistoryIndex(appDb);
	// Reuse the admin redaction policy to sanitize history text before embedding.
	const historyRedactor = createRedactionPipelineFromPolicy(
		policy.get() as unknown as {
			redaction?: import("./redaction-pipeline.js").RedactionPolicy;
		},
	);
	historyStore.attachIndex(historyIndex, historyRedactor);
	const bookmarksStore = new BookmarksStore(appDb);
	const profileStore = new ProfileStore(appDb);
	const unregisterHistory = registerHistoryIpc(historyStore);
	const unregisterBookmarks = registerBookmarksIpc(bookmarksStore);

	let activeSlug: string | undefined = personaManager.list()[0]?.slug;
	// Lazily populated below once orchestrator is built; the hook reads through
	// this indirection so the current host can be found at nav time.
	const hostRef: { get: () => AgentHost | undefined } = {
		get: () => undefined,
	};

	// Downloads (Stage 1.6 + P1-12 multi-session). Constructed BEFORE
	// TabManager so onPartitionSeen can attach per-session will-download
	// listeners as new profile / incognito partitions come online.
	const downloadsMgr = new DownloadManager({
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
	// Attach the default session explicitly — the first tab that uses
	// persist:default will trigger onPartitionSeen too, but we want the
	// listener live even before the first tab exists (e.g. downloads kicked
	// off from about:blank or service workers).
	downloadsMgr.attachSession(
		session.defaultSession as unknown as import("./download.js").SessionLike,
		{ partition: "persist:default" },
	);
	const unregisterDownloads = registerDownloadsIpc(downloadsMgr);

	const tm = new TabManager({
		window: win,
		defaultProfileId: "default",
		resolveProfilePartition: (profileId) =>
			profileStore.getById(profileId)?.partition,
		onPartitionSeen: (partition, ctx) => {
			// Wire every new partition (persistent profile or incognito) to
			// the DownloadManager so downloads originating in non-default
			// profiles / incognito tabs are captured, not dispatched to
			// Electron's default writer.
			const sess = session.fromPartition(
				partition,
			) as unknown as import("./download.js").SessionLike;
			downloadsMgr.attachSession(sess, {
				partition,
				profileId: ctx.profileId,
				isIncognito: ctx.isIncognito,
			});
		},
		onIncognitoPartitionEmpty: (partition) => {
			// Purge in-memory storage when the last incognito tab of a session closes.
			// Detach the will-download handler and drop any in-memory records
			// tied to this partition — no incognito download should survive.
			downloadsMgr.dropPartition(partition);
			void session
				.fromPartition(partition)
				.clearStorageData()
				.catch((err) =>
					console.warn("[incognito] clearStorageData failed:", err),
				);
		},
		navigationHook: {
			onNavigate: (_tabId, url, title, ctx) => {
				// Incognito tabs never touch the persistent history / embedding index
				// — that would defeat the point. Persona auto-switch still fires since
				// it's purely in-memory and session-scoped.
				if (!ctx.isIncognito) {
					try {
						historyStore.recordWithIndex(url, title);
					} catch (err) {
						console.warn("[history] record failed:", err);
					}
				}
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
	const unregisterReading = registerReadingIpc(tm);

	// Extensions (Stage 15). Loaded into the default session so installed
	// Chrome MV3 extensions see the main persistent profile. Incognito partitions
	// deliberately skip extension loading.
	const extSession = session.defaultSession as unknown as ExtensionSessionLike;
	const extensionHost = new ExtensionHost({
		storePath: path.join(userDataDir, "agent-browser", "extensions.json"),
		session: extSession,
		getPolicy: () => policy.get().extension,
	});
	void extensionHost.loadEnabledAll().then((r) => {
		if (r.failed.length > 0 || r.blockedByPolicy.length > 0) {
			console.warn(
				"[extensions] boot load report:",
				JSON.stringify(r, null, 2),
			);
		}
	});
	const unregisterExtensions = registerExtensionsIpc({
		host: extensionHost,
		pickFolder: async () => {
			const r = await dialog.showOpenDialog(win, {
				properties: ["openDirectory"],
				title: "Load unpacked extension folder",
			});
			if (r.canceled || r.filePaths.length === 0) return null;
			return r.filePaths[0] ?? null;
		},
	});

	// E2E sync (Stage 16). Passphrase-derived key lives only in engine memory.
	// Transport is resolved lazily via a factory so updateServerUrl()/configure()
	// can repoint at a new backend without an app restart.
	const syncConfigStore = new SyncConfigStore(
		path.join(userDataDir, "agent-browser", "sync-config.json"),
	);
	const syncEngine = new SyncEngine({
		configStore: syncConfigStore,
		bookmarks: bookmarksStore,
		history: historyStore,
		appDb,
		transport: (serverUrl) => {
			if (!serverUrl) return new NoopSyncTransport();
			return new HttpSyncTransport({
				baseUrl: serverUrl,
				// Reuse an existing persona auth token if stored under this vault key.
				getAuthToken: () => null,
			});
		},
	});
	const unregisterSync = registerSyncIpc(syncEngine);

	// MCP server (Stage 17). Disabled by default; user toggles in Settings.
	// If the persisted config already had enabled=true, the server won't auto-
	// start here — we surface status via IPC and the renderer decides whether
	// to auto-enable. Keeps loopback listeners from silently reappearing on
	// every boot until the UI explicitly asks.
	const mcpHost = new McpServerHost({
		configStore: new McpConfigFileStore(
			path.join(userDataDir, "agent-browser", "mcp-config.json"),
		),
		tabs: tm,
		history: historyStore,
		bookmarks: bookmarksStore,
		auditLog: infra.auditLog,
	});
	const unregisterMcp = registerMcpIpc(mcpHost);

	const unregisterProfiles = registerProfilesIpc(profileStore, {
		onProfileRemoved: (partition) => {
			// Close any tabs still using the removed partition, then purge the session.
			for (const t of tm.list()) {
				if (t.partition === partition) tm.close(t.id);
			}
			void session
				.fromPartition(partition)
				.clearStorageData()
				.catch((err) =>
					console.warn("[profiles] clearStorageData failed:", err),
				);
		},
	});
	tm.create("https://example.com");
	win.on("resize", () => tm.handleResize());

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
	const routinesEngine = new RoutinesEngine({
		dir: path.join(userDataDir, "agent-browser", "routines"),
		orchestrator: {
			// Route scheduled routines through the background task channel so
			// a cron tick never interrupts the user's live sidebar session.
			startTask: (prompt, target) =>
				orchestrator.startBackgroundTask(prompt, target),
			// New in P2 §2.5: await terminal task state so the engine can
			// enforce a stale timeout (default 10 min) and accumulate a real
			// run history, not just an optimistic "started" stamp.
			runToCompletion: (prompt, opts) =>
				orchestrator.runBackgroundTaskToCompletion(prompt, opts),
		},
	});
	void routinesEngine.load().then(() => routinesEngine.start());
	const unregisterRoutines = registerRoutinesIpc(routinesEngine);
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
		unregisterRoutines();
		routinesEngine.stop();
		unregisterHistory();
		unregisterBookmarks();
		unregisterDownloads();
		unregisterProfiles();
		unregisterReading();
		unregisterExtensions();
		unregisterSync();
		syncEngine.lock();
		unregisterMcp();
		void mcpHost.disable();
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
