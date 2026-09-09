import {
  useState,
  memo,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from "react";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";
import { VirtualizedFileDiff } from "@pierre/diffs";
import type { FileDiffOptions } from "@pierre/diffs";
import {
  registerDiffTarget,
  scheduleDiffNavigation,
} from "../lib/diffNavigation";
import { openDefinitionPeek } from "../lib/definitionPeek";
import {
  useCodeIntel,
  type CodeIntelAction,
  type CodeIntelEdits,
  type CodeIntelTarget,
} from "../hooks/useCodeIntel";
import { decideCodeIntelApply } from "../lib/codeIntelApply";
import { createEditPredictProvider } from "../lib/editPredictProvider";
import { InputDialog } from "../primitives/InputDialog";
import { CodeIntelPopover } from "./CodeIntelPopover";
import type {
  DiffLineAnnotation,
  DiffTokenEventBaseProps,
  FileDiffMetadata,
  AnnotationSide,
  SelectedLineRange,
  FileContents,
  VirtualFileMetrics,
} from "@pierre/diffs";
import type { Editor, EditorOptions, TextEdit } from "@pierre/diffs/edit";

/** Structural slice of the library's SelectionActionContext (not exported). */
interface EditSelectionActionContext {
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  getSelectionText: () => string;
  close: () => void;
}
import {
  ChevronDown,
  ChevronRight,
  Edit3,
  PenLine,
  MessageSquare,
  Maximize2,
  Loader2,
  Undo2,
  AlertCircle,
  X,
  HelpCircle,
  Clock,
  User,
  Copy,
  Check,
  Save,
  RotateCcw,
  Search,
} from "lucide-react";
import type { FileSearchSession } from "../hooks/useFileSearch";
import { FileSearchBar } from "./FileSearchBar";
import { Modal } from "../primitives/Modal";
import { Tooltip } from "../primitives/Tooltip";
import { EMBEDDED_COMMENT_STYLES } from "../lib/embeddedCommentStyles";
import { useFileContents } from "../hooks/useFileContents";
import { isReviewCommentSide, type ReviewComment } from "../../lib/types";
import type { AiDiffSelection } from "../../lib/ai/types";
import type { HunkHistory } from "../../lib/git";
import type { PrExistingComment } from "../../lib/pr-session";
import type {
  LineDiffType,
  DiffIndicators,
  HunkSeparatorStyle,
  LineHoverHighlight,
} from "../hooks/useSettings";
import { CommentForm } from "./CommentForm";
import { CommentBubble } from "./CommentBubble";
import { ExistingPrCommentBubble } from "./ExistingPrCommentBubble";
import { DiffMinimap } from "./DiffMinimap";
import { SHIKI_THEME_MAP, scrollToLine } from "../utils";
import {
  clearFindHighlights,
  syncFindHighlights,
} from "../lib/findInFileHighlights";
import type { EditAnnotation, EditSessionView } from "../hooks/useEditSessions";
import {
  pendingFromSelection,
  pendingLineLabel,
  pendingOrderedRange,
  pendingSideLabel,
  selectedRangeFromPending,
  adjustPendingStart,
  adjustPendingEnd,
  canAdjustPendingStart,
  canAdjustPendingEnd,
  normalizePendingRange,
  type PendingLineComment,
  type PendingLineBounds,
} from "../lib/commentSelection";

type PendingComment = PendingLineComment;

/** Metadata union carried by every inline annotation this card renders. */
type CardAnnotationMetadata =
  | ReviewComment
  | { _pending: true }
  | { _existingPr: true; comment: PrExistingComment };

/** Keep current GitHub threads on their exact diff line; stale anchors fall back to file-level context. */
export function canAnchorPrComment(
  fileDiff: FileDiffMetadata,
  comment: PrExistingComment,
): boolean {
  if (
    comment.isOutdated ||
    comment.line == null ||
    comment.line < 1 ||
    comment.side == null
  )
    return false;
  const side = comment.side === "LEFT" ? "deletions" : "additions";
  const startKey = side === "additions" ? "additionStart" : "deletionStart";
  const countKey = side === "additions" ? "additionCount" : "deletionCount";
  return fileDiff.hunks.some(
    (hunk) =>
      comment.line! >= hunk[startKey] &&
      comment.line! < hunk[startKey] + hunk[countKey],
  );
}

/** Min/max file line numbers present on one side of a pierre FileDiffMetadata. */
function boundsForSide(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  expandedLineCount?: number,
): PendingLineBounds {
  const startKey = side === "additions" ? "additionStart" : "deletionStart";
  const countKey = side === "additions" ? "additionCount" : "deletionCount";
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const hunk of fileDiff.hunks) {
    const start = hunk[startKey] as number;
    const count = hunk[countKey] as number;
    if (count <= 0) continue;
    min = Math.min(min, start);
    max = Math.max(max, start + count - 1);
  }
  // When full-file context is expanded, allow navigating the whole file.
  if (expandedLineCount && expandedLineCount > 0) {
    min = Math.min(min === Number.POSITIVE_INFINITY ? 1 : min, 1);
    max = Math.max(max, expandedLineCount);
  }
  if (!Number.isFinite(min) || max < 1) {
    return { min: 1, max: Math.max(1, expandedLineCount ?? 1) };
  }
  return { min, max };
}

/** Keep malformed persisted annotations away from Pierre's strict side index. */
export function filterSupportedLineAnnotations<T>(
  annotations: DiffLineAnnotation<T>[],
): DiffLineAnnotation<T>[] {
  return annotations.filter(
    (annotation) =>
      annotation.lineNumber > 0 && isReviewCommentSide(annotation.side),
  );
}

interface FileDiffCardProps {
  id?: string;
  fileDiff: FileDiffMetadata;
  filePath: string;
  annotations: DiffLineAnnotation<ReviewComment>[];
  /** Published GitHub threads, anchored to their PR diff line when possible. */
  existingComments?: PrExistingComment[];
  diffStyle: "split" | "unified";
  tabSize: number;
  viewed: boolean;
  theme: string;
  editorIDE?: string;
  lineDiffType: LineDiffType;
  lineWrap: boolean;
  diffIndicators: DiffIndicators;
  showLineNumbers: boolean;
  hunkSeparators: HunkSeparatorStyle;
  lineHoverHighlight: LineHoverHighlight;
  fontSize: number;
  monoFontFamily: string;
  expandContextByDefault: boolean;
  collapsedContextThreshold: number;
  expansionLineCount: number;
  /**
   * Auto-collapse the card when its added+deleted line count exceeds this.
   * Set to 0 to disable. The user can still expand any card by clicking the
   * header; auto-collapse only fires on initial mount / file change.
   */
  autoCollapseLineThreshold: number;
  onViewedChange: (filePath: string, viewed: boolean) => void;
  onAddComment: (
    filePath: string,
    side: AnnotationSide,
    lineNumber: number,
    lineContent: string,
    body: string,
    startLineNumber?: number,
    severity?: import("../../lib/types").CommentSeverity,
  ) => void | Promise<unknown>;
  onDeleteComment: (id: string) => void;
  onAddSelectionToAsk?: (selection: AiDiffSelection) => void;
  onReplyExisting?: (commentId: number, body: string) => Promise<void>;
  onEditExisting?: (commentId: number, body: string) => Promise<void>;
  onDeleteExisting?: (commentId: number) => Promise<void>;
  onSetExistingResolved?: (
    threadId: string,
    resolved: boolean,
  ) => Promise<void>;
  onApplyExisting?: (commentId: number) => Promise<void>;
  expectedHeadSha?: string;
  /** Hide editor/revert actions on remote or otherwise read-only review surfaces. */
  allowLocalActions?: boolean;
  /**
   * Fired by the header click AFTER the local `collapsed` state has been
   * flipped. Used by App.tsx to drive the auto-advance-to-next-file
   * scroll when the user collapses a card. Not fired by the "Add Comment"
   * expand path or by the `viewed`-prop sync effect — only by the user's
   * explicit header click.
   */
  onCardToggleCollapse?: (filePath: string, willCollapse: boolean) => void;
  /** Scope-level gate: editing is only available in working-tree reviews. */
  canEdit?: boolean;
  /** Active in-place edit session for this file, if any. */
  editSession?: EditSessionView | null;
  onRequestEdit?: (filePath: string) => void;
  onEditChange?: (
    filePath: string,
    file: FileContents,
    annotations?: EditAnnotation[],
  ) => void;
  onEditAttach?: (
    filePath: string,
    editor: Editor<"file-diff", CardAnnotationMetadata>,
  ) => void;
  onEditSave?: (filePath: string) => void;
  onEditDiscard?: (filePath: string) => void;
  onEditExit?: (filePath: string) => void;
  /**
   * Active file-scoped search session. The card renders its find-in-file bar
   * only when `fileSearch.filePath` matches this card's file. Undefined (or a
   * session targeting another file) hides the bar.
   */
  fileSearch?: FileSearchSession | null;
  /** Open the find-in-file bar on this file (from the header search button). */
  onOpenFileSearch?: (filePath: string) => void;
  /** The `codeIntel` setting; false keeps token listeners off the renderer. */
  codeIntelEnabled?: boolean;
  /** The scope being displayed, which code intel must answer against. */
  staged?: boolean;
  /**
   * Apply language-server edits to this file's open editor. Returns false when
   * there is nothing to apply them to.
   */
  onApplyEdits?: (filePath: string, edits: TextEdit[]) => boolean;
  /** Opt-in ghost-text edit prediction (Alt) for this file. */
  editPredictionEnabled?: boolean;
}

