/**
 * Bounded LSP client for the language intelligence the review surfaces use.
 *
 * A language server is discovered on PATH, exactly like the provider runtimes:
 * when it is absent the feature reports itself unavailable rather than
 * pretending. The client is deliberately small and defensive — it speaks only
 * the few requests it needs, correlates every response by id, bounds frames,
 * bytes and time, and never grants the server authority: a server-initiated
 * request is answered with "method not found", and of everything the server
 * volunteers only `textDocument/publishDiagnostics` is listened to, and only
 * for documents this client opened. No workspace edit, command or file write
 * is ever accepted.
 *
 * Documents are pushed, never pulled: servers of the tsserver family answer
 * nothing about a file they were not given, even one sitting in the project on
 * disk, so callers open the documents they ask about. That direction is safe —
 * we tell the server what a file contains; it never tells us to change one.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "./child-process.js";

export const LSP_LIMITS = Object.freeze({
	frameBytes: 4 * 1024 * 1024,
	/**
	 * Bytes held in the decoder awaiting a complete frame. This bounds memory,
	 * not lifetime throughput: a session that stays open to receive document
	 * diagnostics streams far more than this over its life and is healthy.
	 */
	bufferedBytes: 16 * 1024 * 1024,
	pendingRequests: 32,
	locations: 500,
	hoverBytes: 8 * 1024,
	/** Diagnostics kept from one publish; a broken build can report thousands. */
	diagnostics: 1000,
	/** Text edits accepted from one rename, format or code action. */
	edits: 5000,
	/** Code actions offered for one selection. */
	codeActions: 64,
	requestMs: 10_000,
	startupMs: 20_000,
});

export class LspError extends Error {
	constructor(
		readonly code:
			| "unavailable"
			| "protocol_error"
			| "timeout"
			| "resource_limit",
	) {
		super(
			{
				unavailable: "No language server is available for this source.",
				protocol_error: "The language server sent an unusable response.",
				timeout: "The language server did not answer in time.",
				resource_limit: "The language server response exceeded its limit.",
			}[code],
		);
		this.name = "LspError";
	}
}

