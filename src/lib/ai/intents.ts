/**
 * The three review activities, and the bounds that keep them activities rather
 * than autonomous background work.
 *
 * Taken from the approved plan:
 *  - Ask: answer about a selection, file, whole review or plan, with citations
 *    and explicit unknowns.
 *  - Investigate: build a review map, inspect evidence through approved
 *    read-only tools, and return findings plus coverage. Bounded in duration,
 *    steps and output.
 *  - Propose: draft a comment, reply, summary, code suggestion or plan
 *    revision, shown for human review — never silently applied or published.
 *
 * The rule that matters most is the last one: a proposal is inert. Nothing
 * here can apply or publish, and `requiresHumanApproval` is true for every
 * proposal so a caller cannot treat one as an action already taken.
 */
import { AiSnapshotError } from "./snapshots.js";

export type ReviewIntent = "ask" | "investigate" | "propose";

export type ProposalKind =
	| "comment"
	| "reply"
	| "summary"
	| "code-suggestion"
	| "plan-revision";

export interface IntentBounds {
	/** Wall-clock ceiling for the activity. */
	maxMs: number;
	/** Tool calls an investigation may make; Ask and Propose do not iterate. */
	maxSteps: number;
	/** Serialized output ceiling. */
	maxOutputBytes: number;
}

/**
 * Bounds per intent. Investigate is the only iterative activity, so it is the
 * only one given a step budget above one.
 */
export const INTENT_BOUNDS: Readonly<Record<ReviewIntent, IntentBounds>> =
	Object.freeze({
		ask: Object.freeze({
			maxMs: 120_000,
			maxSteps: 1,
			maxOutputBytes: 32 * 1024,
		}),
		investigate: Object.freeze({
			maxMs: 300_000,
			maxSteps: 24,
			maxOutputBytes: 64 * 1024,
		}),
		propose: Object.freeze({
			maxMs: 120_000,
			maxSteps: 1,
			maxOutputBytes: 32 * 1024,
		}),
	});

export interface IntentRequest {
	intent: ReviewIntent;
	/** Only a person starts an activity; there is no background trigger. */
	trigger: "user";
	proposal?: ProposalKind;
}

export interface AdmittedIntent {
	intent: ReviewIntent;
	bounds: IntentBounds;
	/** True for every proposal: a draft is shown, never applied or published. */
	requiresHumanApproval: boolean;
	proposal: ProposalKind | null;
	/** What the activity is expected to return, so an empty answer is visible. */
	expects: readonly string[];
}

const EXPECTS: Readonly<Record<ReviewIntent, readonly string[]>> = Object.freeze(
	{
		// Explicit unknowns are part of the answer, not an omission.
		ask: Object.freeze(["citations", "unknowns"]),
		investigate: Object.freeze(["findings", "questions", "coverage"]),
		propose: Object.freeze(["draft", "citations"]),
	},
);

const PROPOSAL_KINDS: readonly ProposalKind[] = [
	"comment",
	"reply",
	"summary",
	"code-suggestion",
	"plan-revision",
];

/**
 * Validates an activity request and returns its bounds. A proposal must name
 * what it drafts, and only a proposal may name one.
 */
export function admitIntent(request: IntentRequest): AdmittedIntent {
	const intent = request?.intent;
	if (
		(intent !== "ask" && intent !== "investigate" && intent !== "propose") ||
		request.trigger !== "user"
	)
		throw new AiSnapshotError("invalid");

	if (intent === "propose") {
		if (!request.proposal || !PROPOSAL_KINDS.includes(request.proposal))
			throw new AiSnapshotError("invalid");
	} else if (request.proposal !== undefined)
		throw new AiSnapshotError("invalid");

	return {
		intent,
		bounds: INTENT_BOUNDS[intent],
		// A proposal is inert until a person accepts it.
		requiresHumanApproval: intent === "propose",
		proposal: intent === "propose" ? request.proposal! : null,
		expects: EXPECTS[intent],
	};
}

export interface StepBudget {
	steps: number;
	elapsedMs: number;
	outputBytes: number;
}

export interface BudgetVerdict {
	withinBounds: boolean;
	/** Which bound stopped the activity, so exhaustion is reported not hidden. */
	exceeded: "steps" | "duration" | "output" | null;
}

/**
 * Checks an activity against its bounds. Exhaustion is a reportable outcome —
 * an activity that ran out of budget must say so rather than present partial
 * work as complete.
 */
export function checkBudget(
	admitted: AdmittedIntent,
	used: StepBudget,
): BudgetVerdict {
	if (
		!Number.isFinite(used?.steps) ||
		!Number.isFinite(used?.elapsedMs) ||
		!Number.isFinite(used?.outputBytes) ||
		used.steps < 0 ||
		used.elapsedMs < 0 ||
		used.outputBytes < 0
	)
		throw new AiSnapshotError("invalid");
	const { bounds } = admitted;
	if (used.steps > bounds.maxSteps)
		return { withinBounds: false, exceeded: "steps" };
	if (used.elapsedMs > bounds.maxMs)
		return { withinBounds: false, exceeded: "duration" };
	if (used.outputBytes > bounds.maxOutputBytes)
		return { withinBounds: false, exceeded: "output" };
	return { withinBounds: true, exceeded: null };
}
