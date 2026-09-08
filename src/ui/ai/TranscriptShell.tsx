import { memo } from "react";
import { ActivityList } from "./ActivityList";
import { FindingCard } from "./FindingCard";
import { TranscriptTurn } from "./TranscriptTurn";
import type { RunActivity } from "../../lib/ai/activity";
import type { NotebookEntry } from "../../lib/ai/notebook";
import type { AiConversationTurn } from "../../lib/ai/types";
import type { CitationStatus } from "./FindingCard";

/**
 * The composed transcript: completed turns, the active response, run activity
 * and cited findings in one column.
 *
 * This is a proposal, not a rollout. The plan requires human visual review to
 * "confirm that the result still looks and feels like diffing before rollout",
 * so it ships behind a default-off flag: nothing renders it unless someone
 * turns it on to look at it.
 *
 * Composition rules that are not cosmetic:
 *  - Completed turns render through the memoized component, so a streamed
 *    token does not re-parse the transcript above it.
 *  - The active response is rendered separately and never merged into the
 *    completed list, so a stream cannot rewrite settled history.
 *  - Activity sits with the active response, not at the top, so a long
 *    transcript does not push the run's status off screen.
 */
export interface TranscriptShellProps {
	turns: AiConversationTurn[];
	activity: RunActivity;
	/** The streaming response, if one is in flight. */
	streaming?: { turn: AiConversationTurn; text: string } | null;
	findings?: NotebookEntry[];
	verification?: Record<string, CitationStatus>;
	copiedId?: string | null;
	onCopy: (turn: AiConversationTurn) => void;
	onRetry?: () => void;
}

function TranscriptShellView({
	turns,
	activity,
	streaming,
	findings = [],
	verification,
	copiedId,
	onCopy,
	onRetry,
}: TranscriptShellProps) {
	const terminalFailure =
		activity.phase === "failed" ||
		activity.phase === "interrupted" ||
		activity.phase === "canceled";

	return (
		<div className="ai-transcript" data-phase={activity.phase}>
			{turns.length === 0 && !streaming && (
				<p className="ai-transcript-empty">
					Nothing has been asked in this conversation yet.
				</p>
			)}

			{turns.map((turn) =>
				turn.role === "user" ? (
					<article className="ai-request-document" key={turn.id}>
						{turn.text}
					</article>
				) : (
					<TranscriptTurn
						key={turn.id}
						turn={turn}
						copied={copiedId === turn.id}
						onCopy={onCopy}
					/>
				),
			)}

			{findings.length > 0 && (
				<section className="ai-transcript-findings" aria-label="Cited findings">
					{findings.map((entry) => (
						<FindingCard
							key={entry.id}
							entry={entry}
							verification={verification}
						/>
					))}
				</section>
			)}

			{streaming && (
				<>
					<article className="ai-request-document">
						{streaming.turn.text}
					</article>
					{/* Kept out of the completed list: a stream never rewrites history. */}
					<article className="ai-response-document" data-streaming="true">
						{streaming.text}
					</article>
				</>
			)}

			<ActivityList activity={activity} />

			{terminalFailure && onRetry && (
				<div className="ai-transcript-retry">
					<button type="button" className="btn btn-sm" onClick={onRetry}>
						Try again
					</button>
					{/* A retry is a new attempt, never an overwrite of this one. */}
					<span>This starts a new attempt and keeps the one above.</span>
				</div>
			)}
		</div>
	);
}

export const TranscriptShell = memo(TranscriptShellView);
