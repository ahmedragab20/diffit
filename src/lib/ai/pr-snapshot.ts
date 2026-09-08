import type { PrSession } from "../pr-session.js";
import {
	AiSnapshotError,
	sourceHash,
	type SnapshotIdentity,
} from "./snapshots.js";

export function capturePrReview(session: PrSession | null) {
	if (!session) throw new AiSnapshotError("missing");
	if (
		Buffer.byteLength(session.diff, "utf8") > 4 * 1024 * 1024 ||
		Buffer.byteLength(JSON.stringify(session.diffCompleteness ?? null), "utf8") >
			8192
	)
		throw new AiSnapshotError("limit");
	const completenessHash = sourceHash(
		JSON.stringify(session.diffCompleteness ?? null),
	);
	const identity: Extract<SnapshotIdentity, { kind: "pr" }> = {
		kind: "pr",
		host: session.host ?? "github.com",
		owner: session.owner,
		repo: session.repo,
		number: session.pullNumber,
		baseSha: session.baseSha,
		headSha: session.headSha,
		mergeBaseSha: session.mergeBaseSha ?? null,
		patchHash: sourceHash(session.diff),
	};
	Object.freeze(identity);
	const patch = session.diff;
	const omissions = [
		...(identity.mergeBaseSha
			? []
			: [
					"PR merge-base identity is unavailable; old-side expansion is not verified.",
				]),
		...(session.diffCompleteness?.omittedPatches
			? [`PR patch omits ${session.diffCompleteness.omittedPatches} file patches.`]
			: []),
		...(session.diffCompleteness
			? []
			: ["PR diff completeness has not been established."]),
		"Unified patches do not establish complete original-file coverage.",
	];
	return {
		identity,
		patch,
		omissions,
		cacheKey(path: string) {
			return JSON.stringify([
				identity.host,
				identity.owner,
				identity.repo,
				identity.headSha,
				path,
			]);
		},
		assertFresh(current: PrSession | null) {
			if (!current) throw new AiSnapshotError("stale");
			const now = capturePrReview(current);
			if (
				sourceHash(JSON.stringify(current.diffCompleteness ?? null)) !==
					completenessHash ||
				JSON.stringify(now.identity) !== JSON.stringify(identity) ||
				JSON.stringify(now.omissions) !== JSON.stringify(omissions)
			)
				throw new AiSnapshotError("stale");
		},
	};
}
