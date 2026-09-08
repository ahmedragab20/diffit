import { spawn } from "./child-process.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	AiBackendAdapter,
	AiConnection,
	AiCredentialRoute,
	AiModel,
	AiRunEvent,
	AiRunRequest,
	AiSourceId,
} from "./types.js";
import type { SecretStore } from "./secrets.js";
import { consumeProviderText } from "./provider-stream.js";
import { RuntimeTextDecoder } from "./runtime-protocol.js";
import {
	codexModelCatalog,
	parseModelLines,
	parseDirectCatalog,
	readCatalogResponse,
} from "./catalog.js";
import { AiRunError, DEFAULT_AI_RUN_POLICY } from "./lifecycle.js";
import {
	providerCapabilities,
	validateProviderOptions,
} from "./capabilities.js";

const execFileAsync = promisify(execFile);

interface RuntimeSpec {
	id: Extract<AiSourceId, "codex" | "claude" | "opencode" | "cursor">;
	label: string;
	bin: string;
	versionArgs: string[];
	statusArgs: string[];
	disconnectArgs?: string[];
	modelArgs?: string[];
	fallbackModels?: Array<{ id: string; label: string }>;
	routes: AiCredentialRoute[];
	setup: Partial<Record<AiCredentialRoute, string>>;
	args(modelId: string): string[];
	promptAsArgument?: boolean;
}

async function commandAvailable(bin: string, args: string[]): Promise<boolean> {
	try {
		await execFileAsync(bin, args, { timeout: 5000, maxBuffer: 64 * 1024 });
		return true;
	} catch {
		return false;
	}
}

function modelName(id: string): string {
	return id
		.split(/[/_-]/g)
		.filter(Boolean)
		.map((part) =>
			/^gpt$/i.test(part) ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1),
		)
		.join(" ");
}

async function runCommand(
	source: RuntimeSpec["id"],
	bin: string,
	args: string[],
	prompt: string,
	signal: AbortSignal,
	onEvent: (event: AiRunEvent) => void | Promise<void>,
	promptAsArgument = false,
): Promise<string> {
	signal.throwIfAborted();
	const decoder = new RuntimeTextDecoder(source);
	const child = spawn(bin, promptAsArgument ? [...args, prompt] : args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1", CI: "1" },
	});
	let failure: unknown;
	let closed = false;
	const stop = (error: unknown) => {
		failure ??= error;
		if (!closed) child.kill("SIGTERM");
		child.stdout.destroy();
	};
	const abort = () => stop(signal.reason);
	const ioError = () => stop(new AiRunError("provider_failed"));
	const closure = new Promise<number | null>((resolve) => {
		child.once("close", (code) => {
			closed = true;
			resolve(code);
		});
	});
	child.on("error", ioError);
	child.stdin.on("error", ioError);
	child.stderr.on("error", ioError);
	child.stderr.resume(); // Drain, but never retain or expose provider stderr.
	signal.addEventListener("abort", abort, { once: true });
	let buffer = "";
	let bytes = 0;
	let frames = 0;
	const consumeLine = async (line: string) => {
		signal.throwIfAborted();
		if (
			++frames > DEFAULT_AI_RUN_POLICY.maxEvents ||
			Buffer.byteLength(line, "utf8") > DEFAULT_AI_RUN_POLICY.maxEventBytes
		)
			throw new AiRunError("resource_limit");
		if (!line.trim()) return;
		let parsed: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error();
			parsed = value as Record<string, unknown>;
		} catch {
			throw new AiRunError("protocol_error");
		}
		const delta = decoder.push(parsed);
		if (!delta) return;
		// Await delivery before pulling more stdout; the pipe provides backpressure.
		try {
			await onEvent({ type: "text-delta", text: delta });
		} catch {
			throw new AiRunError("delivery_failed");
		}
	};
	try {
		if (signal.aborted) abort();
		signal.throwIfAborted();
		child.stdout.setEncoding("utf8");
		child.stdin.end(promptAsArgument ? undefined : prompt);
		for await (const chunk of child.stdout) {
			bytes += Buffer.byteLength(chunk as string, "utf8");
			if (bytes > 16 * 1024 * 1024) throw new AiRunError("resource_limit");
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				await consumeLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
			if (Buffer.byteLength(buffer, "utf8") > DEFAULT_AI_RUN_POLICY.maxEventBytes)
				throw new AiRunError("resource_limit");
		}
		if (buffer) await consumeLine(buffer);
		const code = await closure;
		signal.throwIfAborted();
		if (failure) throw failure;
		if (code !== 0) throw new AiRunError("provider_failed");
		return decoder.finish();
	} catch (error) {
		stop(error);
		// SIGTERM is only a request. Do not release ownership until close confirms it.
		await closure;
		throw failure;
	} finally {
		signal.removeEventListener("abort", abort);
		child.removeListener("error", ioError);
		child.stdin.removeListener("error", ioError);
		child.stderr.removeListener("error", ioError);
	}
}

