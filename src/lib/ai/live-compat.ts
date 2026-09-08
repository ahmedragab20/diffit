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
	/** Present only on failed/timeout pings. Typed codes, never provider text. */
	failureCode: string | null;
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

function failureCodeOf(error: unknown): string | null {
	if (!error || typeof error !== "object") return null;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && /^[a-z][a-z_]{0,63}$/.test(code)
		? code
		: null;
}

async function ping(
	adapter: AiBackendAdapter,
	modelId: string,
	now: () => number,
	pingMs: number,
): Promise<{ inference: InferenceOutcome; failureCode: string | null }> {
	const started = now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), pingMs);
	try {
		const text = await adapter.run(requestFor(modelId), controller.signal, () => {});
		if (typeof text !== "string" || !text.trim())
			return { inference: "failed", failureCode: "empty_output" };
		return { inference: "ok", failureCode: null };
	} catch (error) {
		const timedOut =
			controller.signal.aborted || now() - started >= pingMs;
		const name =
			error && typeof error === "object"
				? (error as { name?: string }).name
				: undefined;
		if (timedOut || name === "AbortError" || name === "TimeoutError")
			return { inference: "timeout", failureCode: failureCodeOf(error) };
		return { inference: "failed", failureCode: failureCodeOf(error) };
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
		let failureCode: string | null = null;
		if (options.ping && connection.status === "connected" && models[0]?.id) {
			const pinged = await ping(
				adapter,
				models[0].id,
				now,
				options.pingMs ?? LIVE_PING_MS,
			);
			inference = pinged.inference;
			failureCode = pinged.failureCode;
		}
		probes.push({
			sourceId: adapter.id,
			status: connection.status,
			runtimeAvailable: connection.runtimeAvailable,
			runtimeVersion: adapter.capabilities?.runtimeVersion ?? null,
			modelCount: models.length,
			inference,
			failureCode,
			liveVerified: false,
		});
	}
	return {
		schemaVersion: LIVE_COMPAT_SCHEMA,
		liveVerified: false,
		probes,
	};
}
