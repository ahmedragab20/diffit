import { spawn } from "node:child_process";
import { z } from "zod";
import { AiRunError } from "./lifecycle.js";

export const CATALOG_LIMITS = Object.freeze({
	bytes: 4 * 1024 * 1024,
	frameBytes: 1024 * 1024,
	models: 1000,
	pages: 20,
});
const modelId = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[a-z0-9][a-z0-9._:/\-[\]]*$/i);
const option = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-z0-9][a-z0-9._-]*$/i);
const directModels = z
	.array(
		z.object({
			id: modelId,
			input_modalities: z.array(z.string().max(64)).max(32).optional(),
		}),
	)
	.max(CATALOG_LIMITS.models);
const codexModels = z
	.array(
		z
			.object({
				model: modelId.optional(),
				id: modelId.optional(),
				displayName: z.string().min(1).max(512).optional(),
				description: z.string().max(4096).optional(),
				isDefault: z.boolean().optional(),
				supportedReasoningEfforts: z
					.array(z.union([option, z.object({ reasoningEffort: option })]))
					.max(32)
					.optional(),
				serviceTiers: z
					.array(z.union([option, z.object({ id: option })]))
					.max(32)
					.optional(),
				inputModalities: z.array(z.string().max(64)).max(32).optional(),
			})
			.refine((model) => model.model !== undefined || model.id !== undefined),
	)
	.max(100);

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AiRunError("protocol_error");
	return value as Record<string, unknown>;
}
export function parseDirectCatalog(value: unknown) {
	const payload = object(value);
	const parsed = directModels.safeParse(payload.data ?? payload.models);
	if (!parsed.success) throw new AiRunError("protocol_error");
	const ids = new Set<string>();
	for (const model of parsed.data) {
		if (ids.has(model.id)) throw new AiRunError("protocol_error");
		ids.add(model.id);
	}
	return parsed.data;
}

/** Reads actual bytes, not Content-Length; no provider body reaches diagnostics. */
export async function readCatalogResponse(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new AiRunError("protocol_error");
	let complete = false;
	let rejectAbort!: (error: Error) => void;
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const abort = () => rejectAbort(new AiRunError("preparation_timeout"));
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (signal.aborted) throw new AiRunError("preparation_timeout");
		let bytes = 0;
		let text = "";
		const decoder = new TextDecoder("utf-8", { fatal: true });
		while (true) {
			const { done, value } = await Promise.race([reader.read(), aborted]);
			if (done) break;
			bytes += value.byteLength;
			if (bytes > CATALOG_LIMITS.bytes) throw new AiRunError("resource_limit");
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		const result: unknown = JSON.parse(text);
		complete = true;
		return result;
	} catch (error) {
		throw error instanceof AiRunError ? error : new AiRunError("protocol_error");
	} finally {
		signal.removeEventListener("abort", abort);
		if (!complete) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function parseModelLines(output: string): string[] {
	if (Buffer.byteLength(output, "utf8") > CATALOG_LIMITS.bytes)
		throw new AiRunError("resource_limit");
	const ids = new Set<string>();
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line || /^(available models|models:|[-=]{2,})/i.test(line)) continue;
		const match = line.match(
			/^[*✓>]?\s*([a-z0-9][a-z0-9._:/\-[\]]{0,511})(?:\s+-\s+[^\r\n]{1,1024})?$/i,
		);
		if (!match) throw new AiRunError("protocol_error");
		ids.add(match[1]);
		if (ids.size > CATALOG_LIMITS.models) throw new AiRunError("resource_limit");
	}
	return [...ids];
}

export interface CatalogModel {
	id: string;
	displayName: string;
	description?: string;
	isDefault?: boolean;
	reasoningEfforts?: string[];
	serviceTiers?: string[];
	supportsImages: boolean;
}

/** Strict response correlation; no server request can grant tool authority. */
export class CodexCatalogDecoder {
	private expected = 1;
	private pages = 0;
	private readonly cursors = new Set<string>();
	private readonly ids = new Set<string>();
	private readonly models: CatalogModel[] = [];
	done = false;