export class RuntimeAdapter implements AiBackendAdapter {
	readonly id: RuntimeSpec["id"];
	readonly supportsImages: boolean = false;
	private runtimeVersion: string | null = null;
	constructor(private readonly spec: RuntimeSpec) {
		this.id = spec.id;
	}

	get capabilities() {
		return {
			...providerCapabilities(this.id),
			runtimeVersion: this.runtimeVersion,
		};
	}

	async connection(): Promise<AiConnection> {
		let available = false;
		this.runtimeVersion = null;
		try {
			const { stdout } = await execFileAsync(
				this.spec.bin,
				this.spec.versionArgs,
				{
					timeout: 5000,
					maxBuffer: 64 * 1024,
				},
			);
			available = true;
			// Retain only a bounded version token, never raw runtime diagnostics.
			this.runtimeVersion =
				stdout.match(
					/(?:^|\s)(\d{1,8}\.\d{1,8}\.\d{1,8}(?:[-+][\w.-]{1,64})?)(?=\s|$)/,
				)?.[1] ?? null;
		} catch {
			// An executable's error output is not a successful discovery result.
		}
		if (!available) {
			return {
				id: this.id,
				label: this.spec.label,
				status: "missing-runtime",
				runtimeAvailable: false,
				credentialRoutes: this.spec.routes,
				activeRoutes: [],
				authentication: { evidence: "none", verified: false, configuredRoutes: [] },
				setupCommand:
					this.spec.setup.subscription ?? this.spec.setup["runtime-key"],
			};
		}
		const connected = await commandAvailable(this.spec.bin, this.spec.statusArgs);
		return {
			id: this.id,
			label: this.spec.label,
			status: connected ? "connected" : "needs-configuration",
			runtimeAvailable: true,
			credentialRoutes: this.spec.routes,
			activeRoutes: [],
			authentication: {
				evidence: connected ? "runtime-status" : "none",
				verified: false,
				configuredRoutes: [],
			},
			detail: connected
				? "Runtime status command succeeded; authentication and credential route are unverified."
				: undefined,
			setupCommand: connected
				? undefined
				: (this.spec.setup.subscription ?? this.spec.setup["runtime-key"]),
		};
	}

	async models(): Promise<AiModel[]> {
		const connection = await this.connection();
		if (connection.status !== "connected") return [];
		let entries = this.spec.fallbackModels ?? [];
		let catalogSource: "runtime" | "fallback" = "fallback";
		if (this.spec.modelArgs) {
			try {
				const { stdout } = await execFileAsync(this.spec.bin, this.spec.modelArgs, {
					timeout: 15000,
					maxBuffer: 4 * 1024 * 1024,
				});
				const parsed = parseModelLines(stdout);
				if (parsed.length) {
					entries = parsed.map((id) => ({ id, label: modelName(id) }));
					catalogSource = "runtime";
				}
			} catch {
				// Preserve the runtime's safe aliases when catalog discovery is unavailable.
			}
		}
		const route =
			this.id === "opencode" || this.id === "cursor"
				? "runtime-key"
				: "subscription";
		return entries.map((entry, index) => ({
			id: `${this.id}/${route}/${this.id}/${entry.id}`,
			sourceId: this.id,
			credentialRoute: route,
			providerId: this.id,
			modelId: entry.id,
			displayName: entry.label,
			isDefault: index === 0,
			supportsImages: false,
			catalogSource,
			capabilities: this.capabilities,
		}));
	}

	setupCommand(route: AiCredentialRoute, providerId?: string): string | null {
		const command = this.spec.setup[route];
		if (!command) return null;
		return providerId
			? command.replace("{provider}", providerId)
			: command.replace(" {provider}", "");
	}

	async disconnect(): Promise<void> {
		if (!this.spec.disconnectArgs)
			throw new Error(`${this.spec.label} manages logout in its native client.`);
		await execFileAsync(this.spec.bin, this.spec.disconnectArgs, {
			timeout: 15000,
		});
	}

