/**
 * Bounded in-memory retention of captured review snapshots.
 *
 * A run captures its evidence inline, which leaves an external caller nothing
 * to address. Retaining the capture briefly lets HTTP, CLI and MCP callers
 * navigate exactly the evidence a run would have read, under the same limits.
 *
 * Nothing here is persisted, a retained snapshot is never widened after
 * capture, and a caller that names a revision the store has moved past is told
 * the evidence is stale rather than being served a different generation.
 */
import { AiSnapshotError, type ReviewSnapshot } from "./snapshots.js";

export interface RetainedSnapshot {
	id: string;
	revision: string;
	identityKind: "local" | "pr" | "plan";
	sourceCount: number;
	capturedAt: number;
}

export class SnapshotStore {
	private readonly entries = new Map<
		string,
		{ snapshot: ReviewSnapshot; capturedAt: number }
	>();

	constructor(
		private readonly maxEntries = 8,
		private readonly ttlMs = 10 * 60_000,
		private readonly now: () => number = Date.now,
	) {
		if (
			!Number.isSafeInteger(maxEntries) ||
			maxEntries < 1 ||
			!Number.isSafeInteger(ttlMs) ||
			ttlMs < 1
		)
			throw new AiSnapshotError("invalid");
	}

	/** Retains a capture and returns how to address it. Re-putting refreshes it. */
	put(snapshot: ReviewSnapshot): { id: string; revision: string } {
		const { id, revision } = snapshot.manifest;
		this.sweep();
		// Re-insert so the freshest capture is the most recently used.
		this.entries.delete(id);
		this.entries.set(id, { snapshot, capturedAt: this.now() });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		return { id, revision };
	}

	/**
	 * Resolves a retained snapshot. A caller may pin the revision it captured
	 * against; a mismatch is stale, never a silent substitution.
	 */
	get(id: string, revision?: string): ReviewSnapshot {
		this.sweep();
		const entry = this.entries.get(id);
		if (!entry) throw new AiSnapshotError("missing");
		if (revision !== undefined && revision !== entry.snapshot.manifest.revision)
			throw new AiSnapshotError("stale");
		// Reading through the store counts as use, so an active snapshot survives.
		this.entries.delete(id);
		this.entries.set(id, entry);
		return entry.snapshot;
	}

	list(): RetainedSnapshot[] {
		this.sweep();
		return [...this.entries.entries()].map(([id, entry]) => {
			const manifest = entry.snapshot.manifest;
			return {
				id,
				revision: manifest.revision,
				identityKind: manifest.identity.kind,
				sourceCount: manifest.sources.length,
				capturedAt: entry.capturedAt,
			};
		});
	}

	delete(id: string): boolean {
		return this.entries.delete(id);
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		this.sweep();
		return this.entries.size;
	}

	private sweep(): void {
		const cutoff = this.now() - this.ttlMs;
		for (const [id, entry] of this.entries)
			if (entry.capturedAt <= cutoff) this.entries.delete(id);
	}
}
