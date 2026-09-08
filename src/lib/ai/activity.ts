/**
 * Run activity: what actually happened, derived from run events.
 *
 * The approved plan is specific about honesty here — report actual evidence
 * reads, tool outcomes, elapsed time and coverage, and "do not invent
 * percentages, pretend to expose private model reasoning, or animate a false
 * success". This model enforces that structurally:
 *
 *  - There is no progress fraction. A caller cannot render a percentage
 *    because none is computed; only counted facts are exposed.
 *  - `succeeded` is true only after a terminal complete event actually
 *    arrived. A stream that stops is interrupted, never quietly successful.
 *  - Partial output from a canceled or interrupted run is preserved and
 *    labelled, rather than discarded or presented as an answer.
 *  - A retry is a new attempt with its own state; it never overwrites the
 *    attempt before it.
 */
import type { AiRunEvent } from "./types.js";

export type ActivityPhase =
	| "disconnected"
	| "preparing"
	| "reading"
	| "responding"
	| "reconnecting"
	| "cancel-requested"
	| "canceled"
	| "interrupted"
	| "failed"
	| "complete";

/** A phase from which no further transition is possible. */
export const TERMINAL_PHASES: readonly ActivityPhase[] = Object.freeze([
	"canceled",
	"interrupted",
	"failed",
	"complete",
]);

export interface ActivityStep {
	/** What the run did, e.g. a tool name or an evidence read. */
	label: string;
	outcome: "ok" | "failed";
	at: number;
}

export interface RunActivity {
	phase: ActivityPhase;
	/** Only ever a terminal complete; never inferred from a quiet stream. */
	succeeded: boolean;
	/** Text received so far. Preserved on cancel and interruption. */
	text: string;
	/** True when `text` is not the run's final answer. */
	partial: boolean;
	steps: ActivityStep[];
	warnings: string[];
	/** Set only when the run actually failed. */
	errorCode: string | null;
	elapsedMs: number;
	/** Attempt number; a retry starts a new activity rather than replacing one. */
	attempt: number;
}

export interface ActivityInput {
	/** Wall clock, injected so elapsed time is measured, not guessed. */
	now: number;
	startedAt: number;
	attempt?: number;
	/** Set once the reader asked to cancel, before the run has confirmed. */
	cancelRequested?: boolean;
	/** Set while the transport is retrying its connection. */
	reconnecting?: boolean;
	/** Evidence reads and tool calls the run actually performed. */
	steps?: ActivityStep[];
	/** True once the event stream ended, however it ended. */
	streamEnded?: boolean;
}

export const EMPTY_ACTIVITY: RunActivity = Object.freeze({
	phase: "disconnected",
	succeeded: false,
	text: "",
	partial: false,
	steps: [],
	warnings: [],
	errorCode: null,
	elapsedMs: 0,
	attempt: 1,
});

/**
 * Folds run events into an activity. The event sequence is the only source of
 * truth: nothing is assumed from silence.
 */
export function deriveActivity(
	events: readonly AiRunEvent[],
	input: ActivityInput,
): RunActivity {
	const steps = input.steps ?? [];
	const warnings: string[] = [];
	let started = false;
	let text = "";
	let completed = false;
	let errorCode: string | null = null;

	for (const event of events) {
		switch (event.type) {
			case "start":
				started = true;
				break;
			case "text-delta":
				text += event.text;
				break;
			case "warning":
				warnings.push(event.message);
				break;
			case "error":
				errorCode = event.code ?? "provider_failed";
				break;
			case "complete":
				completed = true;
				// A complete event carries the authoritative final text.
				text = event.text;
				break;
		}
	}

	const elapsedMs = Math.max(0, input.now - input.startedAt);
	const attempt = input.attempt ?? 1;
	const base = {
		text,
		steps,
		warnings,
		elapsedMs,
		attempt,
	};

	if (completed)
		return {
			...base,
			phase: "complete",
			succeeded: true,
			partial: false,
			errorCode: null,
		};

	if (errorCode !== null)
		return {
			...base,
			phase: "failed",
			succeeded: false,
			// Whatever arrived before the failure is kept and marked partial.
			partial: text.length > 0,
			errorCode,
		};

	if (input.cancelRequested && input.streamEnded)
		return {
			...base,
			phase: "canceled",
			succeeded: false,
			partial: text.length > 0,
			errorCode: null,
		};

	if (input.streamEnded)
		// The stream stopped without a terminal event. That is an interruption,
		// never a success.
		return {
			...base,
			phase: "interrupted",
			succeeded: false,
			partial: text.length > 0,
			errorCode: null,
		};

	if (input.cancelRequested)
		return {
			...base,
			phase: "cancel-requested",
			succeeded: false,
			partial: true,
			errorCode: null,
		};

	if (input.reconnecting)
		return {
			...base,
			phase: "reconnecting",
			succeeded: false,
			partial: true,
			errorCode: null,
		};

	if (!started)
		return {
			...base,
			phase: "preparing",
			succeeded: false,
			partial: false,
			errorCode: null,
		};

	return {
		...base,
		// Reading is only claimed while steps are arriving and no text has begun.
		phase: text.length > 0 ? "responding" : "reading",
		succeeded: false,
		partial: true,
		errorCode: null,
	};
}

/** True when the activity can still change. */
export function isActive(activity: RunActivity): boolean {
	return !TERMINAL_PHASES.includes(activity.phase);
}

/**
 * Starts a fresh attempt. The previous activity is returned untouched by the
 * caller's own bookkeeping: a retry is an explicit new attempt, not an
 * overwrite of what came before.
 */
export function retryOf(previous: RunActivity): RunActivity {
	return { ...EMPTY_ACTIVITY, attempt: previous.attempt + 1 };
}
