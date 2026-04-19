import { describe, expect, it } from "vitest";
import { RefRegistry } from "../ref-registry.js";

describe("RefRegistry", () => {
	it("allocates sequential refs starting from @e1", () => {
		const r = new RefRegistry();
		const a = r.allocate({ backendNodeId: 10, role: "button", name: "Submit" });
		const b = r.allocate({ backendNodeId: 11, role: "link", name: "Home" });
		expect(a).toBe("@e1");
		expect(b).toBe("@e2");
	});

	it("returns the same ref for the same backendNodeId across snapshots", () => {
		const r = new RefRegistry();
		const first = r.allocate({ backendNodeId: 42, role: "button", name: "Go" });
		const second = r.allocate({
			backendNodeId: 42,
			role: "button",
			name: "Go",
		});
		expect(second).toBe(first);
		expect(r.size()).toBe(1);
	});

	it("updates role/name on re-allocate but keeps ref stable", () => {
		const r = new RefRegistry();
		const ref = r.allocate({ backendNodeId: 7, role: "button", name: "Old" });
		r.allocate({ backendNodeId: 7, role: "button", name: "New" });
		expect(r.get(ref)?.name).toBe("New");
	});

	it("resetLifetime clears everything and restarts counter", () => {
		const r = new RefRegistry();
		r.allocate({ backendNodeId: 1, role: "button", name: "x" });
		r.resetLifetime();
		expect(r.size()).toBe(0);
		const next = r.allocate({ backendNodeId: 2, role: "button", name: "y" });
		expect(next).toBe("@e1");
	});

	it("sweep drops entries older than ttl", async () => {
		const r = new RefRegistry();
		r.allocate({ backendNodeId: 1, role: "button", name: "stale" });
		await new Promise((ok) => setTimeout(ok, 15));
		r.sweep(10);
		expect(r.size()).toBe(0);
	});

	it("sweep keeps entries seen within ttl", () => {
		const r = new RefRegistry();
		r.allocate({ backendNodeId: 1, role: "button", name: "fresh" });
		r.sweep(10_000);
		expect(r.size()).toBe(1);
	});

	it("returns undefined for missing ref", () => {
		const r = new RefRegistry();
		expect(r.get("@e99")).toBeUndefined();
	});
});