export interface LspLocation {
	uri: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

export type LspSeverity = "error" | "warning" | "info" | "hint";

export interface LspDiagnostic {
	severity: LspSeverity;
	message: string;
	source?: string;
	/** Zero-based, as the wire carries them and as editor markers want them. */
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

export interface LspDiagnostics {
	uri: string;
	/**
	 * The document version these were computed against, when the server says.
	 * Undefined means it did not, and the caller has to decide what to trust.
	 */
	version?: number;
	diagnostics: LspDiagnostic[];
}

/** A replacement of one range, with zero-based positions as the wire has them. */
export interface LspTextEdit {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	newText: string;
}

export interface LspWorkspaceEdit {
	/** Edits grouped by the document they apply to. */
	changes: { uri: string; edits: LspTextEdit[] }[];
}

export interface LspCodeAction {
	title: string;
	kind?: string;
	/** Absent when the action has no edit — see `commandOnly`. */
	edit?: LspWorkspaceEdit;
	/**
	 * True when the only way to apply this action is to ask the server to run a
	 * command. This client does not do that, so such an action is offered as
	 * unavailable rather than silently dropped.
	 */
	commandOnly: boolean;
}

export interface LspSignature {
	label: string;
	documentation?: string;
	activeParameter?: number;
}

export interface LspRange {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

function range(value: unknown): LspRange | undefined {
	const item = value as
		| {
				start?: { line?: unknown; character?: unknown };
				end?: { line?: unknown; character?: unknown };
		  }
		| undefined;
	const start = item?.start;
	const end = item?.end;
	if (
		!Number.isSafeInteger(start?.line) ||
		!Number.isSafeInteger(start?.character) ||
		!Number.isSafeInteger(end?.line) ||
		!Number.isSafeInteger(end?.character)
	)
		return undefined;
	return {
		startLine: start!.line as number,
		startCharacter: start!.character as number,
		endLine: end!.line as number,
		endCharacter: end!.character as number,
	};
}

function textEdits(value: unknown): LspTextEdit[] {
	if (!Array.isArray(value)) return [];
	if (value.length > LSP_LIMITS.edits) throw new LspError("resource_limit");
	const edits: LspTextEdit[] = [];
	for (const entry of value) {
		const item = entry as Record<string, unknown>;
		const span = range(item?.range);
		// An AnnotatedTextEdit carries the same shape plus an annotation id.
		if (!span || typeof item?.newText !== "string") continue;
		edits.push({ ...span, newText: item.newText as string });
	}
	return edits;
}

/**
 * Normalize both `WorkspaceEdit` shapes: the older `changes` map keyed by uri,
 * and `documentChanges`, which may also carry create/rename/delete operations.
 * Those file operations are ignored — this client applies text, nothing else.
 */
function workspaceEdit(result: unknown): LspWorkspaceEdit | null {
	if (result === null || result === undefined) return null;
	const item = result as Record<string, unknown>;
	const changes: { uri: string; edits: LspTextEdit[] }[] = [];
	const documentChanges = item.documentChanges;
	if (Array.isArray(documentChanges)) {
		for (const entry of documentChanges) {
			const change = entry as Record<string, unknown>;
			const document = change?.textDocument as { uri?: unknown } | undefined;
			// A create/rename/delete operation has `kind` and no textDocument.
			if (typeof document?.uri !== "string") continue;
			const edits = textEdits(change.edits);
			if (edits.length > 0) changes.push({ uri: document.uri, edits });
		}
	}
	const map = item.changes;
	if (typeof map === "object" && map !== null) {
		for (const [uri, value] of Object.entries(map)) {
			const edits = textEdits(value);
			if (edits.length > 0) changes.push({ uri, edits });
		}
	}
	return changes.length > 0 ? { changes } : null;
}

const SEVERITIES: Record<number, LspSeverity> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
};

/**
 * Parse a publishDiagnostics payload, dropping anything unusable rather than
 * failing the session: a malformed diagnostic is worth losing, a live editing
 * session is not.
 */
function parseDiagnostics(params: unknown): LspDiagnostics | undefined {
	if (typeof params !== "object" || params === null) return undefined;
	const { uri, version, diagnostics } = params as Record<string, unknown>;
	if (typeof uri !== "string" || !uri || uri.length > 4096) return undefined;
	if (!Array.isArray(diagnostics)) return undefined;
	const parsed: LspDiagnostic[] = [];
	for (const entry of diagnostics.slice(0, LSP_LIMITS.diagnostics)) {
		if (typeof entry !== "object" || entry === null) continue;
		const item = entry as Record<string, unknown>;
		const range = item.range as
			| {
					start?: { line?: unknown; character?: unknown };
					end?: { line?: unknown; character?: unknown };
			  }
			| undefined;
		const start = range?.start;
		const end = range?.end;
		if (
			typeof item.message !== "string" ||
			!Number.isSafeInteger(start?.line) ||
			!Number.isSafeInteger(start?.character) ||
			!Number.isSafeInteger(end?.line) ||
			!Number.isSafeInteger(end?.character)
		)
			continue;
		parsed.push({
			// An unknown or absent severity is an error by LSP convention.
			severity: SEVERITIES[item.severity as number] ?? "error",
			message: item.message.slice(0, 2048),
			source: typeof item.source === "string" ? item.source : undefined,
			startLine: start!.line as number,
			startCharacter: start!.character as number,
			endLine: end!.line as number,
			endCharacter: end!.character as number,
		});
	}
	return {
		uri,
		version: Number.isSafeInteger(version) ? (version as number) : undefined,
		diagnostics: parsed,
	};
}

/**
 * Content-Length framing. Header bytes count toward the frame bound as well as
 * the body, so a server cannot stall the reader with an unbounded header.
 */
export class LspFrameDecoder {
	private buffer = "";

