import { useState, useMemo, useEffect, useRef, useCallback, memo } from "react";
import {
  Search,
  Filter,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Check,
} from "lucide-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type {
  FileTreeRowDecorationRenderer,
  GitStatusEntry,
  GitStatus,
} from "@pierre/trees";
import { Tooltip } from "../primitives/Tooltip";
import { sanitizePaths, buildExpandedPaths } from "../lib/treePathSanitize";
import {
  matchesExtensionFilter,
  formatExtensionFilter,
  collectExtensions,
  normalizeExtensions,
  sameExtensionSet,
  extensionFilterNeedsApply,
} from "../lib/extensionFilter";
import { FileTreeErrorBoundary } from "./FileTreeErrorBoundary";

export type FileTreeChipFilter =
  | "all"
  | "unviewed"
  | "has-comments"
  | "since-last";

interface FileTreeProps {
  files: FileDiffMetadata[];
  activeFile: string | null;
  commentCounts: Record<string, number>;
  viewedFiles: Set<string>;
  untrackedFiles: Set<string>;
  onFileClick: (filePath: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Applied extension multi-select (normalized, no dots). Empty = all. */
  appliedExtensions?: string[];
  /** Commit a new applied extension set (from multi-select Apply / live toggle). */
  onApplyExtensions?: (extensions: string[]) => void;
  /** Smart filter chips (AND-combined with extension + name search). */
  chipFilter?: FileTreeChipFilter;
  onChipFilterChange?: (value: FileTreeChipFilter) => void;
  /**
   * Files that differ from the last handoff baseline. Used by the
   * "Since last" chip and row decoration.
   */
  sinceLastFiles?: Set<string>;
  /** Hide "Since last" when there is no handoff baseline yet. */
  sinceLastAvailable?: boolean;
}

export const FileTree = memo(function FileTree({
  files,
  activeFile,
  commentCounts,
  viewedFiles,
  untrackedFiles,
  onFileClick,
  collapsed,
  onToggleCollapse,
  appliedExtensions = [],
  onApplyExtensions,
  chipFilter = "all",
  onChipFilterChange,
  sinceLastFiles,
  sinceLastAvailable = false,
}: FileTreeProps) {
  const [filter, setFilter] = useState("");
  // Draft selection for multi-select; only committed via Apply (or live when small).
  const [draftExtensions, setDraftExtensions] = useState<string[]>(() =>
    normalizeExtensions(appliedExtensions),
  );

  useEffect(() => {
    setDraftExtensions(normalizeExtensions(appliedExtensions));
  }, [appliedExtensions]);

  const totalChangedLines = useMemo(() => {
    let n = 0;
    for (const f of files) {
      n += f.additionLines.length + f.deletionLines.length;
    }
    return n;
  }, [files]);

  const needsApply = extensionFilterNeedsApply(files.length, totalChangedLines);
  const availableExtensions = useMemo(
    () => collectExtensions(files.map((f) => f.name)),
    [files],
  );

  const commitExtensions = useCallback(
    (next: string[]) => {
      const normalized = normalizeExtensions(next);
      setDraftExtensions(normalized);
      onApplyExtensions?.(normalized);
    },
    [onApplyExtensions],
  );

  const toggleDraftExtension = useCallback(
    (ext: string) => {
      setDraftExtensions((prev) => {
        const set = new Set(prev);
        if (set.has(ext)) set.delete(ext);
        else set.add(ext);
        const next = normalizeExtensions([...set]);
        // Small diffs: apply live so multi-select still feels instant.
        if (!needsApply) {
          onApplyExtensions?.(next);
        }
        return next;
      });
    },
    [needsApply, onApplyExtensions],
  );

  const dirty = !sameExtensionSet(draftExtensions, appliedExtensions);

  const filteredFiles = useMemo(() => {
    let list = files;
    // Tree always shows the *applied* set so it matches the main DiffViewer.
    if (appliedExtensions.length > 0) {
      list = list.filter((f) =>
        matchesExtensionFilter(f.name, appliedExtensions),
      );
    }
    if (chipFilter === "unviewed") {
      list = list.filter((f) => !viewedFiles.has(f.name));
    } else if (chipFilter === "has-comments") {
      list = list.filter((f) => (commentCounts[f.name] ?? 0) > 0);
    } else if (chipFilter === "since-last") {
      const set = sinceLastFiles ?? new Set<string>();
      list = list.filter((f) => set.has(f.name));
    }
    return list;
  }, [
    files,
    appliedExtensions,
    chipFilter,
    viewedFiles,
    commentCounts,
    sinceLastFiles,
  ]);

  // Map files to paths required by @pierre/trees, deduping and resolving
  // file↔directory collisions so the underlying tree model never sees a
  // colliding path (which would throw "Path collides with an existing entry").
  const { paths, dropped } = useMemo(
    () => sanitizePaths(filteredFiles.map((f) => f.name)),
    [filteredFiles],
  );

  const pathsSet = useMemo(() => new Set(paths), [paths]);

  const expandedPaths = useMemo(() => buildExpandedPaths(paths), [paths]);

  // Map file change type to GitStatusEntry
  const gitStatus = useMemo<GitStatusEntry[]>(() => {
    return filteredFiles
      .filter((file) => pathsSet.has(file.name))
      .map((file) => {
        let status: GitStatus = "modified";
        if (untrackedFiles.has(file.name)) {
          status = "untracked";
        } else if (file.prevName) {
          status = "renamed";
        } else {
          const prev = file.prevObjectId;
          const next = file.newObjectId;
          if (
            prev === "0000000" ||
            prev === "0000000000000000000000000000000000000000"
          ) {
            status = "added";
          } else if (
            next === "0000000" ||
            next === "0000000000000000000000000000000000000000"
          ) {
            status = "deleted";
          }
        }
        return { path: file.name, status };
      });
  }, [filteredFiles, untrackedFiles, pathsSet]);

  // Keep a ref of viewedFiles and commentCounts to avoid recreating renderRowDecoration
  // and maintain absolute freshness on virtualized list updates.
  const decorationStateRef = useRef({
    commentCounts,
    viewedFiles,
    sinceLastFiles: sinceLastFiles ?? new Set<string>(),
  });
  decorationStateRef.current = {
    commentCounts,
    viewedFiles,
    sinceLastFiles: sinceLastFiles ?? new Set<string>(),
  };

  const renderRowDecoration = useCallback<FileTreeRowDecorationRenderer>(
    (context) => {
      const path = context.item.path;
      const {
        commentCounts: latestComments,
        viewedFiles: latestViewed,
        sinceLastFiles: latestSince,
      } = decorationStateRef.current;
      const isViewed = latestViewed.has(path);
      const count = latestComments[path] ?? 0;
      const sinceLast = latestSince.has(path);

      const parts: string[] = [];
      const titles: string[] = [];
      if (sinceLast) {
        parts.push("Δ");
        titles.push("Changed since last review handoff");
      }
      if (isViewed) {
        parts.push("✓");
        titles.push("Viewed");
      }
      if (count > 0) {
        parts.push(`💬 ${count}`);
        titles.push(`${count} comment${count > 1 ? "s" : ""}`);
      }
      if (parts.length === 0) return null;
      return {
        text: parts.join(" "),
        title: titles.join(" · "),
      };
    },
    [],
  );

  const syncingSelection = useRef(false);
  const { model } = useFileTree({
    paths,
    fileTreeSearchMode: "hide-non-matches",
    gitStatus,
    renderRowDecoration,
    initialSelectedPaths:
      activeFile && pathsSet.has(activeFile) ? [activeFile] : [],
    initialExpandedPaths: expandedPaths,
    onSelectionChange: (selectedPaths) => {
      if (
        !syncingSelection.current &&
        selectedPaths.length > 0 &&
        selectedPaths[0] !== activeFile
      ) {
        onFileClick(selectedPaths[0]);
      }
    },
  });

  // Synchronize paths update on model
  useEffect(() => {
    model.resetPaths(paths, { initialExpandedPaths: expandedPaths });
  }, [paths, expandedPaths, model]);

  // Synchronize git status and force redraw of decorations when comments/viewed states change
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, commentCounts, viewedFiles, model]);

