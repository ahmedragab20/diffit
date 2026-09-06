import { useState, useRef, useEffect, type ReactNode } from 'react'
import { Select as BaseSelect } from '@base-ui-components/react/select'
import {
  AlertOctagon,
  Check,
  ChevronsUpDown,
  CircleDot,
  HelpCircle,
  Minus,
  Sparkles,
} from 'lucide-react'
import { Markdown } from './Markdown'
import { getDraft, setDraft, clearDraft } from '../drafts'
import { useFeedback } from '../hooks/useHaptics'
import { useFileMention } from '../hooks/useFileMention'
import { FileMentionDropdown } from './FileMentionDropdown'
import { useSettings, type SavedReply } from '../hooks/useSettings'
import type { CommentSeverity } from '../../lib/types'
import { InputDialog } from '../primitives/InputDialog'
import { useOptionalAi } from '../ai/AiContext'
import type { AiDiffSelection, AiReviewContext, AiSurface, AiAction } from '../../lib/ai/types'

function preprocessMentions(content: string): string {
  return content.replace(/@([^\s@]+)/g, (_, path: string) => {
    const name = path.split('/').pop() || path
    return `[${name}](file-mention://${path})`
  })
}

const SEVERITY_OPTIONS: {
  value: CommentSeverity
  label: string
  hint: string
  icon: ReactNode
}[] = [
  {
    value: 'none',
    label: 'None',
    hint: 'Untriaged',
    icon: <Minus size={13} />,
  },
  {
    value: 'blocking',
    label: 'Blocking',
    hint: 'Must fix before merge',
    icon: <AlertOctagon size={13} />,
  },
  {
    value: 'nit',
    label: 'Nit',
    hint: 'Optional polish',
    icon: <CircleDot size={13} />,
  },
  {
    value: 'question',
    label: 'Question',
    hint: 'Needs an answer',
    icon: <HelpCircle size={13} />,
  },
  {
    value: 'praise',
    label: 'Praise',
    hint: 'No change required',
    icon: <Sparkles size={13} />,
  },
]

function SeveritySelect({
  value,
  onChange,
}: {
  value: CommentSeverity
  onChange: (v: CommentSeverity) => void
}) {
  const current = SEVERITY_OPTIONS.find((o) => o.value === value) ?? SEVERITY_OPTIONS[0]!
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => onChange(v as CommentSeverity)}
      modal={false}
    >
      <BaseSelect.Trigger
        className={`ui-select-trigger comment-severity-trigger comment-severity-trigger-${value}`}
        aria-label="Comment severity"
        data-severity={value}
      >
        <span className="comment-severity-trigger-inner">
          <span className="comment-severity-icon" data-severity={value} aria-hidden="true">
            {current.icon}
          </span>
          <BaseSelect.Value>
            {(val: string) => SEVERITY_OPTIONS.find((o) => o.value === val)?.label ?? val}
          </BaseSelect.Value>
        </span>
        <BaseSelect.Icon className="ui-select-icon">
          <ChevronsUpDown size={12} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className="ui-select-positioner comment-severity-positioner"
          sideOffset={4}
          align="start"
          side="top"
          alignItemWithTrigger={false}
        >
          <BaseSelect.Popup
            className="ui-select-popup comment-severity-popup"
            aria-label="Severity"
          >
            {SEVERITY_OPTIONS.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                className={`ui-select-item comment-severity-item comment-severity-item-${o.value}`}
              >
                <span className="comment-severity-item-main">
                  <span
                    className="comment-severity-icon"
                    data-severity={o.value}
                    aria-hidden="true"
                  >
                    {o.icon}
                  </span>
                  <span className="comment-severity-item-text">
                    <BaseSelect.ItemText className="comment-severity-item-label">
                      {o.label}
                    </BaseSelect.ItemText>
                    <span className="comment-severity-item-hint">{o.hint}</span>
                  </span>
                </span>
                <BaseSelect.ItemIndicator className="ui-select-indicator">
                  <Check size={13} />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}

/** Editable inclusive line range for a new inline comment draft. */
export interface CommentFormRange {
  /** Top of range (inclusive). */
  start: number
  /** Bottom of range (inclusive) — annotation slot. */
  end: number
  /** "new" | "old" or similar side label. */
  sideLabel: string
  /** Whether the start edge can move up (−1) or down (+1). */
  canAdjustStart?: (delta: -1 | 1) => boolean
  /** Whether the end edge can move up (−1) or down (+1). */
  canAdjustEnd?: (delta: -1 | 1) => boolean
}

