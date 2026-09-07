/**
 * Combined PR conversation timeline: description, issue comments, review
 * notes, and selected GitHub timeline events. Source of truth is the session
 * store — callers page this projection rather than refetching GitHub.
 */
import type {
  PrExistingReview,
  PrIssueComment,
  PrSession,
  PrTimelineEvent,
} from "./pr-session.js";

export type PrTimelineKind =
  | "pr-description"
  | "issue-comment"
  | "review"
  | "timeline-event";

export interface PrTimelineItem {
  id: string;
  kind: PrTimelineKind;
  createdAt: string;
  author: string | null;
  body?: string;
  htmlUrl?: string;
  reviewState?: PrExistingReview["state"];
  event?: string;
  label?: string;
}

export interface TimelinePage {
  returned: number;
  total: number;
  nextCursor: number | null;
  items: PrTimelineItem[];
}

function reviewTime(review: PrExistingReview): string {
  return review.submittedAt ?? "";
}

export function buildPrTimeline(session: PrSession): PrTimelineItem[] {
  const items: PrTimelineItem[] = [];
  if (session.body?.trim()) {
    items.push({
      id: "pr-description",
      kind: "pr-description",
      createdAt: session.createdAt ?? "",
      author: session.author?.login ?? null,
      body: session.body,
      htmlUrl: session.url,
    });
  }
  for (const comment of session.issueComments ?? []) {
    items.push({
      id: `issue-comment:${comment.id}`,
      kind: "issue-comment",
      createdAt: comment.createdAt,
      author: comment.author?.login ?? null,
      body: comment.body,
      htmlUrl: comment.htmlUrl,
    });
  }
  for (const review of session.existingReviews ?? []) {
    items.push({
      id: `review:${review.id}`,
      kind: "review",
      createdAt: reviewTime(review),
      author: review.author?.login ?? null,
      body: review.body,
      htmlUrl: review.htmlUrl,
      reviewState: review.state,
    });
  }
  for (const event of session.timelineEvents ?? []) {
    items.push({
      id: event.id,
      kind: "timeline-event",
      createdAt: event.createdAt,
      author: event.actor?.login ?? null,
      event: event.event,
      label: event.label,
    });
  }
  return items.sort((a, b) => {
    if (a.kind === "pr-description" && b.kind !== "pr-description") return -1;
    if (a.kind !== "pr-description" && b.kind === "pr-description") return 1;
    return (a.createdAt || "").localeCompare(b.createdAt || "");
  });
}

export function paginatePrTimeline(
  session: PrSession,
  opts: { cursor?: number; limit?: number } = {},
): TimelinePage {
  const cursor = Math.max(0, opts.cursor ?? 0);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const items = buildPrTimeline(session);
  const total = items.length;
  const slice = items.slice(cursor, cursor + limit);
  const end = cursor + slice.length;
  return {
    returned: slice.length,
    total,
    nextCursor: end < total ? end : null,
    items: slice,
  };
}

export function issueCommentFromGh(raw: any): PrIssueComment | null {
  if (typeof raw?.id !== "number") return null;
  return {
    id: raw.id,
    author: raw.user?.login
      ? { login: raw.user.login, avatarUrl: raw.user.avatar_url }
      : null,
    body: typeof raw.body === "string" ? raw.body : "",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? raw.created_at ?? "",
    htmlUrl: raw.html_url,
  };
}

const TIMELINE_KEEP = new Set([
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "closed",
  "reopened",
  "merged",
  "ready_for_review",
  "convert_to_draft",
  "review_requested",
  "review_request_removed",
  "head_ref_force_pushed",
  "renamed",
  "connected",
  "disconnected",
  "milestoned",
  "demilestoned",
]);

export function timelineEventFromGh(raw: any): PrTimelineEvent | null {
  const event = typeof raw?.event === "string" ? raw.event : "";
  if (!TIMELINE_KEEP.has(event)) return null;
  const createdAt = raw.created_at ?? raw.submitted_at ?? "";
  const id =
    typeof raw.id === "number" || typeof raw.id === "string"
      ? `event:${raw.id}`
      : `event:${event}:${createdAt}`;
  return {
    id,
    event,
    createdAt,
    actor: raw.actor?.login
      ? { login: raw.actor.login, avatarUrl: raw.actor.avatar_url }
      : raw.user?.login
        ? { login: raw.user.login, avatarUrl: raw.user.avatar_url }
        : null,
    label: raw.label?.name,
    assignee: raw.assignee?.login,
    commitId: raw.commit_id,
    rename:
      raw.rename?.from && raw.rename?.to
        ? { from: String(raw.rename.from), to: String(raw.rename.to) }
        : undefined,
  };
}

export function mergeBlockedReason(
  session: Pick<
    PrSession,
    "state" | "isDraft" | "mergeable" | "mergeStateStatus"
  >,
): string | null {
  if (session.state === "merged") return "Pull request is already merged";
  if (session.state === "closed") return "Pull request is closed";
  if (session.isDraft) return "Draft pull requests cannot be merged";
  const status = (session.mergeStateStatus ?? "").toLowerCase();
  if (status === "dirty") return "Pull request has merge conflicts";
  if (status === "blocked") {
    return "Merge is blocked by branch protection or required checks";
  }
  if (session.mergeable === "CONFLICTING") {
    return "Pull request has merge conflicts";
  }
  return null;
}