	start() {
		return {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				clientInfo: { name: "diffing", title: "diffing", version: "0.18" },
				capabilities: { experimentalApi: true, requestAttestation: false },
			},
		};
	}
	accept(value: unknown): Record<string, unknown>[] {
		if (this.done) throw new AiRunError("protocol_error");
		const message = object(value);
		if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0")
			throw new AiRunError("protocol_error");
		if (typeof message.method === "string") {
			if (message.id !== undefined) throw new AiRunError("unsupported_capability");
			return [];
		}
		if (message.id !== this.expected) throw new AiRunError("protocol_error");
		if (message.error !== undefined)
			throw new AiRunError("capability_unavailable");
		const result = object(message.result);
		if (this.expected === 1) {
			this.expected = 2;
			return [
				{ jsonrpc: "2.0", method: "initialized", params: {} },
				this.page(null),
			];
		}
		if (++this.pages > CATALOG_LIMITS.pages)
			throw new AiRunError("resource_limit");
		const parsed = codexModels.safeParse(result.data);
		if (!parsed.success) throw new AiRunError("protocol_error");
		for (const model of parsed.data) {
			const id = model.model ?? model.id!;
			if (this.ids.has(id)) throw new AiRunError("protocol_error");
			this.ids.add(id);
			if (this.ids.size > CATALOG_LIMITS.models)
				throw new AiRunError("resource_limit");
			this.models.push({
				id,
				displayName: model.displayName ?? id,
				description: model.description,
				isDefault: model.isDefault,
				reasoningEfforts: model.supportedReasoningEfforts?.map((entry) =>
					typeof entry === "string" ? entry : entry.reasoningEffort,
				),
				serviceTiers: model.serviceTiers?.map((entry) =>
					typeof entry === "string" ? entry : entry.id,
				),
				supportsImages: model.inputModalities?.includes("image") === true,
			});
		}
		const cursor = result.nextCursor;
		if (cursor === undefined || cursor === null) {
			this.done = true;
			return [];
		}
		if (
			typeof cursor !== "string" ||
			!cursor ||
			cursor.length > 1024 ||
			this.cursors.has(cursor)
		)
			throw new AiRunError("protocol_error");
		if (this.pages >= CATALOG_LIMITS.pages)
			throw new AiRunError("resource_limit");
		this.cursors.add(cursor);
		this.expected++;
		return [this.page(cursor)];
	}
	finish(): CatalogModel[] {
		if (!this.done) throw new AiRunError("protocol_error");
		return this.models;
	}
	private page(cursor: string | null) {
		return {
			jsonrpc: "2.0",
			id: this.expected,
			method: "model/list",
			params: { cursor, limit: 100, includeHidden: false },
		};
	}
}

/** Test seam accepts an offline child; production always uses codex app-server. */
export async function runCodexCatalog(
	bin = "codex",
	args = ["app-server", "--stdio"],
	timeoutMs = 12000,
): Promise<CatalogModel[]> {
	const child = spawn(bin, args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1" },
	});
	const decoder = new CodexCatalogDecoder();
	let closed = false;
	let terminationRequested = false;
	let failure: unknown;
	const closure = new Promise<number | null>((resolve) =>
		child.once("close", (code) => {
			closed = true;
			resolve(code);
		}),
	);
	const terminate = () => {
		if (!closed && !terminationRequested)
			terminationRequested = child.kill("SIGTERM");
	};
	const stop = (error: unknown) => {
		failure ??= error;
		terminate();
		child.stdout.destroy();
	};
	const ioError = () => stop(new AiRunError("capability_unavailable"));
	child.on("error", ioError);
	child.stdin.on("error", ioError);
	child.stderr.on("error", ioError);
	let stderrBytes = 0;
	const discard = (chunk: Buffer) => {
		stderrBytes += chunk.length;
		if (stderrBytes > 64 * 1024) stop(new AiRunError("resource_limit"));
	};
	child.stderr.on("data", discard);
	const timeout = setTimeout(
		() => stop(new AiRunError("preparation_timeout")),
		timeoutMs,
	);
	const send = (message: Record<string, unknown>) =>
		child.stdin.write(`${JSON.stringify(message)}\n`);
	let bytes = 0;
	let frames = 0;
	let buffer = "";
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	try {
		send(decoder.start());
		for await (const chunk of child.stdout) {
			if (failure) throw failure;
			bytes += Buffer.byteLength(chunk);
			if (bytes > CATALOG_LIMITS.bytes) throw new AiRunError("resource_limit");
			buffer += utf8.decode(chunk, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (++frames > 1000 || Buffer.byteLength(line) > CATALOG_LIMITS.frameBytes)
					throw new AiRunError("resource_limit");
				if (!line.trim()) continue;
				for (const request of decoder.accept(JSON.parse(line))) send(request);
			}
			if (Buffer.byteLength(buffer) > CATALOG_LIMITS.frameBytes)
				throw new AiRunError("resource_limit");
			if (decoder.done) break;
		}
		buffer += utf8.decode();
		if (buffer.trim()) throw new AiRunError("protocol_error");
		decoder.finish();
	} catch (error) {
		failure ??=
			error instanceof AiRunError ? error : new AiRunError("protocol_error");
	} finally {
		terminate();
		const code = await closure;
		if (code !== null && code !== 0)
			failure ??= new AiRunError("capability_unavailable");
		clearTimeout(timeout);
		child.removeListener("error", ioError);
		child.stdin.removeListener("error", ioError);
		child.stderr.removeListener("error", ioError);
		child.stderr.removeListener("data", discard);
	}
	if (failure) throw failure;
	return decoder.finish();
}

let catalogFlight: Promise<CatalogModel[]> | undefined;
export function codexModelCatalog(): Promise<CatalogModel[]> {
	// Retain the slot until owned process cleanup finishes, even after timeout.
	return (catalogFlight ??= runCodexCatalog().finally(() => {
		catalogFlight = undefined;
	}));
}
