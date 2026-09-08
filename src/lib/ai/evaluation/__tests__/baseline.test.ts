// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildAiPrompt } from "../../context.js";
import {
	benchmarkContext,
	CONTEXT_FIXTURE_VERSION,
	makeContextFixtures,
	percentile,
} from "../context-baseline.js";
import { CORPUS_VERSION, makeReplayCorpus } from "../corpus.js";
import {
	contentHash,
	evaluateReplay,
	replaySource,
	type ReplayCase,
	type ReplayCitation,
	type ReplayFinding,
	type ReplaySource,
} from "../replay.js";

function fixtureWith(
	source: ReplaySource,
	findings: ReplayFinding[],
): ReplayCase {
	return { id: "test", category: "test", sources: [source], findings };
}

function validCitation(source: ReplaySource): ReplayCitation {
	return {
		sourceId: source.id,
		revision: source.revision,
		line: 1,
		quote: "line",
	};
}

describe("offline replay baseline", () => {
	it("keeps the corpus deterministic, isolated, and pinned", () => {
		const first = makeReplayCorpus();
		const second = makeReplayCorpus();
		expect(CORPUS_VERSION).toBe("synthetic-review-v1");
		expect(first.map(({ id }) => id)).toEqual([
			"clean",
			"cross-file",
			"large",
			"incomplete",
			"stale",
			"adversarial",
			"conflicting-pr",
			"flawed-plan",
		]);
		expect(first).toEqual(second);
		first[0].sources[0].text = "mutated";
		expect(first).not.toEqual(second);
		expect(second[0].sources[0].text).toBe("export const cents = 100;");
		expect(contentHash("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(contentHash(JSON.stringify(makeReplayCorpus()))).toBe(
			"afd14db9bb90fc1846983191a14cb7655d919a6b6de4430a870c50406ff9f191",
		);
	});

	it("evaluates every corpus case as anchor evidence only", () => {
		const results = new Map(
			makeReplayCorpus().map((fixture) => [fixture.id, evaluateReplay(fixture)]),
		);
		expect(results.get("cross-file")).toMatchObject({
			validCitations: 2,
			citationCoverage: { citedSources: 2 },
		});
		expect(results.get("large")).toMatchObject({ validCitations: 1 });
		expect(results.get("incomplete")).toMatchObject({
			invalidCitations: [{ reason: "omitted-source" }],
			unsupportedFindings: 1,
		});
		expect(results.get("stale")).toMatchObject({
			invalidCitations: [{ reason: "stale-revision" }],
			unsupportedFindings: 1,
		});
		expect(results.get("flawed-plan")).toMatchObject({ validCitations: 1 });
		for (const id of ["clean", "adversarial"]) {
			expect(results.get(id)).toMatchObject({ findings: 0, validCitations: 0 });
		}
		for (const result of results.values()) {
			expect(result.actualReadCoverage).toBeNull();
			expect(result.humanQuality).toEqual({
				status: "not-adjudicated",
				precision: null,
				recall: null,
				usefulness: null,
			});
		}
	});

	it.each<[string, Partial<ReplayCitation>, string]>([
		["unknown ID", { sourceId: "unknown" }, "unknown-source"],
		["stale revision", { revision: "old" }, "stale-revision"],
		["line zero", { line: 0 }, "invalid-line"],
		["negative line", { line: -1 }, "invalid-line"],
		["fractional line", { line: 1.5 }, "invalid-line"],
		["NaN line", { line: Number.NaN }, "invalid-line"],
		["out of range", { line: 2 }, "invalid-line"],
		["wrong quote", { quote: "wrong" }, "quote-mismatch"],
		["empty quote", { quote: "   " }, "quote-mismatch"],
	])("rejects %s citations", (_, overrides, reason) => {
		const source = replaySource("source", "source.ts", "line");
		const fixture = fixtureWith(source, [
			{
				id: "finding",
				claim: "claim",
				citations: [{ ...validCitation(source), ...overrides }],
			},
		]);
		expect(evaluateReplay(fixture).invalidCitations[0]?.reason).toBe(reason);
	});

	it("rejects changed source text with its original revision", () => {
		const source = replaySource("source", "source.ts", "line");
		source.text = "changed";
		const result = evaluateReplay(
			fixtureWith(source, [
				{
					id: "finding",
					claim: "claim",
					citations: [{ ...validCitation(source), quote: "changed" }],
				},
			]),
		);
		expect(result.invalidCitations[0]?.reason).toBe("source-hash-mismatch");
	});

	it("rejects duplicate sources and counts repeated identities or claims", () => {
		const source = replaySource("source", "source.ts", "line");
		const duplicate = fixtureWith(source, []);
		duplicate.sources.push({ ...source });
		expect(() => evaluateReplay(duplicate)).toThrow(
			"Duplicate replay source ID.",
		);
		const finding = { id: "same", claim: " Same   claim ", citations: [] };
		const result = evaluateReplay(
			fixtureWith(source, [
				finding,
				{ ...finding, id: "other", claim: "same claim" },
				{ ...finding, claim: "different" },
			]),
		);
		expect(result.duplicates).toBe(2);
	});

	it("tracks unsupported findings and unique cited sources", () => {
		const source = replaySource("source", "source.ts", "line");
		const valid = validCitation(source);
		const unsupported = evaluateReplay(
			fixtureWith(source, [{ id: "none", claim: "none", citations: [] }]),
		);
		expect(unsupported.unsupportedFindings).toBe(1);
		const repeated = evaluateReplay(
			fixtureWith(source, [
				{ id: "one", claim: "one", citations: [valid, valid] },
			]),
		);
		expect(repeated).toMatchObject({
			validCitations: 2,
			citationCoverage: { citedSources: 1 },
		});
	});
});

describe("offline context baseline", () => {
	it("keeps fixtures pinned and reports independent serialization metrics", () => {
		const first = makeContextFixtures();
		const second = makeContextFixtures();
		expect(CONTEXT_FIXTURE_VERSION).toBe("context-baseline-v1");
		expect(first).toEqual(second);
		expect(first.map((fixture) => contentHash(JSON.stringify(fixture)))).toEqual([
			"cc161774b91ffc5f5df58812e382c5c31769c0898ed1be178e22dfc82be61c20",
			"793488511f527d34ab9c5ae21e6bc2e8aa197b5b5de72ddaec7d8d4242c4fb80",
		]);
		first[0].requiredEvidence[0].text = "mutated";
		expect(first).not.toEqual(second);
		const [small, large] = second;
		const smallResult = benchmarkContext(small, 2);
		const largeResult = benchmarkContext(large, 2);
		const pairs = [
			[small, smallResult],
			[large, largeResult],
		] as const;
		for (const [fixture, result] of pairs) {
			const built = buildAiPrompt(fixture.request);
			expect(result.serializedPromptBytes).toBe(
				Buffer.byteLength(JSON.stringify({ prompt: built.prompt })),
			);
			expect(result.fullEvidenceBytes).toBe(
				Buffer.byteLength(fixture.fullEvidence),
			);
			expect(result.fixtureHash).toBe(contentHash(JSON.stringify(fixture)));
			expect(result.remoteFetches).toBe(0);
			expect(result.providerTimeMs).toBeNull();
			for (const latency of Object.values(result.latencyMs)) {
				expect(Number.isFinite(latency)).toBe(true);
				expect(latency).toBeGreaterThanOrEqual(0);
			}
		}
		expect(smallResult.evidenceTextPreserved).toBe(true);
		expect(smallResult.missingEvidence).toEqual([]);
		expect(largeResult.missingEvidence).toEqual(["unchanged-conversion"]);
		expect(largeResult.truncated).toBe(true);
		expect(largeResult.byteReduction).toBeGreaterThan(0.5);
		expect(largeResult.evidenceTextPreserved).toBe(false);
	});

	it.each([0, 1001, Number.NaN])(
		"rejects invalid iteration count %s",
		(count) => {
			expect(() => benchmarkContext(makeContextFixtures()[0], count)).toThrow();
		},
	);

	it("uses nearest-rank percentiles without mutating samples", () => {
		const samples = [4, 1, 3, 2];
		expect(percentile(samples, 0.95)).toBe(4);
		expect(percentile(samples, 0.5)).toBe(2);
		expect(samples).toEqual([4, 1, 3, 2]);
		for (const invalid of [[], [-1], [Number.NaN]]) {
			expect(() => percentile(invalid, 0.5)).toThrow();
		}
		for (const fraction of [0, 1.1, Number.NaN]) {
			expect(() => percentile([1], fraction)).toThrow();
		}
	});
});
