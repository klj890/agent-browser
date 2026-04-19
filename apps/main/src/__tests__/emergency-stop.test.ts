/**
 * Emergency-stop unit tests — Stage 7.2.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type GlobalShortcutLike,
	registerEmergencyStop,
} from "../emergency-stop.js";
import { TaskStateStore } from "../task-state.js";

function makeMockGs(): GlobalShortcutLike & {
	registered: Map<string, () => void>;
	fire: (accel: string) => void;
} {
	const registered = new Map<string, () => void>();
	return {
		registered,
		register: vi.fn((accel: string, cb: () => void) => {
			registered.set(accel, cb);
			return true;
		}),
		unregister: vi.fn((accel: string) => {
			registered.delete(accel);
		}),
		isRegistered: (accel: string) => registered.has(accel),
		fire: (accel: string) => {
			const cb = registered.get(accel);
			if (!cb) throw new Error(`not registered: ${accel}`);
			cb();
		},
	};
}

const INIT = { prompt: "p", persona: "default", tabId: "tab-1" };

describe("registerEmergencyStop", () => {
	it("registers the default shortcut on electron.globalShortcut", () => {
		const gs = makeMockGs();
		const store = new TaskStateStore();
		const unreg = registerEmergencyStop({ store, globalShortcut: gs });
		expect(gs.register).toHaveBeenCalledTimes(1);
		expect(gs.register).toHaveBeenCalledWith(
			"CmdOrCtrl+Shift+.",
			expect.any(Function),
		);
		expect(gs.isRegistered("CmdOrCtrl+Shift+.")).toBe(true);
		unreg();
	});

	it("honors a custom shortcut override", () => {
		const gs = makeMockGs();
		const store = new TaskStateStore();
		const unreg = registerEmergencyStop({
			store,
			globalShortcut: gs,
			shortcut: "Alt+Escape",
		});
		expect(gs.register).toHaveBeenCalledWith(
			"Alt+Escape",
			expect.any(Function),
		);
		unreg();
	});

	it("firing the shortcut aborts every running task under 200ms", async () => {
		const gs = makeMockGs();
		const store = new TaskStateStore();
		const a = store.create(INIT);
		const b = store.create(INIT);
		const c = store.create(INIT);
		store.transition(a.id, "running");
		store.transition(b.id, "running");
		// c stays pending → should NOT be aborted (spec says status='running')
		const unreg = registerEmergencyStop({ store, globalShortcut: gs });

		const start = Date.now();
		gs.fire("CmdOrCtrl+Shift+.");
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(200);
		expect(store.get(a.id).status).toBe("killed");
		expect(store.get(b.id).status).toBe("killed");
		expect(a.abortController.signal.aborted).toBe(true);
		expect(b.abortController.signal.aborted).toBe(true);
		// pending task untouched
		expect(store.get(c.id).status).toBe("pending");
		expect(c.abortController.signal.aborted).toBe(false);
		unreg();
	});

	it("returned function unregisters via electron.globalShortcut.unregister", () => {
		const gs = makeMockGs();
		const store = new TaskStateStore();
		const unreg = registerEmergencyStop({ store, globalShortcut: gs });
		unreg();
		expect(gs.unregister).toHaveBeenCalledWith("CmdOrCtrl+Shift+.");
		expect(gs.isRegistered("CmdOrCtrl+Shift+.")).toBe(false);
	});

	it("unregister is idempotent", () => {
		const gs = makeMockGs();
		const store = new TaskStateStore();
		const unreg = registerEmergencyStop({ store, globalShortcut: gs });
		unreg();
		unreg();
		unreg();
		expect(gs.unregister).toHaveBeenCalledTimes(1);
	});

	it("fire with no running tasks does not throw", () => {
		const gs = makeMockGs();
		const store = new TaskStateStore();
		const unreg = registerEmergencyStop({ store, globalShortcut: gs });
		expect(() => gs.fire("CmdOrCtrl+Shift+.")).not.toThrow();
		unreg();
	});
});