	push(chunk: string): unknown[] {
		this.buffer += chunk;
		if (Buffer.byteLength(this.buffer, "utf8") > LSP_LIMITS.bufferedBytes)
			throw new LspError("resource_limit");
		const frames: unknown[] = [];
		while (true) {
			const split = this.buffer.indexOf("\r\n\r\n");
			if (split === -1) {
				if (Buffer.byteLength(this.buffer, "utf8") > LSP_LIMITS.frameBytes)
					throw new LspError("resource_limit");
				return frames;
			}
			const header = this.buffer.slice(0, split);
			const match = /content-length:\s*(\d{1,9})\r?\n?/i.exec(header);
			if (!match) throw new LspError("protocol_error");
			const length = Number(match[1]);
			if (!Number.isSafeInteger(length) || length > LSP_LIMITS.frameBytes)
				throw new LspError("resource_limit");
			const start = split + 4;
			const body = Buffer.from(this.buffer.slice(start), "utf8");
			if (body.byteLength < length) return frames;
			const frame = body.subarray(0, length).toString("utf8");
			this.buffer = body.subarray(length).toString("utf8");
			try {
				frames.push(JSON.parse(frame));
			} catch {
				throw new LspError("protocol_error");
			}
		}
	}
}

function encode(message: Record<string, unknown>): string {
	const body = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function locations(result: unknown): LspLocation[] {
	if (result === null || result === undefined) return [];
	const raw = Array.isArray(result) ? result : [result];
	if (raw.length > LSP_LIMITS.locations) throw new LspError("resource_limit");
	return raw.map((entry) => {
		const item = entry as Record<string, unknown>;
		// A LocationLink names its target separately from the originating range.
		const uri = (item.uri ?? item.targetUri) as unknown;
		const range = (item.range ??
			item.targetSelectionRange ??
			item.targetRange) as
			| { start?: { line?: unknown; character?: unknown }; end?: unknown }
			| undefined;
		const start = range?.start as
			| { line?: unknown; character?: unknown }
			| undefined;
		const end = range?.end as
			| { line?: unknown; character?: unknown }
			| undefined;
		if (
			typeof uri !== "string" ||
			!uri ||
			uri.length > 4096 ||
			!Number.isSafeInteger(start?.line) ||
			!Number.isSafeInteger(start?.character) ||
			!Number.isSafeInteger(end?.line) ||
			!Number.isSafeInteger(end?.character)
		)
			throw new LspError("protocol_error");
		return {
			uri,
			// LSP positions are zero-based; snapshot line numbers are one-based.
			startLine: (start!.line as number) + 1,
			startCharacter: start!.character as number,
			endLine: (end!.line as number) + 1,
			endCharacter: end!.character as number,
		};
	});
}

/**
 * A hover's contents, normalized to one markdown string.
 *
 * Three shapes are legal and servers in the wild still emit all of them: a
 * plain string, a `MarkedString` (or array of them, where the object form is a
 * language-tagged code block), and the modern `MarkupContent`. Anything else is
 * a protocol error rather than a guess.
 */
function hoverMarkdown(result: unknown): string | null {
	if (result === null || result === undefined) return null;
	const contents = (result as { contents?: unknown }).contents;
	if (contents === null || contents === undefined) return null;
	const parts = (Array.isArray(contents) ? contents : [contents]).map(
		(entry) => {
			if (typeof entry === "string") return entry;
			if (typeof entry !== "object" || entry === null)
				throw new LspError("protocol_error");
			const { language, value, kind } = entry as Record<string, unknown>;
			if (typeof value !== "string") throw new LspError("protocol_error");
			// MarkupContent carries `kind`; a MarkedString object carries
			// `language` and must be rendered as a fenced block to stay readable.
			if (kind !== undefined) return value;
			if (typeof language !== "string") throw new LspError("protocol_error");
			return `\`\`\`${language}\n${value}\n\`\`\``;
		},
	);
	const markdown = parts.join("\n\n").trim();
	return markdown ? boundHover(markdown) : null;
}

/** Keep a tooltip from becoming a channel for flooding the client. */
function boundHover(markdown: string): string {
	const buffer = Buffer.from(markdown, "utf8");
	if (buffer.byteLength <= LSP_LIMITS.hoverBytes) return markdown;
	// Back off to the start of a UTF-8 sequence so the cut never lands inside a
	// character, then say plainly that there was more.
	let end = LSP_LIMITS.hoverBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return `${buffer.subarray(0, end).toString("utf8").trimEnd()}\n\n…`;
}

export class LspSession {
	private readonly decoder = new LspFrameDecoder();
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
	>();
	private nextId = 1;
	private failure: unknown;
	private closed = false;
	/** Open documents, by uri, holding the caller's freshness stamp. */
	private readonly documents = new Map<string, string>();
	private readonly versions = new Map<string, number>();
	private diagnosticsListener?: (published: LspDiagnostics) => void;

	private constructor(private readonly child: ChildProcessWithoutNullStreams) {
		const fail = () => this.abort(new LspError("unavailable"));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.receive(chunk));
		child.stderr.resume();
		child.once("close", () => {
			this.closed = true;
			fail();
		});
		// A server that dies mid-request must not surface as an unhandled error
		// on any of its streams.
		child.once("error", fail);
		child.stdin.on("error", fail);
		child.stdout.on("error", fail);
		child.stderr.on("error", fail);
	}

	static async start(
		command: string,
		args: string[],
		rootUri: string,
	): Promise<LspSession> {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(command, args, {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, NO_COLOR: "1" },
			}) as ChildProcessWithoutNullStreams;
		} catch {
			throw new LspError("unavailable");
		}
		const session = new LspSession(child);
		try {
			await session.request(
				"initialize",
				{
					processId: process.pid,
					rootUri,
					// Ask for nothing that could mutate: no edits, no commands.
					capabilities: {
						textDocument: {
							definition: { linkSupport: true },
							references: {},
							hover: { contentFormat: ["markdown", "plaintext"] },
							// Full-text sync only. The server is told what a file
							// contains; it is never asked to change one.
							synchronization: { dynamicRegistration: false },
							publishDiagnostics: { relatedInformation: false },
							documentHighlight: {},
							signatureHelp: {},
							// Every one of these returns edits for the client to apply
							// or refuse. None of them lets the server act on its own.
							rename: { prepareSupport: true },
							formatting: {},
							rangeFormatting: {},
							codeAction: {
								codeActionLiteralSupport: {
									codeActionKind: { valueSet: [] },
								},
							},
						},
					},
					workspaceFolders: null,
				},
				LSP_LIMITS.startupMs,
			);
			session.notify("initialized", {});
		} catch (error) {
			await session.close();
			throw error;
		}
		return session;
	}