	async run(
		request: AiRunRequest,
		signal: AbortSignal,
		onEvent: (event: AiRunEvent) => void | Promise<void>,
	): Promise<string> {
		const model =
			request.modelId.split("/").slice(3).join("/") ||
			request.modelId.split("/").at(-1) ||
			"";
		await validateProviderOptions(this, request, signal);
		return runCommand(
			this.id,
			this.spec.bin,
			this.spec.args(model),
			request.prompt ?? "",
			signal,
			onEvent,
			this.spec.promptAsArgument,
		);
	}
}

async function runCodexAppServer(
	model: string,
	prompt: string,
	images: AiRunRequest["resolvedImages"],
	effort: string | undefined,
	serviceTier: string | undefined,
	signal: AbortSignal,
	onEvent: (event: AiRunEvent) => void | Promise<void>,
): Promise<string> {
	signal.throwIfAborted();
	const child = spawn("codex", ["app-server", "--stdio"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1" },
	});
	let failure: unknown;
	let closed = false;
	let terminationRequested = false;
	let completed = false;
	let expectedResponse = 1;
	let threadId = "";
	let turnId = "";
	let output = "";
	let outputBytes = 0;
	let streamBytes = 0;
	let sentBytes = 0;
	let frames = 0;
	let buffer = "";
	const closure = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) => {
		child.once("close", (code, exitSignal) => {
			closed = true;
			resolve({ code, signal: exitSignal });
		});
	});
	const terminate = () => {
		if (!closed && !terminationRequested)
			terminationRequested = child.kill("SIGTERM");
	};
	const stop = (error: unknown) => {
		failure ??= error;
		terminate();
		child.stdout.destroy();
	};
	const abort = () => stop(signal.reason);
	const ioError = () => stop(new AiRunError("provider_failed"));
	const timeout = setTimeout(
		() => stop(new AiRunError("total_timeout")),
		DEFAULT_AI_RUN_POLICY.totalMs,
	);
	child.on("error", ioError);
	child.stdin.on("error", ioError);
	child.stderr.on("error", ioError);
	child.stderr.resume();
	signal.addEventListener("abort", abort, { once: true });
	const check = () => {
		signal.throwIfAborted();
		if (failure) throw failure;
	};
	const record = (value: unknown): Record<string, unknown> | undefined =>
		value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const send = (
		id: number | undefined,
		method: string,
		params: Record<string, unknown>,
	) => {
		check();
		const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		sentBytes += Buffer.byteLength(line, "utf8");
		if (sentBytes > 16 * 1024 * 1024) throw new AiRunError("resource_limit");
		child.stdin.write(line);
	};
	const bindTurn = (value: unknown) => {
		const turn = record(value);
		if (
			!turn ||
			typeof turn.id !== "string" ||
			!turn.id ||
			turn.id.length > 512 ||
			(turnId && turnId !== turn.id)
		)
			throw new AiRunError("protocol_error");
		if (
			turn.status === "failed" ||
			turn.status === "interrupted" ||
			turn.error != null
		)
			throw new AiRunError("provider_failed");
		turnId = turn.id;
		return turn;
	};
	const consumeLine = async (line: string) => {
		check();
		if (
			++frames > DEFAULT_AI_RUN_POLICY.maxEvents ||
			Buffer.byteLength(line, "utf8") > DEFAULT_AI_RUN_POLICY.maxEventBytes
		)
			throw new AiRunError("resource_limit");
		if (!line.trim()) return;
		let message: Record<string, unknown> | undefined;
		try {
			message = record(JSON.parse(line));
		} catch {
			throw new AiRunError("protocol_error");
		}
		if (!message || (message.jsonrpc !== undefined && message.jsonrpc !== "2.0"))
			throw new AiRunError("protocol_error");
		if ("id" in message) {
			// Server-initiated approval/tool requests are not delegated authority.
			if (message.method !== undefined || message.id !== expectedResponse)
				throw new AiRunError("protocol_error");
			if (message.error != null) throw new AiRunError("provider_failed");
			const result = record(message.result);
			if (!result) throw new AiRunError("protocol_error");
			if (expectedResponse === 1) {
				expectedResponse = 2;
				send(undefined, "initialized", {});
				send(2, "thread/start", {
					model,
					cwd: process.cwd(),
					approvalPolicy: "never",
					sandbox: "read-only",
					ephemeral: true,
					dynamicTools: [],
					environments: [],
				});
			} else if (expectedResponse === 2) {
				const thread = record(result.thread);
				if (
					!thread ||
					typeof thread.id !== "string" ||
					!thread.id ||
					thread.id.length > 512
				)
					throw new AiRunError("protocol_error");
				threadId = thread.id;
				expectedResponse = 3;
				send(3, "turn/start", {
					threadId,
					input: [
						{ type: "text", text: prompt, text_elements: [] },
						...(images ?? []).map((image) => ({ type: "image", url: image.dataUrl })),
					],
					model,
					effort: effort || undefined,
					serviceTier: serviceTier || undefined,
					approvalPolicy: "never",
					environments: [],
				});
			} else if (expectedResponse === 3) {
				bindTurn(result.turn);
				expectedResponse = 0;
			} else throw new AiRunError("protocol_error");
			return;
		}
		if (typeof message.method !== "string")
			throw new AiRunError("protocol_error");
		if (message.method === "error") throw new AiRunError("provider_failed");
		if (
			!["turn/started", "item/agentMessage/delta", "turn/completed"].includes(
				message.method,
			)
		)
			return;
		const params = record(message.params);
		if (!threadId || !params || params.threadId !== threadId)
			throw new AiRunError("protocol_error");
		if (message.method === "turn/started") {
			// Notifications may precede the response to turn/start.
			bindTurn(params.turn);
			return;
		}
		if (!turnId) throw new AiRunError("protocol_error");
		if (message.method === "item/agentMessage/delta") {
			if (params.turnId !== turnId || typeof params.delta !== "string")
				throw new AiRunError("protocol_error");
			outputBytes += Buffer.byteLength(params.delta, "utf8");
			if (outputBytes > DEFAULT_AI_RUN_POLICY.maxOutputBytes)
				throw new AiRunError("resource_limit");
			if (params.delta) {
				output += params.delta;
				// Pull one frame at a time: downstream delivery applies stdout backpressure.
				try {
					await onEvent({ type: "text-delta", text: params.delta });
				} catch {
					throw new AiRunError("delivery_failed");
				}
				check();
			}
			return;
		}
		const turn = bindTurn(params.turn);
		if (turn.status !== "completed") throw new AiRunError("protocol_error");
		if (!output.trim()) throw new AiRunError("empty_output");
		completed = true;
		terminate();
	};
	try {
		if (signal.aborted) abort();
		check();
		child.stdout.setEncoding("utf8");
		send(1, "initialize", {
			clientInfo: { name: "diffing", title: "diffing", version: "0.18" },
			capabilities: { experimentalApi: true, requestAttestation: false },
		});
		for await (const chunk of child.stdout) {
			streamBytes += Buffer.byteLength(chunk as string, "utf8");
			if (streamBytes > 16 * 1024 * 1024) throw new AiRunError("resource_limit");
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0 && !completed) {
				await consumeLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
			if (completed) break;
			if (Buffer.byteLength(buffer, "utf8") > DEFAULT_AI_RUN_POLICY.maxEventBytes)
				throw new AiRunError("resource_limit");
		}
		if (!completed && buffer) await consumeLine(buffer);
		if (!completed) throw new AiRunError("protocol_error");
		const exit = await closure;
		check();
		if (
			exit.code !== 0 &&
			!(terminationRequested && exit.code === null && exit.signal === "SIGTERM")
		)
			throw new AiRunError("provider_failed");
		return output;
	} catch (error) {
		stop(error);
		await closure;
		throw failure;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
		child.removeListener("error", ioError);
		child.stdin.removeListener("error", ioError);
		child.stderr.removeListener("error", ioError);
	}
}

