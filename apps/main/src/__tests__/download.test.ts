import { describe, expect, it, vi } from "vitest";
import {
	type DialogLike,
	type DownloadItemLike,
	DownloadManager,
	type DownloadRecord,
	type SessionLike,
} from "../download.js";

interface Listeners {
	willDownload: Array<
		(ev: { preventDefault: () => void }, item: DownloadItemLike) => void
	>;
}

function mkSession(): { session: SessionLike; emit: Listeners } {
	const l: Listeners = { willDownload: [] };
	const session: SessionLike = {
		on: (_e, cb) => {
			l.willDownload.push(cb);
		},
	};
	return { session, emit: l };
}

function mkItem(overrides?: Partial<DownloadItemLike>) {
	const handlers: Record<
		string,
		Array<(ev: unknown, state: string) => void>
	> = {};
	const item: DownloadItemLike = {
		getURL: () => "https://example.com/file.zip",
		getFilename: () => "file.zip",
		getTotalBytes: () => 1000,
		getReceivedBytes: () => 0,
		getSavePath: () => "",
		setSavePath: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		cancel: vi.fn(),
		on: (event, cb) => {
			const arr = handlers[event] ?? [];
			arr.push(cb);
			handlers[event] = arr;
		},
		...overrides,
	};
	return {
		item,
		fire(event: "updated" | "done", state: string) {
			for (const cb of handlers[event] ?? []) cb({}, state);
		},
	};
}

