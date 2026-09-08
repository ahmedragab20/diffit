import { createHash, randomUUID } from "node:crypto";

export type SnapshotIdentity =
	| {
			kind: "local";
			repositoryId: string;
			/** Repository HEAD is distinct from the diff's new-side commit. */
			repositoryHeadSha?: string | null;
			scopeHash?: string;
			mode: "working" | "staged" | "revision" | "mixed";
			baseSha: string | null;
			headSha: string | null;
			indexHash: string | null;
			patchHash: string;
	  }
	| {
			kind: "pr";
			host: string;
			owner: string;
			repo: string;
			number: number;
			baseSha: string;
			headSha: string;
			mergeBaseSha: string | null;
			patchHash: string;
	  }
	| {
			kind: "plan";
			planId: string;
			version: number;
			bodyHash: string;
			titleHash: string;
	  };
export type SourceProvenance =
	| "recorded"
	| "reconstructed"
	| "unknown"
	| "draft";
export type SnapshotSide = "old" | "new" | "document" | "draft";
export interface SnapshotSourceInput {
	key: string;
	path: string;
	side: SnapshotSide;
	revision: string;
	content: string | null;
	complete: boolean;
	provenance: SourceProvenance;
	/** Patch offsets must never be presented as original-file line numbers. */
	representation?: "unified-patch" | "original";
	omission?: string;
}
export interface SnapshotSource extends Omit<SnapshotSourceInput, "content"> {
	id: string;
	hash: string | null;
	bytes: number;
	lines: number;
}
export interface AiSnapshotManifest {
	id: string;
	revision: string;
	identity: SnapshotIdentity;
	sources: SnapshotSource[];
	omissions: string[];
}
export interface AiEvidenceReference {
	id: string;
	snapshotId: string;
	snapshotRevision: string;
	sourceId: string;
	sourceHash: string;
	startLine: number;
	endLine: number;
	excerptHash: string;
}
export class AiSnapshotError extends Error {
	constructor(
		readonly code: "invalid" | "missing" | "stale" | "limit" | "unsupported",
	) {
		super(
			{
				unsupported: "This diff mode does not yet support verified AI snapshots.",
				invalid: "Invalid review evidence request.",
				missing: "Review source is unavailable.",
				stale: "Review source changed; refresh and try again.",
				limit: "Review snapshot exceeds its resource limit.",
			}[code],
		);
	}
	get status(): 400 | 404 | 409 | 413 | 422 {
		return {
			invalid: 400,
			missing: 404,
			stale: 409,
			limit: 413,
			unsupported: 422,
		}[this.code] as 400 | 404 | 409 | 413 | 422;
	}
}
export const sourceHash = (content: string | Uint8Array): string =>
	createHash("sha256").update(content).digest("hex");
function sourceLines(content: string): string[] {
	// Bound allocation as well as bytes: a small newline-only source has many rows.
	let count = 0;
	for (
		let offset = content.indexOf("\n");
		offset !== -1;
		offset = content.indexOf("\n", offset + 1)
	) {
		if (++count > 100_000) throw new AiSnapshotError("limit");
	}
	return content === "" ? [] : content.replace(/\n$/, "").split("\n");
}

/** Captured text is immutable. Merely listing sources does not count as reading them. */
export class ReviewSnapshot {
	private readonly value: AiSnapshotManifest;
	private readonly contents = new Map<string, string[]>();
	private readonly issued = new Map<string, AiEvidenceReference>();
	private readonly readLines = new Map<string, Set<number>>();

	constructor(
		identity: SnapshotIdentity,
		inputs: SnapshotSourceInput[],
		omissions: string[] = [],
	) {
		if (
			inputs.length > 256 ||
			omissions.length > 256 ||
			Buffer.byteLength(JSON.stringify(identity)) > 8192
		)
			throw new AiSnapshotError("limit");
		const keys = new Set<string>();
		let bytes = 0;
		const sources = inputs.map((input): SnapshotSource => {
			if (
				!input.key ||
				input.key.length > 1024 ||
				input.path.length > 4096 ||
				input.revision.length > 1024 ||
				(input.omission?.length ?? 0) > 4096 ||
				keys.has(input.key)
			)
				throw new AiSnapshotError("invalid");
			keys.add(input.key);
			const size =
				input.content === null ? 0 : Buffer.byteLength(input.content, "utf8");
			bytes += size;
			if (size > 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024)
				throw new AiSnapshotError("limit");
			if (input.content === null && (!input.omission || input.complete))
				throw new AiSnapshotError("invalid");
			const { content, ...metadata } = input;
			const id = randomUUID();
			const lines = content === null ? [] : sourceLines(content);
			if (content !== null) this.contents.set(id, lines);
			return {
				...metadata,
				id,
				hash: content === null ? null : sourceHash(content),
				bytes: size,
				lines: lines.length,
			};
		});
		if (omissions.some((reason) => reason.length > 4096))
			throw new AiSnapshotError("limit");
		const pinnedIdentity = structuredClone(identity);
		const revision = sourceHash(
			JSON.stringify({
				identity: pinnedIdentity,
				sources: sources.map(({ id: _id, ...source }) => source),
				omissions,
			}),
		);
		this.value = {
			id: randomUUID(),
			revision,
			identity: pinnedIdentity,
			sources,
			omissions: [...omissions],
		};
	}

