/**
 * Captures the actual old and new file contents behind a local diff.
 *
 * A patch alone shows only changed hunks, so evidence built from it cannot cite
 * a real file line. This reads the originals for each changed path at the exact
 * revisions the capture identified: the old side from a git object, and the new
 * side from a git object, the index, or the working tree depending on mode.
 *
 * Correctness rules this enforces:
 *  - A git object read is `recorded`; a working-tree read is only optimistic,
 *    so it is hashed at capture and re-checked before use.
 *  - `mixed` mode asserts no single old/new revision pair, so originals are
 *    omitted rather than attributed to a revision that does not exist.
 *  - A binary or oversized path is omitted explicitly, never silently dropped.
 *  - Renames read the old side at the old path and the new side at the new one.
 */
import { buildAgentDiffIndex } from "../agent-diff-index.js";
import { AiSnapshotError, type SnapshotSourceInput } from "./snapshots.js";

export const ORIGINALS_LIMITS = Object.freeze({
	maxFiles: 100,
	maxFileBytes: 512 * 1024,
	maxTotalBytes: 4 * 1024 * 1024,
});

export type OriginalsMode = "working" | "staged" | "revision" | "mixed";

export interface OriginalsRequest {
	patch: string;
	mode: OriginalsMode;
	/** Old-side commit; null when there is no established old revision. */
	baseSha: string | null;
	/** New-side commit; only set in revision mode. */
	headSha: string | null;
	/** Lower bound than the default, for a reader whose reads cost network. */
	maxFiles?: number;
	/**
	 * What to do when the patch exceeds the bound. Local capture refuses, since
	 * a local read is cheap and a truncated capture would be surprising; a
	 * remote capture omits the excess explicitly instead.
	 */
	onExcess?: "throw" | "omit";
}

export interface OriginalsResult {
	sources: SnapshotSourceInput[];
	omissions: string[];
}

/** Reads one path at a revision, or null when it does not exist there. */
export type BlobReader = (
	revision: string,
	path: string,
) => Promise<string | null>;

/** Reads one path from the working tree, or null when it is gone. */
export type WorktreeReader = (path: string) => Promise<string | null>;

function tooLarge(content: string): boolean {
	return Buffer.byteLength(content, "utf8") > ORIGINALS_LIMITS.maxFileBytes;
}

export async function captureLocalOriginals(
	request: OriginalsRequest,
	readBlob: BlobReader,
	readWorktree: WorktreeReader,
): Promise<OriginalsResult> {
	if (request.mode === "mixed")
		return {
			sources: [],
			omissions: [
				"Original files are not captured for a mixed staged/unstaged diff; no single old/new revision pair applies.",
			],
		};

	const index = buildAgentDiffIndex(request.patch, 0);
	const maxFiles = Math.min(
		request.maxFiles ?? ORIGINALS_LIMITS.maxFiles,
		ORIGINALS_LIMITS.maxFiles,
	);
	const excess = index.files.length - maxFiles;
	if (excess > 0 && (request.onExcess ?? "throw") === "throw")
		throw new AiSnapshotError("limit");
	const files = excess > 0 ? index.files.slice(0, maxFiles) : index.files;

	// The index side to read from, by mode. Working and staged share an old side.
	const oldRevision = request.baseSha ?? "HEAD";
	const newRevision = request.mode === "revision" ? request.headSha : null;

	const sources: SnapshotSourceInput[] = [];
	const omissions: string[] = [];
	// A path can occur more than once in a patch; a snapshot key must stay
	// unique, so the first occurrence wins and later ones are not re-read.
	const captured = new Set<string>();
	let totalBytes = 0;

	const push = (
		key: string,
		path: string,
		side: "old" | "new",
		revision: string,
		content: string | null,
		provenance: "recorded" | "reconstructed",
		omission?: string,
	) => {
		if (captured.has(key)) return;
		captured.add(key);
		if (content !== null) {
			if (tooLarge(content)) {
				omissions.push(`Original omitted, file too large: ${path}`);
				return;
			}
			totalBytes += Buffer.byteLength(content, "utf8");
			if (totalBytes > ORIGINALS_LIMITS.maxTotalBytes)
				throw new AiSnapshotError("limit");
		}
		// An omission is recorded on the source and surfaced in the capture's
		// omission list, so it is visible without inspecting every source.
		if (omission !== undefined) omissions.push(omission);
		sources.push({
			key,
			path,
			side,
			revision,
			content,
			complete: content !== null,
			provenance: content === null ? "unknown" : provenance,
			representation: "original",
			...(omission === undefined ? {} : { omission }),
		});
	};

	if (excess > 0)
		omissions.push(
			`Originals omitted for ${excess} further path(s); the capture reads at most ${maxFiles}.`,
		);

	for (const file of files) {
		if (file.kind === "binary" || file.isBinary) {
			omissions.push(
				`Original omitted, binary path: ${file.newPath ?? file.oldPath ?? "(unknown)"}`,
			);
			continue;
		}
		// A rename reads each side at its own path; an add has no old side and a
		// delete has no new side.
		if (file.oldPath) {
			const content = await readBlob(oldRevision, file.oldPath);
			push(
				`old:${file.oldPath}`,
				file.oldPath,
				"old",
				oldRevision,
				content,
				"recorded",
				content === null
					? `Old original unavailable at ${oldRevision}: ${file.oldPath}`
					: undefined,
			);
		}
		if (file.newPath) {
			const content =
				newRevision !== null
					? await readBlob(newRevision, file.newPath)
					: request.mode === "staged"
						? await readBlob("", file.newPath)
						: await readWorktree(file.newPath);
			// Only a committed or indexed object is recorded; the working tree is not.
			const provenance =
				request.mode === "working" ? "reconstructed" : "recorded";
			push(
				`new:${file.newPath}`,
				file.newPath,
				"new",
				newRevision ?? (request.mode === "staged" ? "index" : "worktree"),
				content,
				provenance,
				content === null
					? `New original unavailable: ${file.newPath}`
					: undefined,
			);
		}
	}

	if (!index.complete)
		omissions.push(
			"The local diff reported incomplete capture; originals cover only the paths it listed.",
		);
	for (const path of index.omittedPaths ?? [])
		omissions.push(`Original omitted, path absent from the patch: ${path}`);

	return { sources, omissions };
}