describe("DownloadManager", () => {
	it("prompts dialog and broadcasts progressing record", async () => {
		const { session, emit } = mkSession();
		const dialog: DialogLike = {
			showSaveDialog: vi
				.fn()
				.mockResolvedValue({ canceled: false, filePath: "/tmp/out.zip" }),
		};
		const broadcast = vi.fn();
		new DownloadManager({ session, dialog, defaultDir: "/tmp", broadcast });
		const { item } = mkItem();
		await emit.willDownload[0]?.({ preventDefault: () => {} }, item);
		expect(dialog.showSaveDialog).toHaveBeenCalled();
		expect(item.setSavePath).toHaveBeenCalledWith("/tmp/out.zip");
		expect(broadcast).toHaveBeenCalledTimes(1);
		const rec = broadcast.mock.calls[0]?.[0] as DownloadRecord;
		expect(rec.path).toBe("/tmp/out.zip");
		expect(rec.state).toBe("progressing");
	});

	it("cancels item when user cancels dialog", async () => {
		const { session, emit } = mkSession();
		const dialog: DialogLike = {
			showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
		};
		new DownloadManager({
			session,
			dialog,
			defaultDir: "/tmp",
			broadcast: vi.fn(),
		});
		const { item } = mkItem();
		await emit.willDownload[0]?.({ preventDefault: () => {} }, item);
		expect(item.cancel).toHaveBeenCalled();
	});

	it("emits completed state on done", async () => {
		const { session, emit } = mkSession();
		const dialog: DialogLike = {
			showSaveDialog: vi
				.fn()
				.mockResolvedValue({ canceled: false, filePath: "/tmp/x" }),
		};
		const broadcast = vi.fn();
		const dm = new DownloadManager({
			session,
			dialog,
			defaultDir: "/tmp",
			broadcast,
		});
		const { item, fire } = mkItem({
			getReceivedBytes: () => 1000,
			getTotalBytes: () => 1000,
		});
		await emit.willDownload[0]?.({ preventDefault: () => {} }, item);
		fire("done", "completed");
		const last = broadcast.mock.calls.at(-1)?.[0] as DownloadRecord;
		expect(last.state).toBe("completed");
		expect(dm.list().length).toBe(1);
	});

	it("skips dialog when askEveryTime=false", async () => {
		const { session, emit } = mkSession();
		const dialog: DialogLike = {
			showSaveDialog: vi.fn(),
		};
		new DownloadManager({
			session,
			dialog,
			defaultDir: "/tmp",
			broadcast: vi.fn(),
			askEveryTime: false,
		});
		const { item } = mkItem();
		await emit.willDownload[0]?.({ preventDefault: () => {} }, item);
		expect(dialog.showSaveDialog).not.toHaveBeenCalled();
		expect(item.setSavePath).toHaveBeenCalled();
	});

	it("attachSession routes per-partition + tags record with partition/profile/ephemeral", async () => {
		const dialog: DialogLike = {
			showSaveDialog: vi.fn(async () => ({
				canceled: false,
				filePath: "/tmp/out.bin",
			})),
		};
		const broadcast = vi.fn();
		const mgr = new DownloadManager({ dialog, defaultDir: "/tmp", broadcast });

		const defaultSess = mkSession();
		const workSess = mkSession();
		const incogSess = mkSession();
		mgr.attachSession(defaultSess.session, { partition: "persist:default" });
		mgr.attachSession(workSess.session, {
			partition: "persist:profile-work",
			profileId: "work",
		});
		mgr.attachSession(incogSess.session, {
			partition: "incognito:abc",
			isIncognito: true,
		});
		expect(mgr.attachedPartitions().sort()).toEqual([
			"incognito:abc",
			"persist:default",
			"persist:profile-work",
		]);

		// Trigger one download on each session.
		const a = mkItem();
		const b = mkItem();
		const c = mkItem();
		await defaultSess.emit.willDownload[0]?.(
			{ preventDefault: () => {} },
			a.item,
		);
		await workSess.emit.willDownload[0]?.({ preventDefault: () => {} }, b.item);
		await incogSess.emit.willDownload[0]?.(
			{ preventDefault: () => {} },
			c.item,
		);

		const rows = mgr.list();
		expect(rows).toHaveLength(3);
		const byPartition = new Map(rows.map((r) => [r.partition, r]));
		expect(byPartition.get("persist:default")?.ephemeral).toBe(false);
		expect(byPartition.get("persist:default")?.profileId).toBeUndefined();
		expect(byPartition.get("persist:profile-work")?.profileId).toBe("work");
		expect(byPartition.get("persist:profile-work")?.ephemeral).toBe(false);
		expect(byPartition.get("incognito:abc")?.ephemeral).toBe(true);
	});

	it("attachSession is idempotent per partition", () => {
		const mgr = new DownloadManager({
			dialog: { showSaveDialog: vi.fn() },
			defaultDir: "/tmp",
			broadcast: vi.fn(),
		});
		const { session } = mkSession();
		expect(mgr.attachSession(session, { partition: "persist:p1" })).toBe(true);
		expect(mgr.attachSession(session, { partition: "persist:p1" })).toBe(false);
		expect(mgr.attachedPartitions()).toEqual(["persist:p1"]);
	});

	it("dropPartition purges records + calls session.off when available", async () => {
		const dialog: DialogLike = {
			showSaveDialog: vi.fn(async () => ({
				canceled: false,
				filePath: "/tmp/out",
			})),
		};
		const off = vi.fn();
		const { session, emit } = mkSession();
		(session as SessionLike).off = off;
		const mgr = new DownloadManager({
			dialog,
			defaultDir: "/tmp",
			broadcast: vi.fn(),
		});
		mgr.attachSession(session, {
			partition: "incognito:xx",
			isIncognito: true,
		});
		const { item } = mkItem();
		await emit.willDownload[0]?.({ preventDefault: () => {} }, item);
		expect(mgr.list()).toHaveLength(1);

		mgr.dropPartition("incognito:xx");
		expect(off).toHaveBeenCalled();
		expect(mgr.attachedPartitions()).toEqual([]);
		expect(mgr.list()).toEqual([]);
	});

	it("legacy constructor with session attaches as persist:default", async () => {
		const { session, emit } = mkSession();
		const dialog: DialogLike = {
			showSaveDialog: vi.fn(async () => ({
				canceled: false,
				filePath: "/tmp/legacy",
			})),
		};
		const mgr = new DownloadManager({
			session,
			dialog,
			defaultDir: "/tmp",
			broadcast: vi.fn(),
		});
		expect(mgr.attachedPartitions()).toEqual(["persist:default"]);
		const { item } = mkItem();
		await emit.willDownload[0]?.({ preventDefault: () => {} }, item);
		expect(mgr.list()[0]?.partition).toBe("persist:default");
	});
});
