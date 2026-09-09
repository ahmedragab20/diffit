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
 * Nothing here grants the server authority. Edits come back as data for the
 * local editor to apply or refuse; no command or file write is ever accepted.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	LspError,
	type LspCodeAction,
	type LspDiagnostics,
	type LspLocation,
	type LspRange,
	type LspSession,
	type LspSignature,
	type LspTextEdit,
	type LspWorkspaceEdit,
} from "./ai/lsp.js";
import type { LanguageServers } from "./ai/language-servers.js";

/** Files above this are not worth pushing at a language server for a tooltip. */
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/**
 * Extensions whose LSP `languageId` is not simply the extension. Servers use
 * it to pick a parser, so a wrong one silently produces nothing.
 */
const LANGUAGE_IDS: Record<string, string> = {
	ts: "typescript",
	tsx: "typescriptreact",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascriptreact",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rs: "rust",
	rb: "ruby",
	kt: "kotlin",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	h: "c",
	md: "markdown",
	yml: "yaml",
	sh: "shellscript",
};

function languageIdFor(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
	return LANGUAGE_IDS[extension] ?? extension;
}

export type CodeIntelOp =
	| "hover"
	| "definition"
	| "references"
	| "rename"
	| "format"
	| "code-actions"
	| "signature"
	| "highlights";

/** Why a position cannot be looked up. Always specific, never "no results". */
export type CodeIntelUnavailable =
	| "not-configured"
	| "unsupported-language"
	| "pull-request"
	| "revision-range"
	| "staged"
	| "old-side"
	| "outside-repository"
	| "invalid-request"
	| "file-unreadable"
	| "file-too-large"
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
	/** The new identifier, for `rename`. */
	newName?: string;
	/** The end of the selection, for `code-actions`. Defaults to the start. */
	endLine?: number;
	endCharacter?: number;
	/** Formatting preferences, for `format`. */
	tabSize?: number;
	insertSpaces?: boolean;
}

/** An edit in the editor's own shape, ready for `Editor.applyEdits`. */
export interface CodeIntelEdit {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	newText: string;
}

/**
 * The part of a server's answer that can actually be applied here.
 *
 * Edits outside the file being edited are counted, never applied: a review
 * tool writing to files the reviewer is not looking at is the wrong default,
 * so the UI reports the spill and leaves it to them.
 */
export interface CodeIntelEdits {
	edits: CodeIntelEdit[];
	otherEdits: number;
	otherFiles: number;
}

export interface CodeIntelAction {
	title: string;
	kind?: string;
	edits?: CodeIntelEdits;
	/** Why this action cannot be applied, when it cannot. Never hidden. */
	unavailable?: "command-only" | "other-files-only";
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
	  }
	| { available: true; op: "rename" | "format"; edits: CodeIntelEdits }
	| { available: true; op: "code-actions"; actions: CodeIntelAction[] }
	| { available: true; op: "signature"; signatures: LspSignature[] }
	| { available: true; op: "highlights"; highlights: LspRange[] };

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

function toCodeIntelEdit(edit: LspTextEdit): CodeIntelEdit {
	return {
		range: {
			start: { line: edit.startLine, character: edit.startCharacter },
			end: { line: edit.endLine, character: edit.endCharacter },
		},
		newText: edit.newText,
	};
}

/**
 * Split a workspace edit into the part that belongs to the open file and a
 * count of everything else. Nothing outside that file is ever returned as an
 * applicable edit.
 */
function editsForFile(
	absolutePath: string,
	edit: LspWorkspaceEdit | null,
): CodeIntelEdits {
	const result: CodeIntelEdits = { edits: [], otherEdits: 0, otherFiles: 0 };
	if (!edit) return result;
	for (const change of edit.changes) {
		let target: string;
		try {
			target = fileURLToPath(change.uri);
		} catch {
			result.otherFiles += 1;
			result.otherEdits += change.edits.length;
			continue;
		}
		if (target === absolutePath) {
			result.edits.push(...change.edits.map(toCodeIntelEdit));
			continue;
		}
		result.otherFiles += 1;
		result.otherEdits += change.edits.length;
	}
	return result;
}

/**
 * An action the UI can offer. One that only carries a command is named and
 * marked unavailable rather than hidden: applying it would mean asking the
 * server to execute that command, which this client never does. The literal
 * method name is deliberately absent here — the adversarial test greps for it.
 */
