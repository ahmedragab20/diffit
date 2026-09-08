import type { AiRunEvent } from "./types.js";

export class AiStreamError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "AiStreamError";
	}
}

/** A cancellation acknowledgement is not evidence that execution has terminated. */
export function parseAiCancelResponse(value: unknown): void {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("AI returned an invalid cancellation acknowledgement.");
	const result = value as Record<string, unknown>;
	if (
		typeof result.cancellationRequested !== "boolean" ||
		result.cancellationConfirmed !== false ||
		result.status !==
			(result.cancellationRequested ? "cancel-requested" : "not-active")
	)
		throw new Error("AI returned an invalid cancellation acknowledgement.");
}

/** Validate the wire event before it can update client run state. */
export function parseAiRunEvent(data: string): AiRunEvent {
	const invalid = () => new Error("AI returned an invalid run event.");
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		throw invalid();
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw invalid();
	const event = value as Record<string, unknown>;
	switch (event.type) {
		case "start":
			if (
				typeof event.runId !== "string" ||
				!event.runId ||
				typeof event.modelId !== "string" ||
				!event.modelId
			)
				throw invalid();
			return { type: "start", runId: event.runId, modelId: event.modelId };
		case "text-delta":
			if (typeof event.text !== "string") throw invalid();
			return { type: "text-delta", text: event.text };
		case "complete":
			if (typeof event.text !== "string" || !event.text.trim()) throw invalid();
			return { type: "complete", text: event.text };
		case "warning":
			if (typeof event.message !== "string") throw invalid();
			return { type: "warning", message: event.message };
		case "error":
			if (
				typeof event.message !== "string" ||
				(event.code !== undefined &&
					(typeof event.code !== "string" ||
						!/^[a-z][a-z_]{0,63}$/.test(event.code)))
			)
				throw invalid();
			return {
				type: "error",
				message: event.message,
				...(event.code === undefined ? {} : { code: event.code }),
			};
		default:
			throw invalid();
	}
}
