/**
 * Retrieval baseline: what an evidence-driven run actually costs.
 *
 * The legacy baseline serializes the whole context into one prompt, which is
 * why the large fixture drops its unchanged dependency line. This measures the
 * alternative the tool layer makes possible — map the capture, locate the
 * required text, then read only those lines — and reports both the bytes
 * retrieved and whether the required evidence survived.
 *
 * Synthetic bytes only: no checkout, credential, provider or network access.
 * A byte reduction here is a measurement, not an approved threshold.
 */
import { performance } from "node:perf_hooks";
import { ReviewSnapshot, sourceHash, type SnapshotIdentity } from "../snapshots.js";
import { reviewMap, sourceRead, sourceSearch } from "../tools.js";
import { contentHash } from "./replay.js";
import type { ContextFixture } from "./context-baseline.js";
import { percentile } from "./context-baseline.js";

export const RETRIEVAL_FIXTURE_VERSION = "retrieval-baseline-v1";

/** Builds a capture holding the fixture's patch and its attachment originals. */
function captureOf(fixture: ContextFixture): ReviewSnapshot {
	const context = fixture.request.context as {
		patch?: string;
		attachments?: { path: string; content: string }[];
	};
	const patch = context.patch ?? "";
	const identity: SnapshotIdentity = {
		kind: "local",
		repositoryId: sourceHash(fixture.id),
		mode: "working",
		baseSha: null,
		headSha: null,
		indexHash: null,
		patchHash: sourceHash(patch),
	};
	return new ReviewSnapshot(identity, [
		{
			key: "patch",
			path: "diff",
			side: "document",
			revision: "fixture",
			content: patch,
			complete: true,
			provenance: "recorded",
			representation: "unified-patch",
		},
		...(context.attachments ?? []).map((attachment) => ({
			key: `new:${attachment.path}`,
			path: attachment.path,
			side: "new" as const,
			revision: "worktree",
			content: attachment.content,
			complete: true,
			provenance: "recorded" as const,
			representation: "original" as const,
		})),
	]);
}

/**
 * Locates each required text and reads only the lines around it, which is what
 * a run navigating the capture would do rather than embedding everything.
 */
function retrieve(fixture: ContextFixture, snapshot: ReviewSnapshot) {
	const map = reviewMap(snapshot);
	let retrievedBytes = Buffer.byteLength(JSON.stringify(map), "utf8");
	const found: string[] = [];
	for (const required of fixture.requiredEvidence) {
		const hits = sourceSearch(snapshot, required.text, { limit: 1 });
		retrievedBytes += Buffer.byteLength(JSON.stringify(hits), "utf8");
		const hit = hits.matches[0];
		if (!hit) continue;
		const source = map.sources.find((entry) => entry.key === hit.key);
		const patchSource = source?.representation === "unified-patch";
		const batch = patchSource
			? null
			: sourceRead(snapshot, [
					{ key: hit.key, startLine: hit.line, endLine: hit.line },
				]);
		const text = batch?.items[0]?.ok ? batch.items[0].value.text : null;
		if (batch) retrievedBytes += Buffer.byteLength(JSON.stringify(batch), "utf8");
		// A patch source is located but never read as file lines; the hit itself
		// is still evidence that the text is present in the capture.
		if (patchSource || (text !== null && text.includes(required.text)))
			found.push(required.id);
	}
	return { map, retrievedBytes, found };
}

export function benchmarkRetrieval(fixture: ContextFixture, iterations = 20) {
	if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1000)
		throw new Error("Benchmark iterations must be between 1 and 1000.");
	const measure = () => {
		// A fresh capture per iteration; reading marks coverage, so reuse would
		// measure a warmed snapshot rather than the same work twice.
		const snapshot = captureOf(fixture);
		const start = performance.now();
		const result = retrieve(fixture, snapshot);
		return { ...result, snapshot, elapsed: performance.now() - start };
	};
	const first = measure();
	let rssSampledMax = process.memoryUsage().rss;
	const samples: number[] = [];
	for (let index = 0; index < iterations; index++) {
		const result = measure();
		if (
			result.retrievedBytes !== first.retrievedBytes ||
			result.found.join(",") !== first.found.join(",")
		)
			throw new Error("Retrieval changed between benchmark iterations.");
		samples.push(result.elapsed);
		rssSampledMax = Math.max(rssSampledMax, process.memoryUsage().rss);
	}
	const fullEvidenceBytes = Buffer.byteLength(fixture.fullEvidence, "utf8");
	const missingEvidence = fixture.requiredEvidence
		.filter((evidence) => !first.found.includes(evidence.id))
		.map((evidence) => evidence.id);
	const coverage = first.snapshot.coverage();
	return {
		id: fixture.id,
		fixtureVersion: RETRIEVAL_FIXTURE_VERSION,
		fixtureHash: contentHash(JSON.stringify(fixture)),
		implementation: "evidence-retrieval",
		iterations,
		fullEvidenceBytes,
		retrievedBytes: first.retrievedBytes,
		byteReduction: 1 - first.retrievedBytes / fullEvidenceBytes,
		estimatedTokens: Math.ceil(first.retrievedBytes / 4),
		tokenEstimateMethod: "UTF-8 bytes / 4; not provider usage",
		requiredEvidence: fixture.requiredEvidence.map((evidence) => evidence.id),
		missingEvidence,
		/** Lines actually returned by reads — not a claim about model attention. */
		returnedLines: coverage.returnedLines,
		availableLines: coverage.availableLines,
		firstCallMs: first.elapsed,
		warmP50Ms: percentile(samples, 0.5),
		warmP95Ms: percentile(samples, 0.95),
		rssSampledMaxBytes: rssSampledMax,
		rssNote: "Sampled process RSS; not precise peak or isolated memory.",
		remoteFetches: 0,
		humanApprovedThresholds: false,
	};
}