interface CommentFormProps {
  initialBody?: string
  lineContent?: string
  /** Optional static range label shown above the form, e.g. "L12–L15 · new". */
  lineLabel?: string
  /**
   * Interactive range chrome (bidirectional start/end steppers). When provided
   * with `onAdjustStart` / `onAdjustEnd`, replaces the static `lineLabel` chip.
   */
  range?: CommentFormRange
  /** Move the top of the range (−1 expand up, +1 shrink toward end). */
  onAdjustStart?: (delta: -1 | 1) => void
  /** Move the bottom of the range (−1 shrink toward start, +1 expand down). */
  onAdjustEnd?: (delta: -1 | 1) => void
  draftKey?: string
  /** Called with body + optional severity (omit / none = no severity). */
  onSubmit: (body: string, severity?: CommentSeverity) => void | Promise<unknown>
  onCancel: () => void
  /** Hide severity control (e.g. reply-only contexts). Default true for new comments. */
  showSeverity?: boolean
  /**
   * Explicit focus-on-open for floating composers (mockup canvas popups). The
   * click that opened the popup may have landed inside an iframe, so focus is
   * retried a beat later to win any late refocus race.
   */
  autoFocus?: boolean
  /** Explicit opt-in: shared plan/mockup composers do not show AI unless provided. */
  aiSurface?: AiSurface
  aiContext?: AiReviewContext
  /** Attach this exact diff selection to the persistent Ask rail. */
  onAddToAsk?: (selection: AiDiffSelection) => void
}

