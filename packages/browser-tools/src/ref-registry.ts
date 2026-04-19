export interface RefEntry {
	ref: string;
	backendNodeId: number;
	role: string;
	name: string;
	createdAt: number;
	lastSeenAt: number;
}

/**
 * Ref registry keyed by `backendNodeId` within a page lifetime.
 *
 * Spike 2026-04-18 showed a naive monotonic counter drifts badly on
 * JS-mutated pages (github-repo 0.17, mdn-home 0.31, wikipedia 0.61 —
 * see spike/results/2026-04-18.md). Keyed allocation re-uses the same
 * `@eN` label for the same DOM node across snapshots, so the LLM sees
 * stable refs even when the tree wiggles.
 *
 * `resetLifetime` is called on navigation / reload — that is the only
 * time the counter starts over.
 */
export class RefRegistry {
	private byRef = new Map<string, RefEntry>();
	private byNode = new Map<number, string>();
	private counter = 0;

	/** Clear everything. Call on navigation or page reload. */
	resetLifetime(): void {
		this.byRef.clear();
		this.byNode.clear();
		this.counter = 0;
	}

	/**
	 * Return the ref for this backendNodeId, allocating a new one if needed.
	 * Safe to call repeatedly within the same lifetime — same node => same ref.
	 */
	allocate(input: {
		backendNodeId: number;
		role: string;
		name: string;
	}): string {
		const existing = this.byNode.get(input.backendNodeId);
		const now = Date.now();
		if (existing) {
			const entry = this.byRef.get(existing);
			if (entry) {
				entry.role = input.role;
				entry.name = input.name;
				entry.lastSeenAt = now;
				return existing;
			}
		}
		this.counter += 1;
		const ref = `@e${this.counter}`;
		this.byRef.set(ref, {
			ref,
			backendNodeId: input.backendNodeId,
			role: input.role,
			name: input.name,
			createdAt: now,
			lastSeenAt: now,
		});
		this.byNode.set(input.backendNodeId, ref);
		return ref;
	}

	get(ref: string): RefEntry | undefined {
		return this.byRef.get(ref);
	}

	size(): number {
		return this.byRef.size;
	}

	/** Drop entries not seen in the last `ttlMs` ms. Called after each snapshot. */
	sweep(ttlMs: number): void {
		const cutoff = Date.now() - ttlMs;
		for (const [ref, entry] of this.byRef) {
			if (entry.lastSeenAt < cutoff) {
				this.byRef.delete(ref);
				this.byNode.delete(entry.backendNodeId);
			}
		}
	}
}
