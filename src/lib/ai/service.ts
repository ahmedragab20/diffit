import { randomUUID } from "node:crypto";
import { buildAiPrompt } from "./context.js";
import { createDefaultAdapters } from "./adapters.js";
import { assertProviderRequest } from "./capabilities.js";
import { resetCodexModelCatalog } from "./catalog.js";
import { AiRequestError } from "./request.js";
import { AiSnapshotError } from "./snapshots.js";
import {
	AiRunError,
	AiRunLifecycle,
	runPolicy,
	type AiRunPolicy,
} from "./lifecycle.js";
import { SystemSecretStore, type SecretStore } from "./secrets.js";
import type {
	AiBackendAdapter,
	AiConnection,
	AiCredentialRoute,
	AiModel,
	AiRunEvent,
	AiRunRequest,
	AiSourceId,
} from "./types.js";

/** Opaque, single-use in-process admission; never accepted from the wire. */
export interface AiPreparedRun {
	readonly runId: string;
}
interface PreparedState {
	request: AiRunRequest;
	modelId: string;
	conversationId: string;
	adapter: AiBackendAdapter;
	lifecycle: AiRunLifecycle;
	controller: AbortController;
	emit?: (event: AiRunEvent) => void | Promise<void>;
	claimed: boolean;
	terminalAttempted: boolean;
}

export class AiService {
	private readonly prepared = new WeakMap<AiPreparedRun, PreparedState>();
	private readonly retired = new WeakMap<AiPreparedRun, AiRunError>();
	private static readonly CATALOG_TTL_MS = 15_000;
	private readonly adapters = new Map<AiSourceId, AiBackendAdapter>();
	private readonly runs = new Map<
		string,
		{ conversationId: string; source: AiSourceId; controller: AbortController }
	>();
	private readonly policy: AiRunPolicy;
	private readonly conversations = new Set<string>();
	private connectionCache: { expiresAt: number; value: AiConnection[] } | null =
		null;
	private modelCache: { expiresAt: number; value: AiModel[] } | null = null;
	private connectionRequest: Promise<AiConnection[]> | null = null;
	private modelRequest: Promise<AiModel[]> | null = null;

	constructor(
		adapters?: AiBackendAdapter[],
		secrets: SecretStore = new SystemSecretStore(),
		policy: Partial<AiRunPolicy> = {},
	) {
		this.policy = runPolicy(policy);
		for (const adapter of adapters ?? createDefaultAdapters(secrets))
			this.adapters.set(adapter.id, adapter);
	}

	async connections(): Promise<AiConnection[]> {
		if (this.connectionCache && this.connectionCache.expiresAt > Date.now())
			return this.connectionCache.value;
		if (this.connectionRequest) return this.connectionRequest;
		const request = Promise.all(
			[...this.adapters.values()].map(async (adapter) => {
				try {
					const connection = await adapter.connection();
					return adapter.capabilities
						? { ...connection, capabilities: adapter.capabilities }
						: connection;
				} catch {
					return {
						id: adapter.id,
						label: adapter.id,
						status: "error" as const,
						runtimeAvailable: true,
						credentialRoutes: [],
						activeRoutes: [],
						detail: "AI connection discovery failed.",
						capabilities: adapter.capabilities,
					};
				}
			}),
		)
			.then((value) => {
				this.connectionCache = {
					value,
					expiresAt: Date.now() + AiService.CATALOG_TTL_MS,
				};
				return value;
			})
			.finally(() => {
				this.connectionRequest = null;
			});
		this.connectionRequest = request;
		return request;
	}

	async models(): Promise<AiModel[]> {
		if (this.modelCache && this.modelCache.expiresAt > Date.now())
			return this.modelCache.value;
		if (this.modelRequest) return this.modelRequest;
		const request = Promise.all(
			[...this.adapters.values()].map((adapter) =>
				adapter
					.models()
					.then((models) =>
						adapter.capabilities
							? models.map((model) => ({
									...model,
									capabilities: adapter.capabilities,
								}))
							: models,
					)
					.catch(() => []),
			),
		)
			.then((groups) => groups.flat())
			.then((value) => {
				this.modelCache = {
					value,
					expiresAt: Date.now() + AiService.CATALOG_TTL_MS,
				};
				return value;
			})
			.finally(() => {
				this.modelRequest = null;
			});
		this.modelRequest = request;
		return request;
	}

