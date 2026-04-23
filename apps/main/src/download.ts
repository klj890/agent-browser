/**
 * Download manager (Stage 1.6).
 *
 * Hooks `session.on('will-download')` to:
 *   - prompt the user for a save location on first download (PLAN decision D3);
 *   - track {id, url, filename, path, state, received, total, started_at};
 *   - broadcast progress events to the renderer via `downloads:progress`.
 */
import path from "node:path";
import { nanoid } from "nanoid";

export type DownloadState =
	| "progressing"
	| "paused"
	| "completed"
	| "cancelled"
	| "interrupted";

export interface DownloadRecord {
	id: string;
	url: string;
	filename: string;
	path: string;
	state: DownloadState;
	received: number;
	total: number;
	started_at: number;
}

// ---------------------------------------------------------------------------
// Electron-facing interfaces (narrow subset for testability).
// ---------------------------------------------------------------------------

export interface DialogLike {
	showSaveDialog(opts: {
		defaultPath?: string;
		title?: string;
	}): Promise<{ canceled: boolean; filePath?: string }>;
}

export interface DownloadItemLike {
	getURL(): string;
	getFilename(): string;
	getTotalBytes(): number;
	getReceivedBytes(): number;
	getSavePath(): string;
	setSavePath(p: string): void;
	pause(): void;
	resume(): void;
	cancel(): void;
	on(event: "updated" | "done", cb: (ev: unknown, state: string) => void): void;
}

export interface SessionLike {
	on(
		event: "will-download",
		cb: (ev: { preventDefault: () => void }, item: DownloadItemLike) => void,
	): void;
}

export interface DownloadManagerDeps {
	session: SessionLike;
	dialog: DialogLike;
	/** Default download directory (falls back to cwd in tests). */
	defaultDir: string;
	/** Broadcast callback: main→renderer via webContents.send. */
	broadcast: (record: DownloadRecord) => void;
	/** Open a folder in the OS file manager. */
	openFolder?: (p: string) => void;
	/** Ask user every time (PLAN D3). Default true. */
	askEveryTime?: boolean;
}

export class DownloadManager {
	private readonly records = new Map<string, DownloadRecord>();
	private readonly items = new Map<string, DownloadItemLike>();
	private readonly askEveryTime: boolean;

	constructor(private readonly deps: DownloadManagerDeps) {
		this.askEveryTime = deps.askEveryTime ?? true;
		deps.session.on("will-download", (ev, item) => this.handle(ev, item));
	}

	private async handle(
		ev: { preventDefault: () => void },
		item: DownloadItemLike,
	): Promise<void> {
		const id = nanoid();
		const url = item.getURL();
		const filename = item.getFilename();
		const total = item.getTotalBytes();
		const defaultPath = path.join(this.deps.defaultDir, filename);

		let savePath = defaultPath;
		if (this.askEveryTime) {
			// Call preventDefault() BEFORE awaiting the save dialog. Without
			// this, Electron's default download pipeline starts writing to
			// `defaultPath` immediately while we're still awaiting user choice,
			// which can race our subsequent `setSavePath` call.
			try {
				ev.preventDefault();
			} catch {
				/* ignore — some test stubs don't implement it */
			}
			const res = await this.deps.dialog.showSaveDialog({
				defaultPath,
				title: "Save file",
			});
			if (res.canceled || !res.filePath) {
				try {
					item.cancel();
				} catch {
					/* ignore */
				}
				return;
			}
			savePath = res.filePath;
		}
		try {
			item.setSavePath(savePath);
		} catch {
			/* setSavePath may throw if already set; ignore */
		}

		const record: DownloadRecord = {
			id,
			url,
			filename: path.basename(savePath),
			path: savePath,
			state: "progressing",
			received: item.getReceivedBytes(),
			total,
			started_at: Date.now(),
		};
		this.records.set(id, record);
		this.items.set(id, item);
		this.deps.broadcast(record);

		item.on("updated", (_e, state: string) => {
			record.received = item.getReceivedBytes();
			record.total = item.getTotalBytes();
			record.state = state === "interrupted" ? "interrupted" : "progressing";
			if (state === "progressing") {
				// If paused the state param is "progressing" — check via isPaused is not
				// in our interface, so just leave as progressing here.
			}
			this.deps.broadcast(record);
		});
		item.on("done", (_e, state: string) => {
			record.received = item.getReceivedBytes();
			record.total = item.getTotalBytes();
			record.state =
				state === "completed"
					? "completed"
					: state === "cancelled"
						? "cancelled"
						: "interrupted";
			this.deps.broadcast(record);
			this.items.delete(id);
		});
	}

	list(): DownloadRecord[] {
		return Array.from(this.records.values()).sort(
			(a, b) => b.started_at - a.started_at,
		);
	}

	cancel(id: string): boolean {
		const item = this.items.get(id);
		if (!item) return false;
		try {
			item.cancel();
			return true;
		} catch {
			return false;
		}
	}

	openFolder(id: string): boolean {
		const rec = this.records.get(id);
		if (!rec) return false;
		const opener = this.deps.openFolder;
		if (!opener) return false;
		opener(path.dirname(rec.path));
		return true;
	}
}
