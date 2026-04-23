/**
 * ProfileStore (Stage P1-12) — manages persistent Electron session profiles.
 *
 * A profile maps a user-facing label to an Electron `session.fromPartition`
 * partition string. All persistent profiles use the `persist:` prefix so
 * cookies / localStorage / IndexedDB survive restarts. The row with
 * id='default' is seeded by the migration and cannot be removed.
 *
 * Incognito tabs use ephemeral partitions `incognito:{nanoid}` and never
 * touch this table — TabManager manages their lifetime entirely in memory.
 */
import { nanoid } from "nanoid";
import type { AppDatabase } from "./storage/sqlite.js";

export interface ProfileRecord {
	id: string;
	name: string;
	partition: string;
	createdAt: number;
}

const DEFAULT_ID = "default";
const PARTITION_PREFIX = "persist:profile-";

function sanitizeName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("profile name cannot be empty");
	if (trimmed.length > 64) throw new Error("profile name too long (max 64)");
	return trimmed;
}

export class ProfileStore {
	private readonly insertStmt: import("better-sqlite3").Statement;
	private readonly renameStmt: import("better-sqlite3").Statement;
	private readonly deleteStmt: import("better-sqlite3").Statement;
	private readonly listStmt: import("better-sqlite3").Statement;
	private readonly getByIdStmt: import("better-sqlite3").Statement;
	private readonly getByPartitionStmt: import("better-sqlite3").Statement;

	constructor(appDb: AppDatabase) {
		const db = appDb.db;
		this.insertStmt = db.prepare(
			"INSERT INTO profiles (id, name, partition, created_at) VALUES (?, ?, ?, ?)",
		);
		this.renameStmt = db.prepare("UPDATE profiles SET name = ? WHERE id = ?");
		this.deleteStmt = db.prepare("DELETE FROM profiles WHERE id = ?");
		this.listStmt = db.prepare(
			"SELECT id, name, partition, created_at FROM profiles ORDER BY created_at ASC, id ASC",
		);
		this.getByIdStmt = db.prepare(
			"SELECT id, name, partition, created_at FROM profiles WHERE id = ?",
		);
		this.getByPartitionStmt = db.prepare(
			"SELECT id, name, partition, created_at FROM profiles WHERE partition = ?",
		);
	}

	list(): ProfileRecord[] {
		return (
			this.listStmt.all() as Array<{
				id: string;
				name: string;
				partition: string;
				created_at: number;
			}>
		).map((r) => ({
			id: r.id,
			name: r.name,
			partition: r.partition,
			createdAt: r.created_at,
		}));
	}

	getById(id: string): ProfileRecord | undefined {
		const row = this.getByIdStmt.get(id) as
			| { id: string; name: string; partition: string; created_at: number }
			| undefined;
		if (!row) return undefined;
		return {
			id: row.id,
			name: row.name,
			partition: row.partition,
			createdAt: row.created_at,
		};
	}

	getByPartition(partition: string): ProfileRecord | undefined {
		const row = this.getByPartitionStmt.get(partition) as
			| { id: string; name: string; partition: string; created_at: number }
			| undefined;
		if (!row) return undefined;
		return {
			id: row.id,
			name: row.name,
			partition: row.partition,
			createdAt: row.created_at,
		};
	}

	create(name: string): ProfileRecord {
		const cleanName = sanitizeName(name);
		const id = nanoid(10);
		const partition = `${PARTITION_PREFIX}${id}`;
		const createdAt = Date.now();
		this.insertStmt.run(id, cleanName, partition, createdAt);
		return { id, name: cleanName, partition, createdAt };
	}

	rename(id: string, name: string): ProfileRecord {
		const existing = this.getById(id);
		if (!existing) throw new Error(`no profile with id=${id}`);
		const cleanName = sanitizeName(name);
		this.renameStmt.run(cleanName, id);
		return { ...existing, name: cleanName };
	}

	/**
	 * Remove a non-default profile. Returns true if a row was deleted.
	 * Caller is responsible for closing tabs using this partition and for
	 * clearing Electron session storage (done in TabManager/index.ts).
	 */
	remove(id: string): boolean {
		if (id === DEFAULT_ID) {
			throw new Error("cannot remove the default profile");
		}
		const info = this.deleteStmt.run(id);
		return info.changes > 0;
	}

	defaultProfile(): ProfileRecord {
		const d = this.getById(DEFAULT_ID);
		if (!d) throw new Error("default profile missing — migration not applied");
		return d;
	}
}