export function CommentForm({
  initialBody,
  lineContent,
  lineLabel,
  range,
  onAdjustStart,
  onAdjustEnd,
  draftKey,
  onSubmit,
  onCancel,
  showSeverity = true,
  autoFocus = false,
  aiSurface,
  aiContext,
  onAddToAsk,
}: CommentFormProps) {
  const { haptic, sound } = useFeedback()
  const { settings, updateSettings } = useSettings()
  const savedReplies: SavedReply[] = settings.savedReplies ?? []
  const [body, setBody] = useState(() => {
    if (draftKey) {
      const draft = getDraft(draftKey)
      if (draft) return draft
    }
    return initialBody || ''
  })
  const [severity, setSeverity] = useState<CommentSeverity>('none')
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'write' | 'preview'>('write')
  const [showSavedReplies, setShowSavedReplies] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiUndoBody, setAiUndoBody] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  const mention = useFileMention(body, setBody)
  const ai = useOptionalAi()

  const runAiEdit = async (action: AiAction) => {
    if (!ai || !aiSurface || !aiContext) return
    setAiRunning(true)
    setAiError(null)
    setAiUndoBody(body)
    try {
      const result = await ai.run({
        surface: aiSurface,
        action,
        context: { ...aiContext, draft: body } as AiReviewContext,
        prompt: body || undefined,
      })
      setBody(result.text)
      setActiveTab('write')
      requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
    } catch (error) {
      setAiUndoBody(null)
      setAiError(error instanceof Error ? error.message : String(error))
    } finally {
      setAiRunning(false)
    }
  }

  const insertSavedReply = (reply: SavedReply) => {
    setBody((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${reply.body}` : reply.body))
    setShowSavedReplies(false)
    setActiveTab('write')
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
  }

  const saveCurrentAsReply = () => {
    if (!body.trim()) return
    setSaveTemplateOpen(true)
  }

  const saveReplyTemplate = (title: string) => {
    const trimmed = body.trim()
    if (!trimmed) return
    const next: SavedReply[] = [...savedReplies, { id: crypto.randomUUID(), title, body: trimmed }]
    updateSettings({ savedReplies: next })
    setSaveTemplateOpen(false)
  }

  useEffect(() => {
    if (activeTab === 'write') {
      textareaRef.current?.focus({ preventScroll: true })
    } else {
      previewRef.current?.focus({ preventScroll: true })
    }
  }, [activeTab])

  // Focus-on-open for floating popups. Runs after paint and retries once so a
  // slow iframe refocus cannot steal the field.
  useEffect(() => {
    if (!autoFocus) return
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (cancelled) return
      textareaRef.current?.focus({ preventScroll: true })
    })
    const retry = setTimeout(() => {
      if (cancelled) return
      if (document.activeElement !== textareaRef.current) {
        textareaRef.current?.focus({ preventScroll: true })
      }
    }, 200)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      clearTimeout(retry)
    }
  }, [autoFocus])

  useEffect(() => {
    if (draftKey) {
      setDraft(body, draftKey)
    }
  }, [body, draftKey])

  const handleSubmit = async () => {
    const trimmed = body.trim()
    if (!trimmed || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onSubmit(trimmed, severity === 'none' ? undefined : severity)
      if (draftKey) clearDraft(draftKey)
      haptic('success')
      sound('success')
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not save comment. Try again.')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  /** Pre-fill a GitHub-style ```suggestion fence from the selected line content. */
  const insertSuggestion = () => {
    if (!lineContent) return
    // Strip leading +/- markers from the reviewed line snapshot.
    const code = lineContent
      .split('\n')
      .map((l) => l.replace(/^[+\- ]/, ''))
      .join('\n')
    const fence = `\`\`\`suggestion\n${code}\n\`\`\`\n`
    setBody((prev) => {
      if (!prev.trim()) return fence
      if (prev.includes('```suggestion')) return prev
      return `${prev.trimEnd()}\n\n${fence}`
    })
    setActiveTab('write')
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    if (mention.handleKeyDown(e)) {
      e.stopPropagation()
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      void handleSubmit()
    }
    if (e.key === 'p' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      setActiveTab((t) => (t === 'write' ? 'preview' : 'write'))
    }
    if (e.key === 'Escape') {
      if (body.includes('\n') || submittingRef.current) return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items
    let imageFile: File | null = null

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        imageFile = item.getAsFile()
        break
      }
    }

    if (!imageFile) return
    e.preventDefault()

    const textarea = textareaRef.current
    if (!textarea) return

    // Upload the image to the server and reference it by URL rather than
    // inlining a huge base64 data URL into the comment body. A unique token in
    // the placeholder lets multiple concurrent pastes resolve independently.
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const token = Math.random().toString(36).slice(2, 8)
    const placeholder = `![Uploading image… ${token}]()`
    const val = textarea.value
    setBody(val.slice(0, start) + placeholder + val.slice(end))

    try {
      const form = new FormData()
      form.append('file', imageFile, imageFile.name || `pasted-${token}.png`)
      const res = await fetch('/api/attachments', {
        method: 'POST',
        body: form,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { url?: string; error?: string }
      if (!data.url) throw new Error(data.error || 'Upload failed')
      const markdownImage = `![pasted image](${data.url})`
      setBody((prev) => prev.replace(placeholder, markdownImage))
    } catch (err) {
      console.error('Image upload failed:', err)
      setBody((prev) => prev.replace(placeholder, '![upload failed]()'))
    }
  }

  const rangeEditable = !!(range && onAdjustStart && onAdjustEnd)
  const lineCount = range ? Math.abs(range.end - range.start) + 1 : 0
  const canStartUp = rangeEditable && (range!.canAdjustStart?.(-1) ?? true)
  const canStartDown = rangeEditable && (range!.canAdjustStart?.(1) ?? true)
  const canEndUp = rangeEditable && (range!.canAdjustEnd?.(-1) ?? true)
  const canEndDown = rangeEditable && (range!.canAdjustEnd?.(1) ?? true)

  /** Keep focus in the textarea when using range steppers. */
  const preventFocusSteal = (e: React.MouseEvent) => {
    e.preventDefault()
  }

  return (
    <div className="comment-form comment-form-sheet" role="form" aria-label="Comment form">
      {rangeEditable && range ? (
        <div className="comment-form-range" aria-live="polite">
          <span className="comment-form-range-prefix">Commenting on</span>
          <div className="comment-form-range-controls" role="group" aria-label="Comment line range">
            <div className="comment-form-range-edge" aria-label="Range start">
              <button
                type="button"
                className="comment-form-range-btn"
                aria-label="Expand range upward"
                title="Expand range upward"
                disabled={!canStartUp}
                onMouseDown={preventFocusSteal}
                onClick={() => onAdjustStart!(-1)}
              >
                −
              </button>
              <span className="comment-form-range-num" aria-label={`Start line ${range.start}`}>
                L{range.start}
              </span>
              <button
                type="button"
                className="comment-form-range-btn"
                aria-label="Shrink range from top"
                title="Shrink range from top"
                disabled={!canStartDown}
                onMouseDown={preventFocusSteal}
                onClick={() => onAdjustStart!(1)}
              >
                +
              </button>
            </div>
            <span className="comment-form-range-sep" aria-hidden="true">
              –
            </span>
            <div className="comment-form-range-edge" aria-label="Range end">
              <button
                type="button"
                className="comment-form-range-btn"
                aria-label="Shrink range from bottom"
                title="Shrink range from bottom"
                disabled={!canEndUp}
                onMouseDown={preventFocusSteal}
                onClick={() => onAdjustEnd!(-1)}
              >
                −
              </button>
              <span className="comment-form-range-num" aria-label={`End line ${range.end}`}>
                L{range.end}
              </span>
              <button
                type="button"
                className="comment-form-range-btn"
                aria-label="Expand range downward"
                title="Expand range downward"
                disabled={!canEndDown}
                onMouseDown={preventFocusSteal}
                onClick={() => onAdjustEnd!(1)}
              >
                +
              </button>
            </div>
          </div>
          <span className="comment-form-range-meta">
            <span className="comment-form-range-side">{range.sideLabel}</span>
            <span className="comment-form-range-count">
              {lineCount} line{lineCount === 1 ? '' : 's'}
            </span>
          </span>
        </div>
      ) : lineLabel ? (
        <div className="comment-form-line-label" aria-live="polite">
          Commenting on <strong>{lineLabel}</strong>
        </div>
      ) : null}
      <div className="comment-form-tabs" role="tablist" aria-label="Comment form mode">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'write'}
          aria-controls="comment-write-panel"
          onClick={() => setActiveTab('write')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              e.preventDefault()
              setActiveTab('preview')
            }
          }}
          className={`comment-form-tab-btn ${activeTab === 'write' ? 'comment-form-tab-btn-active' : 'comment-form-tab-btn-inactive'}`}
        >
          Write
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'preview'}
          aria-controls="comment-preview-panel"
          onClick={() => setActiveTab('preview')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              setActiveTab('write')
            }
          }}
          className={`comment-form-tab-btn ${activeTab === 'preview' ? 'comment-form-tab-btn-active' : 'comment-form-tab-btn-inactive'}`}
        >
          Preview
        </button>
      </div>

      {activeTab === 'write' ? (
        <div>
          <div className="comment-form-suggest-row">
            {ai && aiSurface && aiContext && (
              <div className="comment-form-ai-actions" aria-label="AI comment actions">
                <button
                  type="button"
                  className="btn btn-sm comment-form-suggest-btn ai-comment-btn"
                  disabled={aiRunning}
                  onClick={() => void runAiEdit(body.trim() ? 'improve-comment' : 'draft-comment')}
                >
                  <Sparkles size={12} /> {body.trim() ? 'Improve writing' : 'Draft comment'}
                </button>
                {body.trim() && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm comment-form-suggest-btn"
                      disabled={aiRunning}
                      onClick={() => void runAiEdit('shorten-comment')}
                    >
                      Shorter
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm comment-form-suggest-btn"
                      disabled={aiRunning}
                      onClick={() => void runAiEdit('make-specific')}
                    >
                      More specific
                    </button>
                  </>
                )}
                {lineContent && (
                  <button
                    type="button"
                    className="btn btn-sm comment-form-suggest-btn"
                    disabled={aiRunning}
                    onClick={() => void runAiEdit('suggest-change')}
                  >
                    Generate suggestion
                  </button>
                )}
                {onAddToAsk &&
                  aiContext?.kind === 'selection' &&
                  aiContext.filePath &&
                  aiContext.side &&
                  aiContext.startLine != null &&
                  aiContext.endLine != null && (
                    <button
                      type="button"
                      className="btn btn-sm comment-form-suggest-btn ai-comment-btn"
                      disabled={aiRunning}
                      onClick={() =>
                        onAddToAsk({
                          filePath: aiContext.filePath!,
                          side: aiContext.side!,
                          startLine: aiContext.startLine!,
                          endLine: aiContext.endLine!,
                          selectedText: aiContext.selectedText ?? lineContent ?? '',
                        })
                      }
                    >
                      <Sparkles size={13} /> Add to Ask
                    </button>
                  )}
                {aiUndoBody !== null && (
                  <button
                    type="button"
                    className="btn btn-sm comment-form-suggest-btn"
                    onClick={() => {
                      setBody(aiUndoBody)
                      setAiUndoBody(null)
                    }}
                  >
                    Undo AI edit
                  </button>
                )}
              </div>
            )}
            {savedReplies.length > 0 && (
              <div className="comment-form-saved-replies">
                <button
                  type="button"
                  className="btn btn-sm comment-form-suggest-btn"
                  onClick={() => setShowSavedReplies((v) => !v)}
                  aria-expanded={showSavedReplies}
                  title="Insert a saved reply template"
                >
                  Saved replies
                </button>
                {showSavedReplies && (
                  <ul className="comment-form-saved-list" role="listbox">
                    {savedReplies.map((r) => (
                      <li key={r.id}>
                        <button type="button" onClick={() => insertSavedReply(r)} role="option">
                          {r.title}
                        </button>
                        <button
                          type="button"
                          className="comment-form-saved-delete"
                          aria-label={`Delete template ${r.title}`}
                          onClick={() =>
                            updateSettings({
                              savedReplies: savedReplies.filter((x) => x.id !== r.id),
                            })
                          }
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {body.trim() && (
              <button
                type="button"
                className="btn btn-sm comment-form-suggest-btn"
                onClick={saveCurrentAsReply}
                title="Save current body as a reusable template"
              >
                Save template
              </button>
            )}
            {lineContent ? (
              <button
                type="button"
                className="btn btn-sm comment-form-suggest-btn"
                onClick={insertSuggestion}
                title="Insert a ```suggestion block pre-filled with the selected line(s)"
              >
                Suggest change
              </button>
            ) : null}
          </div>
          {aiError && (
            <div className="comment-form-ai-error" role="alert">
              {aiError}
            </div>
          )}
          <div className="comment-form-editor">
            <textarea
              id="comment-write-panel"
              ref={(el) => {
                ;(textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
                mention.setTextareaRef(el)
              }}
              value={body}
              readOnly={submitting}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Leave a review comment (supports Markdown and Pasting Clipboard Images)..."
              rows={4}
              aria-label="Comment body"
              className="comment-form-textarea"
            />
            {mention.isOpen && (
              <FileMentionDropdown
                results={mention.results}
                focusedIndex={mention.focusedIndex}
                query={mention.query}
                cursorTop={mention.cursorTop}
                onSelect={mention.onSelect}
                onHover={mention.setFocusedIndex}
              />
            )}
          </div>
        </div>
      ) : (
        <div
          id="comment-preview-panel"
          ref={previewRef}
          role="tabpanel"
          aria-label="Preview"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'p' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
              e.preventDefault()
              setActiveTab('write')
            }
          }}
          className="comment-preview-panel"
        >
          {(() => {
            const suggestionMatch = body.match(/```suggestion\n([\s\S]*?)```/)
            const hasSuggestion = !!suggestionMatch
            const remainingText = body.replace(/```suggestion\n([\s\S]*?)```/g, '').trim()
            const hasOtherContent = remainingText.length > 0 || !hasSuggestion

            if (!hasOtherContent) return null

            return (
              <div className="comment-preview markdown-body">
                {body.trim() ? (
                  <Markdown content={preprocessMentions(body)} />
                ) : (
                  <span className="comment-preview-empty">Nothing to preview</span>
                )}
              </div>
            )
          })()}
          {(() => {
            const suggestionMatch = body.match(/```suggestion\n([\s\S]*?)```/)
            const hasSuggestion = !!suggestionMatch
            const suggestionCode = suggestionMatch ? suggestionMatch[1].trimEnd() : ''
            if (!hasSuggestion) return null

            return (
              <div className="suggestion-card">
                <div className="suggestion-header">
                  <span className="suggestion-header-label">Suggested Change Preview</span>
                </div>
                <div className="suggestion-diff">
                  {lineContent && (
                    <div className="suggestion-diff-line suggestion-diff-line-deletion">
                      <span className="suggestion-diff-sign">-</span>
                      <span className="suggestion-diff-code">{lineContent}</span>
                    </div>
                  )}
                  <div className="suggestion-diff-line suggestion-diff-line-addition">
                    <span className="suggestion-diff-sign">+</span>
                    <span className="suggestion-diff-code">{suggestionCode}</span>
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {submitError && (
        <p role="alert" className="comment-form-error">
          {submitError}
        </p>
      )}
      <div className="comment-form-actions">
        {showSeverity && (
          <div className="comment-form-severity" data-severity={severity}>
            <span className="comment-form-severity-label">Severity</span>
            <SeveritySelect value={severity} onChange={setSeverity} />
          </div>
        )}
        <div className="comment-form-actions-right">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
          >
            {submitting ? 'Saving…' : initialBody ? 'Save' : 'Comment'}
          </button>
        </div>
      </div>
      <InputDialog
        open={saveTemplateOpen}
        title="Save reply template"
        description="Give this reusable review response a short, recognizable name."
        label="Template name"
        initialValue={body.trim().slice(0, 40)}
        placeholder="Example: Add regression coverage"
        confirmLabel="Save template"
        maxLength={80}
        onConfirm={saveReplyTemplate}
        onCancel={() => setSaveTemplateOpen(false)}
      />
    </div>
  )
}
