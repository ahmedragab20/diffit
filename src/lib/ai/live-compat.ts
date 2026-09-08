/**
 * Live compatibility probe for the five default providers.
 *
 * Capability declarations stay `liveVerified: false` — a successful ping on
 * this machine is evidence, not certification. Inference is opt-in and bounded.
 */
import type {
	AiBackendAdapter,
	AiConnectionStatus,
	AiRunRequest,
	AiSourceId,
} from "./types.js";

export const LIVE_COMPAT_SCHEMA = 1 as const;
export const LIVE_PING_PROMPT = "Reply with the single word pong.";
export const LIVE_PING_MS = 20_000;

export type InferenceOutcome = "skipped" | "ok" | "failed" | "timeout";

export interface LiveCompatProbe {
	sourceId: AiSourceId;
	status: AiConnectionStatus;
	runtimeAvailable: boolean;
	runtimeVersion: string | null;
	modelCount: number;
	inference: InferenceOutcome;
	liveVerified: false;
}

export interface LiveCompatReport {
	schemaVersion: typeof LIVE_COMPAT_SCHEMA;
	liveVerified: false;
	probes: LiveCompatProbe[];
}

export interface LiveCompatOptions {
	/** When true, a connected provider with a model is pinged once. */
	ping?: boolean;
	pingMs?: number;
	now?: () => number;
}

function requestFor(modelId: string): AiRunRequest {
	return {
		trigger: "user",
		conversationId: "live-compat-ping",
		modelId,
		surface: "diff",
		action: "ask",
		prompt: LIVE_PING_PROMPT,
		context: { kind: "diff" },
	};
}

async function ping(
	adapter: AiBackendAdapter,
	modelId: string,
	now: () => number,
	pingMs: number,
): Promise<InferenceOutcome> {
	const started = now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), pingMs);
	try {
		const text = await adapter.run(requestFor(modelId), controller.signal, () => {});
		if (typeof text !== "string" || !text.trim()) return "failed";
		return "ok";
	} catch (error) {
		if (controller.signal.aborted || now() - started >= pingMs)
			return "timeout";
		if (error && typeof error === "object" && "name" in error) {
			const name = (error as { name?: string }).name;
			if (name === "AbortError" || name === "TimeoutError") return "timeout";
		}
		return "failed";
	} finally {
		clearTimeout(timer);
	}
}

export async function probeLiveCompatibility(
	adapters: readonly AiBackendAdapter[],
	options: LiveCompatOptions = {},
): Promise<LiveCompatReport> {
	const now = options.now ?? Date.now;
	const probes: LiveCompatProbe[] = [];
	for (const adapter of adapters) {
		const connection = await adapter.connection();
		const models =
			connection.status === "connected" ? await adapter.models() : [];
		let inference: InferenceOutcome = "skipped";
		if (options.ping && connection.status === "connected" && models[0]?.id) {
			inference = await ping(
				adapter,
				models[0].id,
				now,
				options.pingMs ?? LIVE_PING_MS,
			);
		}
		probes.push({
			sourceId: adapter.id,
			status: connection.status,
			runtimeAvailable: connection.runtimeAvailable,
			runtimeVersion: adapter.capabilities?.runtimeVersion ?? null,
			modelCount: models.length,
			inference,
			liveVerified: false,
		});
	}
	return {
		schemaVersion: LIVE_COMPAT_SCHEMA,
		liveVerified: false,
		probes,
	};
}
