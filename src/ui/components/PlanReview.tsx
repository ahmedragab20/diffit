import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { scrollBehavior } from "../lib/motion.js";
import { File as DiffsFile } from '@pierre/diffs/react'
import type { LineAnnotation, SelectedLineRange } from '@pierre/diffs'
import {
  Bot,
  MessageSquarePlus,
  Check,
  X,
  MessageSquareWarning,
  Clock,
  History,
  ArrowLeft,
  MessageSquare,
  Copy,
  Link2,
  FileText,
  FolderOpen,
  ListTree,
  ExternalLink,
  Loader2,
  MessagesSquare,
  Maximize2,
  Minimize2,
  Pencil,
  Save,
  GitBranch,
  RotateCcw,
} from 'lucide-react'
import type { Plan, PlanComment, PlanDecision, PlanVersion } from '../../lib/plan-types'
import { sectionTitleForLine, extractPlanLines } from '../../lib/plan-format'
import { SHIKI_THEME_MAP, timeAgo } from '../utils'
import { Markdown } from './Markdown'
import type { LineHoverHighlight } from '../hooks/useSettings'
import { usePlans } from '../hooks/usePlans'
import { CommentForm } from './CommentForm'
import { PlanCommentBubble } from './PlanCommentBubble'
import { PlanReadInlineComments } from './PlanReadInlineComments'
import { FilePreviewModal } from './FilePreviewModal'
import { planCommentLineLabel } from '../lib/planCommentAnchors'
import { EMBEDDED_COMMENT_STYLES } from '../lib/embeddedCommentStyles'
import { Select } from '../primitives/Select'
import { Tooltip } from '../primitives/Tooltip'
import { buildPlanOutline } from '../lib/planOutline'
import {
  resolvePlanSelectionLines,
  selectionIntersectsRoot,
  selectionRangeInRoot,
} from '../lib/planSelection'
import {
  pendingFromSelection,
  pendingOrderedRange,
  pendingLineLabel,
  selectedRangeFromPending,
  adjustPendingStart,
  adjustPendingEnd,
  canAdjustPendingStart,
  canAdjustPendingEnd,
  normalizePendingRange,
  type PendingLineComment,
} from '../lib/commentSelection'
import { setUiStateItem } from '../utils/uiState'
import { PLAN_UI, readBoolUi, readSplitRatioUi, clampSplitRatio, readDefaultCommentsRailOpen } from '../lib/planUiState'
import { usePlanCommentsSheet } from '../hooks/usePlanLayoutMedia'
import {
  PlanFloatComposers,
  clampToWindow,
  clientRectsToPage,
  PANEL_DEFAULT_W,
  PANEL_DEFAULT_H,
  type FloatComposerDraft,
} from './PlanFloatComposers'
import { PlanSourceEditor } from './PlanSourceEditor'
import { faceReadToSourceLine } from '../lib/planLineSync'
import { ConfirmDialog } from '../primitives/ConfirmDialog'
import { PlanDiscardEditsDialog, type PlanDiscardChoice } from './PlanDiscardEditsDialog'
import { withSessionTokenPath } from '../session-auth'

type PlanTextSnapshot = { body: string; title: string }

export type PlanViewMode = 'source' | 'rendered' | 'split'
export { PLAN_UI } from '../lib/planUiState'

type PlanSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

const AUTOSAVE_MS = 700

interface PlanReviewProps {
  plan: Plan
  theme: string
  fontSize: number
  monoFontFamily: string
  defaultTabSize: number
  lineWrap: boolean
  showLineNumbers: boolean
  lineHoverHighlight: LineHoverHighlight
  viewMode: PlanViewMode
  /** Parent-owned view mode (Source / Read / Split). Used when entering edit. */
  onViewModeChange?: (mode: PlanViewMode) => void
  editorIDE?: string
  /** When provided, Settings owns the value (still persisted by the parent). */
  tocOpen?: boolean
  onTocOpenChange?: (open: boolean) => void
  commentsRailOpen?: boolean
  onCommentsRailOpenChange?: (open: boolean) => void
  /**
   * Controlled zen (full-width Read). When omitted, PlanReview owns local
   * persisted state. Parent should pass these when handling the `z` shortcut.
   */
  zenMode?: boolean
  onZenModeChange?: (open: boolean) => void
}

/** Source-mode gutter / line-selection pending only (not floating). */
interface PendingComment {
  lineNumber: number
  startLineNumber?: number
}

/** Adapt plan pending ↔ shared pending helpers (plan source has no diff side). */
function planToLinePending(p: PendingComment): PendingLineComment {
  return normalizePendingRange({
    side: 'additions',
    lineNumber: p.lineNumber,
    startLineNumber: p.startLineNumber,
  })
}

function linePendingToPlan(p: PendingLineComment): PendingComment {
  const n = normalizePendingRange(p)
  return n.startLineNumber != null && n.startLineNumber !== n.lineNumber
    ? { lineNumber: n.lineNumber, startLineNumber: n.startLineNumber }
    : { lineNumber: n.lineNumber }
}

type PlanAnnotationMeta = PlanComment | { _pending: true }

const DECISION_META: Record<
  PlanDecision,
  { label: string; className: string; icon: typeof Check }
> = {
  pending: {
    label: 'Pending review',
    className: 'plan-badge-pending',
    icon: Clock,
  },
  approved: {
    label: 'Approved',
    className: 'plan-badge-approved',
    icon: Check,
  },
  'changes-requested': {
    label: 'Changes requested',
    className: 'plan-badge-changes',
    icon: MessageSquareWarning,
  },
  rejected: { label: 'Rejected', className: 'plan-badge-rejected', icon: X },
  'comment-only': {
    label: 'Comment only',
    className: 'plan-badge-comment-only',
    icon: MessageSquare,
  },
}

