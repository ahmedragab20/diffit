import {
	useState,
	useMemo,
	useCallback,
	useRef,
	useEffect,
	useTransition,
} from "react";
import { parsePatchFiles, preloadHighlighter } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { EditProvider, useWorkerPool } from "@pierre/diffs/react";
import { useEditSessions } from "./hooks/useEditSessions";
import type {
	LineDiffType,
	DiffIndicators,
	HunkSeparatorStyle,
	LineHoverHighlight,
} from "./hooks/useSettings";
import { useDiffReviewKeymaps } from "./hooks/useDiffReviewKeymaps";
import { useSearchSession } from "./hooks/useSearchSession";
import { buildChangedLineKeys, buildDiffFileSet } from "./lib/diffIndex";
import { countDiffChanges } from "./lib/diffStats";
import { SHIKI_THEME_MAP } from "./utils";
import type { ReviewComment } from "../lib/types";
import { useDiff } from "./hooks/useDiff";
import { useComments } from "./hooks/useComments";
import { usePlans } from "./hooks/usePlans";
import { navigate } from "./router";
import { useMergeStatus } from "./hooks/useMergeStatus";
import { useSettings, resolveMonoFont } from "./hooks/useSettings";
import { useApplyFonts } from "./hooks/useApplyFonts";
import { useViewed } from "./hooks/useViewed";
import { useScrollToNextFile } from "./hooks/useScrollToNextFile";
import { useViewportActiveFileTracking } from "./hooks/useViewportActiveFile";
import { HapticsProvider, fireFeedback } from "./hooks/useHaptics";
import {
	parseExtensionFilter,
	matchesExtensionFilter,
	normalizeExtensions,
} from "./lib/extensionFilter";
import { getUiStateItem, setUiStateItem } from "./utils/uiState";
import { DIFF_UI, readZenMode } from "./lib/diffUiState";
import { useDiffSearch } from "./hooks/useDiffSearch";
import { buildFileSearchCorpus } from "./hooks/useDiffSearch";
import { useFileSearch } from "./hooks/useFileSearch";
import { Toolbar } from "./components/Toolbar";
import { ZenBar } from "./components/ZenBar";
import { SendReviewModal } from "./components/SendReviewModal";
import { DiffOverviewBanner } from "./components/DiffOverviewBanner";
import { DiffViewer, sortFilesByName } from "./components/DiffViewer";
import { MergeConflictResolver } from "./components/MergeConflictResolver";
import { FileTree, type FileTreeChipFilter } from "./components/FileTree";
import { CommentTracker } from "./components/CommentTracker";
import { SearchPalette } from "./components/SearchPalette";
import type { Scope } from "./lib/searchTypes";
import { VimStatusBar } from "./components/VimStatusBar";
import { ShortcutsHelpModal } from "./components/ShortcutsHelpModal";
import { AgentActivityToast } from "./components/AgentActivityToast";
import { ThemeModal } from "./components/ThemeModal";
import { FontPickerModal } from "./components/FontPickerModal";
import { AlertTriangle, X } from "lucide-react";
import {
	fileContentFromPatch,
	markOutdatedComments,
} from "../lib/comment-outdated";
import { parsePermalink } from "./lib/permalink";
import { scrollToLine } from "./utils";
import { CommitWalkBar, stepCommitWalk } from "./components/CommitWalkBar";
import { ConfirmDialog } from "./primitives/ConfirmDialog";
import { AgentProgressToast } from "./components/AgentProgressToast";
import { useSinceLastRound } from "./hooks/useSinceLastRound";
import { AiAssistantRail } from "./ai/AiAssistantRail";
import { diffReviewContextForAi } from "./ai/diffContext";
import type { AiDiffSelection } from "../lib/ai/types";

