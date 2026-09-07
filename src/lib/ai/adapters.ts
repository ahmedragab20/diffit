import { spawn } from "node:child_process";
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
		await execFileAsync(bin, args, { timeout: 5000 });
		return true;
	} catch (error) {
		return Boolean((error as { stdout?: string; stderr?: string }).stdout);
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

function parseModelLines(output: string): string[] {
	const ids = new Set<string>();
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line || /^(available models|models|provider|name|[-=]{2,})/i.test(line))
			continue;
		const first = line
			.split(/\s+/)[0]
			?.replace(/^[*✓>]+/, "")
			.replace(/[,:]$/, "");
		if (first && /^[a-z0-9][a-z0-9._:/\-[\]]+$/i.test(first)) ids.add(first);
	}
	return [...ids];
}

function extractText(value: unknown): string {
	if (Array.isArray(value)) return value.map(extractText).join("");
	if (!value || typeof value !== "object") return "";
	const record = value as Record<string, unknown>;
	if (typeof record.result === "string") return record.result;
	if (
		typeof record.text === "string" &&
		["text", "agent_message", "text_delta", "output_text"].includes(
			String(record.type),
		)
	)
		return record.text;
	if (typeof record.delta === "string") return record.delta;
	if (record.delta && typeof record.delta === "object")
		return extractText(record.delta);
	if (Array.isArray(record.content))
		return record.content.map(extractText).join("");
	if (record.event) return extractText(record.event);
	if (record.part) return extractText(record.part);
	if (record.message) return extractText(record.message);
	if (record.item) return extractText(record.item);
	if (record.data) return extractText(record.data);
	return "";
}

function streamDelta(
	payload: Record<string, unknown>,
	provider: "anthropic" | "responses",
): string {
	if (provider === "anthropic") {
		if (payload.type !== "content_block_delta") return "";
		const delta = payload.delta as Record<string, unknown> | undefined;
		return delta?.type === "text_delta" && typeof delta.text === "string"
			? delta.text
			: "";
	}
	return payload.type === "response.output_text.delta" &&
		typeof payload.delta === "string"
		? payload.delta
		: "";
}

async function consumeSseText(
	response: Response,
	provider: "anthropic" | "responses",
	onEvent: (event: AiRunEvent) => void | Promise<void>,
): Promise<string> {
	if (!response.body) throw new Error("Provider returned no response stream.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let output = "";
	const consumeFrame = async (frame: string) => {
		const data = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.join("\n");
		if (!data || data === "[DONE]") return;
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(data) as Record<string, unknown>;
		} catch {
			return;
		}
		const delta = streamDelta(payload, provider);
		if (!delta) return;
		output += delta;
		await onEvent({ type: "text-delta", text: delta });
	};
	while (true) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			await consumeFrame(buffer.slice(0, boundary));
			buffer = buffer.slice(boundary + 2);
			boundary = buffer.indexOf("\n\n");
		}
		if (done) break;
	}
	if (buffer.trim()) await consumeFrame(buffer);
	return output;
}

async function runCommand(
	bin: string,
	args: string[],
	prompt: string,
	signal: AbortSignal,
	onEvent: (event: AiRunEvent) => void | Promise<void>,
	promptAsArgument = false,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(bin, promptAsArgument ? [...args, prompt] : args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1", CI: "1" },
		});
		let stdoutBuffer = "";
		let stderr = "";
		let text = "";
		let finalResult = "";
		let eventChain = Promise.resolve();
		const abort = () => child.kill("SIGTERM");
		signal.addEventListener("abort", abort, { once: true });

		const consumeLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const parsed = JSON.parse(line) as unknown;
				const chunk = extractText(parsed);
				if (!chunk) return;
				const isFinal =
					typeof (parsed as Record<string, unknown>).result === "string";
				if (isFinal) finalResult = chunk;
				else {
					const incremental = chunk.startsWith(text)
						? chunk.slice(text.length)
						: text.endsWith(chunk)
							? ""
							: chunk;
					if (!incremental) return;
					text += incremental;
					eventChain = eventChain
						.then(() => onEvent({ type: "text-delta", text: incremental }))
						.then(() => undefined);
				}
			} catch {
				// Some runtimes emit a final plain-text line even in JSON mode.
				text += `${line}\n`;
				eventChain = eventChain
					.then(() => onEvent({ type: "text-delta", text: `${line}\n` }))
					.then(() => undefined);
			}
		};

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			let newline = stdoutBuffer.indexOf("\n");
			while (newline >= 0) {
				consumeLine(stdoutBuffer.slice(0, newline));
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				newline = stdoutBuffer.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-8000);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			signal.removeEventListener("abort", abort);
			if (stdoutBuffer) consumeLine(stdoutBuffer);
			void eventChain.then(() => {
				if (signal.aborted) return reject(new Error("AI request canceled."));
				if (code !== 0)
					return reject(
						new Error(stderr.trim() || `${bin} exited with code ${code}`),
					);
				resolve((finalResult || text).trim());
			}, reject);
		});
		child.stdin.end(promptAsArgument ? undefined : prompt);
	});
}

