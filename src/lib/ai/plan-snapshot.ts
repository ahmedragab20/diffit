import type { Plan, PlanVersion } from "../plan-types.js";
import type { PlanStore } from "../plans.js";
import type { AiPlanContext } from "./types.js";
import {
	AiSnapshotError,
	ReviewSnapshot,
	sourceHash,
	type SnapshotSourceInput,
} from "./snapshots.js";

function checkedVersion(version: PlanVersion): PlanVersion {
	if (
		typeof version.body !== "string" ||
		typeof version.title !== "string" ||
		(version.provenance !== undefined &&
			!["recorded", "reconstructed"].includes(version.provenance))
	)
		throw new AiSnapshotError("invalid");
	if (
		Buffer.byteLength(version.body, "utf8") > 4 * 1024 * 1024 ||
		Buffer.byteLength(version.title, "utf8") > 4096
	)
		throw new AiSnapshotError("limit");
	return version;
}
function versionOf(plan: Plan, version: number): PlanVersion {
	if (version === plan.version)
		return checkedVersion({
			version,
			title: plan.title,
			body: plan.body,
			createdAt: plan.updatedAt,
			provenance: "recorded",
		});
	const found = plan.versions?.find((entry) => entry.version === version);
	if (!found) throw new AiSnapshotError("missing");
	return checkedVersion({ ...found });
}
function sourceFor(
	version: PlanVersion,
	key: string,
	planId: string,
): SnapshotSourceInput {
	const verified = version.provenance === "recorded";
	return {
		key,
		path: `plan/${planId}`,
		side: "document",
		revision: `v${version.version}`,
		content: verified ? version.body : null,
		complete: verified,
		provenance: version.provenance ?? "unknown",
		...(verified
			? {}
			: {
					omission: `Original body for v${version.version} is ${version.provenance ?? "unverified legacy history"}; it is not established historical evidence.`,
				}),
	};
}

/** Select all versions from one store read; never trust browser bodies as canonical text. */
export async function resolvePlanSnapshot(
	input: AiPlanContext,
	store: PlanStore,
) {
	const plan = await store.get(input.planId);
	if (!plan) throw new AiSnapshotError("missing");
	const planId = plan.id;
	const selected = versionOf(plan, input.version);
	const previous =
		input.previousVersion === undefined
			? undefined
			: versionOf(plan, input.previousVersion);
	if (input.kind === "plan-version-compare" && !previous)
		throw new AiSnapshotError("invalid");
	if (input.previousBody !== undefined && !previous)
		throw new AiSnapshotError("invalid");
	if (
		(input.body !== undefined && input.body !== selected.body) ||
		(input.previousBody !== undefined && input.previousBody !== previous?.body)
	)
		throw new AiSnapshotError("stale");
	if (input.selectedText && !selected.body.includes(input.selectedText))
		throw new AiSnapshotError("stale");
	const sources = [sourceFor(selected, "plan", input.planId)];
	if (previous) sources.push(sourceFor(previous, "previous-plan", input.planId));
	if (input.draft !== undefined)
		sources.push({
			key: "draft",
			path: "user-draft",
			side: "draft",
			revision: sourceHash(input.draft),
			content: input.draft,
			complete: true,
			provenance: "draft",
		});
	if (input.bodyDraft !== undefined)
		sources.push({
			key: "body-draft",
			path: "unsaved-plan",
			side: "draft",
			revision: sourceHash(input.bodyDraft),
			content: input.bodyDraft,
			complete: true,
			provenance: "draft",
		});
	const snapshot = new ReviewSnapshot(
		{
			kind: "plan",
			planId: plan.id,
			version: selected.version,
			bodyHash: sourceHash(selected.body),
			titleHash: sourceHash(selected.title),
		},
		sources,
	);
	const context: AiPlanContext = {
		...input,
		title: selected.title,
		body: sources[0].content ?? undefined,
		selectedText: sources[0].content === null ? undefined : input.selectedText,
		previousBody: previous?.provenance === "recorded" ? previous.body : undefined,
	};
	const assertFresh = async () => {
		const current = await store.get(planId);
		if (!current) throw new AiSnapshotError("stale");
		for (const captured of [selected, previous]) {
			if (!captured) continue;
			let now: PlanVersion;
			try {
				now = versionOf(current, captured.version);
			} catch {
				throw new AiSnapshotError("stale");
			}
			if (
				now.body !== captured.body ||
				now.title !== captured.title ||
				now.provenance !== captured.provenance
			)
				throw new AiSnapshotError("stale");
		}
	};
	return { context, snapshot, assertFresh };
}
