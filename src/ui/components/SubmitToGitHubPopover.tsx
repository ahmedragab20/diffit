import { useState, useMemo, useRef, useEffect } from "react";
import {
  GitPullRequest,
  Pencil,
  Trash2,
  Check,
  X,
  MessageSquare,
  MessageSquareWarning,
  AlertCircle,
  ExternalLink,
  FilePenLine,
} from "lucide-react";
import type { ReviewComment } from "../../lib/types";
import type { PrSession, PrDecision } from "../../lib/pr-session";
import { classifyPrComments } from "../../lib/github";
import { fileName } from "../utils";
import { Popover } from "../primitives/Popover";
import { MarkdownField } from "./MarkdownField";
import {
  useSubmitPrReview,
  type SubmitPrReviewResult,
} from "../hooks/usePrSession";
import { useFeedback } from "../hooks/useHaptics";
import {
  useSubmitPanelSize,
  SUBMIT_PANEL_PRESETS,
} from "../hooks/useSubmitPanelSize";

interface SubmitToGitHubPopoverProps {
  session: PrSession;
  comments: ReviewComment[];
  onEditComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
  onSubmitted?: (result: SubmitPrReviewResult) => void;
}

/**
 * GitHub-style "finish your review" flow for PR mode. Same shape as
 * {@link SendReviewPopover} but the action POSTs to `/api/gh/submit` and the
 * success toast links to the just-created review on github.com.
 */
export function SubmitToGitHubPopover({
  session,
  comments,
  onEditComment,
  onDeleteComment,
  onSubmitted,
}: SubmitToGitHubPopoverProps) {
  const { haptic, sound } = useFeedback();
  const submitMutation = useSubmitPrReview();
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<PrDecision | null>(
    session.reviewDecision ?? null,
  );
  const [general, setGeneral] = useState(session.reviewBody ?? "");
  const {
    popoverStyle,
    activePreset,
    applyPreset,
    startResize,
    startLeftResize,
    startCornerResize,
    handleOpenChange,
    panelRef,
  } = useSubmitPanelSize();

  const classified = useMemo(() => classifyPrComments(comments), [comments]);
  const publishable = useMemo(
    () =>
      [...classified.inline, ...classified.fileLevel].sort(
        (a, b) => a.createdAt - b.createdAt,
      ),
    [classified],
  );
  const count = publishable.length;

  const alreadySubmitted =
    !!session.submittedAt || session.publication?.state === "confirmed";

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void fetch("/api/gh/pr-session/review-draft", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: general, decision: verdict }),
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [general, verdict, open]);

  const handleSubmit = async () => {
    if (!verdict) return;
    haptic("heavy");
    sound("send");
    try {
      const result = await submitMutation.mutateAsync({
        decision: verdict,
        body: general,
      });
      onSubmitted?.(result);
      setGeneral("");
      setVerdict(null);
      setOpen(false);
    } catch {
      // surfaced via submitMutation.error
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => handleOpenChange(next, details, setOpen)}
      ariaLabel="Submit your review to GitHub"
      className="submit-to-github-popover"
      trigger={
        <button
          className="btn btn-primary btn-sm send-review-btn"
          disabled={submitMutation.isPending}
          title={
            alreadySubmitted
              ? "Already submitted"
              : "Submit your review to the PR on GitHub"
          }
          style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
        >
          <GitPullRequest size={14} />
          <span className="btn-label">
            {submitMutation.isPending
              ? "Submitting…"
              : alreadySubmitted
                ? "Submitted ✓"
                : count > 0
                  ? `Submit to GitHub (${count})`
                  : "Submit to GitHub"}
          </span>
        </button>
      }
    >
      <div className="srp" ref={panelRef} style={popoverStyle}>
        <div
          className="srp-resize-handle-left"
          onPointerDown={startLeftResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize submit panel width"
          tabIndex={0}
        />
        <div className="srp-head">
          <GitPullRequest size={15} aria-hidden="true" />
          <span className="srp-title">Submit review to GitHub</span>
          <div
            className="srp-size-presets"
            role="group"
            aria-label="Panel size"
          >
            {SUBMIT_PANEL_PRESETS.map((p, i) => (
              <button
                key={p.label}
                className="srp-preset-btn"
                role="radio"
                aria-checked={activePreset === i}
                aria-pressed={activePreset === i}
                onClick={() => applyPreset(p)}
                title={`${p.width}×${p.height}px`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <span className="srp-count">
            {count} comment{count === 1 ? "" : "s"}
          </span>
        </div>

        <div className="srp-scroll">
          {alreadySubmitted && (
            <div className="srp-already-submitted">
              <Check size={13} />
              <span>
                Already submitted as{" "}
                {session.submittedReviewUrl ? (
                  <a
                    href={session.submittedReviewUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    review #{session.submittedReviewId}{" "}
                    <ExternalLink size={11} />
                  </a>
                ) : (
                  `review #${session.submittedReviewId}`
                )}
                . Re-submitting will post a new review on the same PR.
              </span>
            </div>
          )}

          <div
            className="plan-verdict-options"
            role="radiogroup"
            aria-label="Verdict"
          >
            {VERDICT_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const selected = verdict === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`plan-verdict-option ${opt.className} ${selected ? "plan-verdict-option-selected" : ""}`}
                  onClick={() => setVerdict(opt.value)}
                >
                  <span className="plan-verdict-icon">
                    <Icon size={15} aria-hidden="true" />
                  </span>
                  <span className="plan-verdict-text">
                    <span className="plan-verdict-label">{opt.label}</span>
                    <span className="plan-verdict-desc">{opt.description}</span>
                  </span>
                  <span className="plan-verdict-radio" aria-hidden="true" />
                </button>
              );
            })}
          </div>

          {count > 0 ? (
            <section
              className="srp-comments-section"
              aria-labelledby="srp-gh-comments-title"
            >
              <div className="srp-section-heading" id="srp-gh-comments-title">
                <MessageSquare size={13} aria-hidden="true" />
                <span>Inline comments to publish</span>
                <span className="srp-section-count">{count}</span>
              </div>
              <ul className="srp-list" aria-label="Comments to send">
                {publishable.map((c) => (
                  <CommentRow
                    key={c.id}
                    comment={c}
                    onEdit={onEditComment}
                    onDelete={onDeleteComment}
                  />
                ))}
              </ul>
            </section>
          ) : (
            <p className="srp-empty">
              No inline comments — your verdict and overall note will be sent on
              their own.
            </p>
          )}

          <div className="srp-general">
            <label className="srp-general-label" htmlFor="srp-gh-general-input">
              Overall comment{" "}
              <span className="srp-optional">(optional · Markdown)</span>
            </label>
            <MarkdownField
              id="srp-gh-general-input"
              value={general}
              onChange={setGeneral}
              textareaClassName="srp-general-input"
              placeholder="Add an overall note for the PR that applies to the whole review…"
              rows={3}
              ariaLabel="Overall PR review comment"
              onSubmitShortcut={handleSubmit}
            />
          </div>

          {submitMutation.isError && (
            <div className="srp-error" role="alert">
              <AlertCircle size={13} />
              <span>{submitMutation.error?.message ?? "Submit failed"}</span>
            </div>
          )}
        </div>

        <div className="srp-footer">
          <button
            className="btn btn-sm"
            onClick={() => setOpen(false)}
            disabled={submitMutation.isPending}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!verdict || submitMutation.isPending}
          >
            {submitMutation.isPending
              ? "Submitting…"
              : verdict === "draft"
                ? "Save draft review"
                : "Submit review"}
          </button>
        </div>
        <div
          className="srp-resize-handle"
          onPointerDown={startResize}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize submit panel"
          tabIndex={0}
        />
        <div
          className="srp-resize-handle-corner"
          onPointerDown={startCornerResize}
          role="separator"
          aria-label="Resize submit panel width and height"
          tabIndex={0}
        />
      </div>
    </Popover>
  );
}