export function App() {
	const poolManager = useWorkerPool();
	const { settings, loaded, updateSettings } = useSettings();
	const [, startTransition] = useTransition();
	const {
		patch,
		repoName,
		branch,
		customMode,
		showMode,
		commits,
		binaryFiles,
		tabSizeMap,
		untrackedFiles,
		overview,
		loading,
		refreshing,
		error,
	} = useDiff(
		{
			staged: settings.staged,
			untracked: settings.untracked,
		},
		true,
	);
	const {
		comments: rawComments,
		addComment,
		removeComment,
		resolveComment,
		unresolveComment,
		addReply,
		editComment,
		editReply,
		removeReply,
		copyAllComments,
		copyAllCommentsMarkdown,
		agentActivity,
		clearAgentActivity,
		sendToAgent,
		sending,
		agentWaiting,
		waitingAgents,
		resolveAllOpen,
		lastSend,
	} = useComments();

	// In-place edit sessions (working-tree reviews only). The EditProvider
	// factory stays stable across renders; the editor module is lazy-loaded
	// on the first enterEdit.
	const {
		sessions: editSessions,
		dirtyCount: editDirtyCount,
		enterEdit,
		handleEditChange,
		handleEditAttach,
		saveEdit,
		saveAllDirty,
		discardEdit,
		exitEdit,
		createEditor,
	} = useEditSessions({
		diagnosticsEnabled: settings.editDiagnostics === true,
	});

	// Scope gate: in-place edits mutate the working tree, so they are only
	// offered when the review IS the working tree (no revision range, no
	// commit walk, no staged-only view). PR mode is covered by customMode.
	const canEditScope = !customMode && !showMode && !settings.staged;

	const [editConfirm, setEditConfirm] = useState<{
		kind: "exit" | "discard";
		path: string;
	} | null>(null);
	const [editNotice, setEditNotice] = useState<string | null>(null);
	useEffect(() => {
		if (!editNotice) return;
		const id = setTimeout(() => setEditNotice(null), 6000);
		return () => clearTimeout(id);
	}, [editNotice]);

	const handleEditExit = useCallback(
		(path: string) => {
			const session = editSessions.get(path);
			if (session?.dirty) {
				setEditConfirm({ kind: "exit", path });
			} else {
				exitEdit(path);
			}
		},
		[editSessions, exitEdit],
	);

	const handleEditDiscard = useCallback(
		(path: string) => {
			const session = editSessions.get(path);
			if (session?.dirty) {
				setEditConfirm({ kind: "discard", path });
			} else {
				discardEdit(path);
			}
		},
		[editSessions, discardEdit],
	);

	const confirmEditAction = useCallback(() => {
		if (!editConfirm) return;
		if (editConfirm.kind === "exit") exitEdit(editConfirm.path);
		else discardEdit(editConfirm.path);
		setEditConfirm(null);
	}, [editConfirm, exitEdit, discardEdit]);

	const toggleEditForFile = useCallback(
		(path: string) => {
			if (editSessions.has(path)) {
				handleEditExit(path);
			} else {
				enterEdit(path).catch((err: Error) => {
					// Keymap path has no card to show the error; surface it
					// as a transient notice instead of failing silently.
					console.error("Failed to enter edit mode:", err);
					setEditNotice(`Failed to enter edit mode: ${err.message}`);
				});
			}
		},
		[editSessions, handleEditExit, enterEdit],
	);

	// Never lose unsaved edits to a tab close or reload.
	useEffect(() => {
		if (editDirtyCount === 0) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [editDirtyCount]);

	// Badge-only outdated detection: if the comment's line snapshot is no longer
	// present in the live file content reconstructed from the patch, flag it.
	// No auto-remap. Per-file haystacks are built from the unified patch by
	// stripping diff markers (added/context kept, removed dropped) — feeding the
	// raw patch left `+`/`-` prefixes on every line, which false-positived any
	// multi-line comment as outdated the moment it was created.
	const comments = useMemo(() => {
		if (!patch) return rawComments;
		const map = new Map<string, string>();
		for (const c of rawComments) {
			if (map.has(c.filePath)) continue;
			const content = fileContentFromPatch(patch, c.filePath);
			if (content !== undefined) map.set(c.filePath, content);
		}
		return markOutdatedComments(rawComments, map);
	}, [rawComments, patch]);
	const { plans } = usePlans();
	const pendingPlanCount = useMemo(
		() => plans.filter((p) => p.decision === "pending").length,
		[plans],
	);
	const { status: mergeStatus, refresh: refreshMergeStatus } =
		useMergeStatus(patch);
	const [activeFile, setActiveFile] = useState<string | null>(null);
	const [aiRailOpen, setAiRailOpen] = useState(false);
	const [aiSelections, setAiSelections] = useState<AiDiffSelection[]>([]);
	/**
	 * Timestamp of the last *explicit* active-file selection (click, J/K,
	 * deep link) plus the programmatic smooth scrolls they trigger. Fed to
	 * `useViewportActiveFileTracking` so scroll-derived detection cannot
	 * flicker the active file mid-animation.
	 */
	const explicitActiveFileRef = useRef(0);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
		try {
			const stored = getUiStateItem("diffing-sidebar-collapsed");
			if (stored != null) return stored === "true";
		} catch {
			/* ignore persist / parse errors */
		}
		return typeof window !== "undefined" && window.innerWidth <= 768;
	});
	const [sidebarWidth, setSidebarWidth] = useState(() => {
		try {
			const stored = getUiStateItem("diffing-sidebar-width");
			return stored ? Number(stored) : 320;
		} catch {
			return 320;
		}
	});
	/** Zen mode: diffs only — no sidebar, no full toolbar, just the ZenBar. */
	const [zenMode, setZenMode] = useState(() => readZenMode());
	useEffect(() => {
		try {
			setUiStateItem(DIFF_UI.zenMode, String(zenMode));
		} catch {
			/* ignore persist / parse errors */
		}
	}, [zenMode]);
	/** Applied multi-select extensions (normalized). Empty = show all. */
	const [appliedExtensions, setAppliedExtensions] = useState<string[]>(() => {
		try {
			return parseExtensionFilter(
				getUiStateItem("diffing-extension-filter") ?? "",
			);
		} catch {
			return [];
		}
	});
	useEffect(() => {
		// Persist as "vue,js,ts" (no leading dots) for back-compat with parseExtensionFilter.
		setUiStateItem("diffing-extension-filter", appliedExtensions.join(","));
	}, [appliedExtensions]);
	const [chipFilter, setChipFilter] = useState<FileTreeChipFilter>(() => {
		try {
			const stored = getUiStateItem("diffing-chip-filter");
			if (
				stored === "unviewed" ||
				stored === "has-comments" ||
				stored === "all" ||
				stored === "since-last"
			) {
				return stored;
			}
		} catch {
			/* ignore persist / parse errors */
		}
		return "all";
	});
	useEffect(() => {
		setUiStateItem("diffing-chip-filter", chipFilter);
	}, [chipFilter]);
	const { reviewSet: sinceLastFiles, hasBaseline: sinceLastAvailable } =
		useSinceLastRound(true);
	// Drop "Since last" filter when no baseline exists yet.
	useEffect(() => {
		if (!sinceLastAvailable && chipFilter === "since-last") {
			setChipFilter("all");
		}
	}, [sinceLastAvailable, chipFilter]);
	/** null = all commits in show mode; number = focus one commit's patch */
	const [commitWalkIndex, setCommitWalkIndex] = useState<number | null>(null);
	useEffect(() => {
		// Reset walk when the commit list changes (new show range).
		setCommitWalkIndex(null);
	}, [commits]);
	const sidebarWidthRef = useRef(sidebarWidth);
	sidebarWidthRef.current = sidebarWidth;
	const appRef = useRef<HTMLDivElement>(null);
	const sidebarRef = useRef<HTMLElement>(null);
	const sidebarGuideRef = useRef<HTMLDivElement>(null);

	const SIDEBAR_MIN_WIDTH = 240;
	const SIDEBAR_MAX_WIDTH = 640;

	// Resizing the sidebar live is not viable: every width change relayouts the
	// diff content in <main> (the @pierre/diffs shadow DOM re-wraps every line),
	// which measures at ~80-180ms per frame on a real diff — far too slow for a
	// smooth 60fps drag. So instead of resizing the panel on each mousemove, we
	// drag a lightweight guide line that tracks the cursor via a compositor-only
	// `transform` (zero layout), and commit the real width exactly once on
	// mouseup. The drag feels perfectly snappy and the expensive reflow happens
	// a single time, on release.
	const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = sidebarWidthRef.current;
		const sidebarEl = sidebarRef.current;
		const guideEl = sidebarGuideRef.current;
		// The sidebar's left edge is fixed for the duration of the drag, so the
		// guide's screen position is simply that edge plus the prospective width.
		const sidebarLeft = sidebarEl ? sidebarEl.getBoundingClientRect().left : 0;
		let latestWidth = startWidth;
		let rafId = 0;

		const flush = () => {
			rafId = 0;
			if (guideEl)
				guideEl.style.transform = `translateX(${sidebarLeft + latestWidth}px)`;
		};

		if (guideEl) {
			guideEl.style.transform = `translateX(${sidebarLeft + startWidth}px)`;
			guideEl.classList.add("sidebar-resize-guide-active");
		}

		const handleMove = (ev: MouseEvent) => {
			const delta = ev.clientX - startX;
			latestWidth = Math.max(
				SIDEBAR_MIN_WIDTH,
				Math.min(SIDEBAR_MAX_WIDTH, startWidth + delta),
			);
			if (!rafId) rafId = requestAnimationFrame(flush);
		};

		const handleUp = () => {
			if (rafId) cancelAnimationFrame(rafId);
			if (guideEl) guideEl.classList.remove("sidebar-resize-guide-active");
			// Single, one-time width commit -> one reflow of the diff.
			setSidebarWidth(latestWidth);
			try {
				setUiStateItem("diffing-sidebar-width", String(latestWidth));
			} catch {
				/* ignore persist / parse errors */
			}
			document.removeEventListener("mousemove", handleMove);
			document.removeEventListener("mouseup", handleUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		document.addEventListener("mousemove", handleMove);
		document.addEventListener("mouseup", handleUp);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
	}, []);

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
	const openPalette = useCallback((scope: Scope) => {
		// Match TUI: shortcut opens start changed-only (`/` → All, `f`/`gs` scoped).
		setPalette({ open: true, scope, changedOnly: true });
	}, []);
	const togglePalette = useCallback(() => {
		setPalette((p) =>
			p.open
				? { ...p, open: false }
				: { open: true, scope: "all", changedOnly: lastChangedOnlyRef.current },
		);
	}, []);
	const closePalette = useCallback(
		() => setPalette((p) => ({ ...p, open: false })),
		[],
	);
	const handleChangedOnlyPreference = useCallback((changedOnly: boolean) => {
		lastChangedOnlyRef.current = changedOnly;
		setPalette((p) => ({ ...p, changedOnly }));
	}, []);
	const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
	const [themeModalOpen, setThemeModalOpen] = useState(false);
	const [uiFontModalOpen, setUiFontModalOpen] = useState(false);
	const [monoFontModalOpen, setMonoFontModalOpen] = useState(false);
	/** Send-review surface open state: the toolbar popover (⌘Enter outside zen)
	 *  or the centered dialog (⌘Enter in zen, where the toolbar is hidden). */
	const [sendOpen, setSendOpen] = useState(false);

	/** Any overlay that must swallow Esc / ⌘Enter before the global keymap. */
	const overlayOpen =
		palette.open ||
		shortcutsHelpOpen ||
		themeModalOpen ||
		uiFontModalOpen ||
		monoFontModalOpen ||
		editConfirm !== null ||
		sendOpen;

	const [commentPanelHeight, setCommentPanelHeight] = useState(() => {
		try {
			const stored = getUiStateItem("diffing-comment-panel-height");
			return stored ? Number(stored) : 220;
		} catch {
			return 220;
		}
	});
	const commentPanelHeightRef = useRef(commentPanelHeight);
	commentPanelHeightRef.current = commentPanelHeight;

	const handleResizeStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		const startY = e.clientY;
		const startHeight = commentPanelHeightRef.current;
		const appEl = appRef.current;
		let latestHeight = startHeight;
		let rafId = 0;

		const flush = () => {
			rafId = 0;
			appEl?.style.setProperty("--comment-panel-height", `${latestHeight}px`);
		};

		const handleMove = (ev: MouseEvent) => {
			const delta = startY - ev.clientY;
			latestHeight = Math.max(100, Math.min(600, startHeight + delta));
			if (!rafId) rafId = requestAnimationFrame(flush);
		};

		const handleUp = () => {
			if (rafId) cancelAnimationFrame(rafId);
			setCommentPanelHeight(latestHeight);
			try {
				setUiStateItem("diffing-comment-panel-height", String(latestHeight));
			} catch {
				/* ignore persist / parse errors */
			}
			document.removeEventListener("mousemove", handleMove);
			document.removeEventListener("mouseup", handleUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		document.addEventListener("mousemove", handleMove);
		document.addEventListener("mouseup", handleUp);
		document.body.style.cursor = "row-resize";
		document.body.style.userSelect = "none";
	}, []);

	useEffect(() => {
		try {
			setUiStateItem("diffing-comment-panel-height", String(commentPanelHeight));
		} catch {
			/* ignore persist / parse errors */
		}
	}, [commentPanelHeight]);
	const { viewedFiles, setViewed } = useViewed();
	const diffViewerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		try {
			setUiStateItem("diffing-sidebar-collapsed", String(sidebarCollapsed));
		} catch {
			/* ignore persist / parse errors */
		}
	}, [sidebarCollapsed]);

	const untrackedSet = useMemo(() => new Set(untrackedFiles), [untrackedFiles]);

	const prevFilesRef = useRef<FileDiffMetadata[]>([]);

	const activePatch = useMemo(() => {
		if (showMode && commitWalkIndex != null && commits[commitWalkIndex]?.patch) {
			return commits[commitWalkIndex].patch;
		}
		return patch;
	}, [showMode, commitWalkIndex, commits, patch]);
	const aiReviewContext = useMemo(
		() => ({
			...diffReviewContextForAi(activePatch, {
				repoName,
				branch,
				focusedFilePath: activeFile,
			}),
			selections: aiSelections,
		}),
		[activePatch, activeFile, aiSelections, branch, repoName],
	);
	const addSelectionToAsk = useCallback((selection: AiDiffSelection) => {
		setAiSelections((current) => {
			const key = `${selection.filePath}:${selection.side}:${selection.startLine}:${selection.endLine}`;
			if (
				current.some(
					(item) =>
						`${item.filePath}:${item.side}:${item.startLine}:${item.endLine}` === key,
				)
			)
				return current;
			return [...current, selection].slice(-8);
		});
		setAiRailOpen(true);
	}, []);

	const files = useMemo(() => {
		if (!activePatch) return [];
		try {
			const parsed = parsePatchFiles(activePatch);
			const parsedFiles = parsed.flatMap((p) => p.files);

			// Add synthetic entries for binary files not already in parsed output
			const existingNames = new Set(parsedFiles.map((f) => f.name));
			for (const bf of binaryFiles) {
				if (!existingNames.has(bf.path)) {
					const syntheticFile: FileDiffMetadata = {
						name: bf.path,
						type:
							bf.type === "added" || bf.type === "untracked"
								? "new"
								: bf.type === "deleted"
									? "deleted"
									: "change",
						hunks: [],
						splitLineCount: 0,
						unifiedLineCount: 0,
						isPartial: true,
						deletionLines: [],
						additionLines: [],
					};
					parsedFiles.push(syntheticFile);
				}
			}

			// Defense-in-depth: drop duplicate `name` entries before they reach
			// either the diff list or the FileTree. The tree view runs its own
			// collision sanitizer, but stripping duplicates here keeps the
			// diff indices (prev/next navigation, comment lookups) consistent.
			const seenNames = new Set<string>();
			const dedupedParsedFiles = parsedFiles.filter((f) => {
				if (seenNames.has(f.name)) return false;
				seenNames.add(f.name);
				return true;
			});

			// Optimize rendering by keeping exact object references for unchanged files
			const cachedFiles = dedupedParsedFiles.map((newFile) => {
				const prevFile = prevFilesRef.current.find((f) => f.name === newFile.name);
				if (
					prevFile &&
					prevFile.type === newFile.type &&
					prevFile.isPartial === newFile.isPartial &&
					prevFile.deletionLines.length === newFile.deletionLines.length &&
					prevFile.additionLines.length === newFile.additionLines.length &&
					JSON.stringify(prevFile.hunks) === JSON.stringify(newFile.hunks)
				) {
					return prevFile;
				}
				return newFile;
			});

			prevFilesRef.current = cachedFiles;
			return cachedFiles;
		} catch {
			return [];
		}
	}, [activePatch, binaryFiles]);

	const commentCounts = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const c of comments) {
			counts[c.filePath] = (counts[c.filePath] ?? 0) + 1;
		}
		return counts;
	}, [comments]);

	// Full sorted list (no extension/chip filter) — FileTree needs every path so
	// the multi-select can list all available extensions even when a filter is on.
	const allSortedFiles = useMemo(
		() => [...files].sort(sortFilesByName),
		[files],
	);

	const filteredFiles = useMemo(() => {
		let list = files;
		if (appliedExtensions.length > 0) {
			list = list.filter((f) => matchesExtensionFilter(f.name, appliedExtensions));
		}
		if (chipFilter === "unviewed") {
			list = list.filter((f) => !viewedFiles.has(f.name));
		} else if (chipFilter === "has-comments") {
			list = list.filter((f) => (commentCounts[f.name] ?? 0) > 0);
		} else if (chipFilter === "since-last") {
			list = list.filter((f) => sinceLastFiles.has(f.name));
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

	const sortedFiles = useMemo(
		() => [...filteredFiles].sort(sortFilesByName),
		[filteredFiles],
	);

	// Keep the "active file" (⌘F target, tree highlight, status bar) in sync
	// with the file the user is actually looking at: the card under the mouse,
	// or the card with the most visible height in the viewport.
	useViewportActiveFileTracking(
		sortedFiles,
		activeFile,
		setActiveFile,
		explicitActiveFileRef,
	);

	// Deep links: ?file=&line=&side=&comment= — MUST sit after sortedFiles is
	// declared (TDZ). Run once files are available.
	const permalinkApplied = useRef(false);
	useEffect(() => {
		if (permalinkApplied.current || loading || sortedFiles.length === 0) return;
		if (typeof window === "undefined") return;
		const target = parsePermalink(window.location.search);
		if (!target.file && !target.comment) return;
		permalinkApplied.current = true;
		if (target.file) {
			explicitActiveFileRef.current = Date.now();
			setActiveFile(target.file);
			if (target.line != null) {
				requestAnimationFrame(() => {
					scrollToLine(target.file!, target.line!, target.side ?? "additions");
				});
			}
		}
		if (target.comment) {
			requestAnimationFrame(() => {
				document.getElementById(`comment-${target.comment}`)?.scrollIntoView({
					behavior: "smooth",
					block: "center",
				});
			});
		}
	}, [loading, sortedFiles.length]);

	const scrollToNextFile = useScrollToNextFile(sortedFiles);

	const diffSearchEntries = useDiffSearch(sortedFiles);

	// Find-in-file corpus: changed lines + unchanged context lines.
	const fileSearchCorpus = useMemo(
		() => buildFileSearchCorpus(sortedFiles),
		[sortedFiles],
	);
	const fileSearch = useFileSearch(fileSearchCorpus);
	const openFileSearch = useCallback(
		(path: string) => {
			fileSearch.open(path);
		},
		[fileSearch],
	);

	const searchNavContext = useMemo(
		() => ({
			diffFileSet: buildDiffFileSet(filteredFiles),
			changedKeys: buildChangedLineKeys(diffSearchEntries),
			customMode,
			staged: settings.staged,
		}),
		[filteredFiles, diffSearchEntries, customMode, settings.staged],
	);

	const diffStats = useMemo(
		() => countDiffChanges(filteredFiles),
		[filteredFiles],
	);

	const binaryFileMap = useMemo(() => {
		const map = new Map<string, (typeof binaryFiles)[number]>();
		for (const bf of binaryFiles) {
			map.set(bf.path, bf);
		}
		return map;
	}, [binaryFiles]);

	const prevAnnotationsRef = useRef<
		Map<
			string,
			{
				side: ReviewComment["side"];
				lineNumber: number;
				metadata: ReviewComment;
			}[]
		>
	>(new Map());

	const fileAnnotationsMap = useMemo(() => {
		const nextMap = new Map<
			string,
			{
				side: ReviewComment["side"];
				lineNumber: number;
				metadata: ReviewComment;
			}[]
		>();
		const groups = new Map<string, ReviewComment[]>();

		// Group comments by file path
		for (const c of comments) {
			let g = groups.get(c.filePath);
			if (!g) {
				g = [];
				groups.set(c.filePath, g);
			}
			g.push(c);
		}

		for (const [filePath, fileComments] of groups) {
			const list = fileComments.map((c) => ({
				side: c.side,
				lineNumber: c.lineNumber,
				metadata: c,
			}));

			// Compare with previous annotations for this file
			const prevList = prevAnnotationsRef.current.get(filePath);
			if (prevList && JSON.stringify(prevList) === JSON.stringify(list)) {
				nextMap.set(filePath, prevList);
			} else {
				nextMap.set(filePath, list);
			}
		}

		prevAnnotationsRef.current = nextMap;
		return nextMap;
	}, [comments]);

	const handleFileClick = useCallback((filePath: string) => {
		explicitActiveFileRef.current = Date.now();
		setActiveFile(filePath);
		const el = document.getElementById(`file-${filePath}`);
		if (el) {
			el.scrollIntoView({ block: "start" });
		}
	}, []);

	const handleApplyExtensions = useCallback((extensions: string[]) => {
		// Defer the expensive DiffViewer remount so the Apply click paints first.
		startTransition(() => {
			setAppliedExtensions(normalizeExtensions(extensions));
		});
	}, []);

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

	const handleDiffStyleChange = useCallback(
		(style: "split" | "unified") => {
			startTransition(() => {
				updateSettings({ diffStyle: style });
			});
		},
		[updateSettings],
	);

	const handleDiffOptionsChange = useCallback(
		(options: { staged: boolean; untracked: boolean }) => {
			startTransition(() => {
				updateSettings(options);
			});
		},
		[updateSettings],
	);

	const handleDefaultTabSizeChange = useCallback(
		(size: number) => {
			startTransition(() => {
				updateSettings({ defaultTabSize: size });
			});
		},
		[updateSettings],
	);

	const handleBrowserChange = useCallback(
		(browser: string) => {
			startTransition(() => {
				updateSettings({ browser });
			});
		},
		[updateSettings],
	);

	const handleThemeChange = useCallback(
		(theme: string) => {
			startTransition(() => {
				updateSettings({ theme });
			});
		},
		[updateSettings],
	);

	const handleEditorIDEChange = useCallback(
		(editor: string) => {
			startTransition(() => {
				updateSettings({ editorIDE: editor as any });
			});
		},
		[updateSettings],
	);

	const handleLineDiffTypeChange = useCallback(
		(v: LineDiffType) => {
			startTransition(() => {
				updateSettings({ lineDiffType: v });
			});
		},
		[updateSettings],
	);

	const handleLineWrapChange = useCallback(
		(v: boolean) => {
			startTransition(() => {
				updateSettings({ lineWrap: v });
			});
		},
		[updateSettings],
	);

	const handleDiffIndicatorsChange = useCallback(
		(v: DiffIndicators) => {
			startTransition(() => {
				updateSettings({ diffIndicators: v });
			});
		},
		[updateSettings],
	);

	const handleShowLineNumbersChange = useCallback(
		(v: boolean) => {
			startTransition(() => {
				updateSettings({ showLineNumbers: v });
			});
		},
		[updateSettings],
	);

	const handleHunkSeparatorsChange = useCallback(
		(v: HunkSeparatorStyle) => {
			startTransition(() => {
				updateSettings({ hunkSeparators: v });
			});
		},
		[updateSettings],
	);

	const handleLineHoverHighlightChange = useCallback(
		(v: LineHoverHighlight) => {
			startTransition(() => {
				updateSettings({ lineHoverHighlight: v });
			});
		},
		[updateSettings],
	);

	const handleFontSizeChange = useCallback(
		(v: number) => {
			startTransition(() => {
				updateSettings({ fontSize: v });
			});
		},
		[updateSettings],
	);

	const handleHapticsChange = useCallback(
		(v: boolean) => {
			updateSettings({ haptics: v });
		},
		[updateSettings],
	);

	const handleSoundsChange = useCallback(
		(v: boolean) => {
			updateSettings({ sounds: v });
		},
		[updateSettings],
	);

	const handleUiFontChange = useCallback(
		(font: string | null) => {
			updateSettings({ uiFont: font });
		},
		[updateSettings],
	);

	const handleMonoFontChange = useCallback(
		(font: string | null) => {
			updateSettings({ monoFont: font });
		},
		[updateSettings],
	);

	const handleDensityChange = useCallback(
		(v: "comfortable" | "compact") => {
			updateSettings({ density: v });
		},
		[updateSettings],
	);

	const handleAutoCollapseChange = useCallback(
		(v: number) => {
			updateSettings({ autoCollapseLineThreshold: v });
		},
		[updateSettings],
	);

	const handleRequireViewAllChange = useCallback(
		(v: boolean) => {
			updateSettings({ requireViewAllBeforeSend: v });
		},
		[updateSettings],
	);

	const handleShowStatusBarChange = useCallback(
		(v: boolean) => {
			updateSettings({ showStatusBar: v });
		},
		[updateSettings],
	);
	const handleIgnoreSpaceChange = useCallback(
		(v: boolean) => {
			updateSettings({ ignoreSpaceChange: v });
		},
		[updateSettings],
	);
	const handleIgnoreAllSpaceChange = useCallback(
		(v: boolean) => {
			updateSettings({ ignoreAllSpace: v });
		},
		[updateSettings],
	);

	const handleResolveAllOpen = useCallback(async () => {
		const result = await resolveAllOpen();
		fireFeedback("selection", "toggle");
		// Keep the mutation result observed while the query refresh removes
		// the now-resolved threads from the open-comment count.
		void result.resolved;
	}, [resolveAllOpen, fireFeedback]);

	const toggleLineNumbers = useCallback(() => {
		startTransition(() => {
			updateSettings({ showLineNumbers: !settings.showLineNumbers });
		});
	}, [updateSettings, settings.showLineNumbers]);

	const toggleLineWrap = useCallback(() => {
		handleLineWrapChange(!settings.lineWrap);
	}, [settings.lineWrap, handleLineWrapChange]);

	const cycleDiffIndicators = useCallback(() => {
		const order: DiffIndicators[] = ["classic", "bars", "none"];
		const cur = settings.diffIndicators || "classic";
		const next = order[(order.indexOf(cur) + 1) % order.length];
		handleDiffIndicatorsChange(next);
	}, [settings.diffIndicators, handleDiffIndicatorsChange]);

	const cycleLineDiffType = useCallback(() => {
		const order: LineDiffType[] = ["word", "word-alt", "char", "none"];
		const cur = settings.lineDiffType || "word";
		const next = order[(order.indexOf(cur) + 1) % order.length];
		handleLineDiffTypeChange(next);
	}, [settings.lineDiffType, handleLineDiffTypeChange]);

	const handleToggleCollapse = useCallback(() => {
		setSidebarCollapsed((c) => !c);
	}, []);

	// Walk the same filtered+sorted list DiffViewer renders. Using raw
	// `files` (patch order) made J stop mid-list whenever the current file
	// was last in patch order but not last on screen.
	const navigateFile = useCallback(
		(direction: "next" | "prev") => {
			if (sortedFiles.length === 0) return;
			const currentIndex = activeFile
				? sortedFiles.findIndex((f) => f.name === activeFile)
				: -1;
			const nextIndex =
				direction === "next"
					? Math.min(currentIndex + 1, sortedFiles.length - 1)
					: Math.max(currentIndex - 1, 0);
			const nextFile = sortedFiles[Math.max(0, nextIndex)]?.name;
			if (!nextFile) return;
			explicitActiveFileRef.current = Date.now();
			setActiveFile(nextFile);
			const el = document.getElementById(`file-${nextFile}`);
			if (el) {
				el.scrollIntoView({ block: "start" });
			}
		},
		[sortedFiles, activeFile, setActiveFile],
	);

	/** Prev/next commit in `diffing show` multi-commit mode (`[` / `]`). */
	const navigateCommit = useCallback(
		(direction: "next" | "prev") => {
			if (!showMode || commits.length < 2) return;
			setCommitWalkIndex((cur) => stepCommitWalk(cur, commits.length, direction));
		},
		[showMode, commits.length],
	);

	const toggleActiveFileViewed = useCallback(() => {
		if (!activeFile) return;
		explicitActiveFileRef.current = Date.now();
		const isCurrentlyViewed = viewedFiles.has(activeFile);
		setViewed(activeFile, !isCurrentlyViewed);
		if (!isCurrentlyViewed) scrollToNextFile(activeFile);
	}, [activeFile, viewedFiles, setViewed, scrollToNextFile]);

	const handleCardToggleCollapse = useCallback(
		(filePath: string, willCollapse: boolean) => {
			if (willCollapse) {
				explicitActiveFileRef.current = Date.now();
				scrollToNextFile(filePath);
			}
		},
		[scrollToNextFile],
	);

	const toggleDiffStyle = useCallback(() => {
		const nextStyle = settings.diffStyle === "split" ? "unified" : "split";
		handleDiffStyleChange(nextStyle);
	}, [settings.diffStyle, handleDiffStyleChange]);

	const cycleTabSize = useCallback(() => {
		const sizes = [2, 4, 8];
		const current = settings.defaultTabSize || 4;
		const nextIndex = (sizes.indexOf(current) + 1) % sizes.length;
		handleDefaultTabSizeChange(sizes[nextIndex]);
	}, [settings.defaultTabSize, handleDefaultTabSizeChange]);

	const toggleSidebar = useCallback(() => {
		handleToggleCollapse();
	}, [handleToggleCollapse]);

	/** z — immersive diffs-only view; works in every diffs-page mode. */
	const toggleZenMode = useCallback(() => {
		setZenMode((z) => !z);
		// Entering zen unmounts the toolbar and its Send popover; close any
		// open send surface so the centered dialog doesn't pop in mid-toggle.
		setSendOpen(false);
	}, []);

	const {
		setSnapshot: setSearchSnapshot,
		nextHit,
		prevHit,
		statusMessage: searchStatusMessage,
	} = useSearchSession(searchNavContext, handleFileClick);

	const keymapActions = useMemo(
		() => ({
			onNavigateFile: navigateFile,
			onNavigateCommit:
				showMode && commits.length > 1 ? navigateCommit : undefined,
			onToggleViewed: toggleActiveFileViewed,
			onToggleDiffStyle: toggleDiffStyle,
			onCycleTabSize: cycleTabSize,
			onToggleSidebar: toggleSidebar,
			onToggleLineWrap: toggleLineWrap,
			onToggleLineNumbers: toggleLineNumbers,
			onCycleDiffIndicators: cycleDiffIndicators,
			onCycleLineDiffType: cycleLineDiffType,
			onOpenPalette: openPalette,
			onTogglePalette: togglePalette,
			onOpenFileSearch: activeFile ? () => openFileSearch(activeFile) : undefined,
			// Escape while a find-in-file bar is open closes ONLY the search —
			// even when the bar's input is not focused — never also exits zen.
			onCloseFileSearch:
				!overlayOpen && fileSearch.filePath ? fileSearch.close : undefined,
			onNextSearchHit: nextHit,
			onPrevSearchHit: prevHit,
			onOpenTheme: () => setThemeModalOpen(true),
			onOpenShortcuts: () => setShortcutsHelpOpen(true),
			onToggleEdit:
				canEditScope && activeFile
					? () => toggleEditForFile(activeFile)
					: undefined,
			onSaveAll: editDirtyCount > 0 ? saveAllDirty : undefined,
			onToggleZen: toggleZenMode,
			// Escape exits zen only when no overlay is open — overlays handle
			// their own Escape (palette two-stage, dialog close, etc.).
			onExitZen: zenMode && !overlayOpen ? () => setZenMode(false) : undefined,
			// ⌘Enter opens the Send-review surface: the toolbar popover outside
			// zen, the centered dialog in zen. Suppressed while an overlay is
			// open so its own ⌘Enter handling (e.g. palette peek) keeps working.
			onOpenSendReview: overlayOpen ? undefined : () => setSendOpen(true),
		}),
		[
			navigateFile,
			showMode,
			commits.length,
			navigateCommit,
			toggleActiveFileViewed,
			toggleDiffStyle,
			cycleTabSize,
			toggleSidebar,
			toggleLineWrap,
			toggleLineNumbers,
			cycleDiffIndicators,
			cycleLineDiffType,
			openPalette,
			togglePalette,
			openFileSearch,
			fileSearch.filePath,
			activeFile,
			nextHit,
			prevHit,
			canEditScope,
			activeFile,
			toggleEditForFile,
			editDirtyCount,
			saveAllDirty,
			toggleZenMode,
			zenMode,
			overlayOpen,
		],
	);
	useDiffReviewKeymaps(keymapActions);

	const diffOptions = useMemo(
		() => ({
			staged: settings.staged,
			untracked: settings.untracked,
		}),
		[settings.staged, settings.untracked],
	);

	useEffect(() => {
		const activeTheme = settings.theme || "rose-pine";
		const root = document.documentElement;
		// Suppress the global color/border/box-shadow transitions while the
		// theme attribute flips. Otherwise every card, button and row animates
		// its color change simultaneously, which is what made switching themes
		// feel laggy. We re-enable transitions on the next frame, after the new
		// palette has painted instantly.
		root.classList.add("theme-switching");
		root.setAttribute("data-theme", activeTheme);
		root.setAttribute("data-density", settings.density || "comfortable");
		const id = requestAnimationFrame(() => {
			requestAnimationFrame(() => root.classList.remove("theme-switching"));
		});
		return () => cancelAnimationFrame(id);
	}, [settings.theme, settings.density]);

	useApplyFonts(loaded, settings.uiFont, settings.monoFont);

	const monoFontFamily = useMemo(
		() => resolveMonoFont(settings.monoFont),
		[settings.monoFont],
	);

	const shikiConfig = useMemo(() => {
		const activeTheme = settings.theme || "rose-pine";
		return SHIKI_THEME_MAP[activeTheme] || SHIKI_THEME_MAP["rose-pine"];
	}, [settings.theme]);

	useEffect(() => {
		if (!poolManager) return;
		poolManager
			.setRenderOptions({
				theme: {
					dark: shikiConfig.type === "dark" ? shikiConfig.themeName : "rose-pine",
					light:
						shikiConfig.type === "light" ? shikiConfig.themeName : "github-light",
				},
			})
			.catch((err) => {
				console.error("Failed to set worker pool render options:", err);
			});
	}, [poolManager, shikiConfig]);

	// Pre-warm the Shiki highlighter on the main thread for snappier first paint
	useEffect(() => {
		const dark =
			shikiConfig.type === "dark" ? shikiConfig.themeName : "rose-pine";
		const light =
			shikiConfig.type === "light" ? shikiConfig.themeName : "github-light";
		preloadHighlighter({
			themes: Array.from(new Set([dark, light])),
			langs: [],
		}).catch(() => {});
	}, [shikiConfig]);

	useEffect(() => {
		const parts = [repoName, branch].filter(Boolean);
		document.title =
			parts.length > 0 ? `${parts.join(" · ")} · diffing` : "diffing";
		return () => {
			document.title = "diffing";
		};
	}, [repoName, branch]);

	if (loading) {
		return (
			<div
				className="app skeleton-app"
				style={
					{
						"--sidebar-width": `${sidebarWidth}px`,
						"--comment-panel-height": `${commentPanelHeight}px`,
					} as React.CSSProperties
				}
			>
				{zenMode ? (
					<div className="zen-bar zen-bar-skeleton" aria-hidden="true" />
				) : (
					<header className="skeleton-toolbar">
						<div className="skeleton-item skeleton-logo"></div>
						<div className="skeleton-item skeleton-stats"></div>
						<div className="skeleton-item skeleton-actions"></div>
					</header>
				)}
				<div className="app-body">
					{!zenMode && (
						<aside
							className={`sidebar skeleton-sidebar ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
						>
							{!sidebarCollapsed && (
								<>
									<div className="skeleton-search"></div>
									<div className="skeleton-tree-nodes">
										{Array.from({ length: 8 }).map((_, i) => (
											<div
												key={i}
												className="skeleton-tree-node"
												style={{
													paddingLeft: `${(i % 3) * 16 + 16}px`,
												}}
											>
												<div className="skeleton-node-icon"></div>
												<div
													className="skeleton-node-text"
													style={{
														width: `${60 + ((i * 12) % 60)}px`,
													}}
												></div>
											</div>
										))}
									</div>
								</>
							)}
						</aside>
					)}
					{!zenMode && !sidebarCollapsed && (
						<div className="sidebar-resize-handle" style={{ cursor: "default" }} />
					)}
					<main className="main skeleton-main">
						<div className="diff-viewer">
							{Array.from({ length: 3 }).map((_, i) => (
								<div key={i} className="file-diff-card skeleton-card">
									<div className="skeleton-card-header">
										<div
											className="skeleton-card-title"
											style={{
												width: `${120 + ((i * 45) % 150)}px`,
											}}
										></div>
										<div className="skeleton-card-badge"></div>
									</div>
									<div className="skeleton-card-body">
										{Array.from({ length: 5 }).map((_, j) => (
											<div
												key={j}
												className="skeleton-code-line"
												style={{
													width: `${50 + ((j * 15) % 45)}%`,
												}}
											></div>
										))}
									</div>
								</div>
							))}
						</div>
					</main>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="error empty-state" role="alert">
				<div
					className="empty-state-icon empty-state-icon-danger"
					aria-hidden="true"
				>
					<AlertTriangle size={24} strokeWidth={1.75} />
				</div>
				<p className="empty-state-title">Couldn&apos;t load the diff</p>
				<p className="empty-state-hint">{error}</p>
			</div>
		);
	}

	return (
		<EditProvider createEditor={createEditor}>
			<HapticsProvider
				enabled={settings.haptics ?? true}
				soundsEnabled={settings.sounds ?? true}
			>
				<div
					className={`app ${zenMode ? "app-zen" : ""} ${aiRailOpen ? "app-ai-open" : ""}`}
					ref={appRef}
					style={
						{
							"--sidebar-width": `${sidebarWidth}px`,
							"--comment-panel-height": `${commentPanelHeight}px`,
						} as React.CSSProperties
					}
				>
					<a href="#diff-main" className="skip-to-main">
						Skip to diff
					</a>
					{refreshing && (
						<div
							className="refresh-bar"
							role="status"
							aria-live="polite"
							aria-label="Refreshing diff"
						/>
					)}
					{editNotice && (
						<div className="edit-entry-notice" role="alert">
							<AlertTriangle size={12} />
							{editNotice}
							<button
								type="button"
								className="edit-entry-notice-close"
								onClick={() => setEditNotice(null)}
								aria-label="Dismiss"
							>
								<X size={12} />
							</button>
						</div>
					)}
					<div
						className="sidebar-resize-guide"
						ref={sidebarGuideRef}
						aria-hidden="true"
					/>
					{zenMode ? (
						<ZenBar
							repoName={repoName}
							branch={branch}
							fileCount={filteredFiles.length}
							totalFileCount={files.length}
							additions={diffStats.additions}
							deletions={diffStats.deletions}
							showMode={showMode}
							showCommitCount={commits.length}
							onExit={() => setZenMode(false)}
						/>
					) : (
						<Toolbar
							repoName={repoName}
							branch={branch}
							fileCount={filteredFiles.length}
							totalFileCount={files.length}
							additions={diffStats.additions}
							deletions={diffStats.deletions}
							commentCount={comments.length}
							planCount={plans.length}
							pendingPlanCount={pendingPlanCount}
							lastSend={lastSend}
							onOpenPlans={() => navigate("/plan")}
							onOpenMockups={() => navigate("/mockup")}
							diffStyle={settings.diffStyle}
							diffOptions={diffOptions}
							defaultTabSize={settings.defaultTabSize}
							browser={settings.browser}
							theme={settings.theme || "rose-pine"}
							editorIDE={settings.editorIDE}
							customMode={customMode}
							showMode={showMode}
							showCommitCount={commits.length}
							lineDiffType={settings.lineDiffType}
							lineWrap={settings.lineWrap}
							diffIndicators={settings.diffIndicators}
							showLineNumbers={settings.showLineNumbers}
							hunkSeparators={settings.hunkSeparators}
							lineHoverHighlight={settings.lineHoverHighlight}
							fontSize={settings.fontSize}
							haptics={settings.haptics ?? true}
							sounds={settings.sounds ?? true}
							uiFont={settings.uiFont}
							monoFont={settings.monoFont}
							sidebarCollapsed={sidebarCollapsed}
							onToggleSidebar={handleToggleCollapse}
							onDiffStyleChange={handleDiffStyleChange}
							onDiffOptionsChange={handleDiffOptionsChange}
							onDefaultTabSizeChange={handleDefaultTabSizeChange}
							onBrowserChange={handleBrowserChange}
							onOpenThemeModal={() => setThemeModalOpen(true)}
							onEditorIDEChange={handleEditorIDEChange}
							onLineDiffTypeChange={handleLineDiffTypeChange}
							onLineWrapChange={handleLineWrapChange}
							onDiffIndicatorsChange={handleDiffIndicatorsChange}
							onShowLineNumbersChange={handleShowLineNumbersChange}
							onHunkSeparatorsChange={handleHunkSeparatorsChange}
							onLineHoverHighlightChange={handleLineHoverHighlightChange}
							onFontSizeChange={handleFontSizeChange}
							onHapticsChange={handleHapticsChange}
							onSoundsChange={handleSoundsChange}
							density={settings.density}
							autoCollapseLineThreshold={settings.autoCollapseLineThreshold}
							requireViewAllBeforeSend={settings.requireViewAllBeforeSend}
							showStatusBar={settings.showStatusBar ?? true}
							ignoreSpaceChange={settings.ignoreSpaceChange ?? false}
							ignoreAllSpace={settings.ignoreAllSpace ?? false}
							editDiagnostics={settings.editDiagnostics === true}
							onDensityChange={handleDensityChange}
							onAutoCollapseLineThresholdChange={handleAutoCollapseChange}
							onRequireViewAllBeforeSendChange={handleRequireViewAllChange}
							onShowStatusBarChange={handleShowStatusBarChange}
							onIgnoreSpaceChange={handleIgnoreSpaceChange}
							onIgnoreAllSpaceChange={handleIgnoreAllSpaceChange}
							onEditDiagnosticsChange={(v) => updateSettings({ editDiagnostics: v })}
							onResolveAllOpen={handleResolveAllOpen}
							onOpenUiFontModal={() => setUiFontModalOpen(true)}
							onOpenMonoFontModal={() => setMonoFontModalOpen(true)}
							onOpenSearch={() => openPalette("all")}
							onCopyComments={copyAllComments}
							onCopyMarkdown={copyAllCommentsMarkdown}
							onSendToAgent={sendToAgent}
							agentWaiting={agentWaiting}
							waitingAgents={waitingAgents}
							sending={sending}
							comments={comments}
							viewedFileCount={viewedFiles.size}
							onEditComment={editComment}
							onDeleteComment={removeComment}
							zenMode={zenMode}
							onToggleZen={toggleZenMode}
							sendReviewOpen={sendOpen}
							onSendReviewOpenChange={setSendOpen}
							onOpenAiAssistant={() => setAiRailOpen(true)}
						/>
					)}
					{!zenMode && !sidebarCollapsed && (
						<div
							className="sidebar-mobile-backdrop"
							onClick={handleToggleCollapse}
							aria-hidden="true"
						/>
					)}
					<div className="app-body">
						{!zenMode && (
							<aside
								ref={sidebarRef}
								className={`sidebar ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
							>
								<div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
									<FileTree
										files={allSortedFiles}
										activeFile={activeFile}
										commentCounts={commentCounts}
										viewedFiles={viewedFiles}
										untrackedFiles={untrackedSet}
										onFileClick={handleFileClick}
										collapsed={sidebarCollapsed}
										onToggleCollapse={handleToggleCollapse}
										appliedExtensions={appliedExtensions}
										onApplyExtensions={handleApplyExtensions}
										chipFilter={chipFilter}
										onChipFilterChange={setChipFilter}
										sinceLastFiles={sinceLastFiles}
										sinceLastAvailable={sinceLastAvailable}
									/>
								</div>
								{!sidebarCollapsed && comments.length > 0 && (
									<>
										<div
											className="ct-resize-handle"
											onMouseDown={handleResizeStart}
											role="separator"
											aria-label="Resize comments panel"
											aria-orientation="horizontal"
											tabIndex={0}
										/>
										<div className="ct-wrapper" style={{ flexShrink: 0 }}>
											<CommentTracker
												comments={comments}
												resolveComment={resolveComment}
												unresolveComment={unresolveComment}
												removeComment={removeComment}
												addReply={addReply}
												editComment={editComment}
												editReply={editReply}
												removeReply={removeReply}
											/>
										</div>
									</>
								)}
							</aside>
						)}
						{!zenMode && !sidebarCollapsed && (
							<div
								className="sidebar-resize-handle"
								onMouseDown={handleSidebarResizeStart}
								role="separator"
								aria-label="Resize sidebar"
								aria-orientation="vertical"
								tabIndex={0}
							/>
						)}
						<main className="main" ref={diffViewerRef} id="diff-main" tabIndex={-1}>
							{overview && (
								<DiffOverviewBanner
									overview={overview}
									commits={showMode ? commits : undefined}
								/>
							)}
							{showMode && commits.length > 1 && (
								<CommitWalkBar
									commits={commits}
									activeIndex={commitWalkIndex}
									onChange={setCommitWalkIndex}
								/>
							)}
							{mergeStatus.inMerge && mergeStatus.conflicts.length > 0 && (
								<div className="merge-conflict-banner">
									<strong>Merge in progress</strong>
									<span>
										{mergeStatus.conflicts.length} unresolved file
										{mergeStatus.conflicts.length === 1 ? "" : "s"} below. Use the inline
										buttons to accept current/incoming/both, then "Save &amp; stage".
									</span>
								</div>
							)}
							{mergeStatus.conflicts.map((conflictPath) => (
								<MergeConflictResolver
									key={conflictPath}
									filePath={conflictPath}
									theme={settings.theme || "rose-pine"}
									fontSize={settings.fontSize}
									monoFontFamily={monoFontFamily}
									tabSize={tabSizeMap[conflictPath] ?? settings.defaultTabSize}
									onSaved={() => {
										refreshMergeStatus();
									}}
								/>
							))}
							<DiffViewer
								files={sortedFiles}
								diffStyle={settings.diffStyle}
								tabSizeMap={tabSizeMap}
								defaultTabSize={settings.defaultTabSize}
								viewedFiles={viewedFiles}
								binaryFiles={binaryFileMap}
								theme={settings.theme || "rose-pine"}
								editorIDE={settings.editorIDE}
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
								onViewedChange={handleViewedChange}
								fileAnnotationsMap={fileAnnotationsMap}
								onAddComment={addComment}
								onDeleteComment={removeComment}
								onAddSelectionToAsk={addSelectionToAsk}
								onCardToggleCollapse={handleCardToggleCollapse}
								canEdit={canEditScope}
								editSessions={editSessions}
								onRequestEdit={enterEdit}
								onEditChange={handleEditChange}
								onEditAttach={handleEditAttach}
								onEditSave={saveEdit}
								onEditDiscard={handleEditDiscard}
								onEditExit={handleEditExit}
								fileSearch={fileSearch}
								onOpenFileSearch={openFileSearch}
							/>
						</main>
					</div>
					<AiAssistantRail
						open={aiRailOpen}
						onClose={() => setAiRailOpen(false)}
						surface="diff"
						title="Ask about this diff"
						context={aiReviewContext}
						onRemoveSelection={(index) =>
							setAiSelections((current) =>
								current.filter((_, itemIndex) => itemIndex !== index),
							)
						}
					/>
					<SearchPalette
						isOpen={palette.open}
						onClose={closePalette}
						initialScope={palette.scope}
						initialChangedOnly={palette.changedOnly}
						onChangedOnlyPreference={handleChangedOnlyPreference}
						onSessionSnapshot={setSearchSnapshot}
						files={filteredFiles}
						changedEntries={diffSearchEntries}
						customMode={customMode}
						staged={settings.staged}
						onNavigateFile={handleFileClick}
						theme={settings.theme || "rose-pine"}
						fontSize={settings.fontSize}
						monoFontFamily={monoFontFamily}
						defaultTabSize={settings.defaultTabSize}
						lineWrap={settings.lineWrap}
						showLineNumbers={settings.showLineNumbers}
						lineHoverHighlight={settings.lineHoverHighlight}
					/>
					{!zenMode && (
						<VimStatusBar
							activeFile={activeFile}
							onShowHelp={() => setShortcutsHelpOpen(true)}
							visible={settings.showStatusBar ?? true}
							statusMessage={searchStatusMessage}
							placeholder={
								showMode && commits.length > 1
									? "No active file (J/K files · [ / ] commits)"
									: undefined
							}
							editDirtyCount={editDirtyCount}
							editSaveEnabled={canEditScope}
							onSaveAllEdits={saveAllDirty}
						/>
					)}
					<ShortcutsHelpModal
						isOpen={shortcutsHelpOpen}
						onClose={() => setShortcutsHelpOpen(false)}
					/>
					{zenMode && sendOpen && (
						<SendReviewModal
							open={sendOpen}
							onClose={() => setSendOpen(false)}
							comments={comments}
							totalFileCount={files.length}
							viewedFileCount={viewedFiles.size}
							requireViewAllBeforeSend={settings.requireViewAllBeforeSend}
							onEditComment={editComment}
							onDeleteComment={removeComment}
							onSend={sendToAgent}
							sending={sending}
							agentWaiting={agentWaiting}
							waitingAgents={waitingAgents}
							onCopyComments={copyAllComments}
							onCopyMarkdown={copyAllCommentsMarkdown}
						/>
					)}
					<ThemeModal
						open={themeModalOpen}
						activeTheme={settings.theme || "rose-pine"}
						onThemeChange={handleThemeChange}
						onClose={() => setThemeModalOpen(false)}
					/>
					<FontPickerModal
						open={uiFontModalOpen}
						title="Select UI Font"
						defaultLabel="Default (Geist Mono, from CDN)"
						activeFont={settings.uiFont}
						onFontChange={handleUiFontChange}
						onClose={() => setUiFontModalOpen(false)}
					/>
					<FontPickerModal
						open={monoFontModalOpen}
						title="Select Code Font"
						defaultLabel="Default (JetBrains Mono, from CDN)"
						activeFont={settings.monoFont}
						onFontChange={handleMonoFontChange}
						onClose={() => setMonoFontModalOpen(false)}
					/>
					<AgentActivityToast
						activity={agentActivity}
						onDismiss={clearAgentActivity}
						onJump={handleFileClick}
					/>
					<AgentProgressToast />
					<ConfirmDialog
						open={editConfirm !== null}
						title={
							editConfirm?.kind === "exit" ? "Exit edit mode?" : "Discard edits?"
						}
						description={
							editConfirm?.kind === "exit"
								? "This file has unsaved changes. Discard them and exit edit mode?"
								: "Discard all changes to this file since the last save?"
						}
						confirmLabel="Discard"
						variant="danger"
						onConfirm={confirmEditAction}
						onCancel={() => setEditConfirm(null)}
					/>
				</div>
			</HapticsProvider>
		</EditProvider>
	);
}
