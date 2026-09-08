import { useState, useEffect, useRef } from "react";
import {
  CheckCircle2,
  Bot,
  User,
  Reply,
  Pencil,
  Trash2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { ReviewComment } from "../../lib/types";
import { timeAgo } from "../utils";
import { Markdown } from "./Markdown";
import { SeverityBadge } from "./SeverityBadge";
import { useComments } from "../hooks/useComments";
import { CommentForm } from "./CommentForm";
import { NoticeDialog } from "../primitives/NoticeDialog";

import { useScopedCommentActions, type CommentActions } from "./CommentActionsProvider";

interface CommentBubbleProps {
  comment: ReviewComment;
  onDelete: (id: string) => void;
}

function AvatarIcon({
  role,
  size = 16,
}: {
  role: "user" | "agent";
  size?: number;
}) {
  if (role === "agent") {
    return (
      <div
        className={`comment-avatar-circle comment-avatar-agent comment-avatar-size-${size}`}
      >
        <Bot size={size} aria-hidden="true" />
      </div>
    );
  }
  return (
    <div
      className={`comment-avatar-circle comment-avatar-user comment-avatar-size-${size}`}
    >
      <User size={size} aria-hidden="true" />
    </div>
  );
}

export function CommentBubble(props: CommentBubbleProps) {
  const actions = useScopedCommentActions();
  return actions ? <CommentBubbleContent {...props} actions={actions} /> : <LocalCommentBubble {...props} />;
}

function LocalCommentBubble(props: CommentBubbleProps) {
  const actions = useComments();
  return <CommentBubbleContent {...props} actions={actions} />;
}

function CommentBubbleContent({ comment, onDelete, actions }: CommentBubbleProps & { actions: CommentActions }) {
  const [, setTick] = useState(0);
  const { resolveComment, unresolveComment, addReply, removeReply, editReply, applySuggestion, editComment } = actions;
  const [actionError, setActionError] = useState<string | null>(null);
  const runStatusAction = async (action: () => void | Promise<unknown>) => {
    try { await action(); } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update conversation");
    }
  };
  const isResolved = comment.status === "resolved";
  /** Open threads start expanded; resolved start collapsed. User can toggle either. */
  const [collapsed, setCollapsed] = useState(isResolved);
  const [isReplying, setIsReplying] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [applyingSuggestion, setApplyingSuggestion] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);

  const firstActionBtnRef = useRef<HTMLButtonElement>(null);

  const remainingBody = comment.body
    .replace(/```suggestion\n([\s\S]*?)```/g, "")
    .trim();
  const hasBodyContent = remainingBody.length > 0;
  const bodyPreview = comment.body.replace(/\s+/g, " ").trim().slice(0, 72);
  const replyCount = comment.replies?.length ?? 0;

  useEffect(() => {
    if (comment.status === "resolved") setCollapsed(true);
  }, [comment.status]);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const handleResolve = () => { void runStatusAction(() => resolveComment(comment.id)); };
  const handleUnresolve = () => { void runStatusAction(() => unresolveComment(comment.id)); };

  const handleStartEditReply = (replyId: string) => {
    setEditingReplyId(replyId);
  };

  const handleDeleteReply = (replyId: string) => {
    removeReply?.(comment.id, replyId);
  };

  const locationBits = (
    <>
      {comment.lineNumber === 0 && (
        <span className="comment-file-chip">File</span>
      )}
      {comment.outdated && (
        <span
          className="comment-outdated-badge"
          title="Anchored code no longer matches the live diff"
        >
          <AlertTriangle size={10} /> outdated
        </span>
      )}
      {comment.severity && comment.severity !== "none" && (
        <SeverityBadge severity={comment.severity} />
      )}
      {comment.startLineNumber &&
        comment.startLineNumber !== comment.lineNumber && (
          <span className="comment-range-chip">
            L{comment.startLineNumber}–{comment.lineNumber}
          </span>
        )}
      {comment.lineNumber > 0 &&
        !(
          comment.startLineNumber &&
          comment.startLineNumber !== comment.lineNumber
        ) && <span className="comment-range-chip">L{comment.lineNumber}</span>}
    </>
  );

  if (collapsed && !isEditing) {
    return (
      <div
        className={`comment-collapsed-bar ${isResolved ? "comment-collapsed-bar-resolved" : ""}`}
        id={`comment-${comment.id}`}
        role="article"
      >
        <button
          type="button"
          className="comment-collapsed-toggle"
          onClick={() => setCollapsed(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setCollapsed(false);
            }
          }}
          aria-expanded={false}
          aria-label={
            isResolved ? "Show resolved conversation" : "Expand comment thread"
          }
          title="Expand"
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        <div className="comment-collapsed-main">
          {isResolved ? (
            <CheckCircle2
              size={14}
              className="comment-collapsed-resolved-icon"
              aria-hidden="true"
            />
          ) : (
            <AvatarIcon role="user" size={11} />
          )}
          <span className="comment-collapsed-label">
            {isResolved ? "Resolved" : "User"}
          </span>
          {locationBits}
          <span className="comment-collapsed-preview" title={comment.body}>
            {bodyPreview}
            {comment.body.length > 72 ? "…" : ""}
          </span>
          <span className="comment-collapsed-meta">
            {replyCount > 0 ? `${replyCount + 1} comments` : "1 comment"}
          </span>
        </div>
        <button
          type="button"
          className="comment-collapsed-expand-btn"
          onClick={() => setCollapsed(false)}
          aria-label={
            isResolved ? "Show resolved conversation" : "Expand comment thread"
          }
        >
          Expand
        </button>
      </div>
    );
  }

  if (isEditing) {
    return (
      <div
        className="comment-bubble-canvas"
        id={`comment-${comment.id}`}
        role="article"
        aria-label="Edit comment"
      >
        <div className="comment-node">
          <div className="comment-avatar-col">
            <AvatarIcon role="user" size={16} />
          </div>
          <div className="comment-content-col">
            <div className="comment-node-header">
              <span className="comment-node-author">User</span>
              <span className="comment-node-badge comment-node-badge-user">
                User
              </span>
              <span className="comment-node-time comment-node-meta">
                {timeAgo(comment.createdAt)}
                {comment.lineNumber === 0 && (
                  <span className="comment-file-chip">File Comment</span>
                )}
                {comment.outdated && (
                  <span
                    className="comment-outdated-badge"
                    title="Anchored code no longer matches the live diff"
                  >
                    <AlertTriangle size={10} /> outdated
                  </span>
                )}
                {comment.severity && comment.severity !== "none" && (
                  <SeverityBadge severity={comment.severity} />
                )}
                {comment.startLineNumber &&
                  comment.startLineNumber !== comment.lineNumber && (
                    <span className="comment-range-chip">
                      L{comment.startLineNumber}–{comment.lineNumber}
                    </span>
                  )}
              </span>
            </div>
            <div className="comment-edit-form-wrap">
              <CommentForm
                draftKey={`edit:${comment.id}`}
                initialBody={comment.body}
                lineContent={comment.lineContent}
                onSubmit={async (newBody) => {
                  await editComment(comment.id, newBody);
                  setIsEditing(false);
                }}
                onCancel={() => setIsEditing(false)}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`comment-bubble-canvas ${isResolved ? "comment-bubble-canvas-resolved" : ""}`}
      id={`comment-${comment.id}`}
      role="article"
      aria-label={
        comment.lineNumber === 0
          ? "File-level comment"
          : `Comment by user on line ${comment.lineNumber}`
      }
    >
      {/* Parent Comment Node */}
      <div
        className={`comment-node ${isResolved ? "comment-node-resolved" : ""}`}
      >
        <div className="comment-avatar-col">
          <AvatarIcon role="user" size={16} />
        </div>
        <div className="comment-content-col">
          <div className="comment-node-header">
            <button
              type="button"
              className="comment-collapse-btn"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              aria-label="Collapse comment thread"
              title="Collapse"
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            <span className="comment-node-author">User</span>
            <span className="comment-node-badge comment-node-badge-user">
              User
            </span>
            <span className="comment-node-time comment-node-meta">
              {timeAgo(comment.createdAt)}
              {comment.lineNumber === 0 && (
                <span className="comment-file-chip">File Comment</span>
              )}
              {comment.startLineNumber &&
                comment.startLineNumber !== comment.lineNumber && (
                  <span className="comment-range-chip">
                    L{comment.startLineNumber}–{comment.lineNumber}
                  </span>
                )}
            </span>

            {isResolved && (
              <span className="comment-canvas-resolved-banner comment-resolved-inline">
                <CheckCircle2 size={13} />
                Resolved
              </span>
            )}

            {!isResolved && (
              <div className="comment-node-actions">
                <button
                  ref={firstActionBtnRef}
                  className="comment-node-btn"
                  onClick={() => setIsEditing(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setIsEditing(true);
                    }
                  }}
                  title="Edit comment"
                  aria-label="Edit comment"
                  tabIndex={0}
                >
                  <Pencil size={13} aria-hidden="true" />
                </button>
                {deleteConfirming ? (
                  <div className="comment-delete-confirm">
                    <button
                      className="comment-node-btn comment-node-btn-delete comment-delete-confirm-yes"
                      onClick={() => onDelete(comment.id)}
                      title="Confirm delete"
                      aria-label="Confirm delete comment"
                    >
                      <AlertTriangle size={11} />
                      Delete?
                    </button>
                    <button
                      className="comment-node-btn comment-delete-confirm-cancel"
                      onClick={() => setDeleteConfirming(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDeleteConfirming(false);
                        }
                      }}
                      title="Cancel delete"
                      aria-label="Cancel delete"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="comment-node-btn comment-node-btn-delete"
                    onClick={() => setDeleteConfirming(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDeleteConfirming(true);
                      }
                    }}
                    title="Delete comment"
                    aria-label="Delete comment"
                    tabIndex={0}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </div>
          {hasBodyContent && (
            <Markdown
              content={comment.body}
              className={`comment-node-body markdown-body ${isResolved ? "comment-resolved-line" : ""}`}
            />
          )}

          {/* Suggestion Card */}
          {(() => {
            const suggestionMatch = comment.body.match(
              /```suggestion\n([\s\S]*?)```/,
            );
            const hasSuggestion =
              !!suggestionMatch && comment.side === "additions";
            const suggestionCode = suggestionMatch
              ? suggestionMatch[1].trimEnd()
              : "";
            if (!hasSuggestion) return null;

            return (
              <div className="suggestion-card comment-suggestion-card">
                <div className="suggestion-header">
                  <span className="suggestion-header-label">
                    Suggested Change
                  </span>
                  {isResolved ? (
                    <span className="suggestion-applied">
                      <CheckCircle2 size={12} /> Applied
                    </span>
                  ) : applySuggestion ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={applyingSuggestion}
                      onClick={async () => {
                        setApplyingSuggestion(true);
                        try {
                          await applySuggestion?.(comment.id);
                        } catch (err) {
                          setSuggestionError(
                            err instanceof Error
                              ? err.message
                              : "The suggestion could not be applied.",
                          );
                        } finally {
                          setApplyingSuggestion(false);
                        }
                      }}
                    >
                      {applyingSuggestion ? "Applying…" : "Apply Suggestion"}
                    </button>
                  ) : null}
                </div>
                <div className="suggestion-diff">
                  <div className="suggestion-diff-line suggestion-diff-line-deletion">
                    <span className="suggestion-diff-sign">-</span>
                    <span className="suggestion-diff-code">
                      {comment.lineContent}
                    </span>
                  </div>
                  <div className="suggestion-diff-line suggestion-diff-line-addition">
                    <span className="suggestion-diff-sign">+</span>
                    <span className="suggestion-diff-code">
                      {suggestionCode}
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Replies List */}
      {comment.replies?.length > 0 && (
        <div className="comment-replies" role="list" aria-label="Replies">
          {comment.replies.map((reply, idx) => {
            const isAgent = reply.role === "agent";
            const isEditingThis = editingReplyId === reply.id;
            return (
              <div
                key={reply.id}
                className={`comment-node ${isAgent ? "comment-node-agent" : "comment-node-user"} ${isResolved ? "comment-node-resolved" : ""}`}
                role="listitem"
                aria-label={`${isAgent ? "Agent" : "User"} reply ${idx + 1}`}
              >
                <div className="comment-avatar-col">
                  <AvatarIcon role={isAgent ? "agent" : "user"} size={14} />
                </div>
                <div className="comment-content-col">
                  <div className="comment-node-header">
                    <span className="comment-node-author">
                      {isAgent ? "Agent" : "User"}
                    </span>
                    <span
                      className={`comment-node-badge ${isAgent ? "comment-node-badge-agent" : "comment-node-badge-user"}`}
                    >
                      {isAgent ? "Agent" : "User"}
                    </span>
                    {isAgent && reply.model && (
                      <span className="comment-model-chip">{reply.model}</span>
                    )}
                    <span className="comment-node-time">
                      {timeAgo(reply.createdAt)}
                    </span>

                    {!isResolved && editReply && removeReply && (
                      <div className="comment-node-actions">
                        <button
                          className="comment-node-btn"
                          onClick={() => handleStartEditReply(reply.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleStartEditReply(reply.id);
                            }
                          }}
                          title="Edit reply"
                          aria-label="Edit reply"
                          tabIndex={0}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                        <button
                          className="comment-node-btn comment-node-btn-delete"
                          onClick={() => handleDeleteReply(reply.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleDeleteReply(reply.id);
                            }
                          }}
                          title="Delete reply"
                          aria-label="Delete reply"
                          tabIndex={0}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>

                  {isEditingThis ? (
                    <div className="comment-reply-editor">
                      <CommentForm
                        draftKey={`reply-edit:${comment.id}:${reply.id}`}
                        initialBody={reply.body}
                        onSubmit={async (body) => {
                          await editReply?.(comment.id, reply.id, body);
                          setEditingReplyId(null);
                        }}
                        onCancel={() => setEditingReplyId(null)}
                      />
                    </div>
                  ) : (
                    <Markdown
                      content={reply.body}
                      className="comment-node-body markdown-body"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer (Reply trigger and Resolve toggle) */}
      <div className="comment-canvas-footer">
        {!isReplying &&
          ((comment.severity && comment.severity !== "none") ||
            comment.outdated) && (
            <div className="comment-canvas-footer-meta">
              {comment.severity && comment.severity !== "none" && (
                <SeverityBadge severity={comment.severity} />
              )}
              {comment.outdated && (
                <span
                  className="comment-outdated-badge"
                  title="Anchored code no longer matches the current diff"
                >
                  <AlertTriangle size={10} aria-hidden="true" />
                  outdated
                </span>
              )}
            </div>
          )}

        {!isReplying && (
          <div className="comment-canvas-footer-row">
            <button
              onClick={() => setIsReplying(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setIsReplying(true);
                }
              }}
              className="comment-reply-trigger"
              aria-label="Write a reply"
              tabIndex={0}
            >
              <Reply size={14} aria-hidden="true" />
              Reply...
            </button>

            {isResolved ? (
              <div className="comment-canvas-footer-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setCollapsed(true)}
                  aria-label="Hide resolved conversation"
                >
                  Hide
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleUnresolve}
                  aria-label="Unresolve conversation"
                >
                  Unresolve
                </button>
              </div>
            ) : (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleResolve}
                aria-label="Resolve conversation"
              >
                Resolve conversation
              </button>
            )}
          </div>
        )}

        {isReplying && (
          <div className="comment-reply-composer">
            <CommentForm
              draftKey={`reply:${comment.id}`}
              onSubmit={async (body) => {
                await addReply(comment.id, body);
                setIsReplying(false);
              }}
              onCancel={() => {
                setIsReplying(false);
                firstActionBtnRef.current?.focus();
              }}
            />
          </div>
        )}
      </div>
      <NoticeDialog open={actionError !== null} title="Could not update conversation" description={actionError ?? "The conversation could not be updated."} closeLabel="Return to review" onClose={() => setActionError(null)} />
      <NoticeDialog
        open={suggestionError !== null}
        title="Could not apply suggestion"
        description={suggestionError ?? "The suggestion could not be applied."}
        closeLabel="Return to review"
        onClose={() => setSuggestionError(null)}
      />
    </div>
  );
}
