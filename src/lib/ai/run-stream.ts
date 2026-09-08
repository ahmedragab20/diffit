import { AiRunError } from "./lifecycle.js";
import type { AiService, AiPreparedRun } from "./service.js";
import type { AiRunEvent, AiRunRequest } from "./types.js";

interface RunStream {
	writeSSE(event: { event: string; data: string }): Promise<unknown>;
	onAbort(callback: () => void): void;
}

/**
 * Durable record of a run's boundaries. Deltas are deliberately not journaled:
 * one record per token would be a firehose, and the terminal record already
 * establishes what the run produced.
 */
export interface RunJournal {
	record(entry: {
		key: string;
		runId: string;
		conversationId: string;
		kind: "request" | "result" | "error";
		payload: unknown;
	}): void | Promise<void>;
}

/** A terminal write is attempted once. A failed write is not proof of delivery. */
export async function streamAiRun(
	service: Pick<AiService, "run" | "cancel"> &
		Partial<Pick<AiService, "runPrepared">>,
	request: AiRunRequest,
	stream: RunStream,
	signal: AbortSignal,
	prepared?: AiPreparedRun,
	journal?: RunJournal,
): Promise<void> {
	let runId: string | undefined = prepared?.runId;
	let started = false;
	let disconnected = signal.aborted;
	let terminalAttempted = false;
	const abort = () => {
		disconnected = true;
		// Readers normally close after consuming a terminal event.
		if (runId && !terminalAttempted) service.cancel(runId);
	};
	let events = 0;
	/** Journalling must never take down a live run; a failure is dropped here. */
	const journalRecord = async (
		kind: "request" | "result" | "error",
		payload: unknown,
	) => {
		if (!journal || !runId) return;
		try {
			await journal.record({
				key: `${runId}:${kind}`,
				runId,
				conversationId: request.conversationId,
				kind,
				payload,
			});
		} catch {
			/* Durability is best-effort here; the run continues either way. */
		}
	};
	stream.onAbort(abort);
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (disconnected) {
			if (runId) service.cancel(runId);
			return;
		}
		if (prepared && !service.runPrepared) {
			service.cancel(prepared.runId);
			throw new AiRunError("protocol_error");
		}
		const emit = async (event: AiRunEvent) => {
			if (event.type === "start") {
				if (started || (prepared && event.runId !== prepared.runId))
					throw new AiRunError("protocol_error");
				started = true;
				runId = event.runId;
				await journalRecord("request", {
					modelId: request.modelId,
					surface: request.surface,
					action: request.action,
					trigger: request.trigger,
				});
			}
			events++;
			if (disconnected) {
				if (runId) service.cancel(runId);
				throw new AiRunError("cancelled");
			}
			if (terminalAttempted || (!started && event.type !== "error"))
				throw new AiRunError("protocol_error");
			if (event.type === "complete" || event.type === "error") {
				terminalAttempted = true;
				await journalRecord(event.type === "error" ? "error" : "result", {
					type: event.type,
					events,
				});
			}
			try {
				await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
			} catch {
				abort();
				if (runId && terminalAttempted) service.cancel(runId);
				throw new AiRunError("delivery_failed");
			}
		};
		await (prepared
			? service.runPrepared!(prepared, emit)
			: service.run(request, emit));
		if (!terminalAttempted && !disconnected)
			throw new AiRunError("protocol_error");
	} catch (error) {
		if (!disconnected && !terminalAttempted) {
			terminalAttempted = true;
			const failure =
				error instanceof AiRunError ? error : new AiRunError("provider_failed");
			await journalRecord("error", { code: failure.code, events });
			await stream
				.writeSSE({
					event: "error",
					data: JSON.stringify({
						type: "error",
						code: failure.code,
						message: failure.message,
					}),
				})
				.catch(() => {});
		}
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