export class RuntimeAdapter implements AiBackendAdapter {
	readonly id: RuntimeSpec["id"];
	readonly supportsImages: boolean = false;
	constructor(private readonly spec: RuntimeSpec) {
		this.id = spec.id;
	}

	async connection(): Promise<AiConnection> {
		const available = await commandAvailable(
			this.spec.bin,
			this.spec.versionArgs,
		);
		if (!available) {
			return {
				id: this.id,
				label: this.spec.label,
				status: "missing-runtime",
				runtimeAvailable: false,
				credentialRoutes: this.spec.routes,
				activeRoutes: [],
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
			activeRoutes: connected ? this.spec.routes : [],
			setupCommand: connected
				? undefined
				: (this.spec.setup.subscription ?? this.spec.setup["runtime-key"]),
		};
	}

	async models(): Promise<AiModel[]> {
		const connection = await this.connection();
		if (connection.status !== "connected") return [];
		let entries = this.spec.fallbackModels ?? [];
		if (this.spec.modelArgs) {
			try {
				const { stdout } = await execFileAsync(this.spec.bin, this.spec.modelArgs, {
					timeout: 15000,
					maxBuffer: 4 * 1024 * 1024,
				});
				const parsed = parseModelLines(stdout);
				if (parsed.length)
					entries = parsed.map((id) => ({ id, label: modelName(id) }));
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
			supportsImages: this.supportsImages,
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
		return runCommand(
			this.spec.bin,
			this.spec.args(model),
			request.prompt ?? "",
			signal,
			onEvent,
			this.spec.promptAsArgument,
		);
	}
}

async function codexModelCatalog(): Promise<
	Array<{
		id: string;
		displayName: string;
		description?: string;
		isDefault?: boolean;
		reasoningEfforts?: string[];
		serviceTiers?: string[];
	}>
> {
	return new Promise((resolve, reject) => {
		const child = spawn("codex", ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let buffer = "";
		let cursor: string | null = null;
		const models: Array<{
			id: string;
			displayName: string;
			description?: string;
			isDefault?: boolean;
			reasoningEfforts?: string[];
			serviceTiers?: string[];
		}> = [];
		let requestId = 2;
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("Codex model catalog timed out."));
		}, 12000);
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			child.kill("SIGTERM");
			error ? reject(error) : resolve(models);
		};
		const sendModelPage = () =>
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "model/list", params: { cursor, limit: 100, includeHidden: false } })}\n`,
			);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				let message: Record<string, unknown>;
				try {
					message = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (message.id === 1 && message.result) {
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
					);
					sendModelPage();
					continue;
				}
				if (message.id !== requestId) continue;
				if (message.error)
					return finish(new Error("Codex model catalog request failed."));
				const result = message.result as {
					data?: Array<Record<string, unknown>>;
					nextCursor?: string | null;
				};
				for (const model of result.data ?? []) {
					const id =
						typeof model.model === "string"
							? model.model
							: typeof model.id === "string"
								? model.id
								: "";
					if (!id) continue;
					models.push({
						id,
						displayName:
							typeof model.displayName === "string"
								? model.displayName
								: modelName(id),
						description:
							typeof model.description === "string" ? model.description : undefined,
						isDefault: model.isDefault === true,
						reasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
							? model.supportedReasoningEfforts
									.map((entry) =>
										typeof entry === "string"
											? entry
											: String((entry as Record<string, unknown>).reasoningEffort ?? ""),
									)
									.filter(Boolean)
							: undefined,
						serviceTiers: Array.isArray(model.serviceTiers)
							? model.serviceTiers
									.map((entry) => String((entry as Record<string, unknown>).id ?? ""))
									.filter(Boolean)
							: undefined,
					});
				}
				cursor = result.nextCursor ?? null;
				if (cursor) {
					requestId += 1;
					sendModelPage();
				} else finish();
			}
		});
		child.on("error", finish);
		child.on("exit", (code) => {
			if (code && models.length === 0)
				finish(new Error("Codex app-server exited before returning models."));
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "diffing", title: "diffing", version: "0.18" }, capabilities: { experimentalApi: true, requestAttestation: false } } })}\n`,
		);
	});
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
	return new Promise<string>((resolve, reject) => {
		const child = spawn("codex", ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let buffer = "";
		let stderr = "";
		let threadId = "";
		let output = "";
		let settled = false;
		let eventChain = Promise.resolve();
		const timeout = setTimeout(
			() => finish(new Error("Codex response timed out.")),
			5 * 60 * 1000,
		);
		const abort = () => finish(new Error("AI request canceled."));
		signal.addEventListener("abort", abort, { once: true });
		const send = (id: number, method: string, params: Record<string, unknown>) =>
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			child.kill("SIGTERM");
			void eventChain.finally(() =>
				error
					? reject(error)
					: output
						? resolve(output)
						: reject(new Error(stderr.trim() || "Codex returned no text.")),
			);
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				let message: Record<string, unknown>;
				try {
					message = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (message.id === 1 && message.result) {
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
					);
					send(2, "thread/start", {
						model,
						cwd: process.cwd(),
						approvalPolicy: "never",
						sandbox: "read-only",
						ephemeral: true,
						dynamicTools: [],
						environments: [],
					});
					continue;
				}
				if (message.id === 2 && message.result) {
					const result = message.result as { thread?: { id?: string } };
					threadId = result.thread?.id ?? "";
					if (!threadId) return finish(new Error("Codex did not create a thread."));
					send(3, "turn/start", {
						threadId,
						input: [
							{ type: "text", text: prompt, text_elements: [] },
							...(images ?? []).map((image) => ({
								type: "image",
								url: image.dataUrl,
							})),
						],
						model,
						effort: effort || undefined,
						serviceTier: serviceTier || undefined,
						approvalPolicy: "never",
						environments: [],
					});
					continue;
				}
				if (message.id && message.error)
					return finish(new Error("Codex app-server request failed."));
				if (message.method === "item/agentMessage/delta") {
					const delta = (message.params as { delta?: unknown } | undefined)?.delta;
					if (typeof delta === "string" && delta) {
						output += delta;
						eventChain = eventChain
							.then(() => onEvent({ type: "text-delta", text: delta }))
							.then(() => undefined);
					}
				}
				if (message.method === "turn/completed") finish();
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-4000);
		});
		child.on("error", (error) => finish(error));
		child.on("exit", (code) => {
			if (!settled && code !== 0)
				finish(
					new Error(stderr.trim() || `Codex app-server exited with code ${code}.`),
				);
		});
		send(1, "initialize", {
			clientInfo: { name: "diffing", title: "diffing", version: "0.18" },
			capabilities: { experimentalApi: true, requestAttestation: false },
		});
	});
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
				supportsImages: true,
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
			activeRoutes: key ? ["direct-key"] : [],
			detail: key
				? process.env[this.spec.envKey]
					? `Using ${this.spec.envKey}`
					: "Key configured"
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
		const response = await this.fetchImpl(`${this.spec.baseUrl}${path}`, {
			headers: this.headers(key),
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok)
			throw new Error(
				`${this.spec.label} model catalog failed (${response.status}).`,
			);
		const payload = (await response.json()) as {
			data?: Array<{ id: string }>;
			models?: Array<{ id: string }>;
		};
		const data = payload.data ?? payload.models ?? [];
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
				supportsImages: true,
			}));
	}

	async run(
		request: AiRunRequest,
		signal: AbortSignal,
		onEvent: (event: AiRunEvent) => void | Promise<void>,
	): Promise<string> {
		const key = await this.key();
		if (!key) throw new Error(`${this.spec.label} is not connected.`);
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
			const detail = await response.text().catch(() => "");
			throw new Error(
				`${this.spec.label} request failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
			);
		}
		const text = await consumeSseText(
			response,
			this.id === "anthropic" ? "anthropic" : "responses",
			onEvent,
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