	async definitions(
		uri: string,
		line: number,
		character: number,
	): Promise<LspLocation[]> {
		return locations(
			await this.request("textDocument/definition", {
				textDocument: { uri },
				position: { line: line - 1, character },
			}),
		);
	}

	async references(
		uri: string,
		line: number,
		character: number,
		includeDeclaration = false,
	): Promise<LspLocation[]> {
		return locations(
			await this.request("textDocument/references", {
				textDocument: { uri },
				position: { line: line - 1, character },
				context: { includeDeclaration },
			}),
		);
	}

	/**
	 * Whether this session has already told the server about a document, and
	 * the caller-supplied stamp it was last told about.
	 *
	 * Servers of the tsserver family answer nothing about a file they have not
	 * been given, even when it sits in the project on disk, so a lookup has to
	 * open its document first. The stamp is opaque here: the caller decides
	 * what "unchanged" means (this client never touches the filesystem).
	 */
	documentStamp(uri: string): string | undefined {
		return this.documents.get(uri);
	}

	/**
	 * Observe published diagnostics. Only one listener is kept, and it is only
	 * ever called for documents this client opened.
	 */
	onDiagnostics(listener: (published: LspDiagnostics) => void): void {
		this.diagnosticsListener = listener;
	}

	/** The version last sent for a document, or undefined when not open. */
	documentVersion(uri: string): number | undefined {
		return this.versions.get(uri);
	}