	private invalidateCatalog(): void {
		this.connectionCache = null;
		this.modelCache = null;
		resetCodexModelCatalog();
	}

	async connectKey(
		source: AiSourceId,
		key: string,
		remember: boolean,
	): Promise<void> {
		const adapter = this.adapters.get(source);
		if (!adapter?.connectKey)
			throw new Error(`${source} does not accept a direct key in diffing.`);
		await adapter.connectKey(key, remember);
		this.invalidateCatalog();
	}

	async disconnect(source: AiSourceId): Promise<void> {
		const adapter = this.adapters.get(source);
		if (!adapter) throw new Error(`Unknown AI source: ${source}`);
		await adapter.disconnect?.();
		this.invalidateCatalog();
	}

	setupCommand(
		source: AiSourceId,
		route: AiCredentialRoute,
		providerId?: string,
	): string {
		const command = this.adapters.get(source)?.setupCommand?.(route, providerId);
		if (!command)
			throw new Error(`${source} does not expose a ${route} setup flow.`);
		this.invalidateCatalog();
		return command;
	}

	cancel(runId: string): boolean {
		const active = this.runs.get(runId);
		if (!active) return false;
		active.controller.abort(new AiRunError("cancelled"));
		return true;
	}

	async prepareRun(
		request: AiRunRequest,
		prepare?: (signal: AbortSignal) => Promise<AiRunRequest>,
		signal?: AbortSignal,
	): Promise<AiPreparedRun> {
		if (signal?.aborted) throw new AiRunError("cancelled");
		if (request.trigger !== "user")
			throw new Error("AI inference requires an explicit user trigger.");
		if (!request.conversationId?.trim())
			throw new Error("conversationId is required.");
		if (request.conversationId.length > 160)
			throw new Error("conversationId is too long.");
		if (!request.modelId || request.modelId.length > 512)
			throw new Error("modelId is invalid.");
		if (this.conversations.has(request.conversationId))
			throw new Error("An AI request is already running for this conversation.");
		const [source] = request.modelId.split("/") as [AiSourceId];
		const adapter = this.adapters.get(source);
		if (!adapter) throw new Error(`Unknown model source: ${source}`);
		assertProviderRequest(request, adapter.capabilities);
		if (request.resolvedImages?.length && !adapter.supportsImages) {
			throw new Error(
				`${source} cannot receive image attachments in its current non-interactive runtime. Choose an image-capable model source.`,
			);
		}
		const sourceRuns = [...this.runs.values()].filter(
			(run) => run.source === source,
		).length;
		if (
			this.runs.size >= this.policy.maxConcurrent ||
			sourceRuns >= this.policy.maxPerSource
		)
			throw new AiRunError("capacity");
		const runId = randomUUID();
		const token: AiPreparedRun = Object.freeze({ runId });
		const conversationId = request.conversationId;
		const modelId = request.modelId;
		const controller = new AbortController();
		this.runs.set(runId, {
			conversationId: request.conversationId,
			source,
			controller,
		});
		this.conversations.add(request.conversationId);
		let entry: PreparedState;
		const cancel = () => {
			if (!entry.terminalAttempted) controller.abort(new AiRunError("cancelled"));
		};
		const lifecycle = new AiRunLifecycle(
			controller,
			this.policy,
			(event) => {
				if (!entry.emit) throw new AiRunError("protocol_error");
				if (event.type === "complete" || event.type === "error")
					entry.terminalAttempted = true;
				return entry.emit(event);
			},
			() => {
				this.runs.delete(runId);
				this.conversations.delete(conversationId);
				this.prepared.delete(token);
				if (controller.signal.reason instanceof AiRunError)
					this.retired.set(token, controller.signal.reason);
				signal?.removeEventListener("abort", cancel);
			},
		);
		entry = {
			request,
			modelId,
			conversationId,
			adapter,
			lifecycle,
			controller,
			claimed: false,
			terminalAttempted: false,
		};
		this.prepared.set(token, entry);
		// Also expires unused admissions. Owned preparation/provider promises still retain capacity.
		controller.signal.addEventListener("abort", () => lifecycle.finish(), {
			once: true,
		});
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		try {
			lifecycle.check();
			if (prepare) {
				const pending = lifecycle.track(
					Promise.resolve().then(() => {
						lifecycle.check();
						return prepare(controller.signal);
					}),
				);
				entry.request = await lifecycle.wait(pending);
			}
			lifecycle.check();
			if (
				entry.request.trigger !== "user" ||
				entry.request.conversationId !== conversationId ||
				entry.request.modelId !== modelId
			)
				throw new AiRunError("request_rejected");
			assertProviderRequest(entry.request, adapter.capabilities);
			if (entry.request.resolvedImages?.length && !adapter.supportsImages)
				throw new AiRunError("unsupported_capability");
			return token;
		} catch (error) {
			const failure = lifecycle.fail(
				error instanceof AiRunError ? error : new AiRunError("preparation_failed"),
			);
			lifecycle.finish();
			if (
				failure.code === "preparation_failed" &&
				(error instanceof AiRequestError || error instanceof AiSnapshotError)
			)
				throw error;
			throw failure;
		}
	}

