/**
 * Imports legacy conversation history into server-owned durable storage.
 *
 * The plan is explicit: "Import legacy history without overwriting originals"
 * and "use revisions and idempotency keys rather than whole-transcript
 * last-write-wins saves". Both are enforced here.
 *
 *  - The legacy store is only ever read. Nothing in this module writes to it,
 *    so an import can be re-run, interrupted, or abandoned without damaging
 *    the history it came from.
 *  - Every turn is journaled under a key derived from its conversation and
 *    identity, so a repeated or resumed import adds nothing the second time
 *    instead of duplicating a transcript.
 *  - A turn that cannot be trusted is skipped and counted, never rewritten
 *    into something that would import cleanly.
 */
import type { AiStorage, AiTurnRecord } from "./storage.js";
import type { AiConversation, AiConversationStore } from "./conversations.js";

export interface ImportReport {
	conversations: number;
	/** Turns written by this run. */
	imported: number;
	/** Turns already present, so a re-run is a no-op rather than a duplicate. */
	alreadyPresent: number;
	/** Turns that could not be trusted and were left alone. */
	skipped: number;
}

/**
 * A stable key for one legacy turn. Position is part of the key because legacy
 * turns are not required to carry an id, and two turns may otherwise be
 * identical.
 */
export function legacyTurnKey(
	conversationId: string,
	index: number,
	turnId: string | undefined,
): string {
	return `legacy:${conversationId}:${index}:${turnId ?? ""}`;
}

function usableTurn(turn: unknown): turn is {
	role: "user" | "assistant";
	text: string;
	id?: string;
	createdAt?: number;
	modelId?: string;
} {
	const value = turn as { role?: unknown; text?: unknown } | null;
	return (
		!!value &&
		(value.role === "user" || value.role === "assistant") &&
		typeof value.text === "string"
	);
}

/**
 * Copies a legacy conversation's turns into storage. Returns what it did, so a
 * caller can report an incomplete import rather than implying a clean one.
 */
export async function importConversation(
	conversation: AiConversation,
	storage: AiStorage,
): Promise<Omit<ImportReport, "conversations">> {
	let imported = 0;
	let alreadyPresent = 0;
	let skipped = 0;

	for (const [index, turn] of (conversation.turns ?? []).entries()) {
		if (!usableTurn(turn)) {
			skipped++;
			continue;
		}
		const key = legacyTurnKey(conversation.id, index, turn.id);
		const before = storage.list(conversation.id).length;
		const record: AiTurnRecord = {
			id: key,
			// Legacy turns predate run ids; the conversation owns them.
			runId: conversation.id,
			conversationId: conversation.id,
			kind: turn.role === "user" ? "request" : "result",
			createdAt:
				typeof turn.createdAt === "number" && Number.isSafeInteger(turn.createdAt)
					? turn.createdAt
					: conversation.createdAt,
			payload: {
				source: "legacy-import",
				role: turn.role,
				text: turn.text,
				...(turn.modelId === undefined ? {} : { modelId: turn.modelId }),
			},
		};
		try {
			await storage.append(key, record);
		} catch {
			// A turn that storage refuses is left in the legacy store untouched.
			skipped++;
			continue;
		}
		if (storage.list(conversation.id).length > before) imported++;
		else alreadyPresent++;
	}

	return { imported, alreadyPresent, skipped };
}

/**
 * Imports every legacy conversation. The legacy store is read-only throughout:
 * this never deletes, rewrites or marks the originals.
 */
export async function importLegacyHistory(
	conversations: Pick<AiConversationStore, "list" | "get">,
	storage: AiStorage,
): Promise<ImportReport> {
	const report: ImportReport = {
		conversations: 0,
		imported: 0,
		alreadyPresent: 0,
		skipped: 0,
	};
	for (const summary of await conversations.list()) {
		const conversation = await conversations.get(summary.id);
		if (!conversation) continue;
		report.conversations++;
		const one = await importConversation(conversation, storage);
		report.imported += one.imported;
		report.alreadyPresent += one.alreadyPresent;
		report.skipped += one.skipped;
	}
	return report;
}
