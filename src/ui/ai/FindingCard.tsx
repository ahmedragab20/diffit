import { memo } from "react";
import type { NotebookEntry } from "../../lib/ai/notebook";

/**
 * One notebook entry, rendered honestly.
 *
 * The plan specifies both the contents — claim, uncertainty, evidence
 * references, verification status — and the rule that governs them: "invalid
 * citations are rejected or shown as unverified, not converted into
 * authoritative findings."
 *
 * So verification is presented, never assumed. A citation the capture could
 * not confirm is labelled unverified and the card itself is marked unverified,
 * rather than being dropped (which would hide it) or rendered identically to a
 * confirmed one (which would launder it).
 */
export type CitationStatus = "verified" | "unverified";

export interface FindingCardProps {
	entry: NotebookEntry;
	/** Verification per citation id. A citation absent here is not verified. */
	verification?: Record<string, CitationStatus>;
}

const KIND_LABEL: Record<NotebookEntry["kind"], string> = {
	finding: "Finding",
	proposal: "Proposal",
	question: "Question",
};

function FindingCardView({ entry, verification = {} }: FindingCardProps) {
	const statuses = entry.citations.map(
		(citation) => verification[citation.evidenceId] ?? "unverified",
	);
	const unverified = statuses.filter((status) => status !== "verified").length;

	return (
		<article
			className="ai-finding-card"
			data-entry-id={entry.id}
			data-kind={entry.kind}
			data-unverified={unverified > 0 ? "true" : "false"}
			aria-labelledby={`finding-title-${entry.id}`}
		>
			<header className="ai-finding-head">
				<span className="ai-finding-kind">{KIND_LABEL[entry.kind]}</span>
				<h4 className="ai-finding-title" id={`finding-title-${entry.id}`}>
					{entry.title}
				</h4>
				<span className="ai-finding-uncertainty" data-level={entry.uncertainty}>
					{entry.uncertainty} confidence
				</span>
			</header>

			<p className="ai-finding-body">{entry.body}</p>

			{unverified > 0 && (
				// Stated plainly rather than styled away: an unverified card is not
				// an authoritative finding.
				<p className="ai-finding-warning" role="status">
					{unverified} of {entry.citations.length} citations could not be
					verified against this capture.
				</p>
			)}

			<ul className="ai-finding-citations">
				{entry.citations.map((citation, index) => (
					<li
						key={citation.evidenceId}
						className="ai-finding-citation"
						data-status={statuses[index]}
					>
						<span className="ai-finding-source">
							{citation.key}:{citation.startLine}
							{citation.endLine === citation.startLine
								? ""
								: `-${citation.endLine}`}
						</span>
						<span className="ai-finding-status">{statuses[index]}</span>
						<code className="ai-finding-quote">{citation.quote}</code>
					</li>
				))}
			</ul>

			<footer className="ai-finding-foot">
				{entry.decision ? (
					<span className="ai-finding-decision" data-decision={entry.decision}>
						{entry.decision}
						{entry.decidedBy ? ` by ${entry.decidedBy}` : ""}
					</span>
				) : (
					<span className="ai-finding-decision" data-decision="undecided">
						awaiting decision
					</span>
				)}
				{entry.links.length > 0 && (
					<span className="ai-finding-links">
						links: {entry.links.join(", ")}
					</span>
				)}
			</footer>
		</article>
	);
}

export const FindingCard = memo(FindingCardView);