	/** Tell the server a document exists and what it contains. */
	openDocument(
		uri: string,
		languageId: string,
		text: string,
		stamp: string,
		version = 1,
	): void {
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version, text },
		});
		this.documents.set(uri, stamp);
		this.versions.set(uri, version);
	}

	/** Replace an open document's contents wholesale. */
	changeDocument(
		uri: string,
		text: string,
		stamp: string,
		version = (this.versions.get(uri) ?? 1) + 1,
	): void {
		this.notify("textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
		this.documents.set(uri, stamp);
		this.versions.set(uri, version);
	}

	/** Forget a document. Safe to call for one that was never opened. */
	closeDocument(uri: string): void {
		if (!this.documents.has(uri)) return;
		this.notify("textDocument/didClose", { textDocument: { uri } });
		this.documents.delete(uri);
		this.versions.delete(uri);
	}

	/** Hover markdown for a position, or null when the server has nothing to say. */
	async hover(
		uri: string,
		line: number,
		character: number,
	): Promise<string | null> {
		return hoverMarkdown(
			await this.request("textDocument/hover", {
				textDocument: { uri },
				position: { line: line - 1, character },
			}),
		);
	}

	/** Whether a symbol at this position can be renamed at all. */
	async prepareRename(
		uri: string,
		line: number,
		character: number,
	): Promise<LspRange | null> {
		const result = await this.request("textDocument/prepareRename", {
			textDocument: { uri },
			position: { line: line - 1, character },
		});
		if (result === null || result === undefined) return null;
		const item = result as Record<string, unknown>;
		// Servers answer with a Range, {range, placeholder}, or {defaultBehavior}.
		return range(item.range ?? result) ?? null;
	}

	/** The edits a rename would make, across every file it touches. */
	async rename(
		uri: string,
		line: number,
		character: number,
		newName: string,
	): Promise<LspWorkspaceEdit | null> {
		return workspaceEdit(
			await this.request("textDocument/rename", {
				textDocument: { uri },
				position: { line: line - 1, character },
				newName,
			}),
		);
	}

	/** Edits that reformat the whole document. */
	async formatting(
		uri: string,
		tabSize: number,
		insertSpaces: boolean,
	): Promise<LspTextEdit[]> {
		return textEdits(
			await this.request("textDocument/formatting", {
				textDocument: { uri },
				options: { tabSize, insertSpaces },
			}),
		);
	}

	/** Edits that reformat one range. */
	async rangeFormatting(
		uri: string,
		span: LspRange,
		tabSize: number,
		insertSpaces: boolean,
	): Promise<LspTextEdit[]> {
		return textEdits(
			await this.request("textDocument/rangeFormatting", {
				textDocument: { uri },
				range: {
					start: { line: span.startLine, character: span.startCharacter },
					end: { line: span.endLine, character: span.endCharacter },
				},
				options: { tabSize, insertSpaces },
			}),
		);
	}

	/** Actions offered for a range, with their edits already normalized. */
	async codeActions(uri: string, span: LspRange): Promise<LspCodeAction[]> {
		const result = await this.request("textDocument/codeAction", {
			textDocument: { uri },
			range: {
				start: { line: span.startLine, character: span.startCharacter },
				end: { line: span.endLine, character: span.endCharacter },
			},
			context: { diagnostics: [] },
		});
		if (!Array.isArray(result)) return [];
		const actions: LspCodeAction[] = [];
		for (const entry of result.slice(0, LSP_LIMITS.codeActions)) {
			const item = entry as Record<string, unknown>;
			if (typeof item?.title !== "string") continue;
			const edit = workspaceEdit(item.edit);
			actions.push({
				title: item.title.slice(0, 200),
				kind: typeof item.kind === "string" ? item.kind : undefined,
				edit: edit ?? undefined,
				commandOnly: edit === null,
			});
		}
		return actions;
	}

	/** Signatures for the call being typed, or an empty list. */
	async signatureHelp(
		uri: string,
		line: number,
		character: number,
	): Promise<LspSignature[]> {
		const result = await this.request("textDocument/signatureHelp", {
			textDocument: { uri },
			position: { line: line - 1, character },
		});
		const signatures = (result as { signatures?: unknown } | null)?.signatures;
		if (!Array.isArray(signatures)) return [];
		const active = (result as { activeParameter?: unknown }).activeParameter;
		return signatures.slice(0, 16).flatMap((entry) => {
			const item = entry as Record<string, unknown>;
			if (typeof item?.label !== "string") return [];
			const documentation =
				typeof item.documentation === "string"
					? item.documentation
					: typeof (item.documentation as { value?: unknown })?.value ===
							"string"
						? ((item.documentation as { value: string }).value as string)
						: undefined;
			return [
				{
					label: item.label.slice(0, 1024),
					documentation: documentation?.slice(0, LSP_LIMITS.hoverBytes),
					activeParameter: Number.isSafeInteger(active)
						? (active as number)
						: undefined,
				},
			];
		});
	}

	/** Other occurrences of the symbol at a position, within this document. */
	async documentHighlights(
		uri: string,
		line: number,
		character: number,
	): Promise<LspRange[]> {
		const result = await this.request("textDocument/documentHighlight", {
			textDocument: { uri },
			position: { line: line - 1, character },
		});
		if (!Array.isArray(result)) return [];
		return result.slice(0, LSP_LIMITS.locations).flatMap((entry) => {
			const span = range((entry as { range?: unknown })?.range);
			return span ? [span] : [];
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.abort(new LspError("unavailable"));
		this.child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			if (this.child.exitCode !== null || this.child.signalCode !== null)
				return resolve();
			this.child.once("close", () => resolve());
		});
	}

	private request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs: number = LSP_LIMITS.requestMs,
	): Promise<unknown> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.closed) return Promise.reject(new LspError("unavailable"));
		if (this.pending.size >= LSP_LIMITS.pendingRequests)
			return Promise.reject(new LspError("resource_limit"));
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new LspError("timeout"));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.write(encode({ jsonrpc: "2.0", id, method, params }));
		});
	}

	private notify(method: string, params: Record<string, unknown>): void {
		if (this.closed) return;
		this.write(encode({ jsonrpc: "2.0", method, params }));
	}

	/** A write to a dead server is a failure of this session, never a crash. */
	private write(frame: string): void {
		try {
			this.child.stdin.write(frame);
		} catch {
			this.abort(new LspError("unavailable"));
		}
	}

	private receive(chunk: string): void {
		let frames: unknown[];
		try {
			frames = this.decoder.push(chunk);
		} catch (error) {
			return this.abort(error);
		}
		for (const frame of frames) {
			const message = frame as Record<string, unknown>;
			if (message?.jsonrpc !== "2.0") return this.abort(new LspError("protocol_error"));
			if (typeof message.method === "string") {
				// The server may not ask us to do anything; requests get a refusal.
				if (message.id !== undefined) {
					this.write(
						encode({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32601, message: "Method not found" },
						}),
					);
					continue;
				}
				// Exactly one notification is listened to, and only for a document
				// this client opened. Everything else the server says is dropped.
				if (
					message.method === "textDocument/publishDiagnostics" &&
					this.diagnosticsListener
				) {
					const parsed = parseDiagnostics(message.params);
					if (parsed && this.documents.has(parsed.uri))
						this.diagnosticsListener(parsed);
				}
				continue;
			}
			const slot = this.pending.get(message.id as number);
			if (!slot) return this.abort(new LspError("protocol_error"));
			this.pending.delete(message.id as number);
			if (message.error !== undefined) slot.reject(new LspError("protocol_error"));
			else slot.resolve(message.result);
		}
	}

	private abort(error: unknown): void {
		this.failure ??= error;
		for (const [id, slot] of this.pending) {
			this.pending.delete(id);
			slot.reject(error);
		}
	}
}