  // Synchronize activeFile selection and viewport scroll
  useEffect(() => {
    if (!activeFile || !pathsSet.has(activeFile)) return;
    try {
      syncingSelection.current = true;
      for (const path of model.getSelectedPaths()) {
        if (path !== activeFile) model.getItem(path)?.deselect();
      }
      model.getItem(activeFile)?.select();
      model.scrollToPath(activeFile, { focus: false, offset: "nearest" });
    } catch (err) {
      console.error("Failed to scroll to active file:", err);
    } finally {
      syncingSelection.current = false;
    }
  }, [activeFile, model, pathsSet]);

  // Synchronize custom filter search input with @pierre/trees search engine
  useEffect(() => {
    model.setSearch(filter || null);
  }, [filter, model]);

  if (collapsed) {
    return (
      <div className="ft ft-collapsed">
        {onToggleCollapse && (
          <Tooltip content="Expand sidebar · b" side="right">
            <button
              className="sidebar-toggle"
              onClick={onToggleCollapse}
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen size={16} />
            </button>
          </Tooltip>
        )}
      </div>
    );
  }

  const filterLabel = formatExtensionFilter(appliedExtensions);
  const totalFiles = files.length;
  const shownFiles = filteredFiles.length;
  const hiddenFiles = totalFiles - shownFiles;
  const showExtensionPicker =
    availableExtensions.length > 0 && !!onApplyExtensions;

