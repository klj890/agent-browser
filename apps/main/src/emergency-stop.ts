/**
 * Emergency stop — Stage 7.2.
 *
 * Registers a global shortcut (default `CmdOrCtrl+Shift+.`) that, when fired,
 * aborts every running task in the given TaskStateStore. PLAN requires
 * response < 200ms — abort() fires the AbortController synchronously so the
 * Agent stream unwinds on the next microtask.
 *
 * We don't wire this into `apps/main/src/index.ts` here — a parallel Stage 3
 * agent is editing that file. Caller imports `registerEmergencyStop` from
 * here when ready.
 */
import type { TaskStateStore } from "./task-state.js";

/** Minimal shape of electron.globalShortcut we need; easy to mock in tests. */
export interface GlobalShortcutLike {
	register(accelerator: string, callback: () => void): boolean;
	unregister(accelerator: string): void;
	isRegistered(accelerator: string): boolean;
}

export interface EmergencyStopOpts {
	store: TaskStateStore;
	/** Electron `globalShortcut` — defaults to real one lazily loaded. */
	globalShortcut?: GlobalShortcutLike;
	/** Accelerator string; default per PLAN Stage 7.2. */
	shortcut?: string;
}

const DEFAULT_SHORTCUT = "CmdOrCtrl+Shift+.";

/**
 * Register the emergency-stop global shortcut.
 *
 * Returns an unregister function. The returned function is safe to call
 * multiple times (idempotent).
 */
export function registerEmergencyStop(opts: EmergencyStopOpts): () => void {
	const gs = opts.globalShortcut ?? loadRealGlobalShortcut();
	const accel = opts.shortcut ?? DEFAULT_SHORTCUT;
	const store = opts.store;

	const handler = () => {
		const active = store.listActive();
		for (const t of active) {
			if (t.status !== "running") continue;
			try {
				store.abort(t.id);
			} catch {
				/* swallow: one failing task must not block the others */
			}
		}
	};

	gs.register(accel, handler);

	let unregistered = false;
	return () => {
		if (unregistered) return;
		unregistered = true;
		try {
			gs.unregister(accel);
		} catch {
			/* ignore */
		}
	};
}

function loadRealGlobalShortcut(): GlobalShortcutLike {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { createRequire } =
			require("node:module") as typeof import("node:module");
		const req = createRequire(import.meta.url);
		const electron = req("electron") as { globalShortcut: GlobalShortcutLike };
		return electron.globalShortcut;
	} catch (err) {
		const msg = (err as Error)?.message ?? String(err);
		const stub: GlobalShortcutLike = {
			register() {
				throw new Error(`electron.globalShortcut unavailable: ${msg}`);
			},
			unregister() {
				/* ignore */
			},
			isRegistered() {
				return false;
			},
		};
		return stub;
	}
}