function toCodeIntelAction(
	absolutePath: string,
	action: LspCodeAction,
): CodeIntelAction {
	if (action.commandOnly)
		return {
			title: action.title,
			kind: action.kind,
			unavailable: "command-only",
		};
	const edits = editsForFile(absolutePath, action.edit ?? null);
	if (edits.edits.length === 0)
		return {
			title: action.title,
			kind: action.kind,
			edits,
			unavailable: "other-files-only",
		};
	return { title: action.title, kind: action.kind, edits };
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
 * A document owned by an open editor in the browser rather than by disk.
 *
 * Drafts and disk syncing must not fight over the same document: while a
 * reviewer is typing, disk is stale by definition, so the stamp says who owns
 * it and the disk path leaves a draft alone.
 */
const DRAFT_PREFIX = "draft:";

/** Positions are zero-based, matching `Editor.setMarkers`. */
export interface CodeIntelMarker {
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	source: string;
	start: { line: number; character: number };
	end: { line: number; character: number };
}

export interface PublishedMarkers {
	/** Repository-relative path the diagnostics belong to. */
	path: string;
	/**
	 * The draft version they were computed against, when the server said. The
	 * client drops anything that does not match what it last sent.
	 */
	version?: number;
	markers: CodeIntelMarker[];
}

export interface DraftDocument {
	path: string;
	text: string;
	/** The client's own version, echoed back with any diagnostics. */
	version: number;
}

export type DraftResult =
	| { ok: true }
	| { ok: false; reason: CodeIntelUnavailable };

/** Turn a published diagnostic batch into markers the editor can render. */
export function markersFromDiagnostics(
	repositoryRoot: string,
	published: LspDiagnostics,
): PublishedMarkers | undefined {
	let absolute: string;
	try {
		absolute = fileURLToPath(published.uri);
	} catch {
		return undefined;
	}
	const rel = relative(resolve(repositoryRoot), absolute);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		return undefined;
	return {
		path: rel,
		version: published.version,
		markers: published.diagnostics.map((diagnostic) => ({
			severity: diagnostic.severity,
			message: diagnostic.message,
			source: diagnostic.source ?? "lsp",
			start: {
				line: diagnostic.startLine,
				character: diagnostic.startCharacter,
			},
			end: { line: diagnostic.endLine, character: diagnostic.endCharacter },
		})),
	};
}

/**
 * Hand the language server the text the reviewer is actually looking at.
 *
 * Called on entering an edit session and on every debounced change. The
 * version travels with the text so a diagnostic batch computed against an
 * older draft can be recognised and dropped rather than painting squiggles on
 * lines that have since moved.
 */
export async function syncDraft(
	servers: LanguageServers,
	repositoryRoot: string,
	scope: CodeIntelScope,
	draft: DraftDocument,
	onDiagnostics: (published: PublishedMarkers) => void,
): Promise<DraftResult> {
	if (!servers.configured) return { ok: false, reason: "not-configured" };
	const scoped = scopeReason(scope);
	if (scoped) return { ok: false, reason: scoped };
	const absolute = resolveInRepository(repositoryRoot, draft.path);
	if (!absolute) return { ok: false, reason: "outside-repository" };
	if (!servers.supports(draft.path))
		return { ok: false, reason: "unsupported-language" };
	if (Buffer.byteLength(draft.text, "utf8") > MAX_DOCUMENT_BYTES)
		return { ok: false, reason: "file-too-large" };

	const uri = pathToFileURL(absolute).href;
	try {
		const session = await servers.sessionFor(draft.path);
		session.onDiagnostics((published) => {
			const markers = markersFromDiagnostics(repositoryRoot, published);
			if (markers) onDiagnostics(markers);
		});
		const stamp = `${DRAFT_PREFIX}${draft.version}`;
		if (session.documentStamp(uri) === undefined)
			session.openDocument(
				uri,
				languageIdFor(draft.path),
				draft.text,
				stamp,
				draft.version,
			);
		else session.changeDocument(uri, draft.text, stamp, draft.version);
		return { ok: true };
	} catch (error) {
		if (error instanceof LspError)
			return { ok: false, reason: "server-error" };
		throw error;
	}
}

/**
 * Forget a draft. The next lookup re-opens the file from disk, which is what
 * it should describe once the editor is closed.
 */
export async function closeDraft(
	servers: LanguageServers,
	repositoryRoot: string,
	path: string,
): Promise<void> {
	if (!servers.configured || !servers.supports(path)) return;
	const absolute = resolveInRepository(repositoryRoot, path);
	if (!absolute) return;
	try {
		const session = await servers.sessionFor(path);
		session.closeDocument(pathToFileURL(absolute).href);
	} catch (error) {
		// A server that is already gone has nothing to forget.
		if (!(error instanceof LspError)) throw error;
	}
}

/**
 * Make sure the server holds the file's current text before it is asked about.
 *
 * Servers of the tsserver family answer nothing about a document they were
 * never given, so a lookup that skips this silently returns "no results" — the
 * exact lie this module exists to avoid. The document is kept open for the
 * session's life; size and mtime are the freshness stamp, which is a cheap
 * `stat` per lookup rather than a re-read.
 */
function syncDocument(
	session: LspSession,
	absolutePath: string,
	uri: string,
	repositoryPath: string,
): CodeIntelUnavailable | undefined {
	let stamp: string;
	try {
		const stats = statSync(absolutePath);
		if (!stats.isFile()) return "file-unreadable";
		if (stats.size > MAX_DOCUMENT_BYTES) return "file-too-large";
		stamp = `${stats.size}:${stats.mtimeMs}`;
	} catch {
		return "file-unreadable";
	}
	const known = session.documentStamp(uri);
	// An open editor owns this document; disk is stale by definition while the
	// reviewer is typing, and overwriting the draft would erase their text.
	if (known?.startsWith(DRAFT_PREFIX)) return undefined;
	if (known === stamp) return undefined;
	let text: string;
	try {
		text = readFileSync(absolutePath, "utf8");
	} catch {
		return "file-unreadable";
	}
	if (known === undefined)
		session.openDocument(uri, languageIdFor(repositoryPath), text, stamp);
	else session.changeDocument(uri, text, stamp);
	return undefined;
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

	if (request.op === "rename" && !request.newName?.trim())
		return { available: false, reason: "invalid-request" };

	// Built through pathToFileURL so spaces and other characters are encoded,
	// matching how returned locations are decoded on the way back.
	const uri = pathToFileURL(absolute).href;
	try {
		const session = await servers.sessionFor(request.path);
		const unreadable = syncDocument(session, absolute, uri, request.path);
		if (unreadable) return { available: false, reason: unreadable };
		if (request.op === "hover") {
			const hover = await session.hover(uri, request.line, request.character);
			return { available: true, op: "hover", hover };
		}
		if (request.op === "rename") {
			const newName = request.newName?.trim();
			if (!newName) return { available: false, reason: "invalid-request" };
			const edit = await session.rename(
				uri,
				request.line,
				request.character,
				newName,
			);
			return {
				available: true,
				op: "rename",
				edits: editsForFile(absolute, edit),
			};
		}
		if (request.op === "format") {
			const tabSize = request.tabSize ?? 2;
			const insertSpaces = request.insertSpaces !== false;
			const edits =
				request.endLine !== undefined
					? await session.rangeFormatting(
							uri,
							{
								startLine: request.line - 1,
								startCharacter: request.character,
								endLine: request.endLine - 1,
								endCharacter: request.endCharacter ?? request.character,
							},
							tabSize,
							insertSpaces,
						)
					: await session.formatting(uri, tabSize, insertSpaces);
			return {
				available: true,
				op: "format",
				edits: {
					edits: edits.map(toCodeIntelEdit),
					otherEdits: 0,
					otherFiles: 0,
				},
			};
		}
		if (request.op === "code-actions") {
			const span: LspRange = {
				startLine: request.line - 1,
				startCharacter: request.character,
				endLine: (request.endLine ?? request.line) - 1,
				endCharacter: request.endCharacter ?? request.character,
			};
			const actions = await session.codeActions(uri, span);
			return {
				available: true,
				op: "code-actions",
				actions: actions.map((action) => toCodeIntelAction(absolute, action)),
			};
		}
		if (request.op === "signature") {
			return {
				available: true,
				op: "signature",
				signatures: await session.signatureHelp(
					uri,
					request.line,
					request.character,
				),
			};
		}
		if (request.op === "highlights") {
			return {
				available: true,
				op: "highlights",
				highlights: await session.documentHighlights(
					uri,
					request.line,
					request.character,
				),
			};
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
