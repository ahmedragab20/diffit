import { arch, cpus, platform, release } from "node:os";
import {
	benchmarkContext,
	makeContextFixtures,
} from "../src/lib/ai/evaluation/context-baseline.js";
import {
	CORPUS_VERSION,
	makeReplayCorpus,
} from "../src/lib/ai/evaluation/corpus.js";
import {
	contentHash,
	evaluateReplay,
} from "../src/lib/ai/evaluation/replay.js";

const [mode, ...extra] = process.argv.slice(2);
if ((mode !== "bench" && mode !== "eval") || extra.length) {
	console.error(
		"Usage: tsx scripts/ai-baseline.ts <bench|eval> (offline baselines only)",
	);
	process.exitCode = 1;
} else {
	const runtime = {
		node: process.version,
		platform: platform(),
		osRelease: release(),
		arch: arch(),
		cpuModel: cpus()[0]?.model ?? "unknown",
		logicalCpus: cpus().length,
	};
	const corpus = mode === "eval" ? makeReplayCorpus() : [];
	const report =
		mode === "bench"
			? {
					schemaVersion: 1,
					mode: "offline-context-baseline",
					runtime,
					results: makeContextFixtures().map((fixture) => benchmarkContext(fixture)),
					browserMeasurements: null,
					performanceThresholdsApproved: false,
				}
			: {
					schemaVersion: 1,
					mode: "synthetic-replay-baseline",
					runtime,
					corpusVersion: CORPUS_VERSION,
					corpusHash: contentHash(JSON.stringify(corpus)),
					responseProvenance:
						"hand-authored synthetic replay; includes deliberately invalid citations",
					model: null,
					promptVersion: null,
					usage: null,
					qualityThresholdsApproved: false,
					results: corpus.map(evaluateReplay),
				};
	console.log(JSON.stringify(report, null, 2));
}
