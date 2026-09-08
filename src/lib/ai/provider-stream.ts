import { consumeSseData } from "./sse.js";
import { AiRunError, DEFAULT_AI_RUN_POLICY } from "./lifecycle.js";
import type { AiRunEvent } from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function invalidEvent(): Error {
	return new Error("AI provider returned an invalid stream event.");
}

/** A text delta or EOF is never evidence of a successfully completed response. */
export async function consumeProviderText(
	response: Response,
	provider: "anthropic" | "responses",
	onEvent: (event: AiRunEvent) => void | Promise<void>,
	signal: AbortSignal,
): Promise<string> {
	if (!response.body) throw new Error("Provider returned no response stream.");
	let output = "";
	let outputBytes = 0;
	let frames = 0;
	let completed = false;
	let stopReason: string | undefined;
	await consumeSseData(
		response.body,
		async (data) => {
			if (++frames > DEFAULT_AI_RUN_POLICY.maxEvents)
				throw new AiRunError("resource_limit");
			if (data === "[DONE]")
				throw new Error("AI provider stream ended before successful completion.");
			let value: unknown;
			try {
				value = JSON.parse(data);
			} catch {
				throw invalidEvent();
			}
			const payload = record(value);
			if (!payload || typeof payload.type !== "string") throw invalidEvent();
			if (payload.type === "error" || payload.type === "response.failed") {
				throw new Error("AI provider reported a failed response.");
			}
			if (payload.type === "response.incomplete")
				throw new Error("AI provider response was incomplete.");

			let delta: string | undefined;
			if (provider === "responses") {
				if (payload.type === "response.completed") {
					const result = record(payload.response);
					if (result?.status !== "completed" || result.error) throw invalidEvent();
					completed = true;
					return true;
				}
				if (payload.type === "response.output_text.delta") {
					if (typeof payload.delta !== "string") throw invalidEvent();
					delta = payload.delta;
				}
			} else {
				if (payload.type === "message_delta") {
					const update = record(payload.delta);
					if (!update) throw invalidEvent();
					if (update.stop_reason != null) {
						if (typeof update.stop_reason !== "string") throw invalidEvent();
						stopReason = update.stop_reason;
					}
				}
				if (payload.type === "message_stop") {
					if (
						!stopReason ||
						!["end_turn", "stop_sequence", "refusal"].includes(stopReason)
					) {
						throw new Error(
							"AI provider response ended without a complete text answer.",
						);
					}
					completed = true;
					return true;
				}
				if (payload.type === "content_block_delta") {
					const update = record(payload.delta);
					if (!update || typeof update.type !== "string") throw invalidEvent();
					if (update.type === "text_delta") {
						if (typeof update.text !== "string") throw invalidEvent();
						delta = update.text;
					}
				}
			}
			if (delta) {
				outputBytes += Buffer.byteLength(delta, "utf8");
				if (outputBytes > DEFAULT_AI_RUN_POLICY.maxOutputBytes)
					throw new AiRunError("resource_limit");
				output += delta;
				await onEvent({ type: "text-delta", text: delta });
			}
		},
		signal,
	);
	if (!completed)
		throw new Error("AI provider stream ended before successful completion.");
	return output;
}
