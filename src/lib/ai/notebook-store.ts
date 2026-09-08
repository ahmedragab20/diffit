/**
 * Durable storage for notebook entries and the decisions made on them.
 *
 * Entries are journaled on the same append-only store as run turns, so they
 * inherit its idempotency, replay and recovery. Two rules from the notebook
 * model are preserved across persistence:
 *
 *  - Authoring is not deciding. An entry and a decision are separate records,
 *    so a writer cannot smuggle an outcome in with the entry it authored.
 *  - A decision is the latest one recorded, and earlier decisions stay in the
 *    journal. Changing your mind is a new record, never an erasure.
 */
import { AiSnapshotError, type ReviewSnapshot } from "./snapshots.js";
import {
	authorEntry,
	type Decision,
	type NotebookEntry,
	type NotebookEntryInput,
} from "./notebook.js";
import type { AiStorage } from "./storage.js";

const CONVERSATION = "notebook";

interface EntryPayload {
	kind: "notebook-entry";
	snapshotId: string;
	entry: NotebookEntry;
}

interface DecisionPayload {
	kind: "notebook-decision";
	snapshotId: string;
	entryId: string;
	decision: Decision;
	decidedBy: string;
	decidedAt: number;
}

type Payload = EntryPayload | DecisionPayload;

export interface StoredNotebook {
	snapshotId: string;
	entries: NotebookEntry[];
}

function payloadOf(value: unknown): Payload | null {
	const payload = value as Partial<Payload> | null;
	if (
		payload?.kind !== "notebook-entry" &&
		payload?.kind !== "notebook-decision"
	)
		return null;
	return payload as Payload;
}

export class NotebookStore {
	constructor(private readonly storage: AiStorage) {}

	/**
	 * Validates an entry against the capture and journals it. Validation runs
	 * first, so an entry that cannot cite the capture is never stored.
	 */
	async author(
		snapshot: ReviewSnapshot,
		input: NotebookEntryInput,
	): Promise<NotebookEntry> {
		const entry = authorEntry(snapshot, input);
		const snapshotId = snapshot.manifest.id;
		const payload: EntryPayload = {
			kind: "notebook-entry",
			snapshotId,
			entry,
		};
		await this.storage.append(`notebook:${snapshotId}:${entry.id}`, {
			id: `notebook:${snapshotId}:${entry.id}`,
			runId: snapshotId,
			conversationId: CONVERSATION,
			kind: "result",
			createdAt: Date.now(),
			payload,
		});
		return entry;
	}

	/**
	 * Records a decision as its own entry in the journal. The entry it decides
	 * must already exist, so a decision cannot invent one.
	 */
	async decide(
		snapshotId: string,
		entryId: string,
		decision: Decision,
		decidedBy: string,
		now: () => number = Date.now,
	): Promise<NotebookEntry> {
		if (
			!["accepted", "rejected", "deferred"].includes(decision) ||
			typeof decidedBy !== "string" ||
			!decidedBy ||
			decidedBy.length > 200
		)
			throw new AiSnapshotError("invalid");
		const existing = this.read(snapshotId).entries.find(
			(entry) => entry.id === entryId,
		);
		if (!existing) throw new AiSnapshotError("missing");
		const decidedAt = now();
		const payload: DecisionPayload = {
			kind: "notebook-decision",
			snapshotId,
			entryId,
			decision,
			decidedBy,
			decidedAt,
		};
		// Keyed by time as well as target, so a changed decision is a new record
		// rather than a rewrite of the previous one.
		const key = `notebook-decision:${snapshotId}:${entryId}:${decidedAt}`;
		await this.storage.append(key, {
			id: key,
			runId: snapshotId,
			conversationId: CONVERSATION,
			kind: "result",
			createdAt: decidedAt,
			payload,
		});
		return { ...existing, decision, decidedBy, decidedAt };
	}

	/** Replays the journal into entries with their latest decisions applied. */
	read(snapshotId: string): StoredNotebook {
		const entries = new Map<string, NotebookEntry>();
		const decisions = new Map<string, DecisionPayload>();
		for (const record of this.storage.list(snapshotId)) {
			const payload = payloadOf(record.payload);
			if (!payload || payload.snapshotId !== snapshotId) continue;
			if (payload.kind === "notebook-entry")
				entries.set(payload.entry.id, payload.entry);
			else {
				const current = decisions.get(payload.entryId);
				// The latest decision wins; earlier ones remain in the journal.
				if (!current || payload.decidedAt >= current.decidedAt)
					decisions.set(payload.entryId, payload);
			}
		}
		return {
			snapshotId,
			entries: [...entries.values()].map((entry) => {
				const decided = decisions.get(entry.id);
				return decided
					? {
							...entry,
							decision: decided.decision,
							decidedBy: decided.decidedBy,
							decidedAt: decided.decidedAt,
						}
					: entry;
			}),
		};
	}
}
