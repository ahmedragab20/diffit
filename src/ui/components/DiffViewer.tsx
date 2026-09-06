import { memo, useEffect, useState } from "react";
import { GitCompare } from "lucide-react";
import { Virtualizer } from "@pierre/diffs";
import { VirtualizerContext } from "@pierre/diffs/react";
import type {
  FileDiffMetadata,
  DiffLineAnnotation,
  AnnotationSide,
  FileContents,
} from "@pierre/diffs";
import type { Editor } from "@pierre/diffs/edit";
import type { ReviewComment } from "../../lib/types";
import type { AiDiffSelection } from "../../lib/ai/types";
import type { PrExistingComment } from "../../lib/pr-session";
import type { BinaryFileInfo } from "../hooks/useDiff";
import type { EditAnnotation, EditSessionView } from "../hooks/useEditSessions";
import type {
  LineDiffType,
  DiffIndicators,
  HunkSeparatorStyle,
  LineHoverHighlight,
} from "../hooks/useSettings";
import { FileDiffCard } from "./FileDiffCard";
import { BinaryFileDiff } from "./BinaryFileDiff";
import type { FileSearchSession } from "../hooks/useFileSearch";

interface DiffViewerProps {
  files: FileDiffMetadata[];
  diffStyle: "split" | "unified";
  tabSizeMap: Record<string, number>;
  defaultTabSize: number;
  viewedFiles: Set<string>;
  binaryFiles: Map<string, BinaryFileInfo>;
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
  autoCollapseLineThreshold: number;
  onViewedChange: (filePath: string, viewed: boolean) => void;
  fileAnnotationsMap: Map<string, DiffLineAnnotation<ReviewComment>[]>;
  existingCommentsMap?: Map<string, PrExistingComment[]>;
  onAddComment: (
    filePath: string,
    side: AnnotationSide,
    lineNumber: number,
    lineContent: string,
    body: string,
    startLineNumber?: number,
    severity?: import("../../lib/types").CommentSeverity,
  ) => void;
  onDeleteComment: (id: string) => void;
  onAddSelectionToAsk?: (selection: AiDiffSelection) => void;
  onReplyExisting?: (commentId: number, body: string) => Promise<void>;
  onEditExisting?: (commentId: number, body: string) => Promise<void>;
  onDeleteExisting?: (commentId: number) => Promise<void>;
  onSetExistingResolved?: (
    threadId: string,
    resolved: boolean,
  ) => Promise<void>;
  /** Whether controls that mutate/open the local working tree are available. */
  allowLocalActions?: boolean;
  /**
   * Fired by `<FileDiffCard>` right after the user toggles the card's
   * collapsed state by clicking the header. The viewer does not care
   * about the value — it just passes it through. App.tsx uses this to
   * drive the auto-advance-to-next-file scroll.
   */
  onCardToggleCollapse?: (filePath: string, willCollapse: boolean) => void;
  /** Working-tree scope gate for in-place editing (hidden for staged/revision/PR). */
  canEdit?: boolean;
  /** Active in-place edit sessions keyed by file path. */
  editSessions?: ReadonlyMap<string, EditSessionView>;
  onRequestEdit?: (filePath: string) => Promise<void>;
  onEditChange?: (
    filePath: string,
    file: FileContents,
    annotations?: EditAnnotation[],
  ) => void;
  onEditAttach?: (
    filePath: string,
    editor: Editor<
      "file-diff",
      import("../hooks/useEditSessions").EditSessionMetadata
    >,
  ) => void;
  onEditSave?: (filePath: string) => void;
  onEditDiscard?: (filePath: string) => void;
  onEditExit?: (filePath: string) => void;
  /** Active file-scoped search session (bar renders on the matching card). */
  fileSearch?: FileSearchSession | null;
  /** Open the find-in-file bar on a specific file (header search button). */
  onOpenFileSearch?: (filePath: string) => void;
}

const emptyAnnotations: DiffLineAnnotation<ReviewComment>[] = [];
const emptyExistingComments: PrExistingComment[] = [];

/**
 * Shared file-name comparator used by `<DiffViewer>` and by App.tsx when
 * it pre-sorts the file list for `useScrollToNextFile` / J·K navigate.
 * Exposed so those navigators and the rendered card list always walk the
 * same order — a divergence here would let them pick a different "next"
 * than what the user can see on screen.
 *
 * Sort rules (unchanged from the previous inline implementation):
 *   - Compare path components left-to-right.
 *   - Directory prefixes come before their descendants.
 *   - Within the same depth, `localeCompare` decides.
 *   - Shorter paths come before longer ones at the same prefix.
 */
export function sortFilesByName(
  a: FileDiffMetadata,
  b: FileDiffMetadata,
): number {
  const partsA = a.name.split("/");
  const partsB = b.name.split("/");
  const len = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const aIsDir = i < partsA.length - 1;
    const bIsDir = i < partsB.length - 1;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    const cmp = partsA[i].localeCompare(partsB[i]);
    if (cmp !== 0) return cmp;
  }
  return partsA.length - partsB.length;
}

