import { AiRunError } from "./lifecycle.js";
import type {
	AiBackendAdapter,
	AiModel,
	AiProviderCapabilities,
	AiRunRequest,
	AiSourceId,
} from "./types.js";

/** Transport declarations, not certification of an installed runtime or model. */
export function providerCapabilities(
	source: AiSourceId,
): AiProviderCapabilities {
	const direct =
		source === "openai" || source === "anthropic" || source === "xai";
	const codex = source === "codex";
	const protocols = {
		codex: "codex-app-server",
		claude: "claude-stream-json",
		opencode: "opencode-json",
		cursor: "cursor-stream-json",
		openai: "responses-sse",
		anthropic: "anthropic-sse",
		xai: "responses-sse",
	} as const;
	return {
		protocol: protocols[source],
		contractVersion: 1,
		runtimeVersion: null,
		liveVerified: false,
		routes: direct ? ["direct-key"] : ["subscription", "runtime-key"],
		reasoningEffort: codex ? "model-catalog" : "unsupported",
		serviceTier: codex ? "model-catalog" : "unsupported",
		images: codex || direct ? "model-catalog" : "unsupported",
		toolAuthority: direct ? "disabled" : "runtime-managed-unverified",
		investigation: false,
	};
}

/** Fail before inference, discovery or credential access for unsupported operations. */
export function assertProviderRequest(
	request: AiRunRequest,
	capabilities?: AiProviderCapabilities,
): void {
	if (request.mode !== undefined && request.mode !== "answer")
		throw new AiRunError("unsupported_capability");
	if (
		request.reasoningEffort !== undefined &&
		(!request.reasoningEffort.trim() ||
			capabilities?.reasoningEffort !== "model-catalog")
	)
		throw new AiRunError("unsupported_capability");
	if (
		request.serviceTier !== undefined &&
		(!request.serviceTier.trim() || capabilities?.serviceTier !== "model-catalog")
	)
		throw new AiRunError("unsupported_capability");
	if (request.resolvedImages?.length && capabilities?.images === "unsupported")
		throw new AiRunError("unsupported_capability");
}

export function assertModelOptions(
	request: AiRunRequest,
	model: AiModel | undefined,
): void {
	if (
		request.reasoningEffort !== undefined &&
		!model?.reasoningEfforts?.includes(request.reasoningEffort)
	)
		throw new AiRunError("unsupported_capability");
	if (
		request.serviceTier !== undefined &&
		!model?.serviceTiers?.includes(request.serviceTier)
	)
		throw new AiRunError("unsupported_capability");
	if (request.resolvedImages?.length && model?.supportsImages !== true)
		throw new AiRunError("unsupported_capability");
}

export function assertProviderModelId(
	request: AiRunRequest,
	adapter: AiBackendAdapter,
): void {
	const [source, route, provider, ...parts] = request.modelId.split("/");
	const model = parts.join("/");
	if (
		source !== adapter.id ||
		provider !== adapter.id ||
		!adapter.capabilities?.routes.some((entry) => entry === route) ||
		!model ||
		model.startsWith("-") ||
		/\s|[\u0000-\u001f\u007f]/.test(model)
	)
		throw new AiRunError("request_rejected");
}

/** Only requests needing model-specific options trigger catalog I/O. No fallback grants capabilities. */
export async function validateProviderOptions(
	adapter: AiBackendAdapter,
	request: AiRunRequest,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	assertProviderRequest(request, adapter.capabilities);
	assertProviderModelId(request, adapter);
	if (
		request.reasoningEffort === undefined &&
		request.serviceTier === undefined &&
		!request.resolvedImages?.length
	)
		return;
	let models: AiModel[];
	try {
		models = await adapter.models();
	} catch {
		signal.throwIfAborted();
		throw new AiRunError("capability_unavailable");
	}
	signal.throwIfAborted();
	const model = models.find(
		(entry) => entry.id === request.modelId && entry.sourceId === adapter.id,
	);
	assertModelOptions(request, model);
}
