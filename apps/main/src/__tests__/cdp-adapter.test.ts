/**
 * CdpAdapter unit tests — mock `webContents.debugger`.
 */
import { describe, expect, it, vi } from "vitest";
import {
	CdpAdapter,
	CdpUnavailableError,
	type DebuggerLike,
	type WebContentsLike,
} from "../cdp-adapter.js";

interface FakeDebugger extends DebuggerLike {
	_emit(event: "message" | "detach", ...args: unknown[]): void;
	readonly _commands: Array<{ method: string; params?: object }>;
	readonly _attachCalls: number;
	readonly _detachCalls: number;
	readonly _attached: boolean;
	_sendImpl: ((method: string, params?: object) => Promise<unknown>) | null;
}

function makeFakeDebugger(): FakeDebugger {
	const state = {
		attached: false,
		attachCalls: 0,
		detachCalls: 0,
	};
	const commands: Array<{ method: string; params?: object }> = [];
	const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
	const fake = {
		_sendImpl: null as
			| ((method: string, params?: object) => Promise<unknown>)
			| null,
		attach(_v?: string) {
			state.attached = true;
			state.attachCalls += 1;
		},
		detach() {
			state.attached = false;
			state.detachCalls += 1;
		},
		isAttached() {
			return state.attached;
		},
		sendCommand(method: string, params?: object) {
			commands.push({ method, params });
			if (fake._sendImpl) return fake._sendImpl(method, params);
			return Promise.resolve({});
		},
		on(event: string, listener: (...a: unknown[]) => void) {
			const arr = listeners.get(event) ?? [];
			arr.push(listener);
			listeners.set(event, arr);
			return fake;
		},
		off(event: string, listener: (...a: unknown[]) => void) {
			const arr = listeners.get(event) ?? [];
			listeners.set(
				event,
				arr.filter((l) => l !== listener),
			);
			return fake;
		},
		_emit(event: "message" | "detach", ...args: unknown[]) {
			for (const l of listeners.get(event) ?? []) l(...args);
		},
		get _commands() {
			return commands;
		},
		get _attachCalls() {
			return state.attachCalls;
		},
		get _detachCalls() {
			return state.detachCalls;
		},
		get _attached() {
			return state.attached;
		},
	};
	return fake as unknown as FakeDebugger;
}

function makeWc(dbg: DebuggerLike): WebContentsLike {
	return { debugger: dbg, isDestroyed: () => false };
}

describe("CdpAdapter", () => {
	it("attaches with protocol 1.3 and enables default domains on construct", async () => {
		const dbg = makeFakeDebugger();
		const cdp = new CdpAdapter(makeWc(dbg));
		await cdp.ready();
		expect(dbg._attachCalls).toBe(1);
		const methods = dbg._commands.map((c) => c.method);
		expect(methods).toEqual([
			"Page.enable",
			"DOM.enable",
			"Accessibility.enable",
		]);
		cdp.detach();
	});

	it("send forwards params and returns result", async () => {
		const dbg = makeFakeDebugger();
		dbg._sendImpl = async (method: string) => {
			if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
			return {};
		};
		const cdp = new CdpAdapter(makeWc(dbg));
		const r = await cdp.send<{ root: { nodeId: number } }>("DOM.getDocument");
		expect(r.root.nodeId).toBe(1);
		cdp.detach();
	});

	it("on() subscribes to events and returns unsubscribe", async () => {
		const dbg = makeFakeDebugger();
		const cdp = new CdpAdapter(makeWc(dbg));
		await cdp.ready();
		const cb = vi.fn();
		const off = cdp.on("Page.frameNavigated", cb);
		dbg._emit("message", null, "Page.frameNavigated", { frame: { id: "f1" } });
		expect(cb).toHaveBeenCalledWith({ frame: { id: "f1" } });
		off();
		dbg._emit("message", null, "Page.frameNavigated", { frame: { id: "f2" } });
		expect(cb).toHaveBeenCalledTimes(1);
		cdp.detach();
	});

	it("reconnects up to 3 times on detach errors, then throws CdpUnavailableError", async () => {
		const dbg = makeFakeDebugger();
		let domainsEnabled = 0;
		dbg._sendImpl = async (method: string) => {
			if (method.endsWith(".enable")) {
				domainsEnabled += 1;
				return {};
			}
			if (method === "DOM.getDocument") {
				throw new Error("Target closed.");
			}
			return {};
		};
		const cdp = new CdpAdapter(makeWc(dbg));
		await expect(cdp.send("DOM.getDocument")).rejects.toBeInstanceOf(
			CdpUnavailableError,
		);
		// initial attach + at least 1 reconnect
		expect(dbg._attachCalls).toBeGreaterThanOrEqual(1);
		expect(domainsEnabled).toBeGreaterThanOrEqual(6); // 2+ full enables
		cdp.detach();
	});

	it("detach unsubscribes listeners and marks disposed", async () => {
		const dbg = makeFakeDebugger();
		const cdp = new CdpAdapter(makeWc(dbg));
		await cdp.ready();
		const cb = vi.fn();
		cdp.on("Page.loadEventFired", cb);
		cdp.detach();
		expect(dbg._detachCalls).toBe(1);
		expect(dbg._attached).toBe(false);
		dbg._emit("message", null, "Page.loadEventFired", {});
		expect(cb).not.toHaveBeenCalled();
		await expect(cdp.send("x")).rejects.toBeInstanceOf(CdpUnavailableError);
	});

	it("send after transient session-closed error reconnects and succeeds", async () => {
		const dbg = makeFakeDebugger();
		let failOnce = true;
		dbg._sendImpl = async (method: string) => {
			if (method === "Page.reload" && failOnce) {
				failOnce = false;
				throw new Error("session closed");
			}
			return { ok: 1 };
		};
		const cdp = new CdpAdapter(makeWc(dbg));
		await cdp.ready();
		const r = (await cdp.send("Page.reload")) as { ok: number };
		expect(r.ok).toBe(1);
		cdp.detach();
	});

	it("isAttached reflects debugger state", async () => {
		const dbg = makeFakeDebugger();
		const cdp = new CdpAdapter(makeWc(dbg));
		await cdp.ready();
		expect(cdp.isAttached()).toBe(true);
		cdp.detach();
		expect(cdp.isAttached()).toBe(false);
	});
});