export const DiffViewer = memo(function DiffViewer({
  files,
  diffStyle,
  tabSizeMap,
  defaultTabSize,
  viewedFiles,
  binaryFiles,
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
  fileAnnotationsMap,
  existingCommentsMap,
  onAddComment,
  onDeleteComment,
  onAddSelectionToAsk,
  onReplyExisting,
  onEditExisting,
  onDeleteExisting,
  onSetExistingResolved,
  allowLocalActions = true,
  onCardToggleCollapse,
  canEdit = false,
  editSessions,
  onRequestEdit,
  onEditChange,
  onEditAttach,
  onEditSave,
  onEditDiscard,
  onEditExit,
  fileSearch,
  onOpenFileSearch,
}: DiffViewerProps) {
  // One shared window-scrolled virtualizer for the whole diff list. Every
  // @pierre/diffs FileDiff / MultiFileDiff rendered below reads it from
  // `VirtualizerContext` and switches from materialising every line to
  // per-line virtualization (diffs.com best practice: only lines in the
  // viewport + overscan exist in the DOM). The instance is created once and
  // set up against `document` because this surface scrolls with the window,
  // not a dedicated overflow container — the React <Virtualizer> wrapper
  // can't own window scroll, so we wire the low-level instance ourselves.
  const [virtualizer] = useState(() => {
    const canVirtualize =
      typeof ResizeObserver !== "undefined" &&
      typeof IntersectionObserver !== "undefined";
    return canVirtualize ? new Virtualizer() : null;
  });
  useEffect(() => {
    if (!virtualizer) return;
    virtualizer.setup(document);
    return () => virtualizer.cleanUp();
  }, [virtualizer]);

  // Callers (App) already sort with sortFilesByName — re-sorting here was pure
  // CPU cost on every parent re-render of large diffs.
  if (files.length === 0) {
    return (
      <div className="empty-state" role="status">
        <div className="empty-state-icon" aria-hidden="true">
          <GitCompare size={24} strokeWidth={1.75} />
        </div>
        <p className="empty-state-title">All clean</p>
        <p className="empty-state-hint">
          No changes found. Stage, edit, or pick a different range to review.
        </p>
      </div>
    );
  }

  return (
    <VirtualizerContext.Provider value={virtualizer ?? undefined}>
      <div className="diff-viewer">
        {files.map((file) => {
          const filePath = file.name;
          const binaryInfo = binaryFiles.get(filePath);
          if (binaryInfo) {
            return (
              <BinaryFileDiff
                key={filePath}
                filePath={filePath}
                info={binaryInfo}
                viewed={viewedFiles.has(filePath)}
                onViewedChange={onViewedChange}
              />
            );
          }
          return (
            <FileDiffCard
              key={filePath}
              id={`file-${filePath}`}
              fileDiff={file}
              filePath={filePath}
              annotations={fileAnnotationsMap.get(filePath) ?? emptyAnnotations}
              existingComments={
                existingCommentsMap?.get(filePath) ?? emptyExistingComments
              }
              diffStyle={diffStyle}
              tabSize={tabSizeMap[filePath] ?? defaultTabSize}
              viewed={viewedFiles.has(filePath)}
              theme={theme}
              editorIDE={editorIDE}
              lineDiffType={lineDiffType}
              lineWrap={lineWrap}
              diffIndicators={diffIndicators}
              showLineNumbers={showLineNumbers}
              hunkSeparators={hunkSeparators}
              lineHoverHighlight={lineHoverHighlight}
              fontSize={fontSize}
              monoFontFamily={monoFontFamily}
              expandContextByDefault={expandContextByDefault}
              collapsedContextThreshold={collapsedContextThreshold}
              expansionLineCount={expansionLineCount}
              autoCollapseLineThreshold={autoCollapseLineThreshold}
              onViewedChange={onViewedChange}
              onAddComment={onAddComment}
              onDeleteComment={onDeleteComment}
              onAddSelectionToAsk={onAddSelectionToAsk}
              onReplyExisting={onReplyExisting}
              onEditExisting={onEditExisting}
              onDeleteExisting={onDeleteExisting}
              onSetExistingResolved={onSetExistingResolved}
              allowLocalActions={allowLocalActions}
              onCardToggleCollapse={onCardToggleCollapse}
              canEdit={canEdit}
              editSession={editSessions?.get(filePath) ?? null}
              onRequestEdit={onRequestEdit}
              onEditChange={onEditChange}
              onEditAttach={onEditAttach}
              onEditSave={onEditSave}
              onEditDiscard={onEditDiscard}
              onEditExit={onEditExit}
              fileSearch={fileSearch?.filePath === filePath ? fileSearch : null}
              onOpenFileSearch={onOpenFileSearch}
            />
          );
        })}
      </div>
    </VirtualizerContext.Provider>
  );
});
