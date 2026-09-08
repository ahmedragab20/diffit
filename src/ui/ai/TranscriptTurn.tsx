import { memo } from "react";
import { Check, Copy } from "lucide-react";
import { Markdown } from "../components/Markdown";
import type { AiConversationTurn } from "../../lib/ai/types";

/**
 * One completed assistant turn.
 *
 * Memoized deliberately: the plan requires not "reparsing the entire
 * transcript per token" and to "memoize completed turns and completed Markdown
 * blocks". A completed turn's content never changes, so re-rendering it while
 * the active response streams is pure waste — and on a long transcript it is
 * the difference between a smooth stream and a stuttering one.
 *
 * The comparator is therefore explicit: a turn re-renders only when its own
 * identity, text or copied state changes, never because a sibling is
 * streaming.
 */
export interface TranscriptTurnProps {
	turn: AiConversationTurn;
	copied: boolean;
	onCopy: (turn: AiConversationTurn) => void;
}

function TranscriptTurnView({ turn, copied, onCopy }: TranscriptTurnProps) {
	return (
		<article className="ai-response-document" data-turn-id={turn.id}>
			<Markdown
				content={turn.text}
				className="markdown-body ai-response-markdown"
			/>
			<div className="ai-message-actions">
				<button
					type="button"
					onClick={() => onCopy(turn)}
					aria-label={`Copy response ${turn.id}`}
				>
					{copied ? <Check size={12} /> : <Copy size={12} />}{" "}
					{copied ? "Copied" : "Copy Markdown"}
				</button>
			</div>
		</article>
	);
}

export const TranscriptTurn = memo(
	TranscriptTurnView,
	(previous, next) =>
		previous.turn.id === next.turn.id &&
		previous.turn.text === next.turn.text &&
		previous.copied === next.copied &&
		previous.onCopy === next.onCopy,
);
