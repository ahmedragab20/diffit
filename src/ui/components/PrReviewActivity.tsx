import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  MessageCircle,
  XCircle,
} from "lucide-react";
import type { PrExistingReview } from "../../lib/pr-session";
import { timeAgo } from "../utils";
import { Markdown } from "./Markdown";
import { ConfirmDialog } from "../primitives/ConfirmDialog";

const REVIEW_STATE = {
  APPROVED: {
    label: "approved these changes",
    short: "Approved",
    icon: CheckCircle2,
  },
  CHANGES_REQUESTED: {
    label: "requested changes",
    short: "Changes requested",
    icon: XCircle,
  },
  COMMENTED: {
    label: "left a review comment",
    short: "Commented",
    icon: MessageCircle,
  },
  PENDING: {
    label: "started a pending review",
    short: "Pending",
    icon: Clock3,
  },
  DISMISSED: {
    label: "had a review dismissed",
    short: "Dismissed",
    icon: XCircle,
  },
} as const;

type PendingReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** Walk submitted GitHub reviews without mixing review-level notes into line threads or PR alerts. */
export function PrReviewActivity({
  reviews,
  onSubmitPending,
  onDiscardPending,
}: {
  reviews: PrExistingReview[];
  onSubmitPending?: (
    reviewId: number,
    event: PendingReviewEvent,
  ) => Promise<void>;
  onDiscardPending?: (reviewId: number) => Promise<void>;
}) {
  const ordered = [...reviews].sort((a, b) => {
    if (a.state === "PENDING" && b.state !== "PENDING") return -1;
    if (a.state !== "PENDING" && b.state === "PENDING") return 1;
    return 0;
  });
  const [activeId, setActiveId] = useState<number | null>(
    ordered[0]?.id ?? null,
  );
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  useEffect(() => {
    setActiveId(ordered[0]?.id ?? null);
  }, [ordered[0]?.id]);

  useEffect(() => {
    setFailedAvatarUrl(null);
    setError(null);
  }, [activeId]);

  if (ordered.length === 0) return null;
  const activeIndex = Math.max(
    0,
    ordered.findIndex((review) => review.id === activeId),
  );
  const review = ordered[activeIndex] ?? ordered[0];
  const runPending = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Pending review action failed",
      );
    } finally {
      setBusy(false);
    }
  };
  const state = REVIEW_STATE[review.state];
  const StateIcon = state.icon;
  const submittedAt = review.submittedAt
    ? new Date(review.submittedAt).getTime()
    : null;

  return (
    <section className="pr-review-activity" aria-label="GitHub review activity">
      <header className="pr-review-activity-head">
        <div className="pr-review-activity-identity">
          {review.author?.avatarUrl &&
          failedAvatarUrl !== review.author.avatarUrl ? (
            <img
              src={`/api/gh/avatar?url=${encodeURIComponent(review.author.avatarUrl)}`}
              alt=""
              className="pr-review-activity-avatar"
              referrerPolicy="no-referrer"
              onError={() =>
                setFailedAvatarUrl(review.author?.avatarUrl ?? null)
              }
            />
          ) : (
            <span
              className="pr-review-activity-avatar is-fallback"
              aria-hidden="true"
            >
              <StateIcon size={14} />
            </span>
          )}
          <StateIcon
            className="pr-review-activity-state-icon"
            data-state={review.state}
            size={16}
            aria-hidden="true"
          />
          <span>
            <strong>@{review.author?.login ?? "unknown"}</strong> {state.label}
          </span>
          {submittedAt != null && (
            <time
              dateTime={review.submittedAt!}
              title={new Date(submittedAt).toLocaleString()}
            >
              {timeAgo(submittedAt)}
            </time>
          )}
          <span
            className="pr-review-activity-verdict"
            data-state={review.state}
          >
            {state.short}
          </span>
        </div>

        <nav
          className="pr-review-activity-nav"
          aria-label="Walk GitHub reviews"
        >
          <button
            type="button"
            className="btn btn-sm commit-walk-btn"
            disabled={activeIndex === 0}
            onClick={() =>
              setActiveId(ordered[activeIndex - 1]?.id ?? review.id)
            }
            aria-label="Newer review"
            title="Newer review"
          >
            <ChevronLeft size={14} />
          </button>
          <span>
            {activeIndex + 1} / {ordered.length}
          </span>
          <button
            type="button"
            className="btn btn-sm commit-walk-btn"
            disabled={activeIndex >= ordered.length - 1}
            onClick={() =>
              setActiveId(ordered[activeIndex + 1]?.id ?? review.id)
            }
            aria-label="Older review"
            title="Older review"
          >
            <ChevronRight size={14} />
          </button>
          {review.htmlUrl && (
            <a
              className="pr-review-activity-link"
              href={review.htmlUrl}
              target="_blank"
              rel="noreferrer"
            >
              View on GitHub <ExternalLink size={11} />
            </a>
          )}
        </nav>
      </header>

      {review.body.trim() ? (
        <Markdown
          content={review.body}
          className="pr-review-activity-body markdown-body"
        />
      ) : (
        <p className="pr-review-activity-empty">
          No overall comment was submitted with this review.
        </p>
      )}

      {review.state === "PENDING" && (onSubmitPending || onDiscardPending) && (
        <div className="pr-pending-review-actions">
          <p>
            This pending review can be finished here without going to GitHub.
          </p>
          {error && <p role="alert">{error}</p>}
          {onSubmitPending && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  void runPending(() => onSubmitPending(review.id, "COMMENT"))
                }
              >
                Submit as comment
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  void runPending(() => onSubmitPending(review.id, "APPROVE"))
                }
              >
                Approve
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  void runPending(() =>
                    onSubmitPending(review.id, "REQUEST_CHANGES"),
                  )
                }
              >
                Request changes
              </button>
            </>
          )}
          {onDiscardPending && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => setDiscardOpen(true)}
            >
              Discard pending review
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={discardOpen}
        title="Discard pending review?"
        description="This deletes the unpublished GitHub pending review. Local drafts are kept."
        confirmLabel="Discard"
        variant="danger"
        busy={busy}
        onConfirm={() => {
          if (!onDiscardPending) return;
          void runPending(() => onDiscardPending(review.id)).finally(() =>
            setDiscardOpen(false),
          );
        }}
        onCancel={() => setDiscardOpen(false)}
      />
    </section>
  );
}
