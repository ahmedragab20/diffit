import { CommentActionsProvider, type CommentActions } from "./CommentActionsProvider";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  getFiletypeFromFileName,
  parsePatchFiles,
  preloadHighlighter,
} from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { useWorkerPool } from "@pierre/diffs/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  GitCompare,
  GitPullRequest,
  MessageCircle,
} from "lucide-react";
import type { ReviewComment } from "../../lib/types";
import type { PrExistingComment, PrSession } from "../../lib/pr-session";
import { useDiff } from "../hooks/useDiff";
import {
  usePrCommentSync,
  usePrComments,
  usePrSession,
  useRefreshPrSession,
  type SubmitPrReviewResult,
} from "../hooks/usePrSession";
import {
  resolveMonoFont,
  useSettings,
  type Settings,
} from "../hooks/useSettings";
import { useApplyFonts } from "../hooks/useApplyFonts";
import { useViewed } from "../hooks/useViewed";
import { useScrollToNextFile } from "../hooks/useScrollToNextFile";
import { cancelDiffNavigation, navigateToFile } from "../lib/diffNavigation";
import { useDiffSearch, buildFileSearchCorpus } from "../hooks/useDiffSearch";
import { useFileSearch } from "../hooks/useFileSearch";
import { useViewportActiveFileTracking } from "../hooks/useViewportActiveFile";
import { HapticsProvider } from "../hooks/useHaptics";
import { useDiffReviewKeymaps } from "../hooks/useDiffReviewKeymaps";
import { useSearchSession } from "../hooks/useSearchSession";
import { buildChangedLineKeys, buildDiffFileSet } from "../lib/diffIndex";
import {
  parseExtensionFilter,
  matchesExtensionFilter,
  normalizeExtensions,
} from "../lib/extensionFilter";
import type { FileTreeChipFilter } from "./FileTree";
import type { Scope } from "../lib/searchTypes";
import { getUiStateItem, setUiStateItem } from "../utils/uiState";
import { SHIKI_THEME_MAP } from "../utils";
import { navigate } from "../router";
import { DiffViewer, sortFilesByName } from "./DiffViewer";
import { FileTree } from "./FileTree";
import { CommentTracker } from "./CommentTracker";
import { FontPickerModal } from "./FontPickerModal";
import { PrReviewToolbar } from "./PrReviewToolbar";
import { PrReviewActivity } from "./PrReviewActivity";
import { PrConversationInbox } from "./PrConversationInbox";
import { PrReviewSummaryBanner } from "./PrReviewSummaryBanner";
import { commentsMissingFromPatch } from "../../lib/pr-conversation-inbox";
import { buildPrTimeline } from "../../lib/pr-timeline";
import { PrConversationTimeline } from "./PrConversationTimeline";
import { PrSubmittedToast } from "./PrSubmittedToast";
import { SearchPalette } from "./SearchPalette";
import { ShortcutsHelpModal } from "./ShortcutsHelpModal";
import { ThemeModal } from "./ThemeModal";
import { VimStatusBar } from "./VimStatusBar";
import { AiAssistantRail } from "../ai/AiAssistantRail";
import { diffReviewContextForAi } from "../ai/diffContext";

