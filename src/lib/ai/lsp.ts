/**
 * Bounded LSP client for definition and reference lookups.
 *
 * A language server is discovered on PATH, exactly like the provider runtimes:
 * when it is absent the feature reports itself unavailable rather than
 * pretending. The client is deliberately small and defensive — it speaks only
 * the three requests it needs, correlates every response by id, bounds frames,
 * bytes and time, and never grants the server authority: a server-initiated
 * request is answered with "method not found" and its notifications are
 * dropped. No workspace edit, command or file write is ever accepted.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "./child-process.js";

export const LSP_LIMITS = Object.freeze({
	frameBytes: 4 * 1024 * 1024,
	totalBytes: 16 * 1024 * 1024,
	pendingRequests: 32,
	locations: 500,
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

/**
 * Content-Length framing. Header bytes count toward the frame bound as well as
 * the body, so a server cannot stall the reader with an unbounded header.
 */
export class LspFrameDecoder {
	private buffer = "";
	private total = 0;

	push(chunk: string): unknown[] {
		this.total += Buffer.byteLength(chunk, "utf8");
		if (this.total > LSP_LIMITS.totalBytes)
			throw new LspError("resource_limit");
		this.buffer += chunk;
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

export class LspSession {
	private readonly decoder = new LspFrameDecoder();
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
	>();
	private nextId = 1;
	private failure: unknown;
	private closed = false;

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
				if (message.id !== undefined)
					this.write(
						encode({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32601, message: "Method not found" },
						}),
					);
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
