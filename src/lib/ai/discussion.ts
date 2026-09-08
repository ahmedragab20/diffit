/**
 * Review discussion for a captured source.
 *
 * Threads are scoped to the paths the capture actually holds, so a run reads
 * discussion about the files it was given and nothing else. Bodies are review
 * comments written by people, so they are returned as data, never as
 * instructions to the run.
 */
import { AiSnapshotError, type ReviewSnapshot } from "./snapshots.js";
import type { ReviewComment } from "../types.js";

export const DISCUSSION_LIMITS = Object.freeze({
	maxThreads: 50,
	maxBodyBytes: 4096,
});

export interface DiscussionReply {
	id: string;
	body: string;
	createdAt: number;
	truncated: boolean;
}

export interface DiscussionThread {
	id: string;
	key: string;
	path: string;
	side: ReviewComment["side"];
	lineNumber: number;
	startLineNumber?: number;
	status: ReviewComment["status"];
	severity?: string;
	outdated?: boolean;
	createdAt: number;
	body: string;
	truncated: boolean;
	replies: DiscussionReply[];
}

export interface SourceDiscussion {
	threads: DiscussionThread[];
	/** Threads on paths this capture does not hold, counted but not returned. */
	outOfScope: number;
	nextCursor: string | null;
}

function clamp(body: string): { body: string; truncated: boolean } {
	const text = typeof body === "string" ? body : "";
	if (Buffer.byteLength(text, "utf8") <= DISCUSSION_LIMITS.maxBodyBytes)
		return { body: text, truncated: false };
	const cut = Buffer.from(text, "utf8")
		.subarray(0, DISCUSSION_LIMITS.maxBodyBytes)
		.toString("utf8");
	// A trailing partial code point is dropped rather than shown as a replacement.
	return { body: cut.replace(/�$/, ""), truncated: true };
}

/**
 * Lists review threads anchored to captured sources. A `key` scopes to one
 * source; without it every captured path is included.
 */
export function sourceDiscussion(
	snapshot: ReviewSnapshot,
	comments: readonly ReviewComment[],
	options: { key?: string; limit?: number; cursor?: string } = {},
): SourceDiscussion {
	const limit = options.limit ?? 20;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > DISCUSSION_LIMITS.maxThreads
	)
		throw new AiSnapshotError("invalid");
	const match = /^o:(\d{1,9})$/.exec(options.cursor ?? "o:0");
	const offset = match ? Number(match[1]) : Number.NaN;
	if (!Number.isSafeInteger(offset)) throw new AiSnapshotError("invalid");

	const byPath = new Map<string, string>();
	for (const source of snapshot.manifest.sources)
		if (!byPath.has(source.path)) byPath.set(source.path, source.key);
	if (options.key !== undefined) {
		const scoped = snapshot.manifest.sources.find(
			(source) => source.key === options.key,
		);
		if (!scoped) throw new AiSnapshotError("missing");
		byPath.clear();
		byPath.set(scoped.path, scoped.key);
	}

	let outOfScope = 0;
	const matching: DiscussionThread[] = [];
	for (const comment of comments) {
		const key = byPath.get(comment.filePath);
		if (key === undefined) {
			outOfScope++;
			continue;
		}
		const lead = clamp(comment.body);
		matching.push({
			id: comment.id,
			key,
			path: comment.filePath,
			side: comment.side,
			lineNumber: comment.lineNumber,
			...(comment.startLineNumber === undefined
				? {}
				: { startLineNumber: comment.startLineNumber }),
			status: comment.status,
			...(comment.severity === undefined ? {} : { severity: comment.severity }),
			...(comment.outdated === undefined ? {} : { outdated: comment.outdated }),
			createdAt: comment.createdAt,
			body: lead.body,
			truncated: lead.truncated,
			replies: (comment.replies ?? []).map((reply) => {
				const text = clamp(reply.body);
				return {
					id: reply.id,
					body: text.body,
					createdAt: reply.createdAt,
					truncated: text.truncated,
				};
			}),
		});
	}

	const page = matching.slice(offset, offset + limit);
	const end = offset + page.length;
	return {
		threads: page,
		outOfScope,
		nextCursor: end < matching.length ? `o:${end}` : null,
	};
}
