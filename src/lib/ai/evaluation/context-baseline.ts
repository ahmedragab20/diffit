import { performance } from "node:perf_hooks";
import { buildAiPrompt } from "../context.js";
import type { AiRunRequest } from "../types.js";
import { contentHash } from "./replay.js";

export const CONTEXT_FIXTURE_VERSION = "context-baseline-v1";

export interface ContextFixture {
	id: string;
	request: AiRunRequest;
	fullEvidence: string;
	requiredEvidence: { id: string; text: string }[];
}

/** Synthetic bytes only: no checkout, credential, provider, or network access. */
export function makeContextFixtures(): ContextFixture[] {
	const changed = "export const chargedCents = toCents(total);";
	const dependency = "export const toCents = (amount: number) => amount / 100;";
	return [4, 80].map((fileCount) => {
		const large = fileCount === 80;
		const lineCount = large ? 160 : 8;
		const patch =
			Array.from({ length: fileCount }, (_, file) => {
				const lines = Array.from({ length: lineCount }, (_, line) =>
					file === 0 && line === Math.floor(lineCount / 2)
						? `+${changed}`
						: `+export const item_${file}_${line} = "${"synthetic-".repeat(8)}";`,
				);
				return [
					`diff --git a/src/file-${file}.ts b/src/file-${file}.ts`,
					"new file mode 100644",
					"--- /dev/null",
					`+++ b/src/file-${file}.ts`,
					`@@ -0,0 +1,${lineCount} @@`,
					...lines,
				].join("\n");
			}).join("\n") + "\n";
		const sourceLines = large ? 4096 : 8;
		const fullFile = Array.from({ length: sourceLines }, (_, line) =>
			line === Math.floor(sourceLines / 2)
				? dependency
				: `// dependency fixture ${line}: ${"padding ".repeat(12)}`,
		).join("\n");
		const attachments = [{ path: "src/money.ts", content: fullFile }];
		const id = large ? "focused-large-diff" : "small-complete-diff";
		return {
			id,
			request: {
				trigger: "user",
				conversationId: `benchmark-${id}`,
				modelId: "codex/offline-fixture",
				surface: "diff",
				action: "review-risks",
				prompt:
					"Check the cents conversion at the selected call site and its dependency.",
				context: {
					kind: "selection",
					filePath: "src/file-0.ts",
					selectedText: changed,
					patch,
					attachments,
				},
			},
			fullEvidence: JSON.stringify({ patch, attachments }),
			requiredEvidence: [
				{ id: "changed-call-site", text: changed },
				{ id: "unchanged-conversion", text: dependency },
			],
		};
	});
}

export function percentile(samples: number[], fraction: number): number {
	if (
		!samples.length ||
		samples.some((value) => !Number.isFinite(value) || value < 0)
	)
		throw new Error("Latency samples must be nonempty, finite and nonnegative.");
	if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
		throw new Error("Percentile must be greater than zero and at most one.");
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * fraction) - 1];
}

/** Legacy prompt serialization baseline. No retrieval optimization is claimed. */
export function benchmarkContext(fixture: ContextFixture, iterations = 20) {
	if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1000)
		throw new Error("Benchmark iterations must be between 1 and 1000.");
	const measure = () => {
		const start = performance.now();
		const built = buildAiPrompt(fixture.request);
		const serialized = JSON.stringify({ prompt: built.prompt });
		return { built, serialized, elapsed: performance.now() - start };
	};
	const rssBefore = process.memoryUsage().rss;
	const first = measure();
	let rssSampledMax = process.memoryUsage().rss;
	const samples: number[] = [];
	for (let index = 0; index < iterations; index++) {
		const result = measure();
		if (
			result.serialized !== first.serialized ||
			result.built.truncated !== first.built.truncated
		)
			throw new Error(
				"Context serialization changed between benchmark iterations.",
			);
		samples.push(result.elapsed);
		rssSampledMax = Math.max(rssSampledMax, process.memoryUsage().rss);
	}
	const serializedPromptBytes = Buffer.byteLength(first.serialized);
	const fullEvidenceBytes = Buffer.byteLength(fixture.fullEvidence);
	const missingEvidence = fixture.requiredEvidence
		.filter((evidence) => !first.built.prompt.includes(evidence.text))
		.map((evidence) => evidence.id);
	return {
		id: fixture.id,
		fixtureVersion: CONTEXT_FIXTURE_VERSION,
		fixtureHash: contentHash(JSON.stringify(fixture)),
		promptHash: contentHash(first.built.prompt),
		implementation: "legacy-buildAiPrompt",
		iterations,
		fullEvidenceBytes,
		serializedPromptBytes,
		byteReduction: 1 - serializedPromptBytes / fullEvidenceBytes,
		estimatedPromptTokens: Math.ceil(Buffer.byteLength(first.built.prompt) / 4),
		tokenEstimateMethod: "UTF-8 bytes / 4; not provider usage",
		truncated: first.built.truncated,
		requiredEvidence: fixture.requiredEvidence.map((evidence) => evidence.id),
		missingEvidence,
		evidenceTextPreserved: missingEvidence.length === 0,
		latencyMs: {
			firstCall: first.elapsed,
			warmP50: percentile(samples, 0.5),
			warmP95: percentile(samples, 0.95),
		},
		latencyScope:
			"prompt construction plus JSON serialization; excludes imports, fixture generation and provider/network time",
		memory: { rssBefore, rssSampledMax, cacheBytes: null },
		remoteFetches: 0,
		providerTimeMs: null,
		acceptance:
			"baseline-only; size reduction is not a pass when required evidence is missing",
	};
}