export const FileDiffCard = memo(function FileDiffCard({
  id,
  fileDiff,
  filePath,
  annotations,
  existingComments = [],
  diffStyle,
  tabSize,
  viewed,
  theme,
  editorIDE,
  lineDiffType,
  lineWrap,
  diffIndicators,
  showLineNumbers,
  hunkSeparators,
  lineHoverHighlight,
  fontSize,
  monoFontFamily,
  expandContextByDefault,
  collapsedContextThreshold,
  expansionLineCount,
  autoCollapseLineThreshold,
  onViewedChange,
  onAddComment,
  onDeleteComment,
  onAddSelectionToAsk,
  onReplyExisting,
  onEditExisting,
  onDeleteExisting,
  onSetExistingResolved,
  onApplyExisting,
  expectedHeadSha,
  allowLocalActions = true,
  onCardToggleCollapse,
  canEdit = false,
  editSession = null,
  onRequestEdit,
  onEditChange,
  onEditAttach,
  onEditSave,
  onEditDiscard,
  onEditExit,
  fileSearch,
  onOpenFileSearch,
  codeIntelEnabled = false,
  staged = false,
  onApplyEdits,
  editPredictionEnabled = false,
}: FileDiffCardProps) {
  const [pending, setPending] = useState<PendingComment | null>(null);
  /**
   * Controlled pierre selection — only set while a pending composer is open so
   * we do not fight live drag selection (re-applying null mid-drag collapses
   * multi-line ranges to a single line).
   */
  const [selectedRange, setSelectedRange] = useState<SelectedLineRange | null>(
    null,
  );
  const [liveSelectionCount, setLiveSelectionCount] = useState(0);
  /** Stable draft key for the open composer session (survives range adjusts). */
  const draftSessionRef = useRef<string | null>(null);
  const [permalinkFlash, setPermalinkFlash] = useState<string | null>(null);
  const [pathCopyFlash, setPathCopyFlash] = useState(false);
  const lineTotal =
    fileDiff.additionLines.length + fileDiff.deletionLines.length;
  // Collapse if the user has viewed the file OR if the auto-collapse threshold
  // is set and the file is larger than it. Threshold 0 = never auto-collapse.
  const initialCollapsed =
    viewed ||
    (autoCollapseLineThreshold > 0 && lineTotal > autoCollapseLineThreshold);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [opening, setOpening] = useState(false);
  const [showFileCommentForm, setShowFileCommentForm] = useState(false);
  const [localContextExpanded, setLocalContextExpanded] = useState(
    expandContextByDefault,
  );
  // In-place editing forces full-file context: the editor's document must be
  // the whole new file so a save never truncates a partial patch.
  const editing = editSession != null;
  const contextExpanded = editing ? true : localContextExpanded;
  const [revertingHunk, setRevertingHunk] = useState<number | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [previewHunkIndex, setPreviewHunkIndex] = useState<number | null>(null);
  const [editEntryError, setEditEntryError] = useState<string | null>(null);
  /** Live selection text for edit-mode comment drafts (patch arrays are stale mid-session). */
  const selectionContentRef = useRef<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<{
    node: HTMLElement;
    instance: VirtualizedFileDiff<CardAnnotationMetadata>;
  } | null>(null);
  const syncSearchRef = useRef<(() => void) | undefined>(undefined);
  const onPostRender = useCallback<
    NonNullable<
      FileDiffOptions<CardAnnotationMetadata, undefined>["onPostRender"]
    >
  >((node, instance, phase) => {
    rendererRef.current =
      phase !== "unmount" && instance instanceof VirtualizedFileDiff
        ? { node, instance }
        : null;
    if (phase !== "unmount") syncSearchRef.current?.();
  }, []);
  // Defer mounting the expensive @pierre/diffs renderer until the card is near
  // the viewport. Once mounted we keep it (sticky) so scroll-back doesn't re-run
  // Shiki. Combined with content-visibility CSS this is the main large-diff win.
  const [bodyMounted, setBodyMounted] = useState(false);

  useEffect(
    () =>
      registerDiffTarget(filePath, {
        reveal: () => {
          setCollapsed(false);
          setBodyMounted(true);
        },
        position: (line, side) => {
          const renderer = rendererRef.current;
          if (renderer?.node.isConnected) {
            const position = renderer.instance.getLinePosition(line, side);
            if (position)
              return (
                window.scrollY +
                renderer.node.getBoundingClientRect().top +
                position.top
              );
          }
          const root =
            cardRef.current?.querySelector("diffs-container")?.shadowRoot;
          const type = side === "additions" ? "addition" : "deletion";
          const row =
            root?.querySelector(
              `[data-line="${line}"][data-line-type="${type}"]`,
            ) ??
            root?.querySelector(
              `[data-line="${line}"][data-line-type="context"]`,
            );
          return row
            ? window.scrollY + row.getBoundingClientRect().top
            : undefined;
        },
      }),
    [filePath],
  );

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(filePath).then(
      () => {
        setPathCopyFlash(true);
        window.setTimeout(() => setPathCopyFlash(false), 1500);
      },
      () => {},
    );
  };

  const handleRevertHunk = async (hunkIndex: number) => {
    if (revertingHunk !== null) return;
    setRevertingHunk(hunkIndex);
    setRevertError(null);
    try {
      const res = await fetch("/api/revert-hunk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, hunkIndex }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // SSE will refresh the diff automatically.
    } catch (err: any) {
      setRevertError(err.message);
    } finally {
      setRevertingHunk(null);
    }
  };

  const isChangedFile =
    fileDiff.type === "change" || fileDiff.type === "rename-changed";
  const canExpandContext = !collapsed && isChangedFile;
  const oldFilePath = fileDiff.prevName ?? filePath;
  const {
    loading: contentsLoading,
    oldContent,
    newContent,
    refetch: refetchContents,
  } = useFileContents(
    filePath,
    (contextExpanded && canExpandContext) || editing,
    oldFilePath,
  );
  const contentsReady =
    contextExpanded && oldContent !== null && newContent !== null;

  // Refetch full contents when the underlying patch changes while context is
  // expanded or an edit session is active (save / revert-hunk / external
  // edit all broadcast `change`). Otherwise the full-context render would
  // keep showing pre-mutation content.
  const fileDiffRef = useRef(fileDiff);
  useEffect(() => {
    if (fileDiffRef.current === fileDiff) return;
    fileDiffRef.current = fileDiff;
    if ((contextExpanded && canExpandContext) || editing) {
      refetchContents();
    }
  }, [fileDiff, contextExpanded, canExpandContext, editing, refetchContents]);

  // Synchronize collapse with viewed state changes from parent.
  // Must use `useLayoutEffect` (NOT `useEffect`) so the collapse commits
  // before the next paint. The "Viewed" checkbox path in App.tsx schedules
  // a `requestAnimationFrame` immediately after `setViewed`, and the rAF
  // fires before paint but AFTER `useLayoutEffect`. If we used `useEffect`,
  // the collapse would run after paint — after the rAF has already
  // scrolled — so the scroll would be computed against the un-collapsed
  // layout, then the page would shift up under the scroll position,
  // landing on the file AFTER the intended next one.
  const previousViewed = useRef(viewed);
  useLayoutEffect(() => {
    if (previousViewed.current !== viewed) setCollapsed(viewed);
    previousViewed.current = viewed;
  }, [viewed]);

  useEffect(() => {
    if (bodyMounted || collapsed) return;
    const el = cardRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setBodyMounted(true);
      return;
    }
    // Eager-mount when already in / near the viewport on expand.
    const rect = el.getBoundingClientRect();
    const near =
      rect.bottom >= -800 &&
      rect.top <=
        (typeof window === "undefined" ? 2000 : window.innerHeight + 800);
    if (near) {
      setBodyMounted(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setBodyMounted(true);
          io.disconnect();
        }
      },
      { root: null, rootMargin: "800px 0px", threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [collapsed, bodyMounted]);

  const shikiConfig = SHIKI_THEME_MAP[theme] || SHIKI_THEME_MAP["rose-pine"];

  // Stable across re-renders triggered by unrelated prop changes (e.g. toggling
  // split/unified) so the diff renderer isn't handed a brand-new CSS string
  // every time. Only tabSize/fontSize actually affect it.
  const unsafeCSS = useMemo(
    () => buildUnsafeCSS(tabSize, fontSize, monoFontFamily),
    [tabSize, fontSize, monoFontFamily],
  );

  // Virtualization metrics for the pierre renderer. `lineHeight` must match
  // the `--diffs-line-height` buildUnsafeCSS emits (Math.round(fontSize * 1.7))
  // so the virtualizer's per-line size estimates stay aligned with the real
  // rows — otherwise scrollbar height and scroll anchoring drift on large
  // files. The built-in header is disabled (`disableFileHeader: true`) and the
  // card renders its own header, so the reserved header height is zero.
  const virtualMetrics = useMemo<VirtualFileMetrics>(
    () => ({
      hunkLineCount: 50,
      lineHeight: Math.round(fontSize * 1.7),
      diffHeaderHeight: 0,
      spacing: 8,
    }),
    [fontSize],
  );

  // Find-in-file persistent match highlights. Sync immediately, then reconcile
  // on an interval: diff rows lazy-mount (IntersectionObserver) and rebuild
  // (style/theme changes, context expansion) inside the shadow DOM, so a
  // one-shot pass would miss rows that appear after the search opens.
  const searchSessionActive = fileSearch?.filePath === filePath;
  const searchQuery = searchSessionActive ? fileSearch.query : "";
  const searchHits = searchSessionActive ? fileSearch.hits : [];
  const searchIndex = searchSessionActive ? fileSearch.index : 0;
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    if (!searchSessionActive || !searchQuery.trim()) return;
    const sync = () =>
      syncFindHighlights(card, searchHits, searchIndex, searchQuery);
    syncSearchRef.current = sync;
    sync();
    return () => {
      syncSearchRef.current = undefined;
      clearFindHighlights(card);
    };
  }, [
    searchSessionActive,
    searchQuery,
    searchHits,
    searchIndex,
    bodyMounted,
    collapsed,
    editing,
  ]);

  const getLineContent = (
    side: AnnotationSide,
    lineNumber: number,
    startLineNumber?: number,
  ): string => {
    const a = startLineNumber ?? lineNumber;
    const b = lineNumber;
    const startNum = Math.min(a, b);
    const endNum = Math.max(a, b);
    const resultLines: string[] = [];
    // Full-file contents when "Expand context" is on — fills lines outside patch hunks.
    const expanded = contentsReady
      ? (side === "additions" ? newContent : oldContent)
          ?.replace(/\r\n/g, "\n")
          .split("\n")
      : undefined;

    for (let line = startNum; line <= endNum; line++) {
      const lines =
        side === "additions" ? fileDiff.additionLines : fileDiff.deletionLines;
      const startKey = side === "additions" ? "additionStart" : "deletionStart";
      const countKey = side === "additions" ? "additionCount" : "deletionCount";
      const indexKey =
        side === "additions" ? "additionLineIndex" : "deletionLineIndex";
      let found = false;
      for (const hunk of fileDiff.hunks) {
        const start = hunk[startKey];
        const count = hunk[countKey];
        if (line >= start && line < start + count) {
          const index = hunk[indexKey] + (line - start);
          resultLines.push(lines[index] ?? "");
          found = true;
          break;
        }
      }
      if (!found) {
        // Context / expanded lines aren't in the patch arrays.
        resultLines.push(expanded?.[line - 1] ?? "");
      }
    }
    return resultLines.join("\n");
  };

  const openPending = useCallback((next: PendingComment) => {
    const normalized = normalizePendingRange(next);
    if (!draftSessionRef.current) {
      draftSessionRef.current = crypto.randomUUID();
    }
    setPending(normalized);
    setSelectedRange(selectedRangeFromPending(normalized));
    setLiveSelectionCount(0);
  }, []);

  const clearPending = useCallback(() => {
    setPending(null);
    setSelectedRange(null);
    setLiveSelectionCount(0);
    draftSessionRef.current = null;
  }, []);

  // A live comment draft has no place in an edit session: clear it on enter.
  useEffect(() => {
    if (editing && pending) clearPending();
  }, [editing, pending, clearPending]);

  const pendingBounds = useMemo((): PendingLineBounds | undefined => {
    if (!pending) return undefined;
    const expandedCount =
      contentsReady && pending.side === "additions"
        ? (newContent ?? "").split("\n").length
        : contentsReady && pending.side === "deletions"
          ? (oldContent ?? "").split("\n").length
          : undefined;
    return boundsForSide(fileDiff, pending.side, expandedCount);
  }, [pending, fileDiff, contentsReady, newContent, oldContent]);

  const updatePendingRange = useCallback((next: PendingComment) => {
    const normalized = normalizePendingRange(next);
    setPending(normalized);
    setSelectedRange(selectedRangeFromPending(normalized));
  }, []);

  // After a new draft opens, scroll its annotation into view (it can land
  // off-screen when opened near the bottom of a tall file). Re-run when the
  // bottom edge moves so the form stays near the anchor slot.
  useEffect(() => {
    if (!pending) return;
    return scheduleDiffNavigation(() => {
      const el = cardRef.current?.querySelector("[data-pending-comment]");
      if (!(el instanceof HTMLElement)) return false;
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
      return true;
    });
  }, [pending?.side, pending?.lineNumber]);

  const handleOpenEditor = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (fileDiff.type === "deleted") return;
    setOpening(true);
    try {
      await fetch("/api/open-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, editor: editorIDE }),
      });
    } catch (err) {
      console.error("Failed to open file in IDE editor:", err);
    } finally {
      setOpening(false);
    }
  };

  const handleRequestEdit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRequestEdit || editEntryError) return;
    try {
      await onRequestEdit(filePath);
      setEditEntryError(null);
    } catch (err: any) {
      setEditEntryError(err?.message ?? "Failed to enter edit mode");
    }
  };

  /**
   * Edit-mode selection action → comment draft. The live selection text is
   * captured because the patch arrays are stale while the editor owns the
   * document. Zero-based editor positions map to 1-based diff lines.
   */
  const handleEditSelectionComment = useCallback(
    (range: { start: number; end: number }, text: string) => {
      const lo = Math.min(range.start, range.end);
      const hi = Math.max(range.start, range.end);
      selectionContentRef.current = text;
      openPending(
        normalizePendingRange({
          side: "additions",
          lineNumber: hi,
          startLineNumber: lo === hi ? undefined : lo,
        }),
      );
    },
    [openPending],
  );

  /**
   * Hover and go-to-declaration over the review's language servers.
   *
   * Drafts are synced while this card is in edit mode, so a dirty file is
   * still answerable — the server has been told what is on screen.
   */
  const codeIntel = useCodeIntel({
    enabled: codeIntelEnabled,
    staged,
  });

  const toTarget = useCallback(
    (props: {
      lineNumber: number;
      lineCharStart: number;
      tokenText: string;
      tokenElement: HTMLElement;
      side: AnnotationSide;
    }): CodeIntelTarget => ({
      path: filePath,
      side: props.side === "deletions" ? "deletions" : "additions",
      line: props.lineNumber,
      character: props.lineCharStart,
      tokenText: props.tokenText,
      anchor: props.tokenElement,
    }),
    [filePath],
  );

  const {
    hoverToken,
    clearHover,
    closeHover,
    resolveDefinition,
    renameAt,
    formatFile,
    codeActionsFor,
  } = codeIntel;

  /**
   * The card's own handle on the editor, so it can read the caret for a rename
   * without routing every keystroke back through the app.
   */
  const editorRef = useRef<Editor<
    "file-diff",
    CardAnnotationMetadata
  > | null>(null);
  const [renamePrompt, setRenamePrompt] = useState<{
    line: number;
    character: number;
    symbol: string;
  } | null>(null);
  const [codeIntelNotice, setCodeIntelNotice] = useState<string | null>(null);

  /** One-based caret position in the open editor, or null when there is none. */
  const caretPosition = useCallback(() => {
    const selection = editorRef.current?.getViewState().selections?.[0];
    if (!selection) return null;
    return {
      line: selection.start.line + 1,
      character: selection.start.character,
    };
  }, []);

  /**
   * Hand a server's edits to the editor, or report why they were not applied.
   * A rename that spills into other files is reported and left untouched.
   */
  useEffect(() => {
    const anchor = codeIntel.hover?.highlights?.length
      ? codeIntel.hover.target.anchor
      : null;
    if (!anchor) return;
    anchor.classList.add("code-intel-occurrence");
    return () => anchor.classList.remove("code-intel-occurrence");
  }, [codeIntel.hover]);

  const applyCodeIntelEdits = useCallback(
    (result: CodeIntelEdits | { reason: string }, verb: string) => {
      const decision = decideCodeIntelApply(result, verb);
      if (decision.apply) onApplyEdits?.(filePath, decision.edits);
      setCodeIntelNotice(decision.notice);
    },
    [filePath, onApplyEdits],
  );

  /**
   * Rename and format while editing in place.
   *
   * The library's keymap only binds its own built-in commands, so these two
   * live on the card instead. Both go through `Editor.applyEdits`, which puts
   * them on the undo timeline like anything typed by hand.
   */
  useEffect(() => {
    const card = cardRef.current;
    if (!card || !editing || !codeIntel.ready) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F2") {
        const at = caretPosition();
        if (!at) return;
        event.preventDefault();
        setCodeIntelNotice(null);
        setRenamePrompt({ ...at, symbol: "" });
        return;
      }
      // Shift+Alt+F, the format shortcut every editor already uses.
      if (event.shiftKey && event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setCodeIntelNotice(null);
        void formatFile(filePath, tabSize).then((result) =>
          applyCodeIntelEdits(result, "Format"),
        );
      }
    };
    card.addEventListener("keydown", onKeyDown);
    return () => card.removeEventListener("keydown", onKeyDown);
  }, [
    applyCodeIntelEdits,
    caretPosition,
    codeIntel.ready,
    editing,
    filePath,
    formatFile,
    tabSize,
  ]);

  /**
   * Token callbacks for the renderer, or undefined when the setting is off so
   * the diff mounts with no token listeners at all — the default.
   *
   * These are gated on the *setting*, not on whether a language server turned
   * out to be reachable. The renderer only wraps tokens individually when a
   * token callback exists at highlight time (`shouldUseTokenTransformer`), and
   * it does not re-highlight when the callbacks appear later, so handing them
   * over after the capability probe resolves would leave the file with no
   * hoverable tokens at all. The callbacks themselves are inert until the hook
   * reports ready, so nothing is requested in the meantime.
   */
  const tokenHandlers = useMemo(() => {
    if (!codeIntelEnabled) return undefined;
    return {
      // MultiFileDiff and FileDiff do not infer this from the callbacks the
      // way UnresolvedFile and the SSR paths do; without it the renderer never
      // wraps tokens and no token event ever fires.
      useTokenTransformer: true,
      onTokenEnter: (props: DiffTokenEventBaseProps) => {
        hoverToken(toTarget(props));
      },
      onTokenLeave: () => {
        clearHover();
      },
      onTokenClick: async (
        props: DiffTokenEventBaseProps,
        event: MouseEvent,
      ) => {
        // Plain clicks still belong to selection; only a modified click nav.
        if (!event.metaKey && !event.ctrlKey && !event.altKey) return;
        event.preventDefault();
        const target = toTarget(props);
        closeHover();
        const locations = await resolveDefinition(target);
        const first = locations?.find((location) => location.inRepository);
        if (!first) return;
        openDefinitionPeek({
          path: first.path,
          line: first.line,
          symbol: target.tokenText,
        });
      },
    };
  }, [
    codeIntelEnabled,
    hoverToken,
    clearHover,
    closeHover,
    resolveDefinition,
    toTarget,
  ]);

  /**
   * The language-server half of the selection widget, or undefined when code
   * intel is off — in which case the widget has no "Fix…" button at all.
   */
  const selectionCodeActions = useMemo<SelectionCodeActions | undefined>(() => {
    if (!codeIntel.ready) return undefined;
    return {
      fetch: (startLine, startCharacter, endLine, endCharacter) =>
        codeActionsFor(
          filePath,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
        ),
      apply: (edits, title) => applyCodeIntelEdits(edits, title),
    };
  }, [applyCodeIntelEdits, codeActionsFor, codeIntel.ready, filePath]);

  /**
   * Creation-time editor options for the in-place edit surface. The factory
   * (from EditProvider) owns the Editor instance; these callbacks wire it to
   * the edit-session state in App.
   */
  const editorOptions = useMemo<
    EditorOptions<"file-diff", CardAnnotationMetadata, undefined>
  >(
    () => ({
      onAttach: (editor) => {
        editorRef.current = editor;
        onEditAttach?.(filePath, editor);
      },
      enabledSelectionAction: true,
      renderSelectionAction: (ctx) =>
        buildEditSelectionAction(
          ctx,
          filePath,
          handleEditSelectionComment,
          selectionCodeActions,
        ),
      ...(editPredictionEnabled
        ? {
            editPrediction: {
              mode: "subtle" as const,
              provider: createEditPredictProvider(),
              include: [filePath],
            },
          }
        : {}),
    }),
    [
      filePath,
      onEditChange,
      onEditAttach,
      handleEditSelectionComment,
      selectionCodeActions,
      editPredictionEnabled,
    ],
  );

  const getStatusBadge = () => {
    switch (fileDiff.type) {
      case "new":
        return <span className="diff-status-badge diff-status-new">Added</span>;
      case "deleted":
        return (
          <span className="diff-status-badge diff-status-deleted">Deleted</span>
        );
      case "rename-pure":
      case "rename-changed":
        return (
          <span className="diff-status-badge diff-status-renamed">Renamed</span>
        );
      default:
        return (
          <span className="diff-status-badge diff-status-modified">
            Modified
          </span>
        );
    }
  };

  const fileLevelAnnotations = annotations.filter((a) => a.lineNumber === 0);
  // Treat persisted/API data as untrusted at the third-party renderer boundary.
  // Pierre assumes every annotation side is valid and otherwise throws while
  // indexing the line, blanking the entire diff surface.
  const lineAnnotations = filterSupportedLineAnnotations(annotations);

  const existingLineAnnotations: DiffLineAnnotation<{
    _existingPr: true;
    comment: PrExistingComment;
  }>[] = existingComments
    .filter((comment) => canAnchorPrComment(fileDiff, comment))
    .map((comment) => ({
      side: comment.side === "LEFT" ? "deletions" : "additions",
      lineNumber: comment.line!,
      metadata: { _existingPr: true, comment },
    }));
  const existingFileLevelComments = existingComments.filter(
    (comment) => !canAnchorPrComment(fileDiff, comment),
  );

  const renderAnnotationFn = (
    annotation: DiffLineAnnotation<
      | ReviewComment
      | { _pending: true }
      | { _existingPr: true; comment: PrExistingComment }
    >,
  ) => {
    if ("_pending" in annotation.metadata) {
      if (!pending) return null;
      const session = draftSessionRef.current ?? "open";
      const draftKey = `new:${filePath}:${pending.side}:${session}`;
      // Edit-mode drafts carry their own line content (the live selection
      // text) because the patch arrays are stale mid-session.
      const lineContent =
        selectionContentRef.current ??
        getLineContent(
          pending.side,
          pending.lineNumber,
          pending.startLineNumber,
        );
      const ordered = pendingOrderedRange(pending);
      const bounds = pendingBounds;
      return (
        <div data-pending-comment={session}>
          <CommentForm
            draftKey={draftKey}
            lineContent={lineContent}
            aiSurface="diff"
            aiContext={{
              kind: "selection",
              filePath,
              side: pending.side,
              startLine: ordered.start,
              endLine: ordered.end,
              selectedText: lineContent,
            }}
            onAddToAsk={
              onAddSelectionToAsk
                ? (selection) => {
                    onAddSelectionToAsk(selection);
                    clearPending();
                  }
                : undefined
            }
            lineLabel={pendingLineLabel(pending)}
            range={{
              start: ordered.start,
              end: ordered.end,
              sideLabel: pendingSideLabel(pending),
              canAdjustStart: (d) => canAdjustPendingStart(pending, d, bounds),
              canAdjustEnd: (d) => canAdjustPendingEnd(pending, d, bounds),
            }}
            onAdjustStart={(delta) => {
              updatePendingRange(adjustPendingStart(pending, delta, bounds));
            }}
            onAdjustEnd={(delta) => {
              updatePendingRange(adjustPendingEnd(pending, delta, bounds));
            }}
            onSubmit={async (body, severity) => {
              // Recompute content at submit so adjusted ranges are accurate.
              const content =
                selectionContentRef.current ??
                getLineContent(
                  pending.side,
                  pending.lineNumber,
                  pending.startLineNumber,
                );
              await onAddComment(
                filePath,
                pending.side,
                pending.lineNumber,
                content,
                body,
                pending.startLineNumber,
                severity,
              );
              selectionContentRef.current = null;
              clearPending();
            }}
            onCancel={clearPending}
          />
        </div>
      );
    }
    if ("_existingPr" in annotation.metadata) {
      return (
        <ExistingPrCommentBubble
          comment={annotation.metadata.comment}
          lineContent={getLineContent(
            annotation.side,
            annotation.lineNumber,
            annotation.metadata.comment.startLine ?? undefined,
          )}
          onReply={onReplyExisting}
          onEdit={onEditExisting}
          onDelete={onDeleteExisting}
          onSetResolved={onSetExistingResolved}
          onApplySuggestion={onApplyExisting}
          expectedHeadSha={expectedHeadSha}
        />
      );
    }
    return (
      <CommentBubble
        comment={annotation.metadata as ReviewComment}
        onDelete={onDeleteComment}
      />
    );
  };

  // Drop any open draft when a new selection starts. Do NOT keep controlling
  // selectedLines during the drag (pending → null → selectedLines=undefined)
  // so pierre owns the live range.
  const handleSelectionStart = useCallback(() => {
    setLiveSelectionCount(0);
    setPending(null);
    setSelectedRange(null);
    draftSessionRef.current = null;
  }, []);

  const handleSelectionChange = useCallback(
    (range: SelectedLineRange | null) => {
      if (range) {
        setLiveSelectionCount(Math.abs(range.end - range.start) + 1);
      } else {
        setLiveSelectionCount(0);
      }
    },
    [],
  );

  const handleSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setLiveSelectionCount(0);
      if (!range) return;
      // Open the composer under the selection (works for single-click select + drag).
      openPending(pendingFromSelection(range));
    },
    [openPending],
  );

  /**
   * Pierre built-in gutter + (single click or drag). Must NOT be combined with
   * `renderGutterUtility` — pierre throws if both APIs are used.
   */
  const handleGutterUtilityClick = useCallback(
    (range: SelectedLineRange) => {
      openPending(pendingFromSelection(range));
    },
    [openPending],
  );

  const allAnnotations: DiffLineAnnotation<
    | ReviewComment
    | { _pending: true }
    | { _existingPr: true; comment: PrExistingComment }
  >[] = [
    ...(pending
      ? [
          {
            side: pending.side,
            lineNumber: pending.lineNumber,
            metadata: { _pending: true as const },
          },
        ]
      : []),
    ...lineAnnotations,
    ...existingLineAnnotations,
  ];

  return (
    <div
      ref={cardRef}
      className={`file-diff-card ${viewed ? "file-diff-viewed" : ""} ${collapsed ? "file-diff-collapsed" : ""}`}
      id={id}
      data-file-path={filePath}
    >
      {codeIntel.hover && (
        <CodeIntelPopover
          hover={codeIntel.hover}
          onHold={codeIntel.holdHover}
          onClose={codeIntel.closeHover}
        />
      )}
      <InputDialog
        open={renamePrompt !== null}
        title="Rename symbol"
        description="Rewrites every use the language server can see in this file. Uses elsewhere are reported, never changed."
        label="New name"
        confirmLabel="Rename"
        maxLength={200}
        onCancel={() => setRenamePrompt(null)}
        onConfirm={(value) => {
          const at = renamePrompt;
          setRenamePrompt(null);
          if (!at || !value.trim()) return;
          void renameAt(filePath, at.line, at.character, value.trim()).then(
            (result) => applyCodeIntelEdits(result, "Rename"),
          );
        }}
      />
      {codeIntelNotice && (
        <div className="code-intel-notice" role="status">
          {codeIntelNotice}
          <button
            type="button"
            className="code-intel-notice-close"
            aria-label="Dismiss"
            onClick={() => setCodeIntelNotice(null)}
          >
            ×
          </button>
        </div>
      )}
      <div
        className="file-diff-card-header"
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          onCardToggleCollapse?.(filePath, next);
        }}
      >
        <div className="file-diff-header-left">
          <span className="file-diff-collapse-indicator" aria-hidden="true">
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </span>
          <div className="file-diff-title-row">
            <span className="file-diff-name" title={filePath}>
              {filePath}
            </span>
            <button
              className="file-diff-copy-path-btn"
              onClick={handleCopyPath}
              title="Copy file path to clipboard"
              aria-label="Copy file path to clipboard"
            >
              {pathCopyFlash ? <Check size={12} /> : <Copy size={12} />}
            </button>
            {getStatusBadge()}
            {lineAnnotations.length + existingLineAnnotations.length > 0 && (
              <span
                className="file-diff-comment-badge"
                title={`${lineAnnotations.length + existingLineAnnotations.length} inline comment${lineAnnotations.length + existingLineAnnotations.length === 1 ? "" : "s"}`}
              >
                <MessageSquare size={10} />
                {lineAnnotations.length + existingLineAnnotations.length}
              </span>
            )}
            {liveSelectionCount > 0 && (
              <span className="file-diff-selection-badge" aria-live="polite">
                {liveSelectionCount} line{liveSelectionCount === 1 ? "" : "s"}{" "}
                selected
              </span>
            )}
            {pathCopyFlash && (
              <span className="file-diff-permalink-flash" role="status">
                Copied path
              </span>
            )}
            {permalinkFlash && (
              <span className="file-diff-permalink-flash" role="status">
                Copied {permalinkFlash}
              </span>
            )}
          </div>
        </div>

        <div
          className="file-diff-header-right"
          onClick={(e) => e.stopPropagation()}
        >
          {onOpenFileSearch && (
            <Tooltip
              content={
                fileSearch?.filePath === filePath
                  ? "Close find in file"
                  : "Find in file (⌘F)"
              }
              side="bottom"
            >
              <button
                className={`file-diff-icon-btn ${fileSearch?.filePath === filePath ? "is-active" : ""}`}
                onClick={() => {
                  if (fileSearch?.filePath === filePath) {
                    fileSearch.close();
                  } else {
                    setCollapsed(false);
                    onOpenFileSearch(filePath);
                  }
                }}
                aria-label={
                  fileSearch?.filePath === filePath
                    ? "Close find in file"
                    : "Find in file"
                }
              >
                <Search size={13} />
              </button>
            </Tooltip>
          )}
          {canExpandContext && !editing && (
            <Tooltip
              content={
                contextExpanded
                  ? "Hide unchanged context"
                  : "Expand full-file context"
              }
              side="bottom"
            >
              <button
                className={`file-diff-icon-btn ${contextExpanded ? "is-active" : ""}`}
                onClick={() => setLocalContextExpanded((v) => !v)}
                disabled={contentsLoading}
                aria-label={
                  contentsLoading
                    ? "Loading context"
                    : contextExpanded
                      ? "Hide context"
                      : "Expand context"
                }
              >
                {contentsLoading ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <Maximize2 size={13} />
                )}
              </button>
            </Tooltip>
          )}
          {allowLocalActions && fileDiff.type !== "deleted" && !editing && (
            <Tooltip content="Open in editor" side="bottom">
              <button
                className="file-diff-icon-btn"
                onClick={handleOpenEditor}
                disabled={opening}
                aria-label={opening ? "Opening file" : "Edit file"}
              >
                {opening ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <Edit3 size={13} />
                )}
              </button>
            </Tooltip>
          )}
          {allowLocalActions &&
            fileDiff.type !== "deleted" &&
            !editing &&
            canEdit && (
              <Tooltip content="Edit in place (e)" side="bottom">
                <button
                  className="file-diff-icon-btn"
                  onClick={handleRequestEdit}
                  aria-label="Edit file in place"
                >
                  <PenLine size={13} />
                </button>
              </Tooltip>
            )}
          {editing && editSession && (
            <>
              {editSession.dirty && (
                <span className="file-diff-edit-dirty" title="Unsaved changes">
                  Edited
                </span>
              )}
              <Tooltip content="Discard changes since last save" side="bottom">
                <button
                  className="file-diff-icon-btn"
                  onClick={() => onEditDiscard?.(filePath)}
                  disabled={!editSession.dirty}
                  aria-label="Discard edits"
                >
                  <RotateCcw size={13} />
                </button>
              </Tooltip>
              <button
                className="file-diff-save-btn"
                onClick={() => onEditSave?.(filePath)}
                disabled={!editSession.dirty || editSession.saving}
                aria-label={
                  editSession.saving ? "Saving…" : "Save edits (Cmd/Ctrl+S)"
                }
              >
                {editSession.saving ? (
                  <Loader2 size={12} className="spin" />
                ) : (
                  <Save size={12} />
                )}
                <span>Save</span>
              </button>
              <Tooltip content="Exit edit mode" side="bottom">
                <button
                  className="file-diff-icon-btn"
                  onClick={() => onEditExit?.(filePath)}
                  aria-label="Exit edit mode"
                >
                  <X size={13} />
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip content="Comment on entire file" side="bottom">
            <button
              className="file-diff-icon-btn"
              onClick={() => {
                setCollapsed(false);
                setShowFileCommentForm(true);
              }}
              aria-label="Add file comment"
            >
              <MessageSquare size={13} />
            </button>
          </Tooltip>
          <label
            className={`viewed-label ${viewed ? "viewed-checked" : ""}`}
            title={viewed ? "Mark unviewed · v" : "Mark viewed · v"}
          >
            <input
              type="checkbox"
              checked={viewed}
              aria-label={viewed ? "Mark as unviewed" : "Mark as viewed"}
              onChange={(e) => {
                const next = e.target.checked;
                // Collapse optimistically in the same event as the parent
                // viewed update so React 18 batches them into one commit.
                // Without this, viewed flips first, the card body is still
                // mounted for a frame, and scroll-to-next measures against
                // the full expanded height — landing past the next file.
                setCollapsed(next);
                onViewedChange(filePath, next);
              }}
            />
            <span className="viewed-label-text">Viewed</span>
          </label>
        </div>
      </div>

      {fileSearch?.filePath === filePath && (
        <div
          className="file-search-bar-wrap"
          onClick={(e) => e.stopPropagation()}
        >
          <FileSearchBar
            filePath={filePath}
            query={fileSearch.query}
            hits={fileSearch.hits}
            index={fileSearch.index}
            focusNonce={fileSearch.focusNonce}
            onQueryChange={fileSearch.setQuery}
            onNext={fileSearch.next}
            onPrev={fileSearch.prev}
            onClose={fileSearch.close}
          />
        </div>
      )}

      {((editing && editSession?.error) || editEntryError) && (
        <div
          className="file-diff-edit-error"
          role="alert"
          onClick={(e) => e.stopPropagation()}
        >
          <AlertCircle size={11} />
          {editing && editSession?.error ? editSession.error : editEntryError}
        </div>
      )}

      {allowLocalActions &&
        !collapsed &&
        !editing &&
        fileDiff.hunks.length > 0 && (
          <div
            className="file-diff-hunk-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="file-diff-hunk-actions-meta">
              <span className="file-diff-hunk-actions-label">Revert hunks</span>
              <Tooltip
                content="Preview and undo specific change blocks via git apply --reverse"
                side="top"
              >
                <HelpCircle size={12} className="file-diff-hunk-help" />
              </Tooltip>
              <span className="file-diff-hunk-count">
                {fileDiff.hunks.length} block
                {fileDiff.hunks.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="file-diff-hunk-actions-buttons">
              {fileDiff.hunks.map((h, i) => (
                <button
                  key={i}
                  type="button"
                  className="file-diff-hunk-revert-btn"
                  onClick={() => setPreviewHunkIndex(i)}
                  disabled={revertingHunk !== null}
                  title={`Preview and revert hunk #${i + 1} (lines @${h.additionStart}+${h.additionLines ?? h.additionCount})`}
                >
                  {revertingHunk === i ? (
                    <Loader2 size={10} className="spin" />
                  ) : (
                    <Undo2 size={10} />
                  )}
                  <span>Hunk #{i + 1}</span>
                </button>
              ))}
            </div>
            {revertError && (
              <span className="file-diff-hunk-error" role="alert">
                <AlertCircle size={11} />
                {revertError}
              </span>
            )}
          </div>
        )}

      {/* Selective Revert Hunk Preview Modal */}
      {allowLocalActions &&
        previewHunkIndex !== null &&
        (() => {
          const previewHunk = fileDiff.hunks[previewHunkIndex];
          if (!previewHunk) return null;
          const previewDeletedLines = fileDiff.deletionLines.slice(
            previewHunk.deletionLineIndex,
            previewHunk.deletionLineIndex +
              (previewHunk.deletionCount ?? previewHunk.deletionLines ?? 0),
          );
          const previewAddedLines = fileDiff.additionLines.slice(
            previewHunk.additionLineIndex,
            previewHunk.additionLineIndex +
              (previewHunk.additionStart !== undefined &&
              previewHunk.additionLines !== undefined
                ? previewHunk.additionLines
                : (previewHunk.additionCount ?? 0)),
          );
          return (
            <Modal
              open={previewHunkIndex !== null}
              onClose={() => setPreviewHunkIndex(null)}
              className="hunk-revert-modal"
              ariaLabel={`Selective Revert Preview Hunk #${previewHunkIndex + 1}`}
            >
              <div className="shortcuts-header">
                <div className="shortcuts-header-title">
                  <Undo2 size={18} className="shortcuts-icon" />
                  <h2>Revert Hunk #{previewHunkIndex + 1}</h2>
                </div>
                <button
                  className="shortcuts-close-btn"
                  onClick={() => setPreviewHunkIndex(null)}
                  aria-label="Close dialog"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="shortcuts-body">
                <div className="hunk-preview-intro">
                  Reverting this hunk will restore the deleted (
                  <span className="hunk-preview-negative">red</span>) lines and
                  remove the added (
                  <span className="hunk-preview-positive">green</span>) lines
                  from <strong>{filePath.split("/").pop()}</strong>.
                </div>

                <div className="hunk-preview-container">
                  <div className="hunk-preview-header">
                    <span>{filePath}</span>
                    <span>
                      Lines: @-{previewHunk.deletionStart},
                      {previewHunk.deletionCount ??
                        previewHunk.deletionLines ??
                        0}{" "}
                      @+
                      {previewHunk.additionStart},
                      {previewHunk.additionLines ??
                        previewHunk.additionCount ??
                        0}
                    </span>
                  </div>
                  <div className="hunk-preview-code">
                    {previewDeletedLines.map((line, idx) => (
                      <div
                        key={`del-${idx}`}
                        className="hunk-preview-line hunk-preview-line-deletion"
                      >
                        <span className="hunk-preview-sign">-</span>
                        <span className="hunk-preview-text">{line}</span>
                      </div>
                    ))}
                    {previewAddedLines.map((line, idx) => (
                      <div
                        key={`add-${idx}`}
                        className="hunk-preview-line hunk-preview-line-addition"
                      >
                        <span className="hunk-preview-sign">+</span>
                        <span className="hunk-preview-text">{line}</span>
                      </div>
                    ))}
                    {previewDeletedLines.length === 0 &&
                      previewAddedLines.length === 0 && (
                        <div className="hunk-preview-line hunk-preview-empty">
                          No changes in this hunk.
                        </div>
                      )}
                  </div>
                </div>

                <HunkHistorySection
                  filePath={filePath}
                  deletionStart={previewHunk.deletionStart}
                  deletionCount={
                    previewHunk.deletionCount ?? previewHunk.deletionLines ?? 0
                  }
                />
              </div>

              <div className="modal-footer">
                <button
                  className="hunk-revert-btn-secondary"
                  onClick={() => setPreviewHunkIndex(null)}
                >
                  Cancel
                </button>
                <button
                  className="hunk-revert-btn-primary"
                  onClick={async () => {
                    const idx = previewHunkIndex;
                    setPreviewHunkIndex(null);
                    await handleRevertHunk(idx);
                  }}
                >
                  Revert Changes
                </button>
              </div>
            </Modal>
          );
        })()}
      {!collapsed && (
        <div className="file-diff-card-body">
          {!bodyMounted && (
            <div className="file-diff-body-placeholder" aria-hidden="true">
              Loading diff…
            </div>
          )}
          {bodyMounted && fileDiff.hunks.length > 0 && (
            <DiffMinimap
              fileDiff={fileDiff}
              filePath={filePath}
              onJump={(path, line) => {
                scrollToLine(path, line, "additions");
              }}
            />
          )}
          {/* File-level comments section */}
          {bodyMounted &&
            (fileLevelAnnotations.length > 0 ||
              existingFileLevelComments.length > 0 ||
              showFileCommentForm) && (
              <div className="file-level-comments-section">
                <div className="file-level-comments-header">
                  <MessageSquare size={14} />
                  <span>
                    File-Level Comments (
                    {fileLevelAnnotations.length +
                      existingFileLevelComments.length}
                    )
                  </span>
                </div>

                {fileLevelAnnotations.length > 0 && (
                  <div className="file-level-comments-list">
                    {fileLevelAnnotations.map((anno) => (
                      <CommentBubble
                        key={anno.metadata.id}
                        comment={anno.metadata}
                        onDelete={onDeleteComment}
                      />
                    ))}
                  </div>
                )}

                {existingFileLevelComments.map((comment) => (
                  <ExistingPrCommentBubble
                    key={`github-${comment.id}`}
                    comment={comment}
                    onReply={onReplyExisting}
                    onEdit={onEditExisting}
                    onDelete={onDeleteExisting}
                    onSetResolved={onSetExistingResolved}
                    onApplySuggestion={onApplyExisting}
                    expectedHeadSha={expectedHeadSha}
                  />
                ))}

                {showFileCommentForm && (
                  <div className="file-level-comment-form">
                    <CommentForm
                      draftKey={`file-comment:${filePath}`}
                      lineContent=""
                      aiSurface="diff"
                      aiContext={{ kind: "file", filePath }}
                      onSubmit={async (body, severity) => {
                        await onAddComment(
                          filePath,
                          "additions",
                          0,
                          "",
                          body,
                          undefined,
                          severity,
                        );
                        setShowFileCommentForm(false);
                      }}
                      onCancel={() => setShowFileCommentForm(false)}
                    />
                  </div>
                )}
              </div>
            )}

          {/* Render switch: when the user opts in to "Expand Context",
              we use MultiFileDiff (computes the diff from full file
              contents, so unchanged hunks are expandable). Otherwise
              the cheaper FileDiff render is used against the parsed
              partial patch. Lazy-mounted until near the viewport.
              An active edit session always renders the full-context
              surface with the editor attached (edit + editorOptions). */}
          {bodyMounted && contentsReady ? (
            editing && editSession ? (
              <MultiFileDiff<
                | ReviewComment
                | { _pending: true }
                | { _existingPr: true; comment: PrExistingComment }
              >
                key={`edit-${editSession.sessionKey}`}
                oldFile={{ name: oldFilePath, contents: oldContent ?? "" }}
                newFile={{ name: filePath, contents: editSession.seedContent }}
                edit
                onEditChange={(event) =>
                  onEditChange?.(filePath, event.file, event.lineAnnotations)
                }
                onEditComplete={() => "reject"}
                editorOptions={editorOptions}
                options={{
                  ...tokenHandlers,
                  onPostRender,
                  diffStyle,
                  // Line selection + gutter utility are read-mode comment
                  // affordances; the editor owns selection while editing.
                  enableGutterUtility: false,
                  enableLineSelection: false,
                  disableFileHeader: true,
                  lineDiffType,
                  overflow: lineWrap ? "wrap" : "scroll",
                  diffIndicators,
                  disableLineNumbers: !showLineNumbers,
                  hunkSeparators,
                  lineHoverHighlight,
                  expandUnchanged: false,
                  collapsedContextThreshold,
                  expansionLineCount,
                  onLineNumberClick: (props) => {
                    const side =
                      props.annotationSide === "deletions"
                        ? "deletions"
                        : "additions";
                    const short = `${filePath}:${side === "deletions" ? "-" : "+"}${props.lineNumber}`;
                    const params = new URLSearchParams({
                      file: filePath,
                      line: String(props.lineNumber),
                      side,
                    });
                    const full =
                      typeof window === "undefined"
                        ? short
                        : `${window.location.origin}${window.location.pathname}?${params}`;
                    navigator.clipboard?.writeText(full).then(
                      () => {
                        setPermalinkFlash(short);
                        setTimeout(() => setPermalinkFlash(null), 1600);
                      },
                      () => {},
                    );
                  },
                  theme: {
                    dark:
                      shikiConfig.type === "dark"
                        ? shikiConfig.themeName
                        : "rose-pine",
                    light:
                      shikiConfig.type === "light"
                        ? shikiConfig.themeName
                        : "github-light",
                  },
                  themeType: shikiConfig.type,
                  unsafeCSS,
                }}
                metrics={virtualMetrics}
                lineAnnotations={allAnnotations}
                renderHeaderMetadata={() => null}
                renderAnnotation={renderAnnotationFn}
              />
            ) : (
              <MultiFileDiff<
                | ReviewComment
                | { _pending: true }
                | { _existingPr: true; comment: PrExistingComment }
              >
                oldFile={{ name: oldFilePath, contents: oldContent ?? "" }}
                newFile={{ name: filePath, contents: newContent ?? "" }}
                options={{
                  ...tokenHandlers,
                  onPostRender,
                  diffStyle,
                  enableGutterUtility: true,
                  enableLineSelection: true,
                  disableFileHeader: true,
                  lineDiffType,
                  overflow: lineWrap ? "wrap" : "scroll",
                  diffIndicators,
                  disableLineNumbers: !showLineNumbers,
                  hunkSeparators,
                  lineHoverHighlight,
                  expandUnchanged: false,
                  collapsedContextThreshold,
                  expansionLineCount,
                  onLineSelectionStart: handleSelectionStart,
                  onLineSelectionChange: handleSelectionChange,
                  onLineSelectionEnd: handleSelectionEnd,
                  onGutterUtilityClick: handleGutterUtilityClick,
                  onLineNumberClick: (props) => {
                    const side =
                      props.annotationSide === "deletions"
                        ? "deletions"
                        : "additions";
                    const short = `${filePath}:${side === "deletions" ? "-" : "+"}${props.lineNumber}`;
                    const params = new URLSearchParams({
                      file: filePath,
                      line: String(props.lineNumber),
                      side,
                    });
                    const full =
                      typeof window === "undefined"
                        ? short
                        : `${window.location.origin}${window.location.pathname}?${params}`;
                    navigator.clipboard?.writeText(full).then(
                      () => {
                        setPermalinkFlash(short);
                        setTimeout(() => setPermalinkFlash(null), 1600);
                      },
                      () => {},
                    );
                  },
                  theme: {
                    dark:
                      shikiConfig.type === "dark"
                        ? shikiConfig.themeName
                        : "rose-pine",
                    light:
                      shikiConfig.type === "light"
                        ? shikiConfig.themeName
                        : "github-light",
                  },
                  themeType: shikiConfig.type,
                  unsafeCSS,
                }}
                metrics={virtualMetrics}
                // Only control selection while a draft is open — never push null mid-drag.
                selectedLines={pending ? selectedRange : undefined}
                lineAnnotations={allAnnotations}
                renderHeaderMetadata={() => null}
                renderAnnotation={renderAnnotationFn}
              />
            )
          ) : bodyMounted ? (
            editing ? (
              <div className="file-diff-body-placeholder" aria-hidden="true">
                Loading full file…
              </div>
            ) : (
              <FileDiff<
                | ReviewComment
                | { _pending: true }
                | { _existingPr: true; comment: PrExistingComment }
              >
                fileDiff={fileDiff}
                options={{
                  ...tokenHandlers,
                  onPostRender,
                  diffStyle,
                  enableGutterUtility: true,
                  enableLineSelection: true,
                  disableFileHeader: true, // Disable built-in header to use custom header
                  lineDiffType,
                  overflow: lineWrap ? "wrap" : "scroll",
                  diffIndicators,
                  disableLineNumbers: !showLineNumbers,
                  hunkSeparators,
                  lineHoverHighlight,
                  onLineSelectionStart: handleSelectionStart,
                  onLineSelectionChange: handleSelectionChange,
                  onLineSelectionEnd: handleSelectionEnd,
                  onGutterUtilityClick: handleGutterUtilityClick,
                  onLineNumberClick: (props) => {
                    const side =
                      props.annotationSide === "deletions"
                        ? "deletions"
                        : "additions";
                    const short = `${filePath}:${side === "deletions" ? "-" : "+"}${props.lineNumber}`;
                    const params = new URLSearchParams({
                      file: filePath,
                      line: String(props.lineNumber),
                      side,
                    });
                    const full =
                      typeof window === "undefined"
                        ? short
                        : `${window.location.origin}${window.location.pathname}?${params}`;
                    navigator.clipboard?.writeText(full).then(
                      () => {
                        setPermalinkFlash(short);
                        setTimeout(() => setPermalinkFlash(null), 1600);
                      },
                      () => {},
                    );
                  },
                  theme: {
                    dark:
                      shikiConfig.type === "dark"
                        ? shikiConfig.themeName
                        : "rose-pine",
                    light:
                      shikiConfig.type === "light"
                        ? shikiConfig.themeName
                        : "github-light",
                  },
                  themeType: shikiConfig.type,
                  unsafeCSS,
                }}
                metrics={virtualMetrics}
                selectedLines={pending ? selectedRange : undefined}
                lineAnnotations={allAnnotations}
                renderHeaderMetadata={() => null} // Header is disabled
                renderAnnotation={renderAnnotationFn}
              />
            )
          ) : null}
        </div>
      )}
    </div>
  );
});