class CodexAdapter extends RuntimeAdapter {
	override readonly supportsImages = true;
	async models(): Promise<AiModel[]> {
		try {
			const catalog = await codexModelCatalog();
			if (!catalog.length) return super.models();
			return catalog.map((model) => ({
				id: `codex/subscription/codex/${model.id}`,
				sourceId: "codex",
				credentialRoute: "subscription",
				providerId: "codex",
				modelId: model.id,
				displayName: model.displayName,
				description: model.description,
				isDefault: model.isDefault,
				reasoningEfforts: model.reasoningEfforts,
				serviceTiers: model.serviceTiers,
				supportsImages: model.supportsImages === true,
				catalogSource: "runtime",
				capabilities: this.capabilities,
			}));
		} catch {
			return super.models();
		}
	}

	async run(
		request: AiRunRequest,
		signal: AbortSignal,
		onEvent: (event: AiRunEvent) => void | Promise<void>,
	): Promise<string> {
		const model =
			request.modelId.split("/").slice(3).join("/") ||
			request.modelId.split("/").at(-1) ||
			"";
		await validateProviderOptions(this, request, signal);
		return runCodexAppServer(
			model,
			request.prompt ?? "",
			request.resolvedImages,
			request.reasoningEffort,
			request.serviceTier,
			signal,
			onEvent,
		);
	}
}

