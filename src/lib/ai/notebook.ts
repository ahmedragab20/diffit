/**
 * Review notebook: findings, proposals and questions that must cite evidence.
 *
 * The point of the notebook is that an entry cannot assert something the
 * capture does not support. Every entry carries at least one citation, each
 * citation is verified against the snapshot that issued it, and each quote is
 * re-read and compared byte for byte — so a fabricated quote, a citation
 * minted elsewhere, or one held against another generation is rejected rather
 * than stored and rendered as if it were evidence.
 *
 * Two separations matter:
 *  - Authoring is not deciding. A run may write entries; only `decide` records
 *    an outcome, and it records who decided it.
 *  - Coverage is not quality. What is reported is the lines reads returned,
 *    never a claim about review thoroughness. Re-reading a cited range to
 *    check its quote is a union of line numbers already read, so verification
 *    cannot inflate it.
 */
import { AiSnapshotError, type ReviewSnapshot } from "./snapshots.js";
import { sourceRead, verifyCitation } from "./tools.js";

export const NOTEBOOK_LIMITS = Object.freeze({
	maxEntries: 200,
	maxCitations: 20,
	maxTitleBytes: 300,
	maxBodyBytes: 8192,
	maxQuoteBytes: 4096,
	maxLinks: 20,
});

export type EntryKind = "finding" | "proposal" | "question";
export type Uncertainty = "low" | "medium" | "high";
export type Decision = "accepted" | "rejected" | "deferred";

export interface NotebookCitation {
	key: string;
	startLine: number;
	endLine: number;
	/** The exact text the entry relies on; checked against the capture. */
	quote: string;
	evidenceId: string;
}

export interface NotebookEntryInput {
	id: string;
	kind: EntryKind;
	title: string;
	body: string;
	uncertainty: Uncertainty;
	citations: NotebookCitation[];
	/** Ids of other entries this one explicitly depends on. */
	links?: string[];
}

export interface NotebookEntry extends NotebookEntryInput {
	links: string[];
	snapshotRevision: string;
	decision: Decision | null;
	/** Who decided, and when. Never set by the run that authored the entry. */
	decidedBy: string | null;
	decidedAt: number | null;
}

export interface NotebookCoverage {
	returnedLines: number;
	availableLines: number;
	citedSources: number;
	/** Repeated verbatim so a reader cannot mistake this for review quality. */
	basis: "returned-source-lines";
}

export interface Notebook {
	snapshotId: string;
	snapshotRevision: string;
	entries: NotebookEntry[];
	coverage: NotebookCoverage;
}

