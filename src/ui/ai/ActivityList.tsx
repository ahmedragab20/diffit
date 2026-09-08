import { memo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { RunActivity } from "../../lib/ai/activity";

/**
 * A compact, expandable account of what a run actually did.
 *
 * The plan is blunt about what this must not do: "do not invent percentages,
 * pretend to expose private model reasoning, or animate a false success". The
 * activity model already withholds a progress fraction, so this cannot render
 * one; what remains is to present the phase and the counted facts truthfully.
 *
 * Two consequences worth naming:
 *  - A terminal phase that is not `complete` is stated as such. An interrupted
 *    run is never dressed as a finished one.
 *  - Partial output is labelled partial, so a reader is not left to assume the
 *    text they can see is the whole answer.
 */
const PHASE_LABEL: Record<RunActivity["phase"], string> = {
	disconnected: "Not started",
	preparing: "Preparing",
	reading: "Reading evidence",
	responding: "Responding",
	reconnecting: "Reconnecting",
	"cancel-requested": "Cancelling",
	canceled: "Canceled",
	interrupted: "Interrupted",
	failed: "Failed",
	complete: "Complete",
};

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

export interface ActivityListProps {
	activity: RunActivity;
	defaultExpanded?: boolean;
}

function ActivityListView({ activity, defaultExpanded }: ActivityListProps) {
	const [expanded, setExpanded] = useState(defaultExpanded === true);
	const { steps } = activity;
	const failedSteps = steps.filter((step) => step.outcome === "failed").length;

	return (
		<section
			className="ai-activity"
			data-phase={activity.phase}
			data-partial={activity.partial ? "true" : "false"}
			aria-label="Run activity"
		>
			<button
				type="button"
				className="ai-activity-head"
				aria-expanded={expanded}
				onClick={() => setExpanded((open) => !open)}
			>
				{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				<span className="ai-activity-phase">{PHASE_LABEL[activity.phase]}</span>
				<span className="ai-activity-counts">
					{steps.length} {steps.length === 1 ? "step" : "steps"}
					{failedSteps > 0 ? `, ${failedSteps} failed` : ""}
				</span>
				<span className="ai-activity-elapsed">{seconds(activity.elapsedMs)}</span>
			</button>

			{/* Status is announced without rereading the whole transcript. */}
			<p className="ai-activity-status" role="status">
				{PHASE_LABEL[activity.phase]}
				{activity.attempt > 1 ? ` · attempt ${activity.attempt}` : ""}
				{activity.partial ? " · partial output" : ""}
				{activity.errorCode ? ` · ${activity.errorCode}` : ""}
			</p>

			{expanded && (
				<ol className="ai-activity-steps">
					{steps.length === 0 && (
						<li className="ai-activity-step" data-outcome="none">
							No evidence reads recorded yet.
						</li>
					)}
					{steps.map((step, index) => (
						<li
							className="ai-activity-step"
							data-outcome={step.outcome}
							key={`${step.at}-${index}`}
						>
							<span className="ai-activity-step-label">{step.label}</span>
							<span className="ai-activity-step-outcome">{step.outcome}</span>
						</li>
					))}
				</ol>
			)}

			{activity.warnings.length > 0 && (
				<ul className="ai-activity-warnings">
					{activity.warnings.map((warning) => (
						<li key={warning}>{warning}</li>
					))}
				</ul>
			)}
		</section>
	);
}

export const ActivityList = memo(ActivityListView);