interface DirectSpec {
	id: Extract<AiSourceId, "openai" | "anthropic" | "xai">;
	label: string;
	baseUrl: string;
	envKey: string;
}

export class DirectProviderAdapter implements AiBackendAdapter {
	readonly id: DirectSpec["id"];
	readonly supportsImages = true;
	constructor(
		private readonly spec: DirectSpec,
		private readonly secrets: SecretStore,
		private readonly fetchImpl: typeof fetch = fetch,
	) {
		this.id = spec.id;
	}

	get capabilities() {
		return providerCapabilities(this.id);
	}

	private async key(): Promise<string | null> {
		return process.env[this.spec.envKey] ?? (await this.secrets.get(this.id));
	}

	async connection(): Promise<AiConnection> {
		const key = await this.key();
		return {
			id: this.id,
			label: this.spec.label,
			status: key ? "connected" : "disconnected",
			runtimeAvailable: true,
			credentialRoutes: ["direct-key"],
			activeRoutes: [],
			authentication: {
				evidence: key ? "key-configured" : "none",
				verified: false,
				configuredRoutes: key ? ["direct-key"] : [],
			},
			detail: key
				? "Key configured; authentication has not been verified."
				: undefined,
		};
	}

	async connectKey(key: string, remember: boolean): Promise<void> {
		if (!key.trim()) throw new Error("API key is required.");
		await this.secrets.set(this.id, key.trim(), remember);
	}

	async disconnect(): Promise<void> {
		await this.secrets.delete(this.id);
	}

	private headers(key: string): Record<string, string> {
		if (this.id === "anthropic")
			return {
				"x-api-key": key,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			};
		return { authorization: `Bearer ${key}`, "content-type": "application/json" };
	}

