import { memo } from "react";
import { Markdown } from "../components/Markdown";
import { ActivityList } from "./ActivityList";
import { FindingCard } from "./FindingCard";
import { TranscriptTurn } from "./TranscriptTurn";
import type { RunActivity } from "../../lib/ai/activity";
import type { NotebookEntry } from "../../lib/ai/notebook";
import type { AiConversationTurn } from "../../lib/ai/types";
import type { CitationStatus } from "./FindingCard";

/**
 * The composed transcript the assistant rail mounts: completed turns, the
 * in-flight response, run activity, cited findings, and retry after a
 * terminal failure.
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

function UserTurn({ turn }: { turn: AiConversationTurn }) {
	const images = turn.context?.imageAttachments ?? [];
	return (
		<article className="ai-message ai-message-user" data-turn-id={turn.id}>
			<span>{turn.text}</span>
			{images.length > 0 && (
				<div className="ai-message-images">
					{images.map((image) => (
						<img
							key={image.url}
							src={image.url}
							alt={image.name}
							title={image.name}
						/>
					))}
				</div>
			)}
		</article>
	);
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
	const waiting =
		activity.phase === "preparing" ||
		activity.phase === "responding" ||
		activity.phase === "cancel-requested";

	return (
		<div className="ai-transcript" data-phase={activity.phase}>
			{turns.length === 0 && !streaming && findings.length === 0 && (
				<p className="ai-transcript-empty">
					Nothing has been asked in this conversation yet.
				</p>
			)}

			{turns.map((turn) =>
				turn.role === "user" ? (
					<UserTurn key={turn.id} turn={turn} />
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
					<UserTurn turn={streaming.turn} />
					{streaming.text ? (
						<article className="ai-response-document" data-streaming="true">
							<Markdown
								content={streaming.text}
								className="markdown-body ai-response-markdown"
							/>
						</article>
					) : waiting ? (
						<div className="ai-thinking" role="status">
							<span className="ai-thinking-mark" aria-hidden="true" />
							<span>
								{activity.phase === "cancel-requested"
									? "Stopping this request"
									: "Thinking about your request"}
							</span>
						</div>
					) : null}
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
