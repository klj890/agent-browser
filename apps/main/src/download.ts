/**
 * Download manager (Stage 1.6 + P1-12 multi-session hardening).
 *
 * Hooks `will-download` on every Electron session the browser actually uses:
 * the default session, each persistent profile partition, and each ephemeral
 * incognito partition. Without per-session registration, downloads triggered
 * in a non-default profile or incognito tab would silently escape the
 * manager (Chromium dispatches will-download on the *originating* session,
 * not the default one).
 *
 * Each attached session is tracked by partition name so we never wire the
 * same session twice. Incognito records are flagged `ephemeral: true`; the
 * renderer is expected to drop them from history when the partition is
 * emptied (TabManager fires onIncognitoPartitionEmpty which calls
 * `dropPartition()` here).
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
	/** Electron session.partition this download originated from. */
	partition: string;
	/** True when the originating partition is an incognito session. */
	ephemeral: boolean;
	/** Persistent profile id (omitted for default/incognito). */
	profileId?: string;
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
	/** Optional — real Electron Session exposes `.off`. Mocks may omit. */
	off?(
		event: "will-download",
		cb: (ev: { preventDefault: () => void }, item: DownloadItemLike) => void,
	): void;
}

export interface AttachOpts {
	/** Electron partition name ("persist:default", "incognito:abc…"). */
	partition: string;
	/** Persistent profile id — omitted for default or incognito sessions. */
	profileId?: string;
	/** Incognito partitions set ephemeral=true on records and skip persistence. */
	isIncognito?: boolean;
}

export interface DownloadManagerDeps {
	dialog: DialogLike;
	/** Default download directory (falls back to cwd in tests). */
	defaultDir: string;
	/** Broadcast callback: main→renderer via webContents.send. */
	broadcast: (record: DownloadRecord) => void;
	/** Open a folder in the OS file manager. */
	openFolder?: (p: string) => void;
	/** Ask user every time (PLAN D3). Default true. */
	askEveryTime?: boolean;
	/**
	 * Convenience: attach the default Electron session at construction time.
	 * Equivalent to calling `attachSession(deps.session, { partition: "persist:default" })`
	 * immediately after construction.
	 */
	session?: SessionLike;
}

interface AttachedSession {
	session: SessionLike;
	opts: AttachOpts;
	handler: (ev: { preventDefault: () => void }, item: DownloadItemLike) => void;
}

export class DownloadManager {
	private readonly records = new Map<string, DownloadRecord>();
	private readonly items = new Map<string, DownloadItemLike>();
	private readonly attached = new Map<string, AttachedSession>();
	private readonly askEveryTime: boolean;

	constructor(private readonly deps: DownloadManagerDeps) {
		this.askEveryTime = deps.askEveryTime ?? true;
		if (deps.session) {
			this.attachSession(deps.session, { partition: "persist:default" });
		}
	}

	/**
	 * Register a session for will-download events. Safe to call multiple
	 * times with the same partition — subsequent calls are no-ops. Returns
	 * `true` when a new attachment was created.
	 */
	attachSession(session: SessionLike, opts: AttachOpts): boolean {
		if (this.attached.has(opts.partition)) return false;
		const handler = (
			ev: { preventDefault: () => void },
			item: DownloadItemLike,
		) => this.handle(ev, item, opts);
		session.on("will-download", handler);
		this.attached.set(opts.partition, { session, opts, handler });
		return true;
	}

	/**
	 * Detach a session and drop in-memory records tied to that partition.
	 * Called by TabManager's onIncognitoPartitionEmpty when the last tab of
	 * an ephemeral partition closes — ensures no file paths or URLs for a
	 * private session survive in the manager's memory.
	 */
	dropPartition(partition: string): void {
		const att = this.attached.get(partition);
		if (att) {
			try {
				att.session.off?.("will-download", att.handler);
			} catch {
				// Some Electron versions lack .off for session events.
			}
			this.attached.delete(partition);
		}
		// Purge any in-memory records originating from this partition.
		for (const [id, rec] of this.records) {
			if (rec.partition === partition) {
				this.records.delete(id);
				this.items.delete(id);
			}
		}
	}

	private async handle(
		ev: { preventDefault: () => void },
		item: DownloadItemLike,
		origin: AttachOpts,
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
			partition: origin.partition,
			ephemeral: origin.isIncognito === true,
			profileId: origin.profileId,
		};
		this.records.set(id, record);
		this.items.set(id, item);
		this.deps.broadcast(record);

		item.on("updated", (_e, state: string) => {
			record.received = item.getReceivedBytes();
			record.total = item.getTotalBytes();
			record.state = state === "interrupted" ? "interrupted" : "progressing";
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

	/** Test-only: introspect attached partitions. */
	attachedPartitions(): string[] {
		return Array.from(this.attached.keys());
	}
}
