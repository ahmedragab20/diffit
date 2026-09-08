/**
 * Typed read-only tools over a captured ReviewSnapshot.
 *
 * Every result is derived from evidence the snapshot already holds. These
 * tools cannot reach the shell, the network or the filesystem, cannot mutate
 * the snapshot, and cannot widen their own scope: the snapshot passed in is
 * the entire world a run may read. Failures are reported per item so one bad
 * request never discards a batch, and an exhausted budget is reported as such
 * rather than silently truncating the batch.
 */
import {
	AiSnapshotError,
	type AiEvidenceReference,
	type ReviewSnapshot,
	type SnapshotIdentity,
	type SnapshotSide,
	type SourceProvenance,
} from "./snapshots.js";

export const TOOL_LIMITS = Object.freeze({
	/** Shared across one batch, so a batch cannot outspend a single read. */
	batchBytes: 64 * 1024,
	batchItems: 32,
	mapPageSize: 50,
	searchMatches: 100,
});

export type ToolErrorCode = AiSnapshotError["code"];

export interface ToolError {
	code: ToolErrorCode;
	message: string;
}

export type ToolItem<T> =
	| { ok: true; value: T }
	| { ok: false; error: ToolError };

function toolError(error: unknown): ToolError {
	// Only snapshot errors are described; anything else stays opaque on purpose.
	if (error instanceof AiSnapshotError)
		return { code: error.code, message: error.message };
	return { code: "invalid", message: "Review evidence request failed." };
}

export interface SourceEntry {
	key: string;
	path: string;
	side: SnapshotSide;
	revision: string;
	representation: "unified-patch" | "original";
	bytes: number;
	lines: number;
	provenance: SourceProvenance;
	complete: boolean;
	omission?: string;
}

export interface ReviewMap {
	revision: string;
	/** Which local/PR/plan generation this capture is of. */
	identity: SnapshotIdentity;
	sources: SourceEntry[];
	omissions: string[];
	coverage: ReturnType<ReviewSnapshot["coverage"]>;
	nextCursor: string | null;
}

function parseCursor(cursor: string | undefined, total: number): number {
	if (cursor === undefined) return 0;
	const match = /^o:(\d{1,9})$/.exec(cursor);
	const offset = match ? Number(match[1]) : Number.NaN;
	if (!Number.isSafeInteger(offset) || offset > total)
		throw new AiSnapshotError("invalid");
	return offset;
}

/**
 * Lists what the run may read. Listing is not reading: this issues no evidence
 * and leaves returned-line coverage untouched.
 */
export function reviewMap(
	snapshot: ReviewSnapshot,
	options: { cursor?: string; limit?: number } = {},
): ReviewMap {
	const manifest = snapshot.manifest;
	const limit = options.limit ?? TOOL_LIMITS.mapPageSize;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > TOOL_LIMITS.mapPageSize
	)
		throw new AiSnapshotError("invalid");
	const offset = parseCursor(options.cursor, manifest.sources.length);
	const page = manifest.sources.slice(offset, offset + limit);
	const end = offset + page.length;
	return {
		revision: manifest.revision,
		identity: manifest.identity,
		sources: page.map((source) => ({
			key: source.key,
			path: source.path,
			side: source.side,
			revision: source.revision,
			representation: source.representation ?? "original",
			bytes: source.bytes,
			lines: source.lines,
			provenance: source.provenance,
			complete: source.complete,
			...(source.omission === undefined ? {} : { omission: source.omission }),
		})),
		omissions: manifest.omissions,
		coverage: snapshot.coverage(),
		nextCursor: end < manifest.sources.length ? `o:${end}` : null,
	};
}

export interface ReadRequest {
	key: string;
	startLine: number;
	endLine: number;
}

export interface ReadValue {
	key: string;
	text: string;
	startLine: number;
	endLine: number;
	truncated: boolean;
	provenance: SourceProvenance;
	representation: "unified-patch" | "original";
	evidence: AiEvidenceReference;
}

export interface BatchRead {
	items: ToolItem<ReadValue>[];
	budget: { maxBytes: number; usedBytes: number; exhausted: boolean };
	/** Repeated identical ranges are read once and shared, not re-billed. */
	deduplicated: number;
}

function readBatch(
	snapshot: ReviewSnapshot,
	requests: ReadRequest[],
	representation: "unified-patch" | "original",
	maxBytes: number,
): BatchRead {
	if (
		!Array.isArray(requests) ||
		!requests.length ||
		requests.length > TOOL_LIMITS.batchItems ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > TOOL_LIMITS.batchBytes
	)
		throw new AiSnapshotError("invalid");

	const sources = new Map(
		snapshot.manifest.sources.map((source) => [source.key, source]),
	);
	const items: ToolItem<ReadValue>[] = [];
	const seen = new Map<string, ToolItem<ReadValue>>();
	let usedBytes = 0;
	let exhausted = false;
	let deduplicated = 0;

	for (const request of requests) {
		const slot = `${request.key} ${request.startLine} ${request.endLine}`;
		const previous = seen.get(slot);
		if (previous) {
			deduplicated++;
			items.push(previous);
			continue;
		}
		let item: ToolItem<ReadValue>;
		const source = sources.get(request.key);
		if (!source) {
			item = { ok: false, error: toolError(new AiSnapshotError("missing")) };
		} else if ((source.representation ?? "original") !== representation) {
			// Patch offsets must never be handed back as original-file line numbers.
			item = { ok: false, error: toolError(new AiSnapshotError("unsupported")) };
		} else if (usedBytes >= maxBytes) {
			exhausted = true;
			item = { ok: false, error: toolError(new AiSnapshotError("limit")) };
		} else {
			try {
				const read = snapshot.read(
					request.key,
					request.startLine,
					request.endLine,
					maxBytes - usedBytes,
				);
				usedBytes += Buffer.byteLength(read.text, "utf8");
				item = {
					ok: true,
					value: {
						key: request.key,
						text: read.text,
						startLine: read.evidence.startLine,
						endLine: read.evidence.endLine,
						truncated: read.truncated,
						provenance: read.provenance,
						representation,
						evidence: read.evidence,
					},
				};
			} catch (error) {
				if (error instanceof AiSnapshotError && error.code === "limit")
					exhausted = true;
				item = { ok: false, error: toolError(error) };
			}
		}
		seen.set(slot, item);
		items.push(item);
	}

	return { items, budget: { maxBytes, usedBytes, exhausted }, deduplicated };
}