function HunkHistorySection({
  filePath,
  deletionStart,
  deletionCount,
}: {
  filePath: string;
  deletionStart: number;
  deletionCount: number;
}) {
  const [data, setData] = useState<HunkHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const queryParams = new URLSearchParams({
          filePath,
          deletionStart: String(deletionStart),
          deletionCount: String(deletionCount),
        });
        const res = await fetch(`/api/hunk-history?${queryParams}`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        if (active) {
          setData(json);
        }
      } catch (err: any) {
        if (active) {
          setError(err.message || "Failed to fetch hunk history");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    fetchData();
    return () => {
      active = false;
    };
  }, [filePath, deletionStart, deletionCount]);

  if (loading) {
    return (
      <div className="hunk-history-loading">
        <Loader2 size={14} className="spin hunk-history-status-icon" />
        <span>Loading git history & origin blame…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="hunk-history-error">
        <AlertCircle
          size={14}
          className="hunk-history-status-icon hunk-history-error-icon"
        />
        <span>Failed to load git history: {error}</span>
      </div>
    );
  }

  if (!data) return null;

  // Get unique commits from blame
  const uniqueBlames = Array.from(
    new Map(data.blame.map((item) => [item.commit, item])).values(),
  );

  return (
    <div className="hunk-history-section">
      {uniqueBlames.length > 0 && (
        <div className="hunk-history-block">
          <h3 className="hunk-history-title">
            Commit(s) introducing deleted lines
          </h3>
          <div className="hunk-history-commits">
            {uniqueBlames.map((entry) => (
              <div key={entry.commit} className="hunk-history-commit-card">
                <div className="hunk-history-commit-header">
                  <span className="hunk-history-commit-hash">
                    {entry.commit}
                  </span>
                  <span className="hunk-history-commit-author">
                    <User size={11} />
                    <span>{entry.author}</span>
                  </span>
                  <span className="hunk-history-commit-date">
                    <Clock size={11} />
                    <span>{entry.date}</span>
                  </span>
                </div>
                <div className="hunk-history-commit-msg">{entry.summary}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.recentCommits.length > 0 && (
        <div className="hunk-history-block">
          <h3 className="hunk-history-title">
            Recent File Modification History
          </h3>
          <div className="hunk-history-log">
            {data.recentCommits.map((c) => (
              <div key={c.hash} className="hunk-history-log-row">
                <span className="hunk-history-log-hash">{c.hash}</span>
                <span className="hunk-history-log-msg" title={c.summary}>
                  {c.summary}
                </span>
                <span className="hunk-history-log-author">{c.author}</span>
                <span className="hunk-history-log-date">{c.date}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function buildUnsafeCSS(
  tabSize: number,
  fontSize: number,
  fontFamily: string,
): string {
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
      cursor: pointer !important;
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
    /* Find-in-file persistent match highlights. Rows are matched and toggled
       by syncFindHighlights; these rules live in the shadow root because the
       app stylesheet cannot pierce it. Added/deleted rows keep their diff
       tint (ring + glow only); context rows get a gold wash. */
    [data-line].find-hit,
    [data-line].find-hit-current {
      box-shadow: inset 0 0 0 1.5px rgba(235, 186, 0, 0.55) !important;
    }
    [data-line].find-hit-current {
      box-shadow: inset 0 0 0 2px rgba(235, 186, 0, 0.9),
        inset 0 0 16px rgba(235, 186, 0, 0.3) !important;
    }
    [data-line].find-hit:not([data-line-type]),
    [data-line].find-hit:not([data-line-type="addition"]):not([data-line-type="deletion"]):not([data-line-type="change-addition"]):not([data-line-type="change-deletion"]) {
      background-color: rgba(235, 186, 0, 0.16) !important;
    }
    [data-line].find-hit-current:not([data-line-type="addition"]):not([data-line-type="deletion"]):not([data-line-type="change-addition"]):not([data-line-type="change-deletion"]) {
      background-color: rgba(235, 186, 0, 0.4) !important;
    }
    [data-line] .find-hit-text {
      background-color: rgba(235, 186, 0, 0.36) !important;
      border-radius: 3px !important;
      box-shadow: 0 0 0 1px rgba(235, 186, 0, 0.4) !important;
    }
    ${EMBEDDED_COMMENT_STYLES}
  `;
}

/** What the selection widget needs to offer language-server code actions. */
export interface SelectionCodeActions {
  fetch: (
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) => Promise<CodeIntelAction[]>;
  apply: (edits: CodeIntelEdits, title: string) => void;
}

/**
 * Replace the widget's contents with the actions a language server offered.
 *
 * An action that cannot be applied here is shown disabled with the reason
 * rather than hidden: "this quick fix only touches other files" and "this one
 * runs a server command, which we do not do" are both worth knowing.
 */
function renderCodeActions(
  el: HTMLElement,
  actions: CodeIntelAction[],
  ctx: EditSelectionActionContext,
  codeActions: SelectionCodeActions,
): void {
  el.replaceChildren();
  if (actions.length === 0) {
    const empty = document.createElement("span");
    empty.className = "edit-selection-action-empty";
    empty.textContent = "No actions here";
    el.append(empty);
    return;
  }
  for (const action of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "edit-selection-action-btn";
    btn.textContent = action.title;
    if (action.unavailable) {
      btn.disabled = true;
      btn.title =
        action.unavailable === "command-only"
          ? "This action runs a command in the language server, which diffing does not do"
          : "This action only changes other files, which are never edited from here";
    } else {
      btn.title = "Apply this fix to the open file";
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const edits = action.edits;
        ctx.close();
        if (edits) codeActions.apply(edits, action.title);
      });
    }
    el.append(btn);
  }
}

/**
 * Build the floating selection-action popover for the edit surface.
 *
 * Edit-mode selections are text-level; these actions keep the review loop
 * alive without leaving the editor:
 * - "Comment" opens the existing comment composer anchored to the selection's
 *   line range (additions side — the only editable side).
 * - "Copy link" copies a permalink to the selection's first line.
 * - "Fix…" asks the language server what it can do with the selection, and is
 *   absent entirely when code intel is off.
 */
function buildEditSelectionAction(
  ctx: EditSelectionActionContext,
  filePath: string,
  onComment: (range: { start: number; end: number }, text: string) => void,
  codeActions?: SelectionCodeActions,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "edit-selection-action";
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", "Selection actions");

  const commentBtn = document.createElement("button");
  commentBtn.type = "button";
  commentBtn.className = "edit-selection-action-btn";
  commentBtn.textContent = "Comment";
  commentBtn.title = "Add a review comment on the selected lines";
  commentBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = ctx.getSelectionText();
    const s = ctx.selection.start;
    const en = ctx.selection.end;
    ctx.close();
    onComment({ start: s.line + 1, end: en.line + 1 }, text);
  });

  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "edit-selection-action-btn";
  linkBtn.textContent = "Copy link";
  linkBtn.title = "Copy a permalink to this line";
  linkBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const line = ctx.selection.start.line + 1;
    ctx.close();
    const params = new URLSearchParams({
      file: filePath,
      line: String(line),
      side: "additions",
    });
    const full = `${window.location.origin}${window.location.pathname}?${params}`;
    navigator.clipboard?.writeText(full).catch(() => {});
  });

  el.append(commentBtn, linkBtn);

  if (codeActions) {
    const fixBtn = document.createElement("button");
    fixBtn.type = "button";
    fixBtn.className = "edit-selection-action-btn";
    fixBtn.textContent = "Fix…";
    fixBtn.title = "Ask the language server what it can do with this selection";
    fixBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      fixBtn.disabled = true;
      fixBtn.textContent = "Asking…";
      const start = ctx.selection.start;
      const end = ctx.selection.end;
      codeActions
        .fetch(start.line + 1, start.character, end.line + 1, end.character)
        .then((actions) => renderCodeActions(el, actions, ctx, codeActions))
        .catch(() => renderCodeActions(el, [], ctx, codeActions));
    });
    el.append(fixBtn);
  }

  return el;
}