	async models(): Promise<AiModel[]> {
		const key = await this.key();
		if (!key) return [];
		const path = this.id === "xai" ? "/v1/language-models" : "/v1/models";
		const signal = AbortSignal.timeout(10000);
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.spec.baseUrl}${path}`, {
				headers: this.headers(key),
				signal,
				redirect: "error",
			});
		} catch {
			throw new AiRunError("capability_unavailable");
		}
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			throw new AiRunError(
				response.status === 401 || response.status === 403
					? "authentication_failed"
					: "capability_unavailable",
			);
		}
		const data = parseDirectCatalog(await readCatalogResponse(response, signal));
		return data
			.filter((model) => typeof model.id === "string")
			.filter(
				(model) =>
					this.id !== "openai" ||
					!/(embedding|image|audio|realtime|transcrib|tts|moderation|sora)/i.test(
						model.id,
					),
			)
			.map((model, index) => ({
				id: `${this.id}/direct-key/${this.id}/${model.id}`,
				sourceId: this.id,
				credentialRoute: "direct-key" as const,
				providerId: this.id,
				modelId: model.id,
				displayName: modelName(model.id),
				isDefault: index === 0,
				supportsImages:
					Array.isArray(model.input_modalities) &&
					model.input_modalities.includes("image"),
				catalogSource: "provider",
				capabilities: this.capabilities,
			}));
	}

	async run(
		request: AiRunRequest,
		signal: AbortSignal,
		onEvent: (event: AiRunEvent) => void | Promise<void>,
	): Promise<string> {
		signal.throwIfAborted();
		await validateProviderOptions(this, request, signal);
		signal.throwIfAborted();
		const key = await this.key();
		signal.throwIfAborted();
		if (!key) throw new AiRunError("authentication_failed");
		const model = request.modelId.split("/").slice(3).join("/");
		const url =
			this.id === "anthropic"
				? `${this.spec.baseUrl}/v1/messages`
				: `${this.spec.baseUrl}/v1/responses`;
		const images = request.resolvedImages ?? [];
		const body =
			this.id === "anthropic"
				? {
						model,
						max_tokens: 4096,
						stream: true,
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: request.prompt },
									...images.map((image) => ({
										type: "image",
										source: {
											type: "base64",
											media_type: image.mimeType,
											data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
										},
									})),
								],
							},
						],
					}
				: {
						model,
						input: [
							{
								role: "user",
								content: [
									{ type: "input_text", text: request.prompt },
									...images.map((image) => ({
										type: "input_image",
										image_url: image.dataUrl,
										detail: "auto",
									})),
								],
							},
						],
						store: false,
						stream: true,
					};
		const response = await this.fetchImpl(url, {
			method: "POST",
			headers: this.headers(key),
			body: JSON.stringify(body),
			signal,
		});
		if (!response.ok) {
			// Error bodies may be unbounded or contain echoed credentials and prompts.
			await response.body?.cancel().catch(() => {});
			signal.throwIfAborted();
			throw new AiRunError(
				response.status === 401 || response.status === 403
					? "authentication_failed"
					: response.status === 429
						? "rate_limited"
						: response.status >= 500
							? "provider_failed"
							: "request_rejected",
			);
		}
		const text = await consumeProviderText(
			response,
			this.id === "anthropic" ? "anthropic" : "responses",
			onEvent,
			signal,
		);
		if (!text) throw new Error(`${this.spec.label} returned no text.`);
		return text;
	}
}

export function createDefaultAdapters(
	secrets: SecretStore,
): AiBackendAdapter[] {
	return [
		new CodexAdapter({
			id: "codex",
			label: "Codex / ChatGPT",
			bin: "codex",
			versionArgs: ["--version"],
			statusArgs: ["login", "status"],
			disconnectArgs: ["logout"],
			fallbackModels: [
				{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
				{ id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
				{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
			],
			routes: ["subscription", "runtime-key"],
			setup: {
				subscription: "codex login",
				"runtime-key": "codex login --with-api-key",
			},
			args: (model) => [
				"-a",
				"never",
				"exec",
				"--ephemeral",
				"--ignore-rules",
				"--sandbox",
				"read-only",
				"--json",
				"--model",
				model,
				"-",
			],
		}),
		new RuntimeAdapter({
			id: "claude",
			label: "Claude Code",
			bin: "claude",
			versionArgs: ["--version"],
			statusArgs: ["auth", "status"],
			disconnectArgs: ["auth", "logout"],
			fallbackModels: [
				{ id: "sonnet", label: "Claude Sonnet" },
				{ id: "opus", label: "Claude Opus" },
				{ id: "fable", label: "Claude Fable" },
			],
			routes: ["subscription", "runtime-key"],
			setup: {
				subscription: "claude auth login",
				"runtime-key": "claude setup-token",
			},
			args: (model) => [
				"-p",
				"--output-format",
				"stream-json",
				"--include-partial-messages",
				"--verbose",
				"--no-session-persistence",
				"--permission-mode",
				"plan",
				"--tools",
				"",
				"--model",
				model,
			],
		}),
		new RuntimeAdapter({
			id: "opencode",
			label: "OpenCode",
			bin: "opencode",
			versionArgs: ["--version"],
			statusArgs: ["auth", "list"],
			modelArgs: ["models"],
			routes: ["runtime-key", "subscription"],
			setup: {
				"runtime-key": "opencode auth login --provider {provider}",
				subscription: "opencode auth login --provider {provider}",
			},
			args: (model) => [
				"run",
				"--format",
				"json",
				"--agent",
				"plan",
				"--model",
				model,
			],
			promptAsArgument: true,
		}),
		new RuntimeAdapter({
			id: "cursor",
			label: "Cursor",
			bin: "cursor-agent",
			versionArgs: ["--version"],
			statusArgs: ["status"],
			disconnectArgs: ["logout"],
			modelArgs: ["--list-models"],
			routes: ["subscription", "runtime-key"],
			setup: {
				subscription: "cursor-agent login",
				"runtime-key": "Open Cursor Settings → Models → API Keys",
			},
			args: (model) => [
				"-p",
				"--output-format",
				"stream-json",
				"--stream-partial-output",
				"--mode",
				"ask",
				"--model",
				model,
			],
		}),
		new DirectProviderAdapter(
			{
				id: "xai",
				label: "Grok",
				baseUrl: "https://api.x.ai",
				envKey: "XAI_API_KEY",
			},
			secrets,
		),
	];
}
