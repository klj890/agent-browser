import { describe, expect, it } from "vitest";
import { ProfileStore } from "../profile-store.js";
import { AppDatabase } from "../storage/sqlite.js";

function mkStore(): { store: ProfileStore; db: AppDatabase } {
	const db = new AppDatabase(":memory:");
	return { store: new ProfileStore(db), db };
}

describe("ProfileStore", () => {
	it("seeds the default profile via migration", () => {
		const { store, db } = mkStore();
		const list = store.list();
		expect(list.map((p) => p.id)).toEqual(["default"]);
		expect(list[0]?.partition).toBe("persist:default");
		expect(store.defaultProfile().id).toBe("default");
		db.close();
	});

	it("create() generates unique persist: partitions", () => {
		const { store, db } = mkStore();
		const a = store.create("Work");
		const b = store.create("Personal");
		expect(a.partition).not.toBe(b.partition);
		expect(a.partition.startsWith("persist:profile-")).toBe(true);
		expect(b.partition.startsWith("persist:profile-")).toBe(true);
		expect(store.list()).toHaveLength(3);
		db.close();
	});

	it("create() rejects empty or overlong names", () => {
		const { store, db } = mkStore();
		expect(() => store.create("")).toThrow();
		expect(() => store.create("   ")).toThrow();
		expect(() => store.create("x".repeat(65))).toThrow();
		db.close();
	});

	it("rename() updates the name but keeps the partition", () => {
		const { store, db } = mkStore();
		const p = store.create("Old");
		const r = store.rename(p.id, "New");
		expect(r.name).toBe("New");
		expect(r.partition).toBe(p.partition);
		db.close();
	});

	it("remove() refuses the default profile", () => {
		const { store, db } = mkStore();
		expect(() => store.remove("default")).toThrow();
		db.close();
	});

	it("remove() deletes a non-default profile", () => {
		const { store, db } = mkStore();
		const p = store.create("Temp");
		expect(store.remove(p.id)).toBe(true);
		expect(store.getById(p.id)).toBeUndefined();
		db.close();
	});

	it("getByPartition resolves persisted partitions", () => {
		const { store, db } = mkStore();
		const p = store.create("Work");
		expect(store.getByPartition(p.partition)?.id).toBe(p.id);
		expect(store.getByPartition("persist:does-not-exist")).toBeUndefined();
		db.close();
	});
});
