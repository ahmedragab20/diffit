/**
 * Language-server intelligence for the review UI.
 *
 * A language server answers about the working tree, so a lookup is only
 * truthful when what the reviewer is looking at *is* the working tree. This
 * module owns that judgement: a request states the shape of the review and
 * gets back either an answer or an explicit reason it cannot be answered. An
 * empty answer therefore always means "the server found nothing", never "we
 * could not ask" — the same contract `ai/symbols.ts` keeps for the AI path.
 *
 * Nothing here grants the server authority. It asks questions and reads
 * answers; no edit, command or file write is ever accepted.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspError, type LspLocation } from "./ai/lsp.js";
import type { LanguageServers } from "./ai/language-servers.js";

export type CodeIntelOp = "hover" | "definition" | "references";

/** Why a position cannot be looked up. Always specific, never "no results". */
export type CodeIntelUnavailable =
	| "not-configured"
	| "unsupported-language"
	| "pull-request"
	| "revision-range"
	| "staged"
	| "old-side"
	| "outside-repository"
	| "server-error";

/**
 * The shape of the review being displayed. Only a plain working-tree diff
 * renders the same bytes the language server reads off disk.
 */
export interface CodeIntelScope {
	/** The diff came from a revision range, pathspec, or an explicit mode. */
	customMode: boolean;
	/** A GitHub pull-request review; the new side is a fetched patch. */
	prMode: boolean;
	/** The diff is against the index, which need not match the working tree. */
	staged: boolean;
}

export interface CodeIntelRequest {
	op: CodeIntelOp;
	/** Repository-relative path, as the diff names it. */
	path: string;
	side: "additions" | "deletions";
	/** One-based, matching the diff gutter and `LspSession`. */
	line: number;
	/** Zero-based character offset within the line. */
	character: number;
	includeDeclaration?: boolean;
}

export interface CodeIntelLocation {
	/** Repository-relative when `inRepository`, otherwise an absolute path. */
	path: string;
	/** One-based. */
	line: number;
	character: number;
	endLine: number;
	endCharacter: number;
	/**
	 * False for a target outside the repository — a stdlib or toolchain file.
	 * It is named so the reviewer knows where the symbol went, but the UI has
	 * no way to read it, and must not offer one.
	 */
	inRepository: boolean;
}

export type CodeIntelResult =
	| { available: false; reason: CodeIntelUnavailable; detail?: string }
	| { available: true; op: "hover"; hover: string | null }
	| {
			available: true;
			op: "definition" | "references";
			locations: CodeIntelLocation[];
	  };

export interface CodeIntelCapabilities {
	/** At least one language server is configured for some extension. */
	configured: boolean;
	/** Extensions with a configured server, lowercase and without the dot. */
	extensions: string[];
	/** Set when this review can never answer a lookup, whatever the file. */
	unavailable?: CodeIntelUnavailable;
}

/** The reason this review is unanswerable, or undefined when it is fine. */
function scopeReason(scope: CodeIntelScope): CodeIntelUnavailable | undefined {
	if (scope.prMode) return "pull-request";
	if (scope.customMode) return "revision-range";
	if (scope.staged) return "staged";
	return undefined;
}

/**
 * What the UI should offer before any position is hovered. The toolbar uses
 * this to explain why the feature is off rather than silently doing nothing.
 */
export function codeIntelCapabilities(
	servers: LanguageServers,
	scope: CodeIntelScope,
): CodeIntelCapabilities {
	return {
		configured: servers.configured,
		extensions: servers.extensions,
		unavailable: !servers.configured ? "not-configured" : scopeReason(scope),
	};
}

/**
 * Resolve a repository-relative path to an absolute one, refusing anything
 * that escapes the repository. A path from the browser is untrusted input.
 */
function resolveInRepository(
	repositoryRoot: string,
	path: string,
): string | undefined {
	if (!path || isAbsolute(path) || path.includes("\0")) return undefined;
	const root = resolve(repositoryRoot);
	const absolute = resolve(root, path);
	const rel = relative(root, absolute);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		return undefined;
	return absolute;
}

/** Map a server location back onto a repository-relative path where possible. */
function toCodeIntelLocation(
	repositoryRoot: string,
	location: LspLocation,
): CodeIntelLocation | undefined {
	let absolute: string;
	try {
		absolute = fileURLToPath(location.uri);
	} catch {
		// A non-file URI (an in-memory or jar-backed document) is not addressable.
		return undefined;
	}
	const root = resolve(repositoryRoot);
	const rel = relative(root, absolute);
	const inRepository = Boolean(
		rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
	);
	return {
		path: inRepository ? rel : absolute,
		line: location.startLine,
		character: location.startCharacter,
		endLine: location.endLine,
		endCharacter: location.endCharacter,
		inRepository,
	};
}

/**
 * Look up a position in the review. Every refusal names its reason, and a
 * failing or absent language server is a refusal rather than an empty answer.
 */
export async function codeIntel(
	servers: LanguageServers,
	repositoryRoot: string,
	scope: CodeIntelScope,
	request: CodeIntelRequest,
): Promise<CodeIntelResult> {
	if (!servers.configured)
		return { available: false, reason: "not-configured" };

	const scoped = scopeReason(scope);
	if (scoped) return { available: false, reason: scoped };

	// The old side is a past version of the file; disk holds the new one.
	if (request.side !== "additions")
		return { available: false, reason: "old-side" };

	const absolute = resolveInRepository(repositoryRoot, request.path);
	if (!absolute) return { available: false, reason: "outside-repository" };

	if (!servers.supports(request.path))
		return { available: false, reason: "unsupported-language" };

	// Built through pathToFileURL so spaces and other characters are encoded,
	// matching how returned locations are decoded on the way back.
	const uri = pathToFileURL(absolute).href;
	try {
		const session = await servers.sessionFor(request.path);
		if (request.op === "hover") {
			const hover = await session.hover(uri, request.line, request.character);
			return { available: true, op: "hover", hover };
		}
		const found =
			request.op === "definition"
				? await session.definitions(uri, request.line, request.character)
				: await session.references(
						uri,
						request.line,
						request.character,
						request.includeDeclaration === true,
					);
		const locations = found
			.map((location) => toCodeIntelLocation(repositoryRoot, location))
			.filter((location): location is CodeIntelLocation => location !== undefined);
		return { available: true, op: request.op, locations };
	} catch (error) {
		if (error instanceof LspError)
			return {
				available: false,
				reason: "server-error",
				detail: error.message,
			};
		throw error;
	}
}