const VERDICT_OPTIONS: {
  value: PrDecision;
  label: string;
  description: string;
  icon: typeof Check;
  className: string;
}[] = [
  {
    value: "approve",
    label: "Approve",
    description: "The PR is good — submit an APPROVE review.",
    icon: Check,
    className: "plan-verdict-approve",
  },
  {
    value: "comment",
    label: "Comment",
    description: "Leave neutral feedback (no approve / no request changes).",
    icon: MessageSquareWarning,
    className: "plan-verdict-changes",
  },
  {
    value: "request-changes",
    label: "Request changes",
    description: "The author must address the comments before merging.",
    icon: X,
    className: "plan-verdict-reject",
  },
  {
    value: "draft",
    label: "Save as draft",
    description:
      "Post a PENDING review on GitHub — finish it later in the PR UI.",
    icon: FilePenLine,
    className: "plan-verdict-comment-only",
  },
];

function CommentRow({
  comment,
  onEdit,
  onDelete,
}: {
  comment: ReviewComment;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  const lineLabel =
    comment.lineNumber > 0
      ? comment.startLineNumber &&
        comment.startLineNumber !== comment.lineNumber
        ? `:${comment.startLineNumber}-${comment.lineNumber}`
        : `:${comment.lineNumber}`
      : " · file";

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== comment.body) onEdit(comment.id, trimmed);
    setEditing(false);
  };

  return (
    <li className="srp-item">
      <div className="srp-item-top">
        <span className="srp-item-loc">
          <span className="srp-item-file">{fileName(comment.filePath)}</span>
          <span className="srp-item-line">{lineLabel}</span>
        </span>
        {comment.status === "resolved" && (
          <span className="srp-item-resolved">resolved</span>
        )}
        <span className="srp-item-actions">
          {editing ? (
            <>
              <button className="srp-icon-btn" onClick={save} title="Save edit">
                <Check size={13} aria-hidden="true" />
              </button>
              <button
                className="srp-icon-btn"
                onClick={() => {
                  setDraft(comment.body);
                  setEditing(false);
                }}
                title="Cancel edit"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </>
          ) : (
            <button
              className="srp-icon-btn"
              onClick={() => setEditing(true)}
              title="Edit comment"
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
          )}
          <button
            className="srp-icon-btn srp-icon-btn-danger"
            onClick={() => onDelete(comment.id)}
            title="Remove from review"
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </span>
      </div>

      {comment.lineContent?.trim() && (
        <code className="srp-item-code">
          {comment.lineContent.trim().slice(0, 160)}
        </code>
      )}

      {editing ? (
        <textarea
          ref={ref}
          className="srp-item-edit"
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(comment.body);
              setEditing(false);
            }
          }}
        />
      ) : (
        <p className="srp-item-body">{comment.body}</p>
      )}
    </li>
  );
}
