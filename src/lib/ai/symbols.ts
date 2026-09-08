/**
 * Definition and reference lookups over a captured review snapshot.
 *
 * The language server answers about the working tree, not about the capture,
 * so every location it returns is mapped back onto the snapshot: a location
 * inside the capture is addressable and readable, and one outside is named but
 * explicitly out of scope. Symbol navigation therefore cannot become a way to
 * read files the run was never given.
 */
import { LspError } from "./lsp.js";
import type { LanguageServers } from "./language-servers.js";
import { AiSnapshotError, type ReviewSnapshot } from "./snapshots.js";
import { locateInSnapshot, type SymbolLocation } from "./tools.js";

export type SymbolKind = "definitions" | "references";

export interface SymbolQuery {
	key: string;
	line: number;
	character: number;
	kind: SymbolKind;
	includeDeclaration?: boolean;
}

export interface SymbolResult {
	kind: SymbolKind;
	locations: SymbolLocation[];
	/** How many locations fell outside the capture and were not made readable. */
	outOfScope: number;
	/** Set when no language server is configured or reachable for this source. */
	unavailable?: string;
}

/**
 * Looks up a symbol at a captured source position. An absent or failing
 * language server yields an explicit `unavailable` result rather than an empty
 * one, so a caller never mistakes "no server" for "no references".
 */
export async function lookupSymbols(
	snapshot: ReviewSnapshot,
	servers: LanguageServers,
	repositoryRoot: string,
	query: SymbolQuery,
): Promise<SymbolResult> {
	if (
		typeof query.key !== "string" ||
		!query.key ||
		!Number.isSafeInteger(query.line) ||
		query.line < 1 ||
		!Number.isSafeInteger(query.character) ||
		query.character < 0 ||
		(query.kind !== "definitions" && query.kind !== "references")
	)
		throw new AiSnapshotError("invalid");

	const source = snapshot.manifest.sources.find(
		(item) => item.key === query.key,
	);
	if (!source) throw new AiSnapshotError("missing");
	// Patch offsets are not file positions, so they are not a valid symbol anchor.
	if ((source.representation ?? "original") !== "original")
		throw new AiSnapshotError("unsupported");
	if (query.line > source.lines) throw new AiSnapshotError("invalid");

	const absolute = `${repositoryRoot.replace(/\/+$/, "")}/${source.path}`;
	const uri = `file://${absolute}`;
	let located: SymbolLocation[];
	try {
		const session = await servers.sessionFor(source.path);
		const found =
			query.kind === "definitions"
				? await session.definitions(uri, query.line, query.character)
				: await session.references(
						uri,
						query.line,
						query.character,
						query.includeDeclaration === true,
					);
		located = locateInSnapshot(snapshot, found, repositoryRoot);
	} catch (error) {
		if (error instanceof LspError)
			return {
				kind: query.kind,
				locations: [],
				outOfScope: 0,
				unavailable: error.message,
			};
		throw error;
	}

	return {
		kind: query.kind,
		locations: located,
		outOfScope: located.filter((location) => !location.inScope).length,
	};
}
