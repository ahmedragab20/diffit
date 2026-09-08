import { parseGitDiffHeaderPaths } from "../git-path.js";
import { toSafeLiteralRelativePath } from "../path.js";
import type { AiDiffContext } from "./types.js";
import {
	AiSnapshotError,
	ReviewSnapshot,
	sourceHash,
	type SnapshotIdentity,
	type SnapshotSourceInput,
} from "./snapshots.js";

export interface CapturedDiff {
	identity: Extract<SnapshotIdentity, { kind: "local" | "pr" }>;
	patch: string;
	omissions: string[];
}

function safePath(path: string, root: string): boolean {
	const normalized = toSafeLiteralRelativePath(path, root);
	return (
		Boolean(path) &&
		(process.platform === "win32"
			? normalized?.replaceAll("\\", "/")
			: normalized) === path
	);
}

/** Keep occurrences, not a path-keyed map: staged and unstaged patches can share a path. */
export function resolveDiffSnapshot(
	input: AiDiffContext,
	capture: CapturedDiff,
	root = process.cwd(),
) {
	if (Buffer.byteLength(capture.patch, "utf8") > 4 * 1024 * 1024)
		throw new AiSnapshotError("limit");
	if (sourceHash(capture.patch) !== capture.identity.patchHash)
		throw new AiSnapshotError("stale");
	const chunks = capture.patch
		.split(/(?=^diff --git )/m)
		.filter((text) => text.trim());
	if (chunks.length > 256) throw new AiSnapshotError("limit");
	const omissions = [
		...capture.omissions,
		"Patch line numbers are artifact offsets, not original-file line numbers. Original-file coverage is not established.",
	];
	const scopedPath = input.kind === "diff" ? undefined : input.filePath;
	if (input.kind !== "diff" && (!scopedPath || !safePath(scopedPath, root)))
		throw new AiSnapshotError("invalid");
	const sources: SnapshotSourceInput[] = [];
	const patches: string[] = [];
	for (const [index, text] of chunks.entries()) {
		const paths = parseGitDiffHeaderPaths(text.split("\n", 1)[0]);
		if (!paths) throw new AiSnapshotError("unsupported");
		if (paths.some((path) => !safePath(path, root)))
			throw new AiSnapshotError("invalid");
		if (scopedPath && !paths.includes(scopedPath)) continue;
		patches.push(text);
		sources.push({
			key: `patch:${index}`,
			path: paths[1],
			side: "document",
			revision: capture.identity.patchHash,
			content: text,
			complete: false,
			provenance: "recorded",
			representation: "unified-patch",
			omission: `Originals not captured: old=${JSON.stringify(paths[0])}, new=${JSON.stringify(paths[1])}.`,
		});
	}
	if (scopedPath && !sources.length) throw new AiSnapshotError("missing");
	return {
		context: { ...input, patch: patches.join("") },
		snapshot: new ReviewSnapshot(capture.identity, sources, omissions),
	};
}
