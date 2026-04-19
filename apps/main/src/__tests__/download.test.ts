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
});