/** Reads original-file sources, whose line numbers are real file lines. */
export function sourceRead(
	snapshot: ReviewSnapshot,
	requests: ReadRequest[],
	maxBytes = TOOL_LIMITS.batchBytes,
): BatchRead {
	return readBatch(snapshot, requests, "original", maxBytes);
}

/** Reads unified-patch sources, whose line numbers are patch offsets. */
export function diffRead(
	snapshot: ReviewSnapshot,
	requests: ReadRequest[],
	maxBytes = TOOL_LIMITS.batchBytes,
): BatchRead {
	return readBatch(snapshot, requests, "unified-patch", maxBytes);
}

export interface CitationCheck {
	anchorValid: true;
	sourceVerified: boolean;
	provenance: SourceProvenance;
}

/**
 * Confirms a previously issued citation still anchors to this capture. A
 * citation that was never issued here is invalid, and one held against a
 * different generation is stale — neither is silently accepted, so a stored
 * reference can be re-checked rather than trusted.
 */
export function verifyCitation(
	snapshot: ReviewSnapshot,
	reference: unknown,
	revision: string,
): CitationCheck {
	const fields: (keyof AiEvidenceReference)[] = [
		"id",
		"snapshotId",
		"snapshotRevision",
		"sourceId",
		"sourceHash",
		"excerptHash",
	];
	const value = reference as Partial<AiEvidenceReference> | null;
	if (
		!value ||
		typeof value !== "object" ||
		fields.some((field) => typeof value[field] !== "string") ||
		!Number.isSafeInteger(value.startLine) ||
		!Number.isSafeInteger(value.endLine) ||
		typeof revision !== "string" ||
		!revision
	)
		throw new AiSnapshotError("invalid");
	return snapshot.verify(value as AiEvidenceReference, revision);
}

export interface SymbolLocation {
	/** Set when the location falls inside the capture and can be read. */
	key: string | null;
	path: string;
	startLine: number;
	endLine: number;
	/** A location outside the capture is named, never read. */
	inScope: boolean;
}

/**
 * Maps language-server locations onto the capture. A server may point anywhere
 * in the repository; a location outside the captured evidence is reported as
 * out of scope and is never read, so navigation cannot widen a run's scope.
 */
export function locateInSnapshot(
	snapshot: ReviewSnapshot,
	locations: readonly {
		uri: string;
		startLine: number;
		endLine: number;
	}[],
	repositoryRoot: string,
): SymbolLocation[] {
	const byPath = new Map<string, string>();
	for (const item of snapshot.manifest.sources)
		if ((item.representation ?? "original") === "original")
			byPath.set(item.path, item.key);
	const root = repositoryRoot.replace(/\/+$/, "");
	return locations.map((location) => {
		const path = fileUriToPath(location.uri, root);
		const key = path === null ? null : (byPath.get(path) ?? null);
		return {
			key,
			path: path ?? location.uri,
			startLine: location.startLine,
			endLine: location.endLine,
			inScope: key !== null,
		};
	});
}

/** Repository-relative path for a file URI, or null when it escapes the root. */
function fileUriToPath(uri: string, root: string): string | null {
	if (!uri.startsWith("file://")) return null;
	let absolute: string;
	try {
		absolute = decodeURIComponent(uri.slice("file://".length));
	} catch {
		return null;
	}
	if (!absolute.startsWith("/")) return null;
	if (absolute === root) return "";
	if (!absolute.startsWith(`${root}/`)) return null;
	const relative = absolute.slice(root.length + 1);
	// A traversal segment can never denote a captured source.
	return relative.split("/").includes("..") ? null : relative;
}

export interface SearchHit {
	key: string;
	line: number;
}

export interface SearchResult {
	matches: SearchHit[];
	truncated: boolean;
	nextCursor: string | null;
}

/**
 * Locates a literal substring and returns positions only. Reading a match is a
 * separate, evidence-issuing step, so searching never inflates coverage. A
 * caller-supplied regular expression is deliberately not accepted.
 */
export function sourceSearch(
	snapshot: ReviewSnapshot,
	query: string,
	options: {
		key?: string;
		limit?: number;
		ignoreCase?: boolean;
		cursor?: string;
	} = {},
): SearchResult {
	const limit = options.limit ?? TOOL_LIMITS.searchMatches;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > TOOL_LIMITS.searchMatches
	)
		throw new AiSnapshotError("invalid");
	const offset = parseCursor(options.cursor, TOOL_LIMITS.searchMatches);
	// Over-read the prefix by one so a further match is detectable; the
	// snapshot scan stays bounded either way.
	const found = snapshot.search(query, {
		key: options.key,
		ignoreCase: options.ignoreCase,
		limit: Math.min(TOOL_LIMITS.searchMatches, offset + limit + 1),
	});
	const page = found.matches.slice(offset, offset + limit);
	const end = offset + page.length;
	return {
		matches: page,
		truncated: found.truncated,
		nextCursor: end < found.matches.length ? `o:${end}` : null,
	};
}
