import type { CommentReply, CommentSeverity } from "./types.js";

/**
 * Plan review data model. A "plan" is any markdown document an AI agent emits
 * before doing work (a step-by-step implementation plan, a design proposal,
 * etc.). diffing renders it line-addressably so a human can comment on specific
 * lines/sections and approve, reject, or request changes — then hands the
 * structured decision back to the waiting agent, mirroring the diff-review
 * handoff.
 */

/** The human's verdict on a plan. `pending` until they submit a review. */
export type PlanDecision =
 | "pending"
 | "approved"
 | "rejected"
 | "changes-requested"
 | "comment-only";

/**
 * Mode controlling agent behavior on plan review handoff.
 * - `standard`: Agent addresses comments and applies edits (default).
 * - `comment-only`: Agent MUST NOT edit files; only replies to comments.
 */
export type PlanMode = "standard" | "comment-only";

export interface PlanComment {
 id: string;
 /**
  * 1-based line in the plan body the comment is anchored to. `0` marks a
  * whole-plan ("general") comment with no specific line.
  */
 lineNumber: number;
 /** Start of a multi-line selection (inclusive). Omitted for single lines. */
 startLineNumber?: number;
 /**
  * Snapshot of the full source line(s) the comment is anchored to (1-based
  * range). Always the raw plan markdown lines — not the rendered HTML.
  */
 lineContent: string;
 /**
  * Exact user highlight from the rendered pane, when the comment was created
  * via text selection. Agents should treat this as the primary quote the
  * human pointed at; `lineContent` is the surrounding source line(s).
  */
 selectedQuote?: string;
 /** Nearest preceding markdown heading, captured so the agent knows the section. */
 sectionTitle?: string;
 /**
  * Optional triage severity (same vocabulary as diff comments).
  * Emitted as `severity="blocking|nit|question|praise"` in the agent handoff.
  */
 severity?: CommentSeverity;
 body: string;
 status: "open" | "resolved";
 createdAt: number;
 /**
  * `plan.version` at the moment the comment was created. Lets the viewer
  * filter comments to those anchored to the version the user is reading.
  * Replies inherit this from their parent comment.
  */
 createdAtPlanVersion: number;
 replies: CommentReply[];
 /**
  * Discriminator so the synthetic comment created from a verdict's overall
  * note can be addressed like any other thread. Defaults to `'general'` for
  * legacy plans and ordinary inline comments. The verdict's note is promoted
  * to a `kind: 'decision'` comment so the agent has a replyable handle for
  * "rewrite the whole thing" / bare "rejected" verdicts — see
  * `Plan.decisionCommentId` and the ambiguous-verdict detection in
  * `/api/plans/:id/decision`.
  */
 kind?: "general" | "decision";
}

export interface PlanVersion {
 /**
  * Monotonically increasing; matches `Plan.version` at the moment this
  * snapshot was captured (i.e. the version whose body is `body`).
  */
 version: number;
 /** Absent on legacy records whose historical provenance cannot be established. */
 provenance?: "recorded" | "reconstructed";
 /** Raw markdown that was submitted for this version. */
 body: string;
 /** Title at the time of capture — titles can change between submissions. */
 title: string;
 source?: string;
 model?: string;
 /** Epoch ms the version was submitted. */
 createdAt: number;
}

export interface Plan {
 id: string;
 title: string;
 /** Raw markdown source of the plan's CURRENT version. */
 body: string;
 /** Free-form origin label, e.g. an agent/tool name or a file path. */
 source?: string;
 /**
  * Absolute path to the on-disk markdown source for this plan (written under
  * `~/.diffing/<repo>/plan-sources/<id>.md` on every upsert). Prefer this for
  * "copy path" / agent handoff; `source` may be a short label instead.
  */
 sourcePath?: string;
 /** The model that authored the plan, when known. */
 model?: string;
 createdAt: number;
 updatedAt: number;
 /** Bumped each time the agent resubmits a revised body for the same plan id. */
 version: number;
 decision: PlanDecision;
 /** The overall note the human attached to their approve/reject/changes verdict. */
 decisionComment?: string;
 /** Epoch ms the human submitted the decision. */
 decidedAt?: number;
 /**
  * Ordered history of submitted bodies, oldest-first. The LAST entry's
  * `body` is always equal to `plan.body`. Always has at least one entry.
  */
 versions: PlanVersion[];
 comments: PlanComment[];
}