/** GitHub-specific variant of the main review shell. */
export function PrReviewApp() {
  const poolManager = useWorkerPool();
  const queryClient = useQueryClient();
  const { settings, loaded, updateSettings } = useSettings();
  const [, startTransition] = useTransition();
  const {
    session,
    loaded: sessionLoaded,
    error: sessionError,
  } = usePrSession();
  const refreshPr = useRefreshPrSession();
  usePrCommentSync(sessionLoaded && !!session);
  const {
    comments,
    addComment,
    removeComment,
    updateComment,
    addReply,
    resolveComment,
    unresolveComment,
    editComment,

  } = usePrComments(sessionLoaded && !!session);
  const { patch, loading, error } = useDiff(
    { staged: false, untracked: false },
    sessionLoaded && !!session,
  );
  const { viewedFiles, setViewed } = useViewed();

  const [activeFile, setActiveFile] = useState<string | null>(null);
  /**
   * Timestamp of the last *explicit* active-file selection (click, J/K) plus
   * the programmatic smooth scrolls they trigger. Fed to
   * `useViewportActiveFileTracking` so scroll-derived detection cannot
   * flicker the active file mid-animation.
   */
  const explicitActiveFileRef = useRef(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const stored = getUiStateItem("diffing-sidebar-collapsed");
    if (stored != null) return stored === "true";
    return typeof window !== "undefined" && window.innerWidth <= 768;
  });
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(getUiStateItem("diffing-sidebar-width")) || 320,
  );
  const [commentPanelHeight, setCommentPanelHeight] = useState(
    () => Number(getUiStateItem("diffing-comment-panel-height")) || 220,
  );
  const [appliedExtensions, setAppliedExtensions] = useState<string[]>(() =>
    parseExtensionFilter(getUiStateItem("diffing-pr-extension-filter") ?? ""),
  );
  const [chipFilter, setChipFilter] = useState<FileTreeChipFilter>(() => {
    const stored = getUiStateItem("diffing-pr-chip-filter");
    return stored === "unviewed" || stored === "has-comments" ? stored : "all";
  });
  const [palette, setPalette] = useState<{
    open: boolean;
    scope: Scope;
    changedOnly: boolean;
  }>({
    open: false,
    scope: "files",
    changedOnly: false,
  });
  const lastChangedOnlyRef = useRef(true);
  const [themeModalOpen, setThemeModalOpen] = useState(false);
  const [uiFontModalOpen, setUiFontModalOpen] = useState(false);
  const [monoFontModalOpen, setMonoFontModalOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [submissionToast, setSubmissionToast] =
    useState<SubmitPrReviewResult | null>(null);
  const [aiRailOpen, setAiRailOpen] = useState(false);
  const [timelineCursor, setTimelineCursor] = useState(0);

  const appRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarGuideRef = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const commentPanelHeightRef = useRef(commentPanelHeight);
  sidebarWidthRef.current = sidebarWidth;
  commentPanelHeightRef.current = commentPanelHeight;

  useApplyFonts(loaded, settings.uiFont, settings.monoFont);

  const files = useMemo<FileDiffMetadata[]>(() => {
    if (!patch) return [];
    try {
      const seen = new Set<string>();
      return parsePatchFiles(patch)
        .flatMap((part) => part.files)
        .filter((file) => {
          if (seen.has(file.name)) return false;
          seen.add(file.name);
          return true;
        })
        .sort(sortFilesByName);
    } catch {
      return [];
    }
  }, [patch]);

  const existingCommentsByFile = useMemo(() => {
    const map = new Map<string, PrExistingComment[]>();
    for (const comment of session?.existingComments ?? []) {
      const list = map.get(comment.path) ?? [];
      list.push(comment);
      map.set(comment.path, list);
    }
    return map;
  }, [session]);

  const inboxComments = useMemo(
    () =>
      commentsMissingFromPatch(
        session?.existingComments ?? [],
        files.map((file) => file.name),
      ),
    [session, files],
  );

  const timelineItems = useMemo(
    () => (session ? buildPrTimeline(session) : []),
    [session],
  );
  const timelinePageSize = 20;
  const timelinePage = timelineItems.slice(
    timelineCursor,
    timelineCursor + timelinePageSize,
  );

  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const comment of comments)
      counts[comment.filePath] = (counts[comment.filePath] ?? 0) + 1;
    for (const comment of session?.existingComments ?? [])
      counts[comment.path] = (counts[comment.path] ?? 0) + 1;
    return counts;
  }, [comments, session]);

  const filteredFiles = useMemo(() => {
    let next = files;
    if (appliedExtensions.length > 0)
      next = next.filter((file) =>
        matchesExtensionFilter(file.name, appliedExtensions),
      );
    if (chipFilter === "unviewed")
      next = next.filter((file) => !viewedFiles.has(file.name));
    if (chipFilter === "has-comments")
      next = next.filter((file) => (commentCounts[file.name] ?? 0) > 0);
    return next;
  }, [files, appliedExtensions, chipFilter, viewedFiles, commentCounts]);

  // Keep the "active file" (⌘F target, tree highlight, status bar) in sync
  // with the file the user is actually looking at: the card under the mouse,
  // or the card with the most visible height in the viewport.
  useViewportActiveFileTracking(
    filteredFiles,
    activeFile,
    setActiveFile,
    explicitActiveFileRef,
  );

  const fileAnnotations = useMemo(() => {
    const map = new Map<
      string,
      Array<{
        side: ReviewComment["side"];
        lineNumber: number;
        metadata: ReviewComment;
      }>
    >();
    for (const comment of comments) {
      const list = map.get(comment.filePath) ?? [];
      list.push({
        side: comment.side,
        lineNumber: comment.lineNumber,
        metadata: comment,
      });
      map.set(comment.filePath, list);
    }
    return map;
  }, [comments]);

  const diffSearchEntries = useDiffSearch(filteredFiles);
  // Find-in-file corpus: changed lines + unchanged context lines.
  const fileSearchCorpus = useMemo(
    () => buildFileSearchCorpus(filteredFiles),
    [filteredFiles],
  );
  const fileSearch = useFileSearch(fileSearchCorpus);
  const openFileSearch = useCallback(
    (path: string) => fileSearch.open(path),
    [fileSearch],
  );
  const searchNavContext = useMemo(
    () => ({
      diffFileSet: buildDiffFileSet(filteredFiles),
      changedKeys: buildChangedLineKeys(diffSearchEntries),
      customMode: true,
      staged: false,
    }),
    [filteredFiles, diffSearchEntries],
  );
  const monoFontFamily = useMemo(
    () => resolveMonoFont(settings.monoFont),
    [settings.monoFont],
  );
  const emptyUntracked = useMemo(() => new Set<string>(), []);

  const handleFileClick = useCallback((filePath: string) => {
    explicitActiveFileRef.current = Date.now();
    setActiveFile(filePath);
    navigateToFile(filePath);
  }, []);

  const scrollToNextFile = useScrollToNextFile(filteredFiles);
  useEffect(() => () => cancelDiffNavigation(), []);

  const handleViewedChange = useCallback(
    (filePath: string, viewed: boolean) => {
      setViewed(filePath, viewed);
      if (viewed) {
        explicitActiveFileRef.current = Date.now();
        scrollToNextFile(filePath);
      }
    },
    [setViewed, scrollToNextFile],
  );

  const replyToExisting = useCallback(
    async (commentId: number, body: string) => {
      const response = await fetch(
        `/api/gh/existing-comments/${commentId}/replies`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || `HTTP ${response.status}`);
      await queryClient.invalidateQueries({ queryKey: ["pr-session"] });
    },
    [queryClient],
  );

  const mutateExistingComment = useCallback(
    async (method: "PATCH" | "DELETE", commentId: number, body?: string) => {
      const response = await fetch(`/api/gh/existing-comments/${commentId}`, {
        method,
        headers:
          body == null ? undefined : { "Content-Type": "application/json" },
        body: body == null ? undefined : JSON.stringify({ body }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || `HTTP ${response.status}`);
      await queryClient.invalidateQueries({ queryKey: ["pr-session"] });
    },
    [queryClient],
  );

  const applyExistingSuggestion = useCallback(
    async (commentId: number) => {
      const response = await fetch(
        `/api/gh/existing-comments/${commentId}/apply-suggestion`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedHeadSha: session?.headSha }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || `HTTP ${response.status}`);
      await queryClient.invalidateQueries({ queryKey: ["pr-session"] });
    },
    [queryClient, session?.headSha],
  );

  const setExistingThreadResolved = useCallback(
    async (threadId: string, resolved: boolean) => {
      const response = await fetch(
        `/api/gh/review-threads/${encodeURIComponent(threadId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolved }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || `HTTP ${response.status}`);
      await queryClient.invalidateQueries({ queryKey: ["pr-session"] });
    },
    [queryClient],
  );

  const handleSidebarResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
    let latestWidth = startWidth;
    const move = (nextEvent: MouseEvent) => {
      latestWidth = Math.max(
        240,
        Math.min(640, startWidth + nextEvent.clientX - startX),
      );
      if (sidebarGuideRef.current)
        sidebarGuideRef.current.style.transform = `translateX(${sidebarLeft + latestWidth}px)`;
    };
    const up = () => {
      sidebarGuideRef.current?.classList.remove("sidebar-resize-guide-active");
      setSidebarWidth(latestWidth);
      setUiStateItem("diffing-sidebar-width", String(latestWidth));
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    sidebarGuideRef.current?.classList.add("sidebar-resize-guide-active");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handleCommentResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = commentPanelHeightRef.current;
    let latestHeight = startHeight;
    const move = (nextEvent: MouseEvent) => {
      latestHeight = Math.max(
        100,
        Math.min(600, startHeight + startY - nextEvent.clientY),
      );
      appRef.current?.style.setProperty(
        "--comment-panel-height",
        `${latestHeight}px`,
      );
    };
    const up = () => {
      setCommentPanelHeight(latestHeight);
      setUiStateItem("diffing-comment-panel-height", String(latestHeight));
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    setUiStateItem("diffing-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  useEffect(
    () =>
      setUiStateItem(
        "diffing-pr-extension-filter",
        appliedExtensions.join(","),
      ),
    [appliedExtensions],
  );
  useEffect(
    () => setUiStateItem("diffing-pr-chip-filter", chipFilter),
    [chipFilter],
  );

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", settings.theme || "rose-pine");
    root.setAttribute("data-density", settings.density || "comfortable");
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => root.classList.remove("theme-switching")),
    );
    return () => cancelAnimationFrame(frame);
  }, [settings.theme, settings.density]);

  const shikiConfig = useMemo(
    () =>
      SHIKI_THEME_MAP[settings.theme || "rose-pine"] ||
      SHIKI_THEME_MAP["rose-pine"],
    [settings.theme],
  );
  const diffLanguages = useMemo(
    () =>
      Array.from(
        new Set(
          files
            .flatMap((file) => [
              getFiletypeFromFileName(file.name),
              file.prevName ? getFiletypeFromFileName(file.prevName) : null,
            ])
            .filter(
              (lang): lang is Exclude<typeof lang, null> =>
                lang != null && lang !== "text",
            ),
        ),
      ),
    [files],
  );
  useEffect(() => {
    if (!poolManager) return;
    poolManager
      .setRenderOptions({
        theme: {
          dark:
            shikiConfig.type === "dark" ? shikiConfig.themeName : "rose-pine",
          light:
            shikiConfig.type === "light"
              ? shikiConfig.themeName
              : "github-light",
        },
      })
      .catch(() => {});
  }, [poolManager, shikiConfig]);
  useEffect(() => {
    const dark =
      shikiConfig.type === "dark" ? shikiConfig.themeName : "rose-pine";
    const light =
      shikiConfig.type === "light" ? shikiConfig.themeName : "github-light";
    preloadHighlighter({
      themes: Array.from(new Set([dark, light])),
      langs: diffLanguages,
    }).catch(() => {});
  }, [shikiConfig, diffLanguages]);

  useEffect(() => {
    if (!session) return;
    document.title = `${session.owner}/${session.repo}#${session.pullNumber} · diffing`;
    return () => {
      document.title = "diffing";
    };
  }, [session]);

  const navigateFile = useCallback(
    (direction: "next" | "prev") => {
      if (filteredFiles.length === 0) return;
      const currentIndex = activeFile
        ? filteredFiles.findIndex((file) => file.name === activeFile)
        : -1;
      const nextIndex =
        direction === "next"
          ? Math.min(currentIndex + 1, filteredFiles.length - 1)
          : Math.max(currentIndex - 1, 0);
      const next = filteredFiles[Math.max(0, nextIndex)];
      if (next) handleFileClick(next.name);
    },
    [activeFile, filteredFiles, handleFileClick],
  );

  const toggleActiveViewed = useCallback(() => {
    if (!activeFile) return;
    handleViewedChange(activeFile, !viewedFiles.has(activeFile));
  }, [activeFile, handleViewedChange, viewedFiles]);

  const {
    setSnapshot: setSearchSnapshot,
    nextHit,
    prevHit,
    statusMessage: searchStatusMessage,
  } = useSearchSession(searchNavContext, handleFileClick);

  const openPalette = useCallback((scope: Scope) => {
    // Match TUI: shortcut opens start changed-only (`/` → All, `f`/`gs` scoped).
    setPalette({ open: true, scope, changedOnly: true });
  }, []);

  const togglePalette = useCallback(() => {
    setPalette((value) =>
      value.open
        ? { ...value, open: false }
        : { open: true, scope: "all", changedOnly: lastChangedOnlyRef.current },
    );
  }, []);

  const handleChangedOnlyPreference = useCallback((changedOnly: boolean) => {
    lastChangedOnlyRef.current = changedOnly;
    setPalette((value) => ({ ...value, changedOnly }));
  }, []);

  const keymapActions = useMemo(
    () => ({
      onNavigateFile: navigateFile,
      onToggleViewed: toggleActiveViewed,
      onToggleDiffStyle: () =>
        updateSettings({
          diffStyle: settings.diffStyle === "split" ? "unified" : "split",
        }),
      onCycleTabSize: () => {
        const sizes = [2, 4, 8];
        updateSettings({
          defaultTabSize:
            sizes[(sizes.indexOf(settings.defaultTabSize) + 1) % sizes.length],
        });
      },
      onToggleSidebar: () => setSidebarCollapsed((value) => !value),
      onToggleLineWrap: () => updateSettings({ lineWrap: !settings.lineWrap }),
      onToggleLineNumbers: () =>
        updateSettings({ showLineNumbers: !settings.showLineNumbers }),
      onCycleDiffIndicators: () => {
        const order: Settings["diffIndicators"][] = ["classic", "bars", "none"];
        updateSettings({
          diffIndicators:
            order[(order.indexOf(settings.diffIndicators) + 1) % order.length],
        });
      },
      onCycleLineDiffType: () => {
        const order: Settings["lineDiffType"][] = [
          "word",
          "word-alt",
          "char",
          "none",
        ];
        updateSettings({
          lineDiffType:
            order[(order.indexOf(settings.lineDiffType) + 1) % order.length],
        });
      },
      onOpenPalette: openPalette,
      onTogglePalette: togglePalette,
      onOpenFileSearch: activeFile
        ? () => fileSearch.open(activeFile)
        : undefined,
      // Escape while a find-in-file bar is open closes ONLY the search — even
      // when the bar's input is not focused — never anything else.
      onCloseFileSearch: fileSearch.filePath ? fileSearch.close : undefined,
      onNextSearchHit: nextHit,
      onPrevSearchHit: prevHit,
      onOpenTheme: () => setThemeModalOpen(true),
      onOpenShortcuts: () => setShortcutsHelpOpen(true),
    }),
    [
      navigateFile,
      settings.defaultTabSize,
      settings.diffIndicators,
      settings.diffStyle,
      settings.lineDiffType,
      settings.lineWrap,
      settings.showLineNumbers,
      toggleActiveViewed,
      updateSettings,
      openPalette,
      togglePalette,
      activeFile,
      fileSearch,
      fileSearch.filePath,
      nextHit,
      prevHit,
    ],
  );
  useDiffReviewKeymaps(keymapActions);

  if (sessionLoaded && !session) {
    return (
      <div className="pr-app-empty">
        <GitPullRequest size={32} />
        <h2>No active PR session</h2>
        <p>
          Start one with <code>diffing &quot;gh pr 1234&quot;</code> or{" "}
          <code>diffing --gh-pr 1234</code> from inside the repo.
        </p>
        <button className="btn btn-sm" onClick={() => navigate("/")}>
          Back to local review
        </button>
      </div>
    );
  }
  if (!session)
    return (
      <div className="pr-app-empty">
        <span>Loading PR session…</span>
      </div>
    );

  const update = (patch: Partial<Settings>) =>
    startTransition(() => updateSettings(patch));
  const settingsProps = {
    diffStyle: settings.diffStyle,
    defaultTabSize: settings.defaultTabSize,
    lineDiffType: settings.lineDiffType,
    lineWrap: settings.lineWrap,
    diffIndicators: settings.diffIndicators,
    showLineNumbers: settings.showLineNumbers,
    hunkSeparators: settings.hunkSeparators,
    lineHoverHighlight: settings.lineHoverHighlight,
    fontSize: settings.fontSize,
    haptics: settings.haptics,
    sounds: settings.sounds,
    uiFont: settings.uiFont,
    monoFont: settings.monoFont,
    density: settings.density,
    autoCollapseLineThreshold: settings.autoCollapseLineThreshold,
    showStatusBar: settings.showStatusBar,
    // PR reviews are read-only: editing is a local working-tree feature.
    editDiagnostics: false,
    onEditDiagnosticsChange: () => {},
    // A language server answers about the working tree, which a PR's new side
    // is not. The toggle stays visible but says why it cannot be switched on.
    codeIntel: false,
    codeIntelUnavailable: "pull-request",
    onCodeIntelChange: () => {},
    onDiffStyleChange: (value: "split" | "unified") =>
      update({ diffStyle: value }),
    onDefaultTabSizeChange: (value: number) =>
      update({ defaultTabSize: value }),
    onOpenThemeModal: () => setThemeModalOpen(true),
    onLineDiffTypeChange: (value: Settings["lineDiffType"]) =>
      update({ lineDiffType: value }),
    onLineWrapChange: (value: boolean) => update({ lineWrap: value }),
    onDiffIndicatorsChange: (value: Settings["diffIndicators"]) =>
      update({ diffIndicators: value }),
    onShowLineNumbersChange: (value: boolean) =>
      update({ showLineNumbers: value }),
    onHunkSeparatorsChange: (value: Settings["hunkSeparators"]) =>
      update({ hunkSeparators: value }),
    onLineHoverHighlightChange: (value: Settings["lineHoverHighlight"]) =>
      update({ lineHoverHighlight: value }),
    onFontSizeChange: (value: number) => update({ fontSize: value }),
    onHapticsChange: (value: boolean) => update({ haptics: value }),
    onSoundsChange: (value: boolean) => update({ sounds: value }),
    onDensityChange: (value: Settings["density"]) => update({ density: value }),
    onAutoCollapseLineThresholdChange: (value: number) =>
      update({ autoCollapseLineThreshold: value }),
    onShowStatusBarChange: (value: boolean) => update({ showStatusBar: value }),
    onOpenUiFontModal: () => setUiFontModalOpen(true),
    onOpenMonoFontModal: () => setMonoFontModalOpen(true),
    showSource: false,
    showWhitespace: false,
    showExternalTools: false,
    showSendPolicy: false,
  };

  return (
    <HapticsProvider enabled={settings.haptics} soundsEnabled={settings.sounds}>
      <div
        ref={appRef}
        className={`app pr-app ${aiRailOpen ? "app-ai-open" : ""}`}
        data-pr-mode="true"
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--comment-panel-height": `${commentPanelHeight}px`,
          } as React.CSSProperties
        }
      >
        <a href="#pr-diff-main" className="skip-to-main">
          Skip to diff
        </a>
        <div
          className="sidebar-resize-guide"
          ref={sidebarGuideRef}
          aria-hidden="true"
        />
        <PrReviewToolbar
          // SAFETY: GET /api/gh/session returns the UI subset of PrSession; toolbar only reads those fields.
          session={session as unknown as PrSession}
          comments={comments}
          settingsProps={settingsProps}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          onOpenSearch={() =>
            setPalette({ open: true, scope: "all", changedOnly: true })
          }
          onRefresh={() => refreshPr.mutate()}
          refreshing={refreshPr.isPending}
          onEditComment={(id, body) => updateComment({ id, body })}
          onDeleteComment={removeComment}
          onSubmitted={setSubmissionToast}
          onOpenAiAssistant={() => setAiRailOpen(true)}
        />

        {!sidebarCollapsed && (
          <div
            className="sidebar-mobile-backdrop"
            onClick={() => setSidebarCollapsed(true)}
            aria-hidden="true"
          />
        )}
        <div className="app-body">
          <aside
            ref={sidebarRef}
            className={`sidebar ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
          >
            <div className="pr-sidebar-tree">
              <FileTree
                files={files}
                activeFile={activeFile}
                commentCounts={commentCounts}
                viewedFiles={viewedFiles}
                untrackedFiles={emptyUntracked}
                onFileClick={handleFileClick}
                collapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed((value) => !value)}
                appliedExtensions={appliedExtensions}
                onApplyExtensions={(extensions) =>
                  setAppliedExtensions(normalizeExtensions(extensions))
                }
                chipFilter={chipFilter}
                onChipFilterChange={setChipFilter}
              />
            </div>
            {!sidebarCollapsed && comments.length > 0 && (
              <>
                <div
                  className="ct-resize-handle"
                  onMouseDown={handleCommentResizeStart}
                  role="separator"
                  aria-label="Resize comments panel"
                  aria-orientation="horizontal"
                  tabIndex={0}
                />
                <div className="ct-wrapper pr-ct-wrapper">
                  <CommentTracker
                    comments={comments}
                    resolveComment={resolveComment}
                    unresolveComment={unresolveComment}
                    removeComment={removeComment}
                    addReply={async (id, body) => {
                      await addReply({ id, body });
                    }}
                    editComment={editComment}
                  />
                </div>
              </>
            )}
          </aside>
          {!sidebarCollapsed && (
            <div
              className="sidebar-resize-handle"
              onMouseDown={handleSidebarResizeStart}
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              tabIndex={0}
            />
          )}

          <main className="main pr-main" id="pr-diff-main" tabIndex={-1}>
            <PrReviewSummaryBanner
              // SAFETY: GET /api/gh/session returns the UI subset of PrSession; banner only reads those fields.
              session={session as unknown as PrSession}
              draftCount={comments.length}
              onAuthorChanged={() => {
                void queryClient.invalidateQueries({
                  queryKey: ["pr-session"],
                });
              }}
            />
            <PrReviewActivity
              reviews={session.existingReviews ?? []}
              onSubmitPending={async (reviewId, event) => {
                const res = await fetch(`/api/gh/reviews/${reviewId}/submit`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ event }),
                });
                const data = (await res.json()) as { error?: string };
                if (!res.ok)
                  throw new Error(data.error || `HTTP ${res.status}`);
                queryClient.invalidateQueries({ queryKey: ["pr-session"] });
              }}
              onDiscardPending={async (reviewId) => {
                const res = await fetch(`/api/gh/reviews/${reviewId}`, {
                  method: "DELETE",
                });
                const data = (await res.json()) as { error?: string };
                if (!res.ok)
                  throw new Error(data.error || `HTTP ${res.status}`);
                queryClient.invalidateQueries({ queryKey: ["pr-session"] });
              }}
            />
            <PrConversationTimeline
              items={timelinePage}
              total={timelineItems.length}
              cursor={timelineCursor}
              onPage={setTimelineCursor}
            />
            <PrConversationInbox comments={inboxComments} />
            {(session.existingComments?.length ?? 0) > 0 && (
              <div className="pr-existing-summary">
                <MessageCircle size={13} />
                <span>
                  {session.existingComments.length} existing GitHub conversation
                  {session.existingComments.length === 1 ? "" : "s"} included in
                  this review.
                </span>
              </div>
            )}
            {(error || sessionError) && (
              <div className="pr-error">
                <AlertCircle size={14} /> Failed to load the PR:{" "}
                {error || sessionError?.message}
              </div>
            )}
            {loading && !patch ? (
              <div className="pr-app-loading">Loading PR diff…</div>
            ) : filteredFiles.length === 0 ? (
              <div className="empty-state" role="status">
                <div className="empty-state-icon">
                  <GitCompare size={24} />
                </div>
                <p className="empty-state-title">No matching files</p>
                <p className="empty-state-hint">
                  Clear the file-tree filters to see the full pull request.
                </p>
              </div>
            ) : (
              <PrDiffSurface
                commentActions={{ addReply: (id, body) => addReply({ id, body }), resolveComment, unresolveComment, editComment }}
                files={filteredFiles}
                fileAnnotations={fileAnnotations}
                existingCommentsByFile={existingCommentsByFile}
                viewedFiles={viewedFiles}
                settings={settings}
                monoFontFamily={monoFontFamily}
                fileSearch={fileSearch}
                onOpenFileSearch={openFileSearch}
                onAddComment={(params) => addComment(params)}
                onDeleteComment={removeComment}
                onViewedChange={handleViewedChange}
                onReplyExisting={replyToExisting}
                onEditExisting={(id, body) =>
                  mutateExistingComment("PATCH", id, body)
                }
                onDeleteExisting={(id) => mutateExistingComment("DELETE", id)}
                onSetExistingResolved={setExistingThreadResolved}
                onApplyExisting={applyExistingSuggestion}
                expectedHeadSha={session.headSha}
              />
            )}
          </main>
        </div>

        <AiAssistantRail
          open={aiRailOpen}
          onClose={() => setAiRailOpen(false)}
          surface="pr-diff"
          title="Ask about this pull request"
          context={diffReviewContextForAi(patch, {
            repoName: session.repo,
            branch: `${session.headRefName} → ${session.baseRefName}`,
            focusedFilePath: activeFile,
          })}
        />

        <SearchPalette
          isOpen={palette.open}
          onClose={() => setPalette((value) => ({ ...value, open: false }))}
          initialScope={palette.scope}
          initialChangedOnly={palette.changedOnly}
          onChangedOnlyPreference={handleChangedOnlyPreference}
          onSessionSnapshot={setSearchSnapshot}
          files={filteredFiles}
          changedEntries={diffSearchEntries}
          customMode
          staged={false}
          onNavigateFile={handleFileClick}
          theme={settings.theme || "rose-pine"}
          fontSize={settings.fontSize}
          monoFontFamily={monoFontFamily}
          defaultTabSize={settings.defaultTabSize}
          lineWrap={settings.lineWrap}
          showLineNumbers={settings.showLineNumbers}
          lineHoverHighlight={settings.lineHoverHighlight}
        />
        <VimStatusBar
          activeFile={activeFile}
          onShowHelp={() => setShortcutsHelpOpen(true)}
          visible={settings.showStatusBar}
          statusMessage={searchStatusMessage}
          placeholder="No active PR file (J/K to jump)"
        />
        <ShortcutsHelpModal
          isOpen={shortcutsHelpOpen}
          onClose={() => setShortcutsHelpOpen(false)}
          mode="pr"
        />
        <ThemeModal
          open={themeModalOpen}
          activeTheme={settings.theme || "rose-pine"}
          onThemeChange={(theme) => update({ theme })}
          onClose={() => setThemeModalOpen(false)}
        />
        <FontPickerModal
          open={uiFontModalOpen}
          title="Select UI Font"
          defaultLabel="Default (Geist Mono, from CDN)"
          activeFont={settings.uiFont}
          onFontChange={(uiFont) => update({ uiFont })}
          onClose={() => setUiFontModalOpen(false)}
        />
        <FontPickerModal
          open={monoFontModalOpen}
          title="Select Code Font"
          defaultLabel="Default (JetBrains Mono, from CDN)"
          activeFont={settings.monoFont}
          onFontChange={(monoFont) => update({ monoFont })}
          onClose={() => setMonoFontModalOpen(false)}
        />
        {submissionToast && (
          <PrSubmittedToast
            result={submissionToast}
            onDismiss={() => setSubmissionToast(null)}
          />
        )}
      </div>
    </HapticsProvider>
  );
}

function PrDiffSurface({
  commentActions,
  files,
  fileAnnotations,
  existingCommentsByFile,
  viewedFiles,
  settings,
  monoFontFamily,
  fileSearch,
  onOpenFileSearch,
  onAddComment,
  onDeleteComment,
  onViewedChange,
  onReplyExisting,
  onEditExisting,
  onDeleteExisting,
  onSetExistingResolved,
  onApplyExisting,
  expectedHeadSha,
}: {
  commentActions: CommentActions;
  files: FileDiffMetadata[];
  fileAnnotations: Map<
    string,
    Array<{
      side: ReviewComment["side"];
      lineNumber: number;
      metadata: ReviewComment;
    }>
  >;
  existingCommentsByFile: Map<string, PrExistingComment[]>;
  viewedFiles: Set<string>;
  settings: Settings;
  monoFontFamily: string;
  fileSearch: ReturnType<typeof useFileSearch>;
  onOpenFileSearch: (filePath: string) => void;
  onAddComment: (params: {
    filePath: string;
    side: ReviewComment["side"];
    lineNumber: number;
    startLineNumber?: number;
    lineContent: string;
    body: string;
  }) => void;
  onDeleteComment: (id: string) => void;
  onViewedChange: (filePath: string, viewed: boolean) => void;
  onReplyExisting: (commentId: number, body: string) => Promise<void>;
  onEditExisting: (commentId: number, body: string) => Promise<void>;
  onDeleteExisting: (commentId: number) => Promise<void>;
  onSetExistingResolved: (threadId: string, resolved: boolean) => Promise<void>;
  onApplyExisting: (commentId: number) => Promise<void>;
  expectedHeadSha?: string;
}) {
  return (
    <div className="pr-diff-surface">
      <CommentActionsProvider actions={commentActions}>
      <DiffViewer
        files={files}
        diffStyle={settings.diffStyle}
        tabSizeMap={{}}
        defaultTabSize={settings.defaultTabSize}
        viewedFiles={viewedFiles}
        binaryFiles={new Map()}
        theme={settings.theme || "rose-pine"}
        lineDiffType={settings.lineDiffType}
        lineWrap={settings.lineWrap}
        diffIndicators={settings.diffIndicators}
        showLineNumbers={settings.showLineNumbers}
        hunkSeparators={settings.hunkSeparators}
        lineHoverHighlight={settings.lineHoverHighlight}
        fontSize={settings.fontSize}
        monoFontFamily={monoFontFamily}
        expandContextByDefault={settings.expandContextByDefault}
        collapsedContextThreshold={settings.collapsedContextThreshold}
        expansionLineCount={settings.expansionLineCount}
        autoCollapseLineThreshold={settings.autoCollapseLineThreshold}
        onViewedChange={onViewedChange}
        fileAnnotationsMap={fileAnnotations}
        existingCommentsMap={existingCommentsByFile}
        onAddComment={(
          filePath,
          side,
          lineNumber,
          lineContent,
          body,
          startLineNumber,
        ) =>
          onAddComment({
            filePath,
            side,
            lineNumber,
            lineContent,
            body,
            startLineNumber,
          })
        }
        onDeleteComment={onDeleteComment}
        onReplyExisting={onReplyExisting}
        onEditExisting={onEditExisting}
        onDeleteExisting={onDeleteExisting}
        onSetExistingResolved={onSetExistingResolved}
        onApplyExisting={onApplyExisting}
        expectedHeadSha={expectedHeadSha}
        allowLocalActions={false}
        fileSearch={fileSearch}
        onOpenFileSearch={onOpenFileSearch}
      />
      </CommentActionsProvider>
    </div>
  );
}