	get manifest(): AiSnapshotManifest {
		return structuredClone(this.value);
	}

	read(
		key: string,
		startLine: number,
		endLine: number,
		maxBytes = 64 * 1024,
	): {
		text: string;
		evidence: AiEvidenceReference;
		truncated: boolean;
		provenance: SourceProvenance;
	} {
		if (
			![startLine, endLine, maxBytes].every(Number.isSafeInteger) ||
			startLine < 1 ||
			endLine < startLine ||
			maxBytes < 1 ||
			maxBytes > 256 * 1024
		)
			throw new AiSnapshotError("invalid");
		if (this.issued.size >= 2048) throw new AiSnapshotError("limit");
		const source = this.value.sources.find((item) => item.key === key);
		if (!source?.hash) throw new AiSnapshotError("missing");
		const lines = this.contents.get(source.id)!;
		if (endLine > lines.length) throw new AiSnapshotError("invalid");
		const selected: string[] = [];
		let bytes = 0;
		const limit = Math.min(endLine, startLine + 199);
		for (let line = startLine; line <= limit; line++) {
			const nextBytes =
				Buffer.byteLength(lines[line - 1], "utf8") + (selected.length ? 1 : 0);
			if (bytes + nextBytes > maxBytes) break;
			selected.push(lines[line - 1]);
			bytes += nextBytes;
		}
		if (!selected.length) throw new AiSnapshotError("limit");
		const text = selected.join("\n");
		const last = startLine + selected.length - 1;
		const evidence: AiEvidenceReference = {
			id: randomUUID(),
			snapshotId: this.value.id,
			snapshotRevision: this.value.revision,
			sourceId: source.id,
			sourceHash: source.hash,
			startLine,
			endLine: last,
			excerptHash: sourceHash(text),
		};
		this.issued.set(evidence.id, evidence);
		const read = this.readLines.get(source.id) ?? new Set<number>();
		for (let line = startLine; line <= last; line++) read.add(line);
		this.readLines.set(source.id, read);
		return {
			text,
			evidence: { ...evidence },
			truncated: last !== endLine || !source.complete,
			provenance: source.provenance,
		};
	}

	verify(
		reference: AiEvidenceReference,
		currentRevision: string,
	): {
		anchorValid: true;
		sourceVerified: boolean;
		provenance: SourceProvenance;
	} {
		if (currentRevision !== this.value.revision)
			throw new AiSnapshotError("stale");
		const issued = this.issued.get(reference.id);
		if (
			!issued ||
			(Object.keys(issued) as (keyof AiEvidenceReference)[]).some(
				(key) => reference[key] !== issued[key],
			)
		)
			throw new AiSnapshotError("invalid");
		const source = this.value.sources.find(
			(item) => item.id === reference.sourceId,
		)!;
		return {
			anchorValid: true,
			sourceVerified: source.provenance === "recorded",
			provenance: source.provenance,
		};
	}

	coverage() {
		return {
			sourceCount: this.value.sources.length,
			availableLines: this.value.sources.reduce(
				(sum, source) => sum + source.lines,
				0,
			),
			returnedLines: [...this.readLines.values()].reduce(
				(sum, lines) => sum + lines.size,
				0,
			),
			readSourceCount: this.readLines.size,
			omittedSourceCount: this.value.sources.filter(
				(source) => source.hash === null || !source.complete,
			).length,
			omissions: [...this.value.omissions],
			// This is evidence returned by reads, never a claim about model attention or review quality.
			basis: "returned-source-lines" as const,
		};
	}
}