function bounded(value: unknown, maxBytes: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

/**
 * Validates one entry against the capture and returns it with provenance.
 * Throws rather than storing anything it could not verify.
 */
export function authorEntry(
	snapshot: ReviewSnapshot,
	input: NotebookEntryInput,
): NotebookEntry {
	const manifest = snapshot.manifest;
	if (
		!bounded(input.id, 200) ||
		!bounded(input.title, NOTEBOOK_LIMITS.maxTitleBytes) ||
		!bounded(input.body, NOTEBOOK_LIMITS.maxBodyBytes) ||
		!["finding", "proposal", "question"].includes(input.kind) ||
		!["low", "medium", "high"].includes(input.uncertainty)
	)
		throw new AiSnapshotError("invalid");

	const links = input.links ?? [];
	if (!Array.isArray(links) || links.length > NOTEBOOK_LIMITS.maxLinks)
		throw new AiSnapshotError("invalid");

	if (
		!Array.isArray(input.citations) ||
		!input.citations.length ||
		input.citations.length > NOTEBOOK_LIMITS.maxCitations
	)
		// An entry with no citation asserts something the capture does not support.
		throw new AiSnapshotError("invalid");

	for (const citation of input.citations) {
		if (
			!bounded(citation.key, 1024) ||
			!bounded(citation.evidenceId, 200) ||
			!bounded(citation.quote, NOTEBOOK_LIMITS.maxQuoteBytes) ||
			!Number.isSafeInteger(citation.startLine) ||
			!Number.isSafeInteger(citation.endLine) ||
			citation.startLine < 1 ||
			citation.endLine < citation.startLine
		)
			throw new AiSnapshotError("invalid");

		// Re-read the cited range. These lines were already returned once to
		// produce the citation, so the coverage union does not grow here.
		const batch = sourceRead(snapshot, [
			{
				key: citation.key,
				startLine: citation.startLine,
				endLine: citation.endLine,
			},
		]);
		const item = batch.items[0];
		if (!item?.ok) throw new AiSnapshotError("missing");
		if (item.value.text !== citation.quote)
			// The quote does not match the capture: it was not read from here.
			throw new AiSnapshotError("invalid");
		if (item.value.evidence.id !== citation.evidenceId) {
			// A fresh read mints a new id, so compare the anchor instead.
			verifyCitation(
				snapshot,
				{ ...item.value.evidence, id: citation.evidenceId },
				manifest.revision,
			);
		}
	}

	return {
		...input,
		links,
		snapshotRevision: manifest.revision,
		decision: null,
		decidedBy: null,
		decidedAt: null,
	};
}

/** Builds a notebook, rejecting duplicate ids and links to absent entries. */
export function buildNotebook(
	snapshot: ReviewSnapshot,
	inputs: NotebookEntryInput[],
): Notebook {
	if (!Array.isArray(inputs) || inputs.length > NOTEBOOK_LIMITS.maxEntries)
		throw new AiSnapshotError("invalid");
	const entries = inputs.map((input) => authorEntry(snapshot, input));
	const ids = new Set<string>();
	for (const entry of entries) {
		if (ids.has(entry.id)) throw new AiSnapshotError("invalid");
		ids.add(entry.id);
	}
	for (const entry of entries)
		for (const link of entry.links)
			// An explicit link must resolve, or the notebook implies a relationship
			// to something that is not there.
			if (!ids.has(link) || link === entry.id)
				throw new AiSnapshotError("invalid");

	const manifest = snapshot.manifest;
	const coverage = snapshot.coverage();
	return {
		snapshotId: manifest.id,
		snapshotRevision: manifest.revision,
		entries,
		coverage: {
			returnedLines: coverage.returnedLines,
			availableLines: coverage.availableLines,
			citedSources: new Set(
				entries.flatMap((entry) =>
					entry.citations.map((citation) => citation.key),
				),
			).size,
			basis: "returned-source-lines",
		},
	};
}

/**
 * Records a human decision. Deciding is deliberately separate from authoring:
 * a run can propose, but only this records an outcome, and it records who.
 */
export function decide(
	notebook: Notebook,
	entryId: string,
	decision: Decision,
	decidedBy: string,
	now: () => number = Date.now,
): Notebook {
	if (
		!["accepted", "rejected", "deferred"].includes(decision) ||
		!bounded(decidedBy, 200)
	)
		throw new AiSnapshotError("invalid");
	const index = notebook.entries.findIndex((entry) => entry.id === entryId);
	if (index === -1) throw new AiSnapshotError("missing");
	const entries = [...notebook.entries];
	entries[index] = {
		...entries[index],
		decision,
		decidedBy,
		decidedAt: now(),
	};
	return { ...notebook, entries };
}

export interface StaleReview {
	stale: boolean;
	/** Entries whose evidence no longer verifies against the current capture. */
	entryIds: string[];
	reason: string | null;
}

/**
 * Re-checks a notebook against a capture. A notebook built on another
 * generation is stale as a whole; otherwise each entry's citations are
 * re-verified so a changed source is reported rather than silently trusted.
 */
export function reviewStaleness(
	notebook: Notebook,
	snapshot: ReviewSnapshot,
): StaleReview {
	const manifest = snapshot.manifest;
	if (
		notebook.snapshotId !== manifest.id ||
		notebook.snapshotRevision !== manifest.revision
	)
		return {
			stale: true,
			entryIds: notebook.entries.map((entry) => entry.id),
			reason: "The capture this notebook cites has been replaced.",
		};

	const entryIds: string[] = [];
	for (const entry of notebook.entries) {
		const drifted = entry.citations.some((citation) => {
			const batch = sourceRead(snapshot, [
				{
					key: citation.key,
					startLine: citation.startLine,
					endLine: citation.endLine,
				},
			]);
			const item = batch.items[0];
			return !item?.ok || item.value.text !== citation.quote;
		});
		if (drifted) entryIds.push(entry.id);
	}
	return {
		stale: entryIds.length > 0,
		entryIds,
		reason: entryIds.length
			? "Cited source text no longer matches the capture."
			: null,
	};
}