export function PlanReview({
  plan,
  theme,
  fontSize,
  monoFontFamily,
  defaultTabSize,
  lineWrap,
  showLineNumbers,
  lineHoverHighlight,
  viewMode,
  onViewModeChange,
  editorIDE,
  tocOpen: tocOpenProp,
  onTocOpenChange,
  commentsRailOpen: commentsRailOpenProp,
  onCommentsRailOpenChange,
  zenMode: zenModeProp,
  onZenModeChange,
}: PlanReviewProps) {
  const {
    addPlanComment,
    editPlanComment,
    resolvePlanComment,
    unresolvePlanComment,
    removePlanComment,
    addPlanReply,
    editPlanReply,
    removePlanReply,
    updatePlan,
    submitPlanVersion,
    submittingPlanVersion,
  } = usePlans()

  /** Source-mode only pending annotation form. */
  const [pending, setPending] = useState<PendingComment | null>(null)
  /** Stable draft key for the open source-mode composer (survives range adjusts). */
  const planDraftSessionRef = useRef<string | null>(null)
  /** Multiple floating selection composers (rendered mode). */
  const [floatComposers, setFloatComposers] = useState<FloatComposerDraft[]>([])
  /** Controlled only while a source-mode draft is open (do not fight live drag). */
  const [selectedRange, setSelectedRange] = useState<SelectedLineRange | null>(null)
  const [liveSelectionCount, setLiveSelectionCount] = useState(0)
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)
  const [copyFlash, setCopyFlash] = useState<string | null>(null)
  // Local fallbacks when parent doesn't control these (still persisted).
  const [tocOpenLocal, setTocOpenLocal] = useState(() => readBoolUi(PLAN_UI.tocOpen, true))
  const [commentsRailLocal, setCommentsRailLocal] = useState(() =>
    readBoolUi(PLAN_UI.commentsRail, readDefaultCommentsRailOpen()),
  )
  const tocOpen = tocOpenProp ?? tocOpenLocal
  const commentsRailOpen = commentsRailOpenProp ?? commentsRailLocal
  const commentsRailSheet = usePlanCommentsSheet()
  const setTocOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === 'function' ? next(tocOpen) : next
      if (onTocOpenChange) onTocOpenChange(value)
      else {
        setTocOpenLocal(value)
        setUiStateItem(PLAN_UI.tocOpen, String(value))
      }
    },
    [tocOpen, onTocOpenChange],
  )
  const setCommentsRailOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === 'function' ? next(commentsRailOpen) : next
      if (onCommentsRailOpenChange) onCommentsRailOpenChange(value)
      else {
        setCommentsRailLocal(value)
        setUiStateItem(PLAN_UI.commentsRail, String(value))
      }
    },
    [commentsRailOpen, onCommentsRailOpenChange],
  )
  const [openingEditor, setOpeningEditor] = useState(false)
  /** Live in-page edit of the current plan body/title. */
  const [editMode, setEditMode] = useState(false)
  const [draftBody, setDraftBody] = useState(plan.body)
  const [draftTitle, setDraftTitle] = useState(plan.title)
  const [saveStatus, setSaveStatus] = useState<PlanSaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  /** When dirty and an agent resubmits, hold the new version for the conflict banner. */
  const [conflictVersion, setConflictVersion] = useState<number | null>(null)
  const [saveAsVersionOpen, setSaveAsVersionOpen] = useState(false)
  const [discardEditsOpen, setDiscardEditsOpen] = useState(false)
  const [discardingEdits, setDiscardingEdits] = useState(false)
  /** Shown after exiting edit when session edits were (auto)saved into the plan. */
  const [exitSavedNotice, setExitSavedNotice] = useState(false)
  const [activeEditLine, setActiveEditLine] = useState(1)
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Last successfully saved (autosave) snapshot — used for dirty detection. */
  const editBaselineRef = useRef<{
    body: string
    title: string
    version: number
  }>({
    body: plan.body,
    title: plan.title,
    version: plan.version,
  })
  /**
   * Snapshot when *this* edit session began. “Discard recent” restores here
   * (including undoing autosaves from the current session).
   */
  const [sessionOrigin, setSessionOrigin] = useState<PlanTextSnapshot>({
    body: plan.body,
    title: plan.title,
  })
  /**
   * Plan body/title when the user first entered edit for this plan version.
   * Survives exit/re-enter so “Roll back to original” remains available.
   * Cleared when plan id or version changes.
   */
  const [versionOriginal, setVersionOriginal] = useState<PlanTextSnapshot | null>(null)
  const flushAutosaveRef = useRef<() => Promise<void>>(async () => {})
  /** Floating "Add comment" after selecting text in the rendered pane. */
  const [selectionPopup, setSelectionPopup] = useState<{
    x: number
    y: number
    /** Prefer below the selection so the chip doesn't cover the highlight. */
    placement: 'above' | 'below'
    startLine: number
    endLine: number
    text: string
  } | null>(null)
  const renderedRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const splitContentRef = useRef<HTMLDivElement>(null)
  const splitRatioRef = useRef(50)
  /** Source pane width % in split mode (persisted). */
  const [splitRatio, setSplitRatio] = useState(() => readSplitRatioUi(50))
  const [splitDragging, setSplitDragging] = useState(false)
  /** Immersive full-width Read mode (only when rendered-only). */
  const [zenModeLocal, setZenModeLocal] = useState(() => readBoolUi(PLAN_UI.zenMode, false))
  const zenMode = zenModeProp ?? zenModeLocal
  splitRatioRef.current = splitRatio
  const showSource = viewMode === 'source' || viewMode === 'split'
  const showRendered = viewMode === 'rendered' || viewMode === 'split'
  const isSplit = showSource && showRendered
  const isReadOnly = viewMode === 'rendered'
  const zenActive = isReadOnly && zenMode

  const setZen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === 'function' ? next(zenMode) : next
      if (onZenModeChange) {
        onZenModeChange(value)
      } else {
        setZenModeLocal(value)
        setUiStateItem(PLAN_UI.zenMode, String(value))
      }
    },
    [zenMode, onZenModeChange],
  )

  // Version switcher: `viewingVersion` is the body the user is reading right
  // now. Defaults to the plan's current version. The user can pick any prior
  // version from the dropdown in the meta row; the banner + comment filter
  // adapt accordingly.
  const versions: PlanVersion[] = plan.versions ?? []
  const [viewingVersion, setViewingVersion] = useState<number>(plan.version)
  const [viewingBody, setViewingBody] = useState<string>(plan.body)
  const [viewingTitle, setViewingTitle] = useState<string>(plan.title)

  // Version / plan identity change invalidates the cross-session original.
  const versionOriginalKeyRef = useRef(`${plan.id}:${plan.version}`)
  useEffect(() => {
    const key = `${plan.id}:${plan.version}`
    if (versionOriginalKeyRef.current !== key) {
      versionOriginalKeyRef.current = key
      setVersionOriginal(null)
      setExitSavedNotice(false)
    }
  }, [plan.id, plan.version])

  // When the server pushes a new version (live SSE), keep the viewer's
  // position in sync: if they were on the previous current, auto-bump them
  // to the new current; otherwise leave them where they are.
  // While editing with unsaved draft changes, surface a conflict instead of
  // clobbering the draft.
  const lastSyncedCurrentRef = useRef<number>(plan.version)
  useEffect(() => {
    if (plan.version === lastSyncedCurrentRef.current) return
    const prev = lastSyncedCurrentRef.current
    lastSyncedCurrentRef.current = plan.version
    const wasOnCurrent = viewingVersion === prev
    const dirty =
      editMode &&
      (draftBody !== editBaselineRef.current.body || draftTitle !== editBaselineRef.current.title)
    if (editMode && dirty) {
      setConflictVersion(plan.version)
      return
    }
    if (editMode && !dirty) {
      // Accept server body into the draft (agent resubmit while idle in editor).
      setDraftBody(plan.body)
      setDraftTitle(plan.title)
      editBaselineRef.current = {
        body: plan.body,
        title: plan.title,
        version: plan.version,
      }
      setSessionOrigin({ body: plan.body, title: plan.title })
      setVersionOriginal(null)
      setSaveStatus('idle')
      setConflictVersion(null)
    }
    if (wasOnCurrent) {
      setViewingVersion(plan.version)
    }
  }, [plan.version, plan.body, plan.title, viewingVersion, editMode, draftBody, draftTitle])

  // Resolve the viewed version's body+title. Cache fast path: the same body
  // lives in `plan.versions[]`. Falls back to the network only if the
  // in-memory copy is missing (defensive — shouldn't happen in practice).
  // Skip overwriting while edit mode owns the draft (current version only).
  useEffect(() => {
    let cancelled = false
    if (editMode && viewingVersion === plan.version) {
      return
    }
    if (viewingVersion === plan.version) {
      setViewingBody(plan.body)
      setViewingTitle(plan.title)
      return
    }
    const local = versions.find((v) => v.version === viewingVersion)
    if (local) {
      setViewingBody(local.body)
      setViewingTitle(local.title)
      return
    }
    fetch(`/api/plans/${plan.id}/versions/${viewingVersion}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { version?: PlanVersion } | null) => {
        if (cancelled || !data?.version) return
        setViewingBody(data.version.body)
        setViewingTitle(data.version.title)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [viewingVersion, plan.version, plan.body, plan.title, plan.id, versions, editMode])

  // Switching versions invalidates in-flight selection/pending/float drafts.
  useEffect(() => {
    setSelectedRange(null)
    setLiveSelectionCount(0)
    setPending(null)
    setFloatComposers([])
  }, [viewingVersion])

  const isHistorical = viewingVersion !== plan.version
  const canEdit = !isHistorical
  const displayBody = editMode && canEdit ? draftBody : viewingBody
  const displayTitle = editMode && canEdit ? draftTitle : viewingTitle
  const isDirty =
    editMode &&
    (draftBody !== editBaselineRef.current.body || draftTitle !== editBaselineRef.current.title)
  /** Changes vs this edit session start (includes in-session autosaves). */
  const hasRecentEdits =
    editMode &&
    (draftBody !== sessionOrigin.body ||
      draftTitle !== sessionOrigin.title ||
      plan.body !== sessionOrigin.body ||
      plan.title !== sessionOrigin.title)
  /**
   * Plan has drifted from the first-enter snapshot for this version
   * (true after exit+re-enter with saved work, or mid-session after autosave
   * when original was captured at first enter — then recent covers it unless
   * original === session).
   */
  const hasOriginalRollback =
    editMode &&
    !!versionOriginal &&
    (draftBody !== versionOriginal.body ||
      draftTitle !== versionOriginal.title ||
      plan.body !== versionOriginal.body ||
      plan.title !== versionOriginal.title)
  /** Original and session start differ → re-entered after prior saved edits. */
  const originalDiffersFromSession =
    !!versionOriginal &&
    (versionOriginal.body !== sessionOrigin.body || versionOriginal.title !== sessionOrigin.title)
  /**
   * Dual choice only when the user re-entered (original ≠ session) and also
   * has newer session edits. Otherwise a single-action discard/rollback.
   */
  const discardIsDual = originalDiffersFromSession && hasRecentEdits && hasOriginalRollback
  const canDiscard = hasRecentEdits || hasOriginalRollback
  const versionOptions = useMemo(
    () =>
      versions.map((v) => ({
        value: String(v.version),
        label: v.version === plan.version ? `v${v.version} (current)` : `v${v.version}`,
      })),
    [versions, plan.version],
  )

  const handleMarkdownClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const anchor = target.closest('a')
    if (anchor) {
      const href = anchor.getAttribute('href')
      if (href && href.startsWith('file:///')) {
        e.preventDefault()
        const absolutePath = href.replace('file://', '')
        setPreviewFilePath(absolutePath)
      }
    }
  }

  const shikiConfig = SHIKI_THEME_MAP[theme] || SHIKI_THEME_MAP['rose-pine']
  const unsafeCSS = useMemo(
    () => buildPlanCSS(defaultTabSize, fontSize, monoFontFamily),
    [defaultTabSize, fontSize, monoFontFamily],
  )

  // Comments are filtered to those anchored to the version being viewed. A
  // comment's `createdAtPlanVersion` is set at write time by the server.
  const allComments = plan.comments ?? []
  const visibleComments = isHistorical
    ? allComments.filter((c) => c.createdAtPlanVersion === viewingVersion)
    : allComments
  const comments = visibleComments
  const lineComments = comments.filter((c) => c.lineNumber > 0)
  const generalComments = comments.filter((c) => c.lineNumber === 0)
  const openCount = comments.filter((c) => c.status === 'open').length
  const totalCommentCount = allComments.length

  const lineRange = (start: number | undefined, end: number) =>
    extractPlanLines(displayBody, start ?? end, end)

  const openSourcePending = useCallback((next: PendingComment) => {
    const normalized = linePendingToPlan(planToLinePending(next))
    if (!planDraftSessionRef.current) {
      planDraftSessionRef.current = crypto.randomUUID()
    }
    setPending(normalized)
    setSelectedRange(selectedRangeFromPending(planToLinePending(normalized)))
    setLiveSelectionCount(0)
  }, [])

  const clearSourcePending = useCallback(() => {
    setPending(null)
    setSelectedRange(null)
    setLiveSelectionCount(0)
    planDraftSessionRef.current = null
  }, [])

  const planLineBounds = useMemo(() => {
    const total = displayBody.replace(/\r\n/g, '\n').split('\n').length
    return { min: 1, max: Math.max(1, total) }
  }, [displayBody])

  const commitSourceComment = (
    p: PendingComment,
    body: string,
    severity?: import('../../lib/types').CommentSeverity,
  ) => {
    const start = p.startLineNumber ?? p.lineNumber
    const exactLines = lineRange(p.startLineNumber, p.lineNumber)
    addPlanComment({
      planId: plan.id,
      lineNumber: p.lineNumber,
      startLineNumber: p.startLineNumber,
      lineContent: exactLines,
      sectionTitle: sectionTitleForLine(displayBody, start),
      body,
      severity: severity && severity !== 'none' ? severity : undefined,
      createdAtPlanVersion: viewingVersion,
    })
    clearSourcePending()
  }

  /**
   * Agent context: exact selected range + ±1 surrounding source lines so
   * partial highlights still ship enough markdown for the agent.
   */
  const buildAgentLineContent = useCallback(
    (startLine: number, endLine: number) => {
      const exact = extractPlanLines(displayBody, startLine, endLine)
      const lines = displayBody.replace(/\r\n/g, '\n').split('\n')
      const from = Math.max(1, startLine - 1)
      const to = Math.min(lines.length, endLine + 1)
      if (from === startLine && to === endLine) return exact
      const parts: string[] = []
      for (let n = from; n <= to; n++) {
        const mark = n >= startLine && n <= endLine ? '▶' : ' '
        parts.push(`${mark} L${n}| ${lines[n - 1] ?? ''}`)
      }
      return parts.join('\n')
    },
    [displayBody],
  )

  const commitFloatComment = useCallback(
    (
      draft: FloatComposerDraft,
      body: string,
      severity?: import('../../lib/types').CommentSeverity,
    ) => {
      const start = draft.startLineNumber ?? draft.lineNumber
      addPlanComment({
        planId: plan.id,
        lineNumber: draft.lineNumber,
        startLineNumber: draft.startLineNumber,
        lineContent: draft.sourceContext || draft.exactLines,
        selectedQuote: draft.selectedQuote.trim() || undefined,
        sectionTitle: draft.sectionTitle ?? sectionTitleForLine(displayBody, start),
        body,
        severity: severity && severity !== 'none' ? severity : undefined,
        createdAtPlanVersion: viewingVersion,
      })
    },
    [addPlanComment, plan.id, displayBody, viewingVersion],
  )

  const annotations: LineAnnotation<PlanAnnotationMeta>[] = useMemo(() => {
    const list: LineAnnotation<PlanAnnotationMeta>[] = lineComments.map((c) => ({
      lineNumber: c.lineNumber,
      metadata: c,
    }))
    if (pending) {
      list.push({
        lineNumber: pending.lineNumber,
        metadata: { _pending: true },
      })
    }
    return list
  }, [lineComments, pending])

  const renderAnnotation = (annotation: LineAnnotation<PlanAnnotationMeta>) => {
    const meta = annotation.metadata
    if (!meta) return null
    if ('_pending' in meta) {
      const p = pending!
      const linePending = planToLinePending(p)
      const ordered = pendingOrderedRange(linePending)
      const session = planDraftSessionRef.current ?? 'open'
      return (
        <CommentForm
          draftKey={`plan-new:${plan.id}:${session}`}
          lineContent={lineRange(p.startLineNumber, p.lineNumber)}
          aiSurface="plan"
          aiContext={{
            kind: 'plan-selection',
            planId: plan.id,
            title: plan.title,
            version: viewingVersion,
            body: displayBody,
            selectedText: lineRange(p.startLineNumber, p.lineNumber),
          }}
          lineLabel={pendingLineLabel(linePending)}
          showSeverity
          range={{
            start: ordered.start,
            end: ordered.end,
            sideLabel: 'source',
            canAdjustStart: (d) => canAdjustPendingStart(linePending, d, planLineBounds),
            canAdjustEnd: (d) => canAdjustPendingEnd(linePending, d, planLineBounds),
          }}
          onAdjustStart={(delta) => {
            const next = linePendingToPlan(adjustPendingStart(linePending, delta, planLineBounds))
            setPending(next)
            setSelectedRange(selectedRangeFromPending(planToLinePending(next)))
          }}
          onAdjustEnd={(delta) => {
            const next = linePendingToPlan(adjustPendingEnd(linePending, delta, planLineBounds))
            setPending(next)
            setSelectedRange(selectedRangeFromPending(planToLinePending(next)))
          }}
          onSubmit={(body, severity) => commitSourceComment(p, body, severity)}
          onCancel={clearSourcePending}
        />
      )
    }
    const comment = meta
    return (
      <div id={`plan-comment-${comment.id}`}>
        <PlanCommentBubble
          comment={comment}
          onResolve={() => resolvePlanComment(plan.id, comment.id)}
          onUnresolve={() => unresolvePlanComment(plan.id, comment.id)}
          onDelete={() => removePlanComment(plan.id, comment.id)}
          onEdit={(body) => editPlanComment(plan.id, comment.id, body)}
          onReply={(body) => addPlanReply(plan.id, comment.id, body)}
          onEditReply={(replyId, body) => editPlanReply(plan.id, comment.id, replyId, body)}
          onDeleteReply={(replyId) => removePlanReply(plan.id, comment.id, replyId)}
        />
      </div>
    )
  }

  const decision = DECISION_META[plan.decision]
  const DecisionIcon = decision.icon

  // Prefer durable on-disk mirror; fall back to free-form source when it looks
  // like an absolute path (agent handoff / original submit file).
  const copyablePath = useMemo(() => {
    if (plan.sourcePath) return plan.sourcePath
    if (plan.source && (plan.source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(plan.source))) {
      return plan.source
    }
    return null
  }, [plan.sourcePath, plan.source])

  const shortPath = useMemo(() => {
    if (!copyablePath) return null
    const parts = copyablePath.replace(/\\/g, '/').split('/')
    if (parts.length <= 3) return copyablePath
    return `…/${parts.slice(-3).join('/')}`
  }, [copyablePath])

  const outline = useMemo(() => buildPlanOutline(displayBody), [displayBody])
  const wordCount = useMemo(() => {
    const t = displayBody.trim()
    if (!t) return 0
    return t.split(/\s+/).length
  }, [displayBody])
  const lineCount = useMemo(
    () => (displayBody ? displayBody.replace(/\r\n/g, '\n').split('\n').length : 0),
    [displayBody],
  )

  const enterEditMode = useCallback(() => {
    if (viewingVersion !== plan.version) return
    const snap: PlanTextSnapshot = { body: plan.body, title: plan.title }
    setDraftBody(snap.body)
    setDraftTitle(snap.title)
    editBaselineRef.current = {
      body: snap.body,
      title: snap.title,
      version: plan.version,
    }
    setSessionOrigin(snap)
    // First enter for this plan version pins the “original” for rollback.
    setVersionOriginal((prev) => prev ?? snap)
    setSaveStatus('idle')
    setSaveError(null)
    setConflictVersion(null)
    setDiscardEditsOpen(false)
    setExitSavedNotice(false)
    setEditMode(true)
    setPending(null)
    setSelectedRange(null)
    setFloatComposers([])
    setSelectionPopup(null)
    if (zenMode) setZen(false)
    if (viewMode !== 'split') onViewModeChange?.('split')
  }, [
    viewingVersion,
    plan.version,
    plan.body,
    plan.title,
    zenMode,
    setZen,
    viewMode,
    onViewModeChange,
  ])

  const exitEditMode = useCallback(async () => {
    const sessionHadChanges =
      draftBody !== sessionOrigin.body ||
      draftTitle !== sessionOrigin.title ||
      plan.body !== sessionOrigin.body ||
      plan.title !== sessionOrigin.title
    // Flush any pending autosave before leaving.
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    await flushAutosaveRef.current()
    // Prefer the draft we just flushed (plan prop may lag a frame behind cache).
    setViewingBody(draftBody)
    setViewingTitle(draftTitle.trim() || 'Untitled plan')
    setEditMode(false)
    setSaveStatus('idle')
    setSaveError(null)
    setConflictVersion(null)
    setDiscardEditsOpen(false)
    // Tell the user saved edits become the re-entry baseline (session origin
    // resets next time), while “original” rollback remains available.
    if (sessionHadChanges) setExitSavedNotice(true)
  }, [draftBody, draftTitle, sessionOrigin, plan.body, plan.title])

  const discardConflictAndLoad = useCallback(() => {
    setDraftBody(plan.body)
    setDraftTitle(plan.title)
    editBaselineRef.current = {
      body: plan.body,
      title: plan.title,
      version: plan.version,
    }
    setSessionOrigin({ body: plan.body, title: plan.title })
    setVersionOriginal(null)
    setConflictVersion(null)
    setSaveStatus('idle')
    setSaveError(null)
    setViewingVersion(plan.version)
  }, [plan.body, plan.title, plan.version])

  /** Restore plan (+ draft) to a snapshot, persisting via PUT when needed. */
  const restorePlanSnapshot = useCallback(
    async (target: PlanTextSnapshot) => {
      if (!editMode) return
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
      setDiscardingEdits(true)
      setSaveError(null)
      try {
        setDraftBody(target.body)
        setDraftTitle(target.title)
        if (plan.body !== target.body || plan.title !== target.title) {
          setSaveStatus('saving')
          const updated = await updatePlan(plan.id, {
            body: target.body,
            title: target.title,
          })
          editBaselineRef.current = {
            body: updated.body,
            title: updated.title,
            version: updated.version,
          }
          setViewingBody(updated.body)
          setViewingTitle(updated.title)
          setSessionOrigin({ body: updated.body, title: updated.title })
        } else {
          editBaselineRef.current = {
            body: target.body,
            title: target.title,
            version: plan.version,
          }
          setViewingBody(target.body)
          setViewingTitle(target.title)
          setSessionOrigin({ body: target.body, title: target.title })
        }
        setSaveStatus('idle')
        setDiscardEditsOpen(false)
        setExitSavedNotice(false)
      } catch (err) {
        setSaveStatus('error')
        setSaveError(err instanceof Error ? err.message : 'Failed to discard edits')
      } finally {
        setDiscardingEdits(false)
      }
    },
    [editMode, plan.body, plan.title, plan.id, plan.version, updatePlan],
  )

  const handleDiscardChoice = useCallback(
    async (choice: PlanDiscardChoice) => {
      if (choice === 'recent') {
        await restorePlanSnapshot(sessionOrigin)
        return
      }
      if (versionOriginal) {
        await restorePlanSnapshot(versionOriginal)
      }
    },
    [restorePlanSnapshot, sessionOrigin, versionOriginal],
  )

  const openDiscardDialog = useCallback(() => {
    if (!editMode || !canDiscard || discardingEdits || saveStatus === 'saving') return
    setDiscardEditsOpen(true)
  }, [editMode, canDiscard, discardingEdits, saveStatus])

  const flushAutosave = useCallback(async () => {
    if (!editMode) return
    const body = draftBody
    const title = draftTitle.trim() || 'Untitled plan'
    if (!body.trim()) {
      setSaveStatus('error')
      setSaveError('Plan body cannot be empty')
      return
    }
    if (body === editBaselineRef.current.body && title === editBaselineRef.current.title) {
      setSaveStatus((s) => (s === 'dirty' ? 'saved' : s))
      return
    }
    setSaveStatus('saving')
    setSaveError(null)
    try {
      const updated = await updatePlan(plan.id, { body, title })
      editBaselineRef.current = {
        body: updated.body,
        title: updated.title,
        version: updated.version,
      }
      setViewingBody(updated.body)
      setViewingTitle(updated.title)
      setSaveStatus('saved')
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }, [editMode, draftBody, draftTitle, updatePlan, plan.id])

  flushAutosaveRef.current = flushAutosave

  // Debounced autosave while editing.
  useEffect(() => {
    if (!editMode) return
    const title = draftTitle.trim() || 'Untitled plan'
    const dirty =
      draftBody !== editBaselineRef.current.body || title !== editBaselineRef.current.title
    if (!dirty) return
    if (!draftBody.trim()) {
      setSaveStatus('error')
      setSaveError('Plan body cannot be empty')
      return
    }
    setSaveStatus('dirty')
    setSaveError(null)
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null
      void flushAutosave()
    }, AUTOSAVE_MS)
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
    }
  }, [editMode, draftBody, draftTitle, flushAutosave])

  // Warn on tab close with unsaved edits.
  useEffect(() => {
    if (!editMode || !isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [editMode, isDirty])

  const handleSaveAsNewVersion = useCallback(async () => {
    const body = draftBody
    const title = draftTitle.trim() || 'Untitled plan'
    if (!body.trim()) {
      setSaveStatus('error')
      setSaveError('Plan body cannot be empty')
      setSaveAsVersionOpen(false)
      return
    }
    setSaveAsVersionOpen(false)
    setSaveStatus('saving')
    setSaveError(null)
    try {
      // Flush in-place first is unnecessary — upsert creates a new version
      // from the draft directly.
      const updated = await submitPlanVersion(plan.id, {
        title,
        body,
        source: plan.source,
        model: plan.model,
      })
      const snap: PlanTextSnapshot = {
        body: updated.body,
        title: updated.title,
      }
      editBaselineRef.current = {
        body: snap.body,
        title: snap.title,
        version: updated.version,
      }
      // New version: reset session + original to this snapshot.
      setSessionOrigin(snap)
      setVersionOriginal(snap)
      versionOriginalKeyRef.current = `${plan.id}:${updated.version}`
      setDraftBody(snap.body)
      setDraftTitle(snap.title)
      setViewingBody(snap.body)
      setViewingTitle(snap.title)
      setViewingVersion(updated.version)
      setConflictVersion(null)
      setExitSavedNotice(false)
      setSaveStatus('saved')
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Save as new version failed')
    }
  }, [draftBody, draftTitle, submitPlanVersion, plan.id, plan.source, plan.model])

  // Split edit: face *only* the Read overflow pane to the active Source line.
  // Never window.scrollTo — that yanks Source with the page and fights the caret.
  useEffect(() => {
    if (!editMode || viewMode !== 'split') return
    let raf = 0
    const run = () => {
      raf = 0
      const root = renderedRef.current
      if (!root) return
      const pane =
        (root.closest('.plan-rendered-layout') as HTMLElement | null) ??
        (root.parentElement as HTMLElement | null)
      faceReadToSourceLine(root, activeEditLine, {
        scrollContainer: pane,
        onlyIfOutOfView: true,
        behavior: 'auto',
      })
    }
    raf = requestAnimationFrame(run)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
    // Intentionally omit displayBody: re-facing on every keystroke fights the
    // caret and reflows while typing.
  }, [editMode, viewMode, activeEditLine])

  // Keyboard: e toggles edit; ⌘/Ctrl+S flushes autosave.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      const inField =
        tag === 'input' || tag === 'textarea' || tag === 'select' || !!target?.isContentEditable

      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        if (!editMode) return
        e.preventDefault()
        if (autosaveTimerRef.current) {
          clearTimeout(autosaveTimerRef.current)
          autosaveTimerRef.current = null
        }
        void flushAutosave()
        return
      }

      if (e.key === 'e' || e.key === 'E') {
        if (inField) return
        if (e.metaKey || e.ctrlKey || e.altKey) return
        e.preventDefault()
        if (editMode) void exitEditMode()
        else if (canEdit) enterEditMode()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editMode, canEdit, enterEditMode, exitEditMode, flushAutosave])

  const flashCopy = useCallback((label: string) => {
    setCopyFlash(label)
    window.setTimeout(() => setCopyFlash(null), 1600)
  }, [])

  const copyText = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text)
        flashCopy(label)
      } catch {
        // Clipboard may be blocked outside secure contexts.
      }
    },
    [flashCopy],
  )

  const openInEditor = useCallback(async () => {
    if (!copyablePath) return
    setOpeningEditor(true)
    try {
      await fetch('/api/open-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: copyablePath, editor: editorIDE }),
      })
    } catch {
      // ignore
    } finally {
      setOpeningEditor(false)
    }
  }, [copyablePath, editorIDE])

  /**
   * Scroll a heading/comment into view. Prefer `scrollIntoView` so nested
   * scrollers (Split panes with `overflow: auto`) move correctly — plain
   * `window.scrollTo` is a no-op when the document itself is not the scroller.
   * Sticky toolbar offset comes from CSS `scroll-margin-top` on headings /
   * `.plan-read-segment`.
   */
  const scrollToPlanElement = useCallback(
    (el: HTMLElement, align: 'start' | 'center' = 'start') => {
      el.scrollIntoView({
        behavior: scrollBehavior(),
        block: align === 'center' ? 'center' : 'start',
      })
    },
    [],
  )

  /** Resolve an outline section: segment wrapper first, then heading id. */
  const findOutlineTarget = useCallback((sectionId: string): HTMLElement | null => {
    if (!sectionId || typeof document === 'undefined') return null
    const root = renderedRef.current
    const scope = root ?? document
    try {
      const segment = scope.querySelector<HTMLElement>(
        `[data-plan-segment="${CSS.escape(sectionId)}"]`,
      )
      if (segment) return segment
    } catch {
      /* CSS.escape may throw on odd ids — fall through */
    }
    return (
      root?.querySelector<HTMLElement>(`#${CSS.escape(sectionId)}`) ??
      document.getElementById(sectionId)
    )
  }, [])

  const jumpToOutlineSection = useCallback(
    (sectionId: string) => {
      const target = findOutlineTarget(sectionId)
      if (target) scrollToPlanElement(target, 'start')
      if (typeof history !== 'undefined' && typeof window !== 'undefined') {
        const next = `${window.location.pathname}${window.location.search}#${sectionId}`
        if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
          history.replaceState(null, '', next)
        }
      }
    },
    [findOutlineTarget, scrollToPlanElement],
  )

  // Deep-link / outline hash: scroll when the URL hash matches a section, and
  // when the rendered body becomes available (mode switch, plan load).
  useEffect(() => {
    if (!showRendered || editMode) return
    const raw = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : ''
    if (!raw) return
    let cancelled = false
    const run = () => {
      if (cancelled) return
      const target = findOutlineTarget(decodeURIComponent(raw))
      if (target) scrollToPlanElement(target, 'start')
    }
    // Double rAF: wait for Markdown segments to commit to the DOM.
    const outer = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(run)
    })
    const onHash = () => run()
    window.addEventListener('hashchange', onHash)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(outer)
      window.removeEventListener('hashchange', onHash)
    }
  }, [showRendered, editMode, displayBody, viewMode, findOutlineTarget, scrollToPlanElement])

  const jumpToComment = useCallback(
    (commentId: string, lineNumber: number) => {
      const el = document.getElementById(`plan-comment-${commentId}`)
      if (el) {
        scrollToPlanElement(el, 'center')
        el.classList.add('plan-comment-flash')
        window.setTimeout(() => el.classList.remove('plan-comment-flash'), 1400)
        return
      }
      const lineEl = document.querySelector(`[data-plan-line="${lineNumber}"]`)
      if (lineEl instanceof HTMLElement) scrollToPlanElement(lineEl, 'center')
    },
    [scrollToPlanElement],
  )

  const jumpToCommentFromRail = useCallback(
    (commentId: string, lineNumber: number) => {
      jumpToComment(commentId, lineNumber)
      if (commentsRailSheet) setCommentsRailOpen(false)
    },
    [jumpToComment, commentsRailSheet, setCommentsRailOpen],
  )

  useEffect(() => {
    if (!commentsRailSheet || !commentsRailOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setCommentsRailOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commentsRailSheet, commentsRailOpen, setCommentsRailOpen])

  /**
   * Evaluate the current selection and show/hide the Add-comment chip.
   * Direction-agnostic: works LTR, RTL, and when the drag starts/ends
   * outside the plan pane.
   *
   * @param mode `update` — only open/refresh when there is a real selection
   *   (used by selectionchange so collapsing the selection on chip click
   *   does not yank the chip away). `sync` — full sync, may clear the chip.
   */
  const evaluateRenderedSelection = useCallback(
    (mode: 'update' | 'sync' = 'sync') => {
      if (isHistorical || editMode) {
        if (mode === 'sync') setSelectionPopup(null)
        return
      }
      const root = renderedRef.current
      const sel = window.getSelection()
      if (!root || !sel || sel.isCollapsed || !sel.rangeCount) {
        if (mode === 'sync') setSelectionPopup(null)
        return
      }
      if (!selectionIntersectsRoot(sel, root)) {
        if (mode === 'sync') setSelectionPopup(null)
        return
      }

      const range = selectionRangeInRoot(sel, root) ?? sel.getRangeAt(0)
      const text = range.toString()
      if (!text.trim()) {
        if (mode === 'sync') setSelectionPopup(null)
        return
      }

      // Map the rendered selection back onto plan source lines. Uses the
      // `.plan-read-segment` source-range metadata + scoped text match so the
      // comment anchors on the actual selected line/section instead of the
      // plan's `# Title` (the old whole-body match collapsed to L1 whenever the
      // selected text — often polluted by the heading's `#` anchor glyph —
      // failed to substring-match the body).
      const mapped =
        resolvePlanSelectionLines(displayBody, text, range) ??
        ({
          text: text.replace(/\s+/g, ' ').trim(),
          startLine: 1,
          endLine: 1,
        } as const)

      const rects = range.getClientRects()
      // first/last non-empty rects are visual top→bottom regardless of direction.
      let first: DOMRect | null = null
      let last: DOMRect | null = null
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]
        if (r.width === 0 && r.height === 0) continue
        if (!first) first = r
        last = r
      }
      const box = first && last ? null : range.getBoundingClientRect()
      const topRect = first ?? box
      const bottomRect = last ?? box
      if (!topRect || !bottomRect || (topRect.width === 0 && topRect.height === 0)) {
        if (mode === 'sync') setSelectionPopup(null)
        return
      }

      const popupH = 36
      const gap = 10
      const spaceBelow = window.innerHeight - bottomRect.bottom
      const placement: 'above' | 'below' =
        spaceBelow < popupH + gap + 8 && topRect.top > popupH + gap + 8 ? 'above' : 'below'
      const midX = (bottomRect.left + bottomRect.right) / 2
      const x = Math.min(Math.max(72, midX), window.innerWidth - 72)
      const y = placement === 'below' ? bottomRect.bottom + gap : topRect.top - gap

      setSelectionPopup({
        x,
        y,
        placement,
        startLine: mapped.startLine,
        endLine: mapped.endLine,
        text: mapped.text,
      })
    },
    [displayBody, isHistorical, editMode],
  )

  // Document-level listeners so we never miss reverse selections, releases
  // outside the pane, or keyboard Shift+Arrow selections.
  useEffect(() => {
    if (isHistorical || editMode || !showRendered) return

    let selTimer: ReturnType<typeof setTimeout> | 0 = 0
    const schedule = (mode: 'update' | 'sync') => {
      if (selTimer) clearTimeout(selTimer)
      selTimer = setTimeout(() => {
        requestAnimationFrame(() => evaluateRenderedSelection(mode))
      }, 0)
    }

    const onMouseUp = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      // Keep chip alive when pressing Add comment or interacting with floats.
      if (
        t?.closest?.(
          '.plan-selection-popup, .plan-selection-comment, .plan-float-tray, .confirm-dialog',
        )
      ) {
        return
      }
      schedule('sync')
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key.startsWith('Arrow') || e.key === 'End' || e.key === 'Home') {
        schedule('sync')
      }
    }
    const onSelectionChange = () => {
      // Only open/refresh — never clear here. Clearing on collapse would
      // remove the chip mid-click when the browser drops the selection.
      schedule('update')
    }

    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('keyup', onKeyUp, true)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      if (selTimer) clearTimeout(selTimer)
      document.removeEventListener('mouseup', onMouseUp, true)
      document.removeEventListener('keyup', onKeyUp, true)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [isHistorical, editMode, showRendered, evaluateRenderedSelection])

  const startCommentFromSelection = useCallback(() => {
    if (!selectionPopup) return
    const sel = window.getSelection()
    const range =
      sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null
    const highlightRects = range ? clientRectsToPage(range) : []

    const preferredLeft = selectionPopup.x - PANEL_DEFAULT_W / 2
    const preferredTop =
      selectionPopup.placement === 'below'
        ? selectionPopup.y + 8
        : selectionPopup.y - PANEL_DEFAULT_H - 8
    // Cascade new panels so multiple don't stack exactly.
    const cascade = floatComposers.length * 28
    const pos = clampToWindow(
      preferredLeft + cascade,
      preferredTop + cascade,
      PANEL_DEFAULT_W,
      PANEL_DEFAULT_H,
    )

    const start = selectionPopup.startLine
    const end = selectionPopup.endLine
    const exact = extractPlanLines(displayBody, start, end)
    const draft: FloatComposerDraft = {
      id: crypto.randomUUID(),
      lineNumber: end,
      startLineNumber: start !== end ? start : undefined,
      selectedQuote: selectionPopup.text,
      exactLines: exact,
      sourceContext: buildAgentLineContent(start, end),
      sectionTitle: sectionTitleForLine(displayBody, start),
      panelPos: pos,
      panelSize: { width: PANEL_DEFAULT_W, height: PANEL_DEFAULT_H },
      minimized: false,
      highlightRects,
    }
    setFloatComposers((prev) => [...prev, draft])
    setLiveSelectionCount(Math.abs(end - start) + 1)
    setSelectionPopup(null)
    // Keep the native selection until the next user interaction would clear it;
    // our page-space overlays also keep the highlight visible after selection drops.
  }, [selectionPopup, floatComposers.length, displayBody, buildAgentLineContent])

  // Esc: dismiss chip → (edit) open discard if anything to discard → exit zen.
  // Works even when focus is in the source textarea so discard is keyboard-accessible.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (discardEditsOpen || saveAsVersionOpen) return // Modal owns Escape
      if (selectionPopup) {
        e.preventDefault()
        setSelectionPopup(null)
        return
      }
      if (editMode) {
        if (canDiscard && !discardingEdits && saveStatus !== 'saving') {
          e.preventDefault()
          e.stopPropagation()
          setDiscardEditsOpen(true)
          return
        }
        // Nothing to discard — leave edit mode (flush on exit).
        e.preventDefault()
        e.stopPropagation()
        void exitEditMode()
        return
      }
      if (zenActive) {
        e.preventDefault()
        setZen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    selectionPopup,
    zenActive,
    setZen,
    editMode,
    canDiscard,
    discardingEdits,
    saveStatus,
    discardEditsOpen,
    saveAsVersionOpen,
    exitEditMode,
  ])

  // Dismiss only the lightweight chip on scroll (not open composers).
  useEffect(() => {
    if (!selectionPopup) return
    const dismiss = () => setSelectionPopup(null)
    window.addEventListener('scroll', dismiss, {
      passive: true,
      capture: true,
    })
    return () => window.removeEventListener('scroll', dismiss, true)
  }, [selectionPopup])

  const reviewUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${withSessionTokenPath(
          window.location.pathname.startsWith('/plan') ? window.location.pathname : `/plan/${plan.id}`,
        )}`
      : withSessionTokenPath(`/plan/${plan.id}`)

  /**
   * Drag the split divider: update a CSS var live (no React re-render per
   * mousemove), then commit ratio + persistence on mouseup.
   */
  const handleSplitResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const container = splitContentRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0) return

    setSplitDragging(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    let latest = splitRatioRef.current
    let rafId = 0

    const apply = (pct: number) => {
      latest = clampSplitRatio(pct)
      container.style.setProperty('--plan-split-pct', `${latest}%`)
    }

    const handleMove = (ev: MouseEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0
          apply(pct)
        })
      }
    }

    const handleUp = () => {
      if (rafId) cancelAnimationFrame(rafId)
      setSplitRatio(latest)
      setUiStateItem(PLAN_UI.splitRatio, String(latest))
      setSplitDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }

    // Immediate feedback on mousedown position (feels snappier than waiting for first move).
    apply(((e.clientX - rect.left) / rect.width) * 100)
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [])

  const sourcePanel = editMode ? (
    <div className="plan-file plan-file-editing">
      <PlanSourceEditor
        value={draftBody}
        onChange={setDraftBody}
        onActiveLineChange={setActiveEditLine}
        fontSize={fontSize}
        monoFontFamily={monoFontFamily}
        defaultTabSize={defaultTabSize}
        lineWrap={lineWrap}
        showLineNumbers={showLineNumbers}
      />
    </div>
  ) : (
    <div className="plan-file">
      <DiffsFile<PlanAnnotationMeta>
        file={{
          name: plan.sourcePath?.split(/[/\\]/).pop() || 'PLAN.md',
          contents: displayBody,
          lang: 'markdown',
        }}
        options={{
          disableFileHeader: true,
          enableGutterUtility: true,
          enableLineSelection: true,
          overflow: lineWrap ? 'wrap' : 'scroll',
          disableLineNumbers: !showLineNumbers,
          lineHoverHighlight,
          onLineSelectionStart: () => {
            // Drop open draft; stop controlling selectedLines so pierre owns the drag.
            setLiveSelectionCount(0)
            setPending(null)
            setSelectedRange(null)
            planDraftSessionRef.current = null
          },
          onLineSelectionChange: (range) => {
            setLiveSelectionCount(range ? Math.abs(range.end - range.start) + 1 : 0)
          },
          onLineSelectionEnd: (range) => {
            setLiveSelectionCount(0)
            if (range) {
              // Normalize reverse drags (start > end) via shared helper.
              const p = pendingFromSelection(range)
              openSourcePending({
                lineNumber: p.lineNumber,
                startLineNumber: p.startLineNumber,
              })
            }
          },
          // Pierre built-in gutter + only — cannot combine with renderGutterUtility.
          onGutterUtilityClick: (range) => {
            const p = pendingFromSelection(range)
            openSourcePending({
              lineNumber: p.lineNumber,
              startLineNumber: p.startLineNumber,
            })
          },
          theme: {
            dark: shikiConfig.type === 'dark' ? shikiConfig.themeName : 'rose-pine',
            light: shikiConfig.type === 'light' ? shikiConfig.themeName : 'github-light',
          },
          themeType: shikiConfig.type,
          unsafeCSS,
        }}
        selectedLines={pending ? selectedRange : undefined}
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation}
      />
    </div>
  )

  const renderedPanel = (
    <div
      className={[
        'plan-rendered-layout',
        tocOpen && outline.length > 0 && !zenActive ? 'has-toc' : '',
        isReadOnly ? 'plan-rendered-layout-solo' : '',
        zenActive ? 'plan-rendered-layout-zen' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {tocOpen && outline.length > 0 && !zenActive && (
        <nav className="plan-toc" aria-label="Plan outline">
          <div className="plan-toc-head">
            <ListTree size={12} aria-hidden="true" />
            <span>Outline</span>
          </div>
          <ul className="plan-toc-list">
            {outline.map((item) => (
              <li
                key={item.id}
                className={`plan-toc-item plan-toc-level-${Math.min(item.level, 4)}`}
              >
                <a
                  href={`#${item.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    jumpToOutlineSection(item.id)
                  }}
                >
                  {item.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div ref={renderedRef} className="markdown-body plan-rendered" onClick={handleMarkdownClick}>
        {/* React-owned sections + comments (no DOM injection — survives mode switches). */}
        <PlanReadInlineComments
          body={displayBody}
          outline={outline}
          comments={lineComments}
          onResolve={(id) => resolvePlanComment(plan.id, id)}
          onUnresolve={(id) => unresolvePlanComment(plan.id, id)}
          onDelete={(id) => removePlanComment(plan.id, id)}
          onEdit={(id, body) => editPlanComment(plan.id, id, body)}
          onReply={(id, body) => addPlanReply(plan.id, id, body)}
          onEditReply={(commentId, replyId, body) =>
            editPlanReply(plan.id, commentId, replyId, body)
          }
          onDeleteReply={(commentId, replyId) => removePlanReply(plan.id, commentId, replyId)}
        />
      </div>
    </div>
  )

  // When inline comments appear/disappear, Read layout reflows — float
  // highlight rects must remeasure (see PlanFloatComposers layoutEpoch).
  const floatLayoutEpoch = useMemo(
    () =>
      `${viewMode}:${viewingVersion}:${lineComments.map((c) => c.id).join(',')}:${floatComposers.map((c) => c.id).join(',')}`,
    [viewMode, viewingVersion, lineComments, floatComposers],
  )

  const floatingSelectionComposers =
    showRendered && !editMode && floatComposers.length > 0 ? (
      <PlanFloatComposers
        planId={plan.id}
        composers={floatComposers}
        onChange={setFloatComposers}
        onSubmit={commitFloatComment}
        planBody={displayBody}
        buildSourceContext={buildAgentLineContent}
        renderedRootRef={renderedRef}
        layoutEpoch={floatLayoutEpoch}
      />
    ) : null

  const saveStatusLabel =
    saveStatus === 'saving'
      ? 'Saving…'
      : saveStatus === 'saved'
        ? 'Saved'
        : saveStatus === 'dirty'
          ? 'Unsaved'
          : saveStatus === 'error'
            ? saveError || 'Save failed'
            : null

  const showCommentsRail = !zenActive && commentsRailOpen && comments.length > 0
  const showCommentsRailInline = showCommentsRail && !commentsRailSheet

  const commentsMapPanel = showCommentsRail ? (
    <aside
      className={`plan-comments-rail ${commentsRailSheet ? 'plan-comments-sheet' : ''}`}
      aria-label="Comments map"
      {...(commentsRailSheet ? { role: 'dialog', 'aria-modal': true as const } : {})}
    >
      <div className="plan-comments-rail-head">
        <MessagesSquare size={12} aria-hidden="true" />
        <span>Comments</span>
        <span className="plan-comments-rail-count">
          {openCount > 0 ? `${openCount} open` : `${comments.length}`}
        </span>
        {commentsRailSheet && (
          <button
            type="button"
            className="plan-comments-sheet-close"
            onClick={() => setCommentsRailOpen(false)}
            aria-label="Close comments map"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <ul className="plan-comments-rail-list">
        {[...comments]
          .sort((a, b) => {
            if (a.status !== b.status) return a.status === 'open' ? -1 : 1
            return a.lineNumber - b.lineNumber
          })
          .map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`plan-comments-rail-item ${c.status === 'resolved' ? 'is-resolved' : ''}`}
                onClick={() => jumpToCommentFromRail(c.id, c.lineNumber)}
                title={c.body.slice(0, 200)}
              >
                <span className="plan-comments-rail-line">{planCommentLineLabel(c)}</span>
                <span className="plan-comments-rail-preview">
                  {c.sectionTitle ? `${c.sectionTitle} · ` : ''}
                  {c.body.replace(/\s+/g, ' ').slice(0, 80)}
                  {c.body.length > 80 ? '…' : ''}
                </span>
                <span
                  className={`plan-comments-rail-status plan-comments-rail-status-${c.status}`}
                >
                  {c.status}
                </span>
              </button>
            </li>
          ))}
      </ul>
    </aside>
  ) : null

  return (
    <div
      className={`plan-review ${zenActive ? 'plan-review-zen' : ''} ${isReadOnly ? 'plan-review-read' : ''} ${
        editMode ? 'plan-review-editing' : ''
      }`}
    >
      <header className="plan-review-head" ref={headRef}>
        <div className="plan-review-head-main">
          <div className="plan-review-title-row">
            {editMode ? (
              <input
                className="plan-review-title-input"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                aria-label="Plan title"
                placeholder="Untitled plan"
              />
            ) : (
              <h2 className="plan-review-title" title={displayTitle}>
                {displayTitle}
                {isHistorical && displayTitle !== plan.title && (
                  <span
                    className="plan-review-title-historical"
                    title={`Currently submitted title: ${plan.title}`}
                  >
                    {' '}
                    · was “{plan.title}”
                  </span>
                )}
              </h2>
            )}
            <span className={`plan-badge ${decision.className}`}>
              <DecisionIcon size={12} aria-hidden="true" />
              {decision.label}
            </span>
            {editMode && saveStatusLabel && (
              <span
                className={`plan-review-chip plan-review-save-status plan-review-save-status-${saveStatus}`}
                role="status"
                title={saveError ?? undefined}
              >
                {saveStatus === 'saving' && (
                  <Loader2 size={11} className="spin" aria-hidden="true" />
                )}
                {saveStatusLabel}
              </span>
            )}
          </div>

          <div className="plan-review-meta">
            {versions.length <= 1 ? (
              <span className="plan-review-chip">v{viewingVersion}</span>
            ) : (
              <div
                className={`plan-review-version-switcher ${isHistorical ? 'is-historical' : ''}`}
              >
                <History
                  size={12}
                  aria-hidden="true"
                  className="plan-review-version-switcher-icon"
                />
                <Select
                  value={String(viewingVersion)}
                  onValueChange={(v) => {
                    const next = Number(v)
                    if (editMode && next !== plan.version) {
                      // Leave edit mode before browsing history (flush first).
                      void exitEditMode().then(() => setViewingVersion(next))
                      return
                    }
                    setViewingVersion(next)
                  }}
                  options={versionOptions}
                  ariaLabel="Plan version"
                />
                {isHistorical && (
                  <button
                    type="button"
                    className="plan-review-version-back"
                    onClick={() => setViewingVersion(plan.version)}
                    title={`Back to current v${plan.version}`}
                  >
                    <ArrowLeft size={11} aria-hidden="true" />
                    Current
                  </button>
                )}
              </div>
            )}

            {plan.model && (
              <span className="plan-review-chip plan-review-chip-model" title={plan.model}>
                <Bot size={11} aria-hidden="true" />
                {plan.model}
              </span>
            )}

            <span
              className="plan-review-meta-stat"
              title={`${lineCount} lines · ${wordCount} words · updated ${timeAgo(plan.updatedAt)}`}
            >
              {lineCount}L · {wordCount}W
              {openCount > 0 && <span className="plan-review-meta-open"> · {openCount} open</span>}
              {comments.length > 0 && openCount === 0 && (
                <span>
                  {' '}
                  · {comments.length} comment{comments.length === 1 ? '' : 's'}
                </span>
              )}
              {isHistorical && totalCommentCount !== comments.length && (
                <span className="plan-review-chip-sub"> of {totalCommentCount}</span>
              )}
            </span>

            {(liveSelectionCount > 0 || floatComposers.length > 0) && (
              <span className="plan-review-chip plan-review-chip-selection" aria-live="polite">
                {floatComposers.length > 0
                  ? `${floatComposers.length} draft${floatComposers.length === 1 ? '' : 's'}`
                  : `${liveSelectionCount} selected`}
              </span>
            )}

            {(copyablePath || plan.source) && (
              <div className="plan-source-inline">
                <FolderOpen size={12} className="plan-source-icon" aria-hidden="true" />
                <code className="plan-source-path" title={copyablePath ?? plan.source}>
                  {shortPath ?? plan.source}
                </code>
                {copyablePath && (
                  <Tooltip content="Copy absolute source path" side="top">
                    <button
                      type="button"
                      className="plan-icon-btn"
                      onClick={() => copyText(copyablePath, 'Path copied')}
                      aria-label="Copy plan source path"
                    >
                      <Copy size={12} />
                    </button>
                  </Tooltip>
                )}
                {copyFlash && (
                  <span className="plan-source-flash" role="status">
                    {copyFlash}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="plan-review-head-actions" role="toolbar" aria-label="Plan actions">
          <Tooltip content="Copy review link" side="bottom">
            <button
              type="button"
              className="plan-icon-btn"
              onClick={() => copyText(reviewUrl, 'Link copied')}
              aria-label="Copy review URL"
            >
              <Link2 size={14} />
            </button>
          </Tooltip>
          <Tooltip content="Copy plan markdown" side="bottom">
            <button
              type="button"
              className="plan-icon-btn"
              onClick={() => copyText(displayBody, 'Markdown copied')}
              aria-label="Copy plan markdown"
            >
              <FileText size={14} />
            </button>
          </Tooltip>
          {copyablePath && (
            <Tooltip content="Open source in editor" side="bottom">
              <button
                type="button"
                className="plan-icon-btn"
                onClick={openInEditor}
                disabled={openingEditor}
                aria-label="Open plan source in editor"
              >
                {openingEditor ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <ExternalLink size={14} />
                )}
              </button>
            </Tooltip>
          )}
          {canEdit && (
            <Tooltip
              content={
                editMode ? 'Done editing (e) — autosave flushes on exit' : 'Edit plan live (e)'
              }
              side="bottom"
            >
              <button
                type="button"
                className={`plan-icon-btn ${editMode ? 'is-active' : ''} ${isDirty ? 'is-dirty' : ''}`}
                onClick={() => {
                  if (editMode) void exitEditMode()
                  else enterEditMode()
                }}
                aria-pressed={editMode}
                aria-label={editMode ? 'Done editing plan' : 'Edit plan'}
              >
                <Pencil size={14} />
              </button>
            </Tooltip>
          )}
          {editMode && (
            <>
              <Tooltip content="Save now (⌘S)" side="bottom">
                <button
                  type="button"
                  className="plan-icon-btn"
                  onClick={() => {
                    if (autosaveTimerRef.current) {
                      clearTimeout(autosaveTimerRef.current)
                      autosaveTimerRef.current = null
                    }
                    void flushAutosave()
                  }}
                  disabled={saveStatus === 'saving' || submittingPlanVersion || discardingEdits}
                  aria-label="Save plan now"
                >
                  <Save size={14} />
                </button>
              </Tooltip>
              <Tooltip
                content="Save as new version — bumps version and reopens review"
                side="bottom"
              >
                <button
                  type="button"
                  className="plan-icon-btn"
                  onClick={() => setSaveAsVersionOpen(true)}
                  disabled={
                    saveStatus === 'saving' ||
                    submittingPlanVersion ||
                    discardingEdits ||
                    !draftBody.trim()
                  }
                  aria-label="Save as new version"
                >
                  {submittingPlanVersion ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <GitBranch size={14} />
                  )}
                </button>
              </Tooltip>
              <Tooltip
                content={
                  discardIsDual
                    ? 'Discard edits (Esc) — recent session or roll back to original'
                    : hasOriginalRollback && !hasRecentEdits
                      ? 'Roll back to original (Esc) — before you started editing this version'
                      : 'Discard edits (Esc) — restore to start of this edit session'
                }
                side="bottom"
              >
                <button
                  type="button"
                  className="plan-icon-btn plan-icon-btn-danger"
                  onClick={openDiscardDialog}
                  disabled={!canDiscard || discardingEdits || saveStatus === 'saving'}
                  aria-label="Discard edits"
                  title="Esc"
                >
                  {discardingEdits ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <RotateCcw size={14} />
                  )}
                </button>
              </Tooltip>
            </>
          )}
          <span className="plan-action-divider" aria-hidden="true" />
          {isReadOnly && (
            <Tooltip
              content={
                zenActive ? 'Exit zen reading (z / Esc)' : 'Zen mode — full-width focus reading (z)'
              }
              side="bottom"
            >
              <button
                type="button"
                className={`plan-icon-btn ${zenActive ? 'is-active' : ''}`}
                onClick={() => setZen((v) => !v)}
                aria-pressed={zenActive}
                aria-label={zenActive ? 'Exit zen reading' : 'Enter zen reading mode'}
              >
                {zenActive ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </Tooltip>
          )}
          {showRendered && outline.length > 0 && !zenActive && (
            <Tooltip content={tocOpen ? 'Hide outline (o)' : 'Show outline (o)'} side="bottom">
              <button
                type="button"
                className={`plan-icon-btn ${tocOpen ? 'is-active' : ''}`}
                onClick={() => setTocOpen((v) => !v)}
                aria-pressed={tocOpen}
                aria-label={tocOpen ? 'Hide outline' : 'Show outline'}
              >
                <ListTree size={14} />
              </button>
            </Tooltip>
          )}
          {comments.length > 0 && !zenActive && (
            <Tooltip
              content={
                commentsRailOpen
                  ? 'Hide comments map (c)'
                  : openCount > 0
                    ? `Show comments map (${openCount} open) · c`
                    : 'Show comments map (c)'
              }
              side="bottom"
            >
              <button
                type="button"
                className={`plan-icon-btn ${commentsRailOpen ? 'is-active' : ''}`}
                onClick={() => setCommentsRailOpen((v) => !v)}
                aria-pressed={commentsRailOpen}
                aria-label={
                  commentsRailOpen
                    ? 'Hide comments map'
                    : openCount > 0
                      ? `Show comments map, ${openCount} open`
                      : 'Show comments map'
                }
              >
                <MessagesSquare size={14} />
                {openCount > 0 && <span className="plan-icon-btn-badge">{openCount}</span>}
              </button>
            </Tooltip>
          )}
        </div>
      </header>

      {zenActive && (
        <div className="plan-zen-bar" role="status">
          <span className="plan-zen-bar-label">Zen reading</span>
          <span className="plan-zen-bar-hint">Esc or button to exit</span>
          <button type="button" className="plan-zen-bar-exit" onClick={() => setZen(false)}>
            <Minimize2 size={13} aria-hidden="true" />
            Exit zen
          </button>
        </div>
      )}

      {isHistorical && (
        <div className="plan-review-historical-banner" role="status">
          <History size={14} aria-hidden="true" />
          <span>
            Viewing <strong>v{viewingVersion}</strong> of this plan (current is{' '}
            <strong>v{plan.version}</strong>). Comments and line anchors reflect v{viewingVersion}.
          </span>
          <button
            type="button"
            className="plan-review-historical-banner-back"
            onClick={() => setViewingVersion(plan.version)}
          >
            <ArrowLeft size={11} aria-hidden="true" />
            Back to current
          </button>
        </div>
      )}

      {editMode && (
        <div className="plan-review-edit-banner" role="status">
          <Pencil size={14} aria-hidden="true" />
          <span>
            Editing live — changes autosave to the current version
            {totalCommentCount > 0
              ? '. Line anchors on existing comments may shift if you insert or delete lines.'
              : '.'}{' '}
            New comments are disabled until you finish editing.
            {originalDiffersFromSession
              ? ' Prior session edits are saved; Esc or Discard can roll back further.'
              : ' Esc opens discard.'}
          </span>
          {canDiscard && (
            <button
              type="button"
              className="plan-review-edit-banner-discard"
              onClick={openDiscardDialog}
              disabled={discardingEdits || saveStatus === 'saving'}
            >
              <RotateCcw size={11} aria-hidden="true" />
              {hasOriginalRollback && !hasRecentEdits ? 'Roll back to original' : 'Discard edits'}
              <kbd className="plan-review-edit-banner-kbd">Esc</kbd>
            </button>
          )}
          {editMode && viewMode === 'rendered' && (
            <button
              type="button"
              className="plan-review-historical-banner-back"
              onClick={() => onViewModeChange?.('split')}
            >
              Show source
            </button>
          )}
        </div>
      )}

      {!editMode && exitSavedNotice && (
        <div className="plan-review-exit-saved-banner" role="status">
          <Save size={14} aria-hidden="true" />
          <span>
            <strong>Edits saved</strong> to this version. They are now the starting point the next
            time you press Edit. Use <strong>Discard</strong> after re-entering edit to roll back to
            the plan as it was before you started editing this version.
          </span>
          <button
            type="button"
            className="plan-review-exit-saved-banner-dismiss"
            onClick={() => setExitSavedNotice(false)}
            aria-label="Dismiss saved-edits notice"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {conflictVersion != null && (
        <div className="plan-review-conflict-banner" role="alert">
          <MessageSquareWarning size={14} aria-hidden="true" />
          <span>
            Agent submitted <strong>v{conflictVersion}</strong> while you have unsaved edits. Keep
            your draft, or discard and load the new version.
          </span>
          <button
            type="button"
            className="plan-review-historical-banner-back"
            onClick={() => setConflictVersion(null)}
          >
            Keep editing
          </button>
          <button
            type="button"
            className="plan-review-historical-banner-back"
            onClick={discardConflictAndLoad}
          >
            Discard &amp; load
          </button>
        </div>
      )}

      {plan.decision !== 'pending' && plan.decisionComment && (
        <div className={`plan-decision-banner ${decision.className}`}>
          <DecisionIcon size={15} aria-hidden="true" />
          <div className="plan-decision-banner-text">
            <strong>{decision.label}</strong>
            <Markdown
              content={plan.decisionComment}
              className="plan-decision-banner-note markdown-body"
            />
          </div>
        </div>
      )}

      {generalComments.length > 0 && (
        <section className="plan-general-section" aria-label="General comments">
          <div className="plan-general-header">
            <MessageSquarePlus size={14} aria-hidden="true" />
            <span>General comments</span>
            <span className="plan-general-count">{generalComments.length}</span>
          </div>
          <div className="plan-general-list">
            {generalComments.map((c) => (
              <div key={c.id} id={`plan-comment-${c.id}`}>
                <PlanCommentBubble
                  comment={c}
                  onResolve={() => resolvePlanComment(plan.id, c.id)}
                  onUnresolve={() => unresolvePlanComment(plan.id, c.id)}
                  onDelete={() => removePlanComment(plan.id, c.id)}
                  onEdit={(body) => editPlanComment(plan.id, c.id, body)}
                  onReply={(body) => addPlanReply(plan.id, c.id, body)}
                  onEditReply={(replyId, body) => editPlanReply(plan.id, c.id, replyId, body)}
                  onDeleteReply={(replyId) => removePlanReply(plan.id, c.id, replyId)}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <div
        className={`plan-review-body ${
          showCommentsRailInline ? 'plan-review-body-with-rail' : ''
        }`}
      >
        <div
          ref={splitContentRef}
          className={`plan-content ${isSplit ? 'plan-content-split' : 'plan-content-single'} ${
            splitDragging ? 'plan-content-split-dragging' : ''
          } ${isReadOnly ? 'plan-content-read' : ''} ${zenActive ? 'plan-content-zen' : ''}`}
          style={
            isSplit
              ? ({
                  '--plan-split-pct': `${splitRatio}%`,
                } as React.CSSProperties)
              : undefined
          }
        >
          {showSource && sourcePanel}
          {isSplit && (
            <div
              className="plan-split-resize-handle"
              onMouseDown={handleSplitResizeStart}
              onDoubleClick={() => {
                const next = 50
                setSplitRatio(next)
                setUiStateItem(PLAN_UI.splitRatio, String(next))
                splitContentRef.current?.style.setProperty('--plan-split-pct', `${next}%`)
              }}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize source and rendered panes"
              title="Drag to resize · double-click to reset 50/50"
              aria-valuenow={Math.round(splitRatio)}
              aria-valuemin={20}
              aria-valuemax={80}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault()
                const delta = e.key === 'ArrowLeft' ? -2 : 2
                const next = clampSplitRatio(splitRatio + delta)
                setSplitRatio(next)
                setUiStateItem(PLAN_UI.splitRatio, String(next))
                splitContentRef.current?.style.setProperty('--plan-split-pct', `${next}%`)
              }}
            >
              <span className="plan-split-resize-grip" aria-hidden="true" />
            </div>
          )}
          {showRendered && renderedPanel}
        </div>

        {showCommentsRailInline && commentsMapPanel}
      </div>

      {showCommentsRail && commentsRailSheet && (
        <>
          <div
            className="plan-comments-sheet-backdrop"
            onClick={() => setCommentsRailOpen(false)}
            aria-hidden="true"
          />
          {commentsMapPanel}
        </>
      )}

      {selectionPopup && !editMode && (
        <button
          type="button"
          className={`plan-selection-popup plan-selection-popup-${selectionPopup.placement}`}
          style={{ left: selectionPopup.x, top: selectionPopup.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={startCommentFromSelection}
        >
          <MessageSquarePlus size={13} aria-hidden="true" />
          Add comment
          <span className="plan-selection-popup-lines">
            L{selectionPopup.startLine}
            {selectionPopup.endLine !== selectionPopup.startLine
              ? `–${selectionPopup.endLine}`
              : ''}
          </span>
        </button>
      )}

      {floatingSelectionComposers}

      <FilePreviewModal
        isOpen={!!previewFilePath}
        filePath={previewFilePath}
        onClose={() => setPreviewFilePath(null)}
      />

      <ConfirmDialog
        open={saveAsVersionOpen}
        title="Save as new version?"
        description={`Creates v${plan.version + 1} from your current draft and reopens the plan for review (decision becomes pending). In-place autosave does not create a version.`}
        confirmLabel="Save as new version"
        cancelLabel="Cancel"
        variant="primary"
        onConfirm={() => {
          void handleSaveAsNewVersion()
        }}
        onCancel={() => setSaveAsVersionOpen(false)}
      />

      <PlanDiscardEditsDialog
        open={discardEditsOpen}
        canDiscardRecent={hasRecentEdits}
        canRollbackOriginal={hasOriginalRollback && originalDiffersFromSession}
        onChoose={(choice) => {
          void handleDiscardChoice(choice)
        }}
        onCancel={() => setDiscardEditsOpen(false)}
        busy={discardingEdits}
      />
    </div>
  )
}

function buildPlanCSS(tabSize: number, fontSize: number, fontFamily: string): string {
  return `
    :host {
      --diffs-tab-size: ${tabSize} !important;
      --diffs-font-family: ${fontFamily} !important;
      --diffs-font-size: ${fontSize}px !important;
      --diffs-border: var(--gl-rule) !important;
      --diffs-bg: var(--gl-canvas) !important;
      --diffs-line-height: ${Math.round(fontSize * 1.7)}px !important;
    }
    [data-column-number], [data-line], [data-line] * {
      font-family: ${fontFamily} !important;
      font-size: ${fontSize}px !important;
      font-variant-ligatures: common-ligatures !important;
      font-feature-settings: "liga" on, "calt" on !important;
    }
    [data-column-number] {
      color: var(--gl-gutter) !important;
      opacity: 1 !important;
      user-select: none !important;
      padding-right: 12px !important;
    }
    [data-line]:hover [data-column-number] {
      opacity: 1 !important;
      color: var(--gl-accent) !important;
    }
    [data-line][data-line-type="addition"] {
      background-color: var(--gl-added-surface) !important;
      box-shadow: inset 2px 0 var(--gl-positive) !important;
    }
    [data-line][data-line-type="deletion"] {
      background-color: var(--gl-removed-surface) !important;
      box-shadow: inset 2px 0 var(--gl-negative) !important;
    }
    /* Lift syntax tokens toward --text-primary on changed lines so muted
       theme colours (e.g. rose-pine comments) stay readable on the tinted
       diff wash. Themes tune --gl-diff-text-lift; 0% = unchanged. */
    [data-line][data-line-type="addition"] *,
    [data-line][data-line-type="deletion"] * {
      color: color-mix(in srgb, var(--text-primary) var(--gl-diff-text-lift, 0%), currentColor) !important;
    }
    [data-line].selected-line {
      outline: 1px solid var(--gl-focus) !important;
      outline-offset: -1px !important;
    }
    [data-line].selected-line:not([data-line-type="addition"]):not([data-line-type="deletion"]) {
      background-color: var(--gl-selected) !important;
    }
    ${EMBEDDED_COMMENT_STYLES}
  `
}