	async run(
		request: AiRunRequest,
		onEvent: (event: AiRunEvent) => void | Promise<void>,
	): Promise<string> {
		const token = await this.prepareRun(request);
		return this.runPrepared(token, onEvent);
	}

	async runPrepared(
		token: AiPreparedRun,
		onEvent: (event: AiRunEvent) => void | Promise<void>,
	): Promise<string> {
		const entry = this.prepared.get(token);
		if (!entry || entry.claimed)
			throw this.retired.get(token) ?? new AiRunError("request_rejected");
		entry.claimed = true;
		entry.emit = onEvent;
		const { request, adapter, lifecycle, controller } = entry;
		const { runId } = token;
		let phase: "preparation_failed" | "provider_failed" = "preparation_failed";
		try {
			lifecycle.check();
			if (
				request.trigger !== "user" ||
				request.modelId !== entry.modelId ||
				request.conversationId !== entry.conversationId
			)
				throw new AiRunError("request_rejected");
			assertProviderRequest(request, adapter.capabilities);
			if (request.resolvedImages?.length && !adapter.supportsImages)
				throw new AiRunError("unsupported_capability");
			const built = buildAiPrompt(request);
			const { snapshotReader: _reader, ...providerInput } = request;
			const providerRequest = {
				...providerInput,
				prompt: built.prompt,
				evidence: built.evidence,
			};
			await lifecycle.wait(
				lifecycle.deliver({ type: "start", runId, modelId: request.modelId }),
			);
			if (built.truncated)
				await lifecycle.wait(
					lifecycle.deliver({
						type: "warning",
						message:
							"Review evidence is incomplete or exceeded the configured context limit.",
					}),
				);
			lifecycle.startProvider();
			phase = "provider_failed";
			const execution = lifecycle.track(
				Promise.resolve().then(() => {
					lifecycle.check();
					return adapter.run(
						providerRequest,
						controller.signal,
						lifecycle.providerEvent,
					);
				}),
			);
			const text = await lifecycle.wait(execution);
			lifecycle.validateOutput(text);
			await lifecycle.drain();
			await lifecycle.wait(lifecycle.deliver({ type: "complete", text }));
			return text;
		} catch (error) {
			throw lifecycle.fail(
				error instanceof AiRunError ? error : new AiRunError(phase),
			);
		} finally {
			// Keep capacity reserved until every owned promise settles, even after a deadline.
			lifecycle.finish();
		}
	}
}
