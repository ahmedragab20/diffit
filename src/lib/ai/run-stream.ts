import { AiRunError } from "./lifecycle.js";
import type { AiService, AiPreparedRun } from "./service.js";
import type { AiRunEvent, AiRunRequest } from "./types.js";

interface RunStream {
	writeSSE(event: { event: string; data: string }): Promise<unknown>;
	onAbort(callback: () => void): void;
}

/** A terminal write is attempted once. A failed write is not proof of delivery. */
export async function streamAiRun(
	service: Pick<AiService, "run" | "cancel"> &
		Partial<Pick<AiService, "runPrepared">>,
	request: AiRunRequest,
	stream: RunStream,
	signal: AbortSignal,
	prepared?: AiPreparedRun,
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
			}
			if (disconnected) {
				if (runId) service.cancel(runId);
				throw new AiRunError("cancelled");
			}
			if (terminalAttempted || (!started && event.type !== "error"))
				throw new AiRunError("protocol_error");
			if (event.type === "complete" || event.type === "error")
				terminalAttempted = true;
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
