import { useEffect, useState } from 'react'
import { MessageCircle, AlertTriangle, CheckCircle2, CornerUpLeft, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import type { PrExistingComment, PrExistingReply } from '../../lib/pr-session'
import { Markdown } from './Markdown'
import { ConfirmDialog } from '../primitives/ConfirmDialog'

interface ExistingPrCommentBubbleProps {
  comment: PrExistingComment
  /** Current diff source covered by the GitHub comment anchor. */
  lineContent?: string
  onReply?: (commentId: number, body: string) => Promise<void> | void
  onEdit?: (commentId: number, body: string) => Promise<void>
  onDelete?: (commentId: number) => Promise<void>
  onSetResolved?: (threadId: string, resolved: boolean) => Promise<void>
  onApplySuggestion?: (commentId: number) => Promise<void>
  expectedHeadSha?: string
}

/**
 * Bubble for an existing PR review comment, including GitHub-backed replies,
 * edits, deletion, and thread resolution controls.
 */
export function ExistingPrCommentBubble({ comment, lineContent, onReply, onEdit, onDelete, onSetResolved, onApplySuggestion, expectedHeadSha }: ExistingPrCommentBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const [replying, setReplying] = useState(false)
  const [replyBody, setReplyBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(comment.body)
  const [busy, setBusy] = useState(false)
  const [deleteConfirming, setDeleteConfirming] = useState(false)
  const [applyConfirming, setApplyConfirming] = useState(false)

  useEffect(() => {
    if (!editing) setEditBody(comment.body)
  }, [comment.body, editing])

  const stateBadge = comment.state
    ? {
        APPROVED: { icon: CheckCircle2, label: 'Approved', cls: 'badge-approved' },
        CHANGES_REQUESTED: { icon: AlertTriangle, label: 'Changes requested', cls: 'badge-changes' },
        COMMENTED: { icon: MessageCircle, label: 'Commented', cls: 'badge-commented' },
        PENDING: { icon: MessageCircle, label: 'Pending', cls: 'badge-pending' },
        DISMISSED: { icon: AlertTriangle, label: 'Dismissed', cls: 'badge-dismissed' },
      }[comment.state]
    : null
  const suggestion = parseGitHubSuggestion(comment.body)

  const handleSendReply = async () => {
    const trimmed = replyBody.trim()
    if (!trimmed || !onReply) return
    setSending(true)
    setError(null)
    try {
      await onReply(comment.id, trimmed)
      setReplyBody('')
      setReplying(false)
      setExpanded(true)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to reply')
    } finally {
      setSending(false)
    }
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err: any) {
      setError(err?.message ?? 'GitHub update failed')
      throw err
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async () => {
    const body = editBody.trim()
    if (!body || !onEdit) return
    try {
      await run(() => onEdit(comment.id, body))
      setEditing(false)
    } catch {
      // Error is rendered in the thread.
    }
  }

  return (
    <div className={`pr-existing-bubble ${comment.isResolved ? 'is-resolved' : ''}`}>
      <div className="pr-existing-bubble-head">
        {comment.author ? (
          <img
            className="pr-existing-avatar"
            src={comment.author.avatarUrl}
            alt={comment.author.login}
          />
        ) : (
          <div className="pr-existing-avatar pr-existing-avatar-fallback" />
        )}
        <div className="pr-existing-bubble-meta">
          <span className="pr-existing-bubble-author">
            @{comment.author?.login ?? 'unknown'}
          </span>
          <span className="pr-existing-bubble-date">
            {new Date(comment.createdAt).toLocaleString()}
          </span>
        </div>
        <span className="pr-existing-bubble-source">from GitHub</span>
        {comment.line != null && (
          <span className="pr-existing-bubble-location">
            L{comment.line} · {comment.side === 'LEFT' ? 'base' : 'head'}
          </span>
        )}
        {stateBadge && (
          <span className={`pr-existing-bubble-badge ${stateBadge.cls}`}>
            <stateBadge.icon size={11} /> {stateBadge.label}
          </span>
        )}
        {comment.isOutdated && (
          <span className="pr-existing-bubble-badge badge-outdated">
            <AlertTriangle size={11} /> outdated
          </span>
        )}
        {comment.isResolved && (
          <span className="pr-existing-bubble-badge badge-approved">
            <CheckCircle2 size={11} /> resolved
          </span>
        )}
        <span className="pr-existing-bubble-actions">
          {comment.threadId && onSetResolved && (
            <button
              type="button"
              className="file-diff-icon-btn"
              disabled={busy || (comment.isResolved ? comment.viewerCanUnresolve === false : comment.viewerCanResolve === false)}
              onClick={() => { void run(() => onSetResolved(comment.threadId!, !comment.isResolved)).catch(() => undefined) }}
              title={comment.isResolved ? 'Reopen conversation on GitHub' : 'Resolve conversation on GitHub'}
              aria-label={comment.isResolved ? 'Reopen conversation' : 'Resolve conversation'}
            >
              {comment.isResolved ? <RotateCcw size={12} /> : <CheckCircle2 size={12} />}
            </button>
          )}
          {onEdit && comment.viewerDidAuthor !== false && (
            <button type="button" className="file-diff-icon-btn" disabled={busy} onClick={() => setEditing(true)} title="Edit on GitHub" aria-label="Edit GitHub comment">
              <Pencil size={12} />
            </button>
          )}
          {onDelete && comment.viewerDidAuthor !== false && (
            <button
              type="button"
              className="file-diff-icon-btn danger"
              disabled={busy}
              onClick={() => {
                setError(null)
                setDeleteConfirming(true)
              }}
              title="Delete from GitHub"
              aria-label="Delete GitHub comment"
            >
              <Trash2 size={12} />
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <div className="pr-existing-edit-form">
          <textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} rows={3} aria-label="Edit GitHub comment body" />
          <div className="pr-existing-reply-form-actions">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setEditing(false); setEditBody(comment.body) }}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !editBody.trim()} onClick={() => { void saveEdit() }}>{busy ? 'Saving…' : 'Save on GitHub'}</button>
          </div>
        </div>
      ) : (
        <>
          {suggestion.remainingBody && (
            <Markdown content={suggestion.remainingBody} className="pr-existing-bubble-body markdown-body" />
          )}
          {suggestion.code != null && (
            <div className="pr-existing-suggestion" aria-label="Suggested change preview">
              <div className="pr-existing-suggestion-head">
                <span>Suggested change</span>
                <span className="pr-existing-suggestion-preview-label">Preview</span>
                {onApplySuggestion && comment.side !== "LEFT" && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => setApplyConfirming(true)}
                  >
                    Apply
                  </button>
                )}
              </div>
              <div className="pr-existing-suggestion-diff">
                {lineContent != null && lineContent !== '' && (
                  <div className="pr-existing-suggestion-line is-removed">
                    <span aria-hidden="true">−</span>
                    <code>{lineContent}</code>
                  </div>
                )}
                <div className="pr-existing-suggestion-line is-added">
                  <span aria-hidden="true">+</span>
                  <code>{suggestion.code}</code>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {comment.replies.length > 0 && (
        <button
          type="button"
          className="pr-existing-bubble-toggle"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? 'Hide' : 'Show'} {comment.replies.length} repl
          {comment.replies.length === 1 ? 'y' : 'ies'}
        </button>
      )}
      {expanded && comment.replies.length > 0 && (
        <ul className="pr-existing-replies">
          {comment.replies.map((reply) => (
            <ExistingReplyRow key={reply.id} reply={reply} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </ul>
      )}
      {onReply && (
        <div className="pr-existing-reply-actions">
          {!replying ? (
            <button
              type="button"
              className="btn btn-sm pr-existing-reply-btn"
              onClick={() => setReplying(true)}
            >
              <CornerUpLeft size={12} />
              Reply on GitHub
            </button>
          ) : (
            <div className="pr-existing-reply-form">
              <textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                rows={3}
                placeholder="Reply to this thread on GitHub…"
                aria-label="Reply body"
              />
              {error && <p className="pr-existing-reply-error">{error}</p>}
              <div className="pr-existing-reply-form-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setReplying(false)
                    setReplyBody('')
                    setError(null)
                  }}
                  disabled={sending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={handleSendReply}
                  disabled={sending || !replyBody.trim()}
                >
                  {sending ? 'Sending…' : 'Post reply'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {error && !replying && <p className="pr-existing-reply-error" role="alert">{error}</p>}
      <ConfirmDialog
        open={deleteConfirming}
        title="Delete published GitHub comment?"
        description="This removes the comment from GitHub for everyone and cannot be undone."
        detail={comment.body}
        confirmLabel="Delete comment"
        busyLabel="Deleting…"
        variant="danger"
        busy={busy}
        error={error}
        onConfirm={async () => {
          if (!onDelete) return
          try {
            await run(() => onDelete(comment.id))
            setDeleteConfirming(false)
          } catch {
            // Keep the dialog open with the rendered GitHub error.
          }
        }}
        onCancel={() => {
          setDeleteConfirming(false)
          setError(null)
        }}
      />
      <ConfirmDialog
        open={applyConfirming}
        title="Apply suggestion to the PR head?"
        description={
          expectedHeadSha
            ? `Commits this suggestion onto the PR head (${expectedHeadSha.slice(0, 7)}). Diffing will refuse if the head moved.`
            : "Commits this suggestion onto the PR head branch."
        }
        confirmLabel="Apply suggestion"
        variant="warning"
        busy={busy}
        error={error}
        onConfirm={async () => {
          if (!onApplySuggestion) return
          try {
            await run(() => onApplySuggestion(comment.id))
            setApplyConfirming(false)
          } catch {
            // keep dialog open
          }
        }}
        onCancel={() => setApplyConfirming(false)}
      />
    </div>
  )
}

export function parseGitHubSuggestion(body: string): { remainingBody: string; code: string | null } {
  const match = /```suggestion[^\r\n]*\r?\n([\s\S]*?)```/i.exec(body)
  if (!match) return { remainingBody: body, code: null }
  return {
    remainingBody: body.replace(/```suggestion[^\r\n]*\r?\n[\s\S]*?```/gi, '').trim(),
    code: match[1].replace(/\r\n/g, '\n').replace(/\n$/, ''),
  }
}

function ExistingReplyRow({
  reply,
  onEdit,
  onDelete,
}: {
  reply: PrExistingReply
  onEdit?: (commentId: number, body: string) => Promise<void>
  onDelete?: (commentId: number) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(reply.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteConfirming, setDeleteConfirming] = useState(false)

  useEffect(() => {
    if (!editing) setBody(reply.body)
  }, [reply.body, editing])

  const save = async () => {
    if (!onEdit || !body.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onEdit(reply.id, body.trim())
      setEditing(false)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to edit reply')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!onDelete) return
    setBusy(true)
    setError(null)
    try {
      await onDelete(reply.id)
      setDeleteConfirming(false)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to delete reply')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="pr-existing-reply">
      <div className="pr-existing-bubble-meta">
        <span className="pr-existing-bubble-author">@{reply.author?.login ?? 'unknown'}</span>
        <span className="pr-existing-bubble-date">{new Date(reply.createdAt).toLocaleString()}</span>
        <span className="pr-existing-bubble-actions">
          {onEdit && reply.viewerDidAuthor !== false && <button type="button" className="file-diff-icon-btn" disabled={busy} onClick={() => setEditing(true)} aria-label="Edit GitHub reply"><Pencil size={11} /></button>}
          {onDelete && reply.viewerDidAuthor !== false && <button type="button" className="file-diff-icon-btn danger" disabled={busy} onClick={() => { setError(null); setDeleteConfirming(true) }} aria-label="Delete GitHub reply"><Trash2 size={11} /></button>}
        </span>
      </div>
      {editing ? (
        <div className="pr-existing-edit-form is-reply">
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} aria-label="Edit GitHub reply body" />
          <div className="pr-existing-reply-form-actions">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setEditing(false); setBody(reply.body) }}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !body.trim()} onClick={() => { void save() }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : <p>{reply.body}</p>}
      {error && <p className="pr-existing-reply-error" role="alert">{error}</p>}
      <ConfirmDialog
        open={deleteConfirming}
        title="Delete published GitHub reply?"
        description="This removes the reply from GitHub for everyone and cannot be undone."
        detail={reply.body}
        confirmLabel="Delete reply"
        busyLabel="Deleting…"
        variant="danger"
        busy={busy}
        error={error}
        onConfirm={remove}
        onCancel={() => {
          setDeleteConfirming(false)
          setError(null)
        }}
      />
    </li>
  )
}