  return (
    <div
      className="ft"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <div className="ft-chrome">
        <div className="ft-search-row">
          {onToggleCollapse && (
            <Tooltip content="Collapse sidebar · b" side="right">
              <button
                className="sidebar-toggle"
                onClick={onToggleCollapse}
                aria-label="Collapse sidebar"
              >
                <PanelLeftClose size={16} />
              </button>
            </Tooltip>
          )}
          <div className="ft-search-wrapper">
            <Search size={14} className="ft-search-icon" aria-hidden="true" />
            <input
              type="text"
              placeholder="Filter files…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="ft-search-input"
              aria-label="Filter files"
            />
          </div>
        </div>

        {showExtensionPicker && (
          <div className="ft-ext-panel" aria-label="Filter by file extension">
            <div className="ft-ext-header">
              <Filter size={12} aria-hidden="true" />
              <span className="ft-ext-title">Extensions</span>
              {appliedExtensions.length > 0 && (
                <span className="ft-ext-applied" title={filterLabel}>
                  {appliedExtensions.length} applied
                </span>
              )}
              {dirty && needsApply && (
                <span className="ft-ext-pending">unsaved</span>
              )}
            </div>
            <div
              className="ft-ext-chips"
              role="group"
              aria-label="File extensions"
            >
              {availableExtensions.map((ext) => {
                const selected = draftExtensions.includes(ext);
                return (
                  <button
                    key={ext}
                    type="button"
                    className={`ft-ext-chip ${selected ? "ft-ext-chip-active" : ""}`}
                    aria-pressed={selected}
                    title={selected ? `Remove .${ext}` : `Include .${ext}`}
                    onClick={() => toggleDraftExtension(ext)}
                  >
                    .{ext}
                  </button>
                );
              })}
            </div>
            <div className="ft-ext-actions">
              {needsApply ? (
                <button
                  type="button"
                  className="ft-ext-apply"
                  disabled={!dirty}
                  onClick={() => commitExtensions(draftExtensions)}
                  title="Apply the selected extensions to the file tree and diff list"
                >
                  <Check size={12} />
                  Apply
                  {dirty && draftExtensions.length > 0
                    ? ` (${draftExtensions.length})`
                    : dirty
                      ? " (all)"
                      : ""}
                </button>
              ) : (
                <span className="ft-ext-hint">Live filter</span>
              )}
              {(draftExtensions.length > 0 || appliedExtensions.length > 0) && (
                <button
                  type="button"
                  className="ft-ext-clear"
                  onClick={() => commitExtensions([])}
                  aria-label="Clear extension filter"
                  title="Show all extensions"
                >
                  <X size={12} />
                  Clear
                </button>
              )}
            </div>
          </div>
        )}

        {onChipFilterChange && (
          <div
            className="ft-chips"
            role="group"
            aria-label="Smart file filters"
          >
            {(
              [
                { id: "all" as const, label: "All" },
                { id: "unviewed" as const, label: "Unviewed" },
                { id: "has-comments" as const, label: "Comments" },
                ...(sinceLastAvailable
                  ? [{ id: "since-last" as const, label: "Since last" }]
                  : []),
              ] as const
            ).map((chip) => (
              <button
                key={chip.id}
                type="button"
                className={`ft-chip ${chipFilter === chip.id ? "ft-chip-active" : ""}`}
                aria-pressed={chipFilter === chip.id}
                title={
                  chip.id === "since-last"
                    ? "Files added or modified since the last Send to agent"
                    : undefined
                }
                onClick={() => onChipFilterChange(chip.id)}
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        {hiddenFiles > 0 && (
          <div className="ft-filter-status">
            <span className="ft-filter-status-text" title={filterLabel}>
              {shownFiles} of {totalFiles}
            </span>
          </div>
        )}
      </div>
      {dropped.length > 0 && (
        <div
          className="ft-collision-warning"
          title={dropped.join("\n")}
          style={{
            fontSize: "0.75rem",
            padding: "4px 8px",
            background: "var(--bg-warning, #fff3cd)",
            color: "var(--text-warning, #856404)",
          }}
        >
          ⚠ {dropped.length} file(s) hidden due to path collision (hover for
          details)
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <FileTreeErrorBoundary>
          <PierreFileTree model={model} className="ft-pierre-tree" />
        </FileTreeErrorBoundary>
      </div>
    </div>
  );
});
