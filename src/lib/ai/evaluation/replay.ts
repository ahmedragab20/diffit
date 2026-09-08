import { createHash } from "node:crypto";

/** Offline harness types, not the production citation or model-output contract. */
export interface ReplaySource {
	id: string;
	path: string;
	revision: string;
	text: string | null;
}

export interface ReplayCitation {
	sourceId: string;
	revision: string;
	line: number;
	quote: string;
}

export interface ReplayFinding {
	id: string;
	claim: string;
	citations: ReplayCitation[];
}

export interface ReplayCase {
	id: string;
	category: string;
	sources: ReplaySource[];
	findings: ReplayFinding[];
}

export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function replaySource(
	id: string,
	path: string,
	text: string,
): ReplaySource {
	return { id, path, text, revision: contentHash(text) };
}

function citationError(
	citation: ReplayCitation,
	source?: ReplaySource,
): string | null {
	if (!source) return "unknown-source";
	if (source.text === null) return "omitted-source";
	if (source.revision !== contentHash(source.text))
		return "source-hash-mismatch";
	if (citation.revision !== source.revision) return "stale-revision";
	if (!Number.isSafeInteger(citation.line) || citation.line < 1)
		return "invalid-line";
	const line = source.text.split("\n")[citation.line - 1];
	if (line === undefined) return "invalid-line";
	if (!citation.quote.trim() || line !== citation.quote) return "quote-mismatch";
	return null;
}

/** Checks anchors only. An exact quotation does not establish a correct finding. */
export function evaluateReplay(fixture: ReplayCase) {
	const sources = new Map(fixture.sources.map((source) => [source.id, source]));
	if (sources.size !== fixture.sources.length)
		throw new Error("Duplicate replay source ID.");
	const seenIds = new Set<string>();
	const seenClaims = new Set<string>();
	const citedSources = new Set<string>();
	let duplicates = 0;
	let unsupportedFindings = 0;
	let validCitations = 0;
	const invalidCitations: {
		findingId: string;
		citationIndex: number;
		reason: string;
	}[] = [];
	for (const finding of fixture.findings) {
		const claim = finding.claim.trim().replace(/\s+/g, " ").toLowerCase();
		if (seenIds.has(finding.id) || seenClaims.has(claim)) duplicates++;
		seenIds.add(finding.id);
		seenClaims.add(claim);
		let supported = false;
		finding.citations.forEach((citation, citationIndex) => {
			const reason = citationError(citation, sources.get(citation.sourceId));
			if (reason)
				invalidCitations.push({ findingId: finding.id, citationIndex, reason });
			else {
				validCitations++;
				supported = true;
				citedSources.add(citation.sourceId);
			}
		});
		if (!supported) unsupportedFindings++;
	}
	return {
		id: fixture.id,
		category: fixture.category,
		findings: fixture.findings.length,
		validCitations,
		invalidCitations,
		duplicates,
		unsupportedFindings,
		citationCoverage: {
			citedSources: citedSources.size,
			availableSources: fixture.sources.filter((source) => source.text !== null)
				.length,
			omittedSources: fixture.sources.filter((source) => source.text === null)
				.length,
		},
		actualReadCoverage: null,
		humanQuality: {
			status: "not-adjudicated",
			precision: null,
			recall: null,
			usefulness: null,
		},
	};
}
