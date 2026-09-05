use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use anyhow::Result;
use diffing_core::comments::{
    CommentSide, CommentStatus, FileCommentStore, NewComment, ReviewComment,
};
use diffing_core::diff::{ChangeKind, FileDiff};
use diffing_core::index::{
    build_git_diff_index, DiffIndex, IndexedChangeKind, IndexedLineKind, ViewRow,
    DEFAULT_VIEWPORT_MAX_BYTES,
};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph, Widget, Wrap};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::agent_api::AgentApi;
use crate::diff::highlight::highlight_line;
use crate::diff_context::DiffContext;
use crate::editorconfig::EditorConfigCache;
use crate::handoff::{CommentsWatcher, RepoWatcher};
use crate::keys::{
    classify_search_special, help_text, viewer_help_text, Action, Command, Keymap,
    SearchSpecialAction,
};
use crate::lsp::{
    character_column_from_utf16, utf16_column, DefinitionTarget, LanguageResponse, LspManager,
    RequestKind, RequestToken, ServerState,
};
use crate::path_safety;
use crate::persistence::FileDisplay;
use crate::search::{
    diff_first_search_hits, execute_search_request, load_local_preview, SearchClient, SearchHit,
    SearchHitKind, SearchPreview, SearchRequest, SearchResponse, SearchScope, SearchWorkerContext,
};
use crate::themes::{Palette, ThemeName};
use crate::ui::agent_activity_toast::{render_toast, Toast};
use crate::ui::comment_form::{
    comment_form_regions, render_form, textarea_char_count, CommentFormState,
};
use crate::ui::comment_thread::render_thread;
use crate::ui::comment_tracker::{render_tracker, TrackerState};
use crate::ui::file_diff_card::{render_card, DiffRenderCache};
use crate::ui::file_tree::FileTree;
use crate::ui::file_tree_render::{
    content_area as file_tree_content_area, render_file_tree, FileTreeRenderOptions,
};
use crate::ui::gridline::{
    chip_row, dim_buffer, fill, hint_line, horizontal_rule, overlay_block, safe_terminal_character,
    safe_terminal_text, shortcut_help, shortcut_help_columns, tail_ellipsize, vertical_rule,
    GridlineTokens, GLYPHS, METRICS,
};
use crate::ui::image_diff::{
    default_compare_mode, is_image_path, render_image_diff, ImageCompareMode, ImageDiffData,
    ImageDiffManager, ImageKey, ImagePresentation, ImageViewState,
};
use crate::ui::send_review_popover::{
    build_send_payload, render_send_popover, send_review_regions, SendField, SendReviewState,
};
use crate::ui::settings_sheet::{render_settings, settings_row_at, SettingsState, SettingsValues};
use crate::ui::vim_status_bar::{render_status_bar, StatusBarContext};

const MAX_MODAL_INPUT_CHARACTERS: usize = 4_096;
const MAX_PASTE_CHARACTERS: usize = 1_048_576;
const MAX_TEXTAREA_CHARACTERS: usize = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    FileTree,
    Diff,
    Tracker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Experience {
    Review,
    Viewer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorTarget {
    pub path: PathBuf,
    pub line: u32,
    pub column: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    CommentForm,
    SendReview,
    Search,
    Command,
    Help,
    ThemePicker,
    Settings,
    Hover,
    ImagePreview,
    CommentDetail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileFilterMode {
    All,
    Unviewed,
    Comments,
}

impl FileFilterMode {
    fn next(self) -> Self {
        match self {
            Self::All => Self::Unviewed,
            Self::Unviewed => Self::Comments,
            Self::Comments => Self::All,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Unviewed => "Unviewed",
            Self::Comments => "Has comments",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus {
    Waiting,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolbarAction {
    SendReview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageControl {
    Mode(ImageCompareMode),
    ZoomOut,
    Reset,
    ZoomIn,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommentDetailControl {
    Jump,
    Edit,
    Reply,
    Resolve,
    Delete,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PointerVisualTarget {
    Toolbar(ToolbarAction),
    Image(ImageControl),
    CommentDetail(CommentDetailControl),
    DiffRow(u16),
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DragState {
    Sidebar,
    Comments,
}

#[derive(Debug, Clone, Copy)]
struct RenderedDiffRow {
    file_index: usize,
    logical_rows: [Option<u64>; 2],
    split: bool,
}

#[derive(Default)]
struct UiRegions {
    root: Option<Rect>,
    toolbar: Vec<(Rect, ToolbarAction)>,
    image_controls: Vec<(Rect, ImageControl)>,
    comment_detail_controls: Vec<(Rect, CommentDetailControl)>,
    file_tree: Option<Rect>,
    file_rows: Vec<(Rect, usize)>,
    diff: Option<Rect>,
    diff_inner: Option<Rect>,
    change_map: Option<Rect>,
    comment_panel: Option<Rect>,
    comment_rows: Vec<(Rect, usize)>,
    sidebar_divider: Option<Rect>,
    comment_divider: Option<Rect>,
    theme_rows: Vec<(Rect, ThemeName)>,
    toast_rows: Vec<(Rect, u64)>,
    search_scopes: Vec<(Rect, SearchScope)>,
    search_changed: Option<Rect>,
    search_regex: Option<Rect>,
    modal_input: Option<Rect>,
    search_results: Vec<(Rect, usize)>,
    search_preview: Option<Rect>,
}

impl UiRegions {
    fn pointer_visual_target(&self, position: Option<(u16, u16)>) -> PointerVisualTarget {
        let Some((column, row)) = position else {
            return PointerVisualTarget::None;
        };
        if let Some(action) = self
            .toolbar
            .iter()
            .find(|(area, _)| contains(*area, column, row))
            .map(|(_, action)| *action)
        {
            return PointerVisualTarget::Toolbar(action);
        }
        if let Some(control) = self
            .image_controls
            .iter()
            .find(|(area, _)| contains(*area, column, row))
            .map(|(_, control)| *control)
        {
            return PointerVisualTarget::Image(control);
        }
        if let Some(control) = self
            .comment_detail_controls
            .iter()
            .find(|(area, _)| contains(*area, column, row))
            .map(|(_, control)| *control)
        {
            return PointerVisualTarget::CommentDetail(control);
        }
        if self
            .diff_inner
            .is_some_and(|area| contains(area, column, row))
        {
            return PointerVisualTarget::DiffRow(row);
        }
        PointerVisualTarget::None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingCommentTarget {
    file_path: String,
    side: CommentSide,
    start_line_number: Option<u32>,
    line_number: u32,
    line_content: String,
}

fn inline_comment_target(
    file_path: String,
    rows: Vec<ViewRow>,
) -> std::result::Result<PendingCommentTarget, &'static str> {
    let mut side = None;
    let mut line_numbers: Vec<u32> = Vec::with_capacity(rows.len());
    let mut contents = Vec::with_capacity(rows.len());
    for row in rows {
        let ViewRow::Line {
            kind,
            old_lineno,
            new_lineno,
            content,
            ..
        } = row
        else {
            return Err("select code lines only");
        };
        let row_side = if kind == IndexedLineKind::Del {
            CommentSide::Deletions
        } else {
            CommentSide::Additions
        };
        if side.is_some_and(|existing| existing != row_side) {
            return Err("selection must stay on one diff side");
        }
        side = Some(row_side);
        let number = match row_side {
            CommentSide::Deletions => old_lineno,
            CommentSide::Additions => new_lineno.or(old_lineno),
        }
        .ok_or("selected line has no comment anchor")?;
        if line_numbers
            .last()
            .is_some_and(|previous| previous.checked_add(1) != Some(number))
        {
            return Err("selection must be contiguous on one diff side");
        }
        line_numbers.push(number);
        contents.push(content);
    }
    let line_number = *line_numbers.last().ok_or("select at least one code line")?;
    let start_line_number = (line_numbers.len() > 1).then(|| line_numbers[0]);
    Ok(PendingCommentTarget {
        file_path,
        side: side.unwrap_or(CommentSide::Additions),
        start_line_number,
        line_number,
        line_content: contents.join("\n"),
    })
}

fn blocked_in_viewer(action: Action) -> bool {
    matches!(
        action,
        Action::OpenSendReview
            | Action::AddComment
            | Action::AddFileComment
            | Action::ToggleVisualSelection
            | Action::EditComment
            | Action::ReplyComment
            | Action::ResolveComment
            | Action::ResolveAllComments
            | Action::DeleteComment
            | Action::NextComment
            | Action::PrevComment
            | Action::OpenCommentThread
            | Action::CycleCommentStatus
            | Action::CycleCommentSeverity
            | Action::ToggleViewed
            | Action::CycleFileFilter
    )
}

pub struct App {
    #[allow(dead_code)]
    pub repo_root: PathBuf,
    pub index: Arc<DiffIndex>,
    shared_index: Arc<RwLock<Arc<DiffIndex>>>,
    index_tx: Sender<IndexEvent>,
    index_rx: Receiver<IndexEvent>,
    git_diff_args: Vec<String>,
    default_context_lines: u32,
    context_lines: u32,
    indexing: bool,
    reindex_pending: bool,
    refresh_anchor: Option<RefreshAnchor>,
    pub agent_api: Option<AgentApi>,
    pub files: Vec<diffing_core::diff::FileDiff>,
    pub file_tree: FileTree,
    pub experience: Experience,
    pub diff_context: DiffContext,
    viewed_paths: HashSet<PathBuf>,
    pub focus: Focus,
    pub mode: Mode,
    pub wrap: bool,
    pub split: bool,
    pub file_display: FileDisplay,
    pub tab_size: u8,
    editorconfig: EditorConfigCache,
    pub line_numbers: bool,
    pub mouse_enabled: bool,
    pub trust_repo_local_bin: bool,
    pub theme: ThemeName,
    pub palette: Palette,
    pub scroll: usize,
    pub cursor_row: u64,
    pub continuous_scroll: u64,
    pub continuous_cursor: u64,
    pub viewport_height: usize,
    render_metadata: DiffRenderMetadata,
    diff_render_cache: DiffRenderCache,
    rendered_diff_rows: Vec<RenderedDiffRow>,
    pointer_overlay_dirty: bool,
    image_diff: ImageDiffManager,
    image_view: ImageViewState,
    active_image_key: Option<ImageKey>,
    pub horizontal_offset: usize,
    code_column: Option<usize>,
    lsp: LspManager,
    lsp_active_path: Option<PathBuf>,
    lsp_last_state: ServerState,
    lsp_revision: u64,
    queued_lsp: Option<RequestKind>,
    pending_lsp: Option<RequestToken>,
    hover_content: Option<String>,
    hover_scroll: u16,
    visual_anchor: Option<(usize, u64)>,
    pending_comment_target: Option<PendingCommentTarget>,
    pending_editor: Option<EditorTarget>,
    pub sidebar_width: u16,
    pub comment_height: u16,
    pub sidebar_visible: bool,
    pub comments_visible: bool,
    regions: UiRegions,
    drag: Option<DragState>,
    mouse_position: Option<(u16, u16)>,
    theme_cursor: usize,
    theme_original: ThemeName,
    theme_return_to_settings: bool,
    help_scroll: u16,
    settings_state: SettingsState,
    pub keymap: Keymap,
    pub modal_input: String,
    modal_cursor: usize,
    pub search_cursor: usize,
    search_client: Option<SearchClient>,
    search_scope: SearchScope,
    search_changed_only: bool,
    search_regex: bool,
    repo_search_hits: Vec<SearchHit>,
    repo_search_total: Option<usize>,
    repo_search_indexing: bool,
    repo_search_loading: bool,
    repo_search_error: Option<String>,
    repo_search_notice: Option<String>,
    repo_search_query: String,
    search_request_id: u64,
    search_request_tx: Sender<SearchRequest>,
    search_result_rx: Receiver<SearchEvent>,
    _search_worker: Arc<SearchWorkerContext>,
    changed_paths_cache: Option<(u64, Arc<[String]>)>,
    status_bar_memo: Option<StatusBarMemo>,
    search_preview: Option<SearchPreview>,
    search_preview_loading: bool,
    search_preview_error: Option<String>,
    search_preview_scroll: usize,
    search_preview_focused: bool,
    preview_request_id: u64,
    preview_request_tx: Sender<PreviewRequest>,
    preview_result_rx: Receiver<PreviewEvent>,
    pub file_tree_scroll: usize,
    file_filter_mode: FileFilterMode,
    pub status_message: Option<String>,
    status_message_at: Option<std::time::Instant>,
    pending_delete_id: Option<String>,
    pending_resolve_all: bool,
    last_ctrl_c_at: Option<std::time::Instant>,
    pub quit: bool,
    pub comments: Vec<ReviewComment>,
    comments_revision: u64,
    pub comment_store: FileCommentStore,
    pub tracker: TrackerState,
    comment_detail_scroll: u16,
    pub comment_form: Option<CommentFormState>,
    pub send_review: Option<SendReviewState>,
    pub toasts: Vec<Toast>,
    pub agent_status: AgentStatus,
    pub review_round: u32,
    pub last_comment_count: usize,
    #[allow(dead_code)]
    pub watcher: CommentsWatcher,
    #[allow(dead_code)]
    pub repo_watcher: Option<RepoWatcher>,
}

enum IndexEvent {
    Snapshot(DiffIndex),
    Failed(String),
}

struct SearchEvent {
    id: u64,
    response: Result<SearchResponse, String>,
}

#[derive(Debug, Clone)]
struct StatusBarMemo {
    generation: u64,
    file_index: usize,
    cursor_row: u64,
    lsp_revision: u64,
    location_label: String,
    diagnostic_hint: Option<String>,
}

struct PreviewRequest {
    id: u64,
    path: String,
}

struct PreviewEvent {
    id: u64,
    response: Result<SearchPreview, String>,
}

#[derive(Debug, Clone)]
struct RefreshAnchor {
    path: PathBuf,
    kind: IndexedLineKind,
    line: u32,
    viewport_offset: u64,
}

const CHANGE_MAP_CACHE_ENTRIES: usize = 16;
const EX_COMMANDS: &[&str] = &[
    "bottom",
    "comments",
    "continuous",
    "display",
    "files",
    "h",
    "help",
    "image",
    "mouse",
    "nomouse",
    "nowrap",
    "q",
    "quit",
    "refresh",
    "reload",
    "set",
    "settings",
    "sidebar",
    "single",
    "split",
    "theme",
    "top",
    "unified",
    "w",
    "wrap",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChangeMapMarker {
    Added,
    Removed,
    Modified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChangeMapKey {
    file_index: Option<usize>,
    height: u16,
}

struct CachedChangeMap {
    key: ChangeMapKey,
    markers: Arc<[Option<ChangeMapMarker>]>,
}

#[derive(Default)]
struct DiffRenderMetadata {
    /// Original file indices in the active continuous-view order, plus their
    /// inclusive starts and one terminal total-row sentinel.
    file_indices: Vec<usize>,
    file_offsets: Vec<u64>,
    change_maps: VecDeque<CachedChangeMap>,
}

impl DiffRenderMetadata {
    fn new(index: &DiffIndex) -> Self {
        let mut metadata = Self::default();
        metadata.rebuild(index);
        metadata
    }

    fn rebuild(&mut self, index: &DiffIndex) {
        self.rebuild_visible(index, 0..index.files.len());
    }

    fn set_visible_files(&mut self, index: &DiffIndex, files: &[usize]) {
        if self.file_indices == files {
            return;
        }
        self.rebuild_visible(index, files.iter().copied());
    }

    fn rebuild_visible(&mut self, index: &DiffIndex, files: impl IntoIterator<Item = usize>) {
        self.file_indices.clear();
        self.file_offsets.clear();
        self.file_offsets.push(0);
        for file_index in files {
            let Some(file) = index.files.get(file_index) else {
                continue;
            };
            self.file_indices.push(file_index);
            let next = self
                .file_offsets
                .last()
                .copied()
                .unwrap_or(0u64)
                .saturating_add(file.row_count);
            self.file_offsets.push(next);
        }
        self.change_maps.clear();
    }

    fn total_rows(&self) -> u64 {
        self.file_offsets.last().copied().unwrap_or(0)
    }

    fn file_offset(&self, file_index: usize) -> u64 {
        self.file_indices
            .iter()
            .position(|index| *index == file_index)
            .and_then(|position| self.file_offsets.get(position))
            .copied()
            .unwrap_or_else(|| self.total_rows())
    }

    fn position(&self, global_row: u64) -> Option<(usize, u64)> {
        let total = self.total_rows();
        if total == 0 || self.file_offsets.len() < 2 || self.file_indices.is_empty() {
            return None;
        }
        let row = global_row.min(total.saturating_sub(1));
        let position = self
            .file_offsets
            .partition_point(|offset| *offset <= row)
            .saturating_sub(1)
            .min(self.file_indices.len().saturating_sub(1));
        let file_index = self.file_indices[position];
        Some((file_index, row.saturating_sub(self.file_offsets[position])))
    }

    fn change_map(
        &mut self,
        index: &DiffIndex,
        file_index: Option<usize>,
        height: u16,
    ) -> Arc<[Option<ChangeMapMarker>]> {
        let key = ChangeMapKey { file_index, height };
        if let Some(position) = self.change_maps.iter().position(|cached| cached.key == key) {
            let cached = self
                .change_maps
                .remove(position)
                .expect("position came from the same cache");
            let markers = cached.markers.clone();
            self.change_maps.push_back(cached);
            return markers;
        }

        let total_rows = file_index
            .and_then(|selected| index.files.get(selected))
            .map(|file| file.row_count)
            .unwrap_or_else(|| self.total_rows());
        let mut markers = vec![None; height as usize];
        if height > 0 && total_rows > 0 {
            for (current_index, file) in index.files.iter().enumerate() {
                if file_index.is_some_and(|selected| selected != current_index) {
                    continue;
                }
                if file_index.is_none() && !self.file_indices.contains(&current_index) {
                    continue;
                }
                let base = if file_index.is_some() {
                    0
                } else {
                    self.file_offset(current_index)
                };
                for hunk in &file.hunks {
                    let logical = base.saturating_add(hunk.row_start);
                    let content_span = total_rows.saturating_sub(1).max(1);
                    let bucket = (logical.saturating_mul(height.saturating_sub(1) as u64)
                        / content_span) as usize;
                    let bucket = bucket.min(markers.len().saturating_sub(1));
                    markers[bucket] = Some(if hunk.new_lines > hunk.old_lines {
                        ChangeMapMarker::Added
                    } else if hunk.old_lines > hunk.new_lines {
                        ChangeMapMarker::Removed
                    } else {
                        ChangeMapMarker::Modified
                    });
                }
            }
        }
        let markers: Arc<[Option<ChangeMapMarker>]> = markers.into();
        self.change_maps.push_back(CachedChangeMap {
            key,
            markers: markers.clone(),
        });
        while self.change_maps.len() > CHANGE_MAP_CACHE_ENTRIES {
            self.change_maps.pop_front();
        }
        markers
    }
}

fn spawn_index_worker(
    repo_root: PathBuf,
    git_diff_args: Vec<String>,
    index_tx: Sender<IndexEvent>,
) -> Result<()> {
    thread::Builder::new()
        .name("diffing-index".to_string())
        .spawn(move || {
            let repo = repo_root.to_string_lossy().into_owned();
            let result = build_git_diff_index(&repo, &git_diff_args, |snapshot| {
                let _ = index_tx.send(IndexEvent::Snapshot(snapshot));
            });
            if let Err(error) = result {
                let _ = index_tx.send(IndexEvent::Failed(error.to_string()));
            }
        })?;
    Ok(())
}

fn spawn_search_worker(
    worker: Arc<SearchWorkerContext>,
    request_rx: Receiver<SearchRequest>,
    result_tx: Sender<SearchEvent>,
) -> Result<()> {
    thread::Builder::new()
        .name("diffing-fff-search".to_string())
        .spawn(move || {
            while let Ok(mut request) = request_rx.recv() {
                // Coalesce a burst of keystrokes so the native engine only
                // evaluates the newest query.
                thread::sleep(Duration::from_millis(55));
                while let Ok(newer) = request_rx.try_recv() {
                    request = newer;
                }
                let response =
                    execute_search_request(&worker, &request).map_err(|error| error.to_string());
                let _ = result_tx.send(SearchEvent {
                    id: request.id,
                    response,
                });
            }
        })?;
    Ok(())
}

fn spawn_preview_worker(
    bridge: Option<SearchClient>,
    repo_root: PathBuf,
    request_rx: Receiver<PreviewRequest>,
    result_tx: Sender<PreviewEvent>,
) -> Result<()> {
    thread::Builder::new()
        .name("diffing-fff-preview".to_string())
        .spawn(move || {
            while let Ok(mut request) = request_rx.recv() {
                while let Ok(newer) = request_rx.try_recv() {
                    request = newer;
                }
                let response = match bridge.as_ref() {
                    Some(client) => client.preview(&request.path),
                    None => load_local_preview(&repo_root, &request.path),
                }
                .map_err(|error| error.to_string());
                let _ = result_tx.send(PreviewEvent {
                    id: request.id,
                    response,
                });
            }
        })?;
    Ok(())
}

impl App {
    pub fn new(
        repo_root: PathBuf,
        git_diff_args: Vec<String>,
        experience: Experience,
        diff_context: DiffContext,
        search_client: Option<SearchClient>,
    ) -> Result<Self> {
        let empty_spool = diffing_core::project_storage_dir(repo_root.to_str().unwrap_or("."))
            .join("diff-index")
            .join("pending.patch");
        let index = Arc::new(DiffIndex::empty(now_ms(), empty_spool, false));
        let render_metadata = DiffRenderMetadata::new(&index);
        let image_diff = ImageDiffManager::new(repo_root.clone())?;
        let shared_index = Arc::new(RwLock::new(index.clone()));
        let (index_tx, index_rx) = mpsc::channel();
        let default_context_lines = context_lines_from_args(&git_diff_args).unwrap_or(3);
        spawn_index_worker(repo_root.clone(), git_diff_args.clone(), index_tx.clone())?;
        let agent_api = (experience == Experience::Review)
            .then(|| {
                AgentApi::start(
                    repo_root.to_string_lossy().into_owned(),
                    shared_index.clone(),
                )
            })
            .transpose()?;
        let files = Vec::new();
        let file_tree = FileTree::build(&files);
        let repo_str = repo_root.to_str().unwrap_or(".");
        let persisted = crate::persistence::load(repo_str);
        let (search_request_tx, search_request_rx) = mpsc::channel();
        let (search_result_tx, search_result_rx) = mpsc::channel();
        let (preview_request_tx, preview_request_rx) = mpsc::channel();
        let (preview_result_tx, preview_result_rx) = mpsc::channel();
        let search_worker = Arc::new(SearchWorkerContext {
            bridge: search_client.clone(),
            index: shared_index.clone(),
            symbol_cache: Mutex::new(HashMap::new()),
        });
        spawn_search_worker(search_worker.clone(), search_request_rx, search_result_tx)?;
        spawn_preview_worker(
            search_client.clone(),
            repo_root.clone(),
            preview_request_rx,
            preview_result_tx,
        )?;
        let theme = persisted.theme;
        let lsp = LspManager::new(
            repo_root.clone(),
            persisted.intelligence_mode,
            persisted.trust_repo_local_bin,
        );
        let store = FileCommentStore::new(repo_str);
        let comments = store.load().unwrap_or_default();
        let last_comment_count = comments.len();
        let storage_dir = diffing_core::comments::comments_path(repo_str)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| repo_root.clone());
        std::fs::create_dir_all(&storage_dir)?;
        let watcher = CommentsWatcher::start(&storage_dir)?;
        let repo_watcher = RepoWatcher::start(&repo_root);
        let agent_status = AgentStatus::Idle;
        Ok(Self {
            repo_root,
            index,
            shared_index,
            index_tx,
            index_rx,
            git_diff_args,
            default_context_lines,
            context_lines: default_context_lines,
            indexing: true,
            reindex_pending: false,
            refresh_anchor: None,
            agent_api,
            files,
            file_tree,
            experience,
            diff_context,
            viewed_paths: persisted.viewed_files,
            focus: Focus::Diff,
            mode: Mode::Normal,
            wrap: persisted.wrap,
            split: persisted.split,
            file_display: if experience == Experience::Viewer {
                FileDisplay::Continuous
            } else {
                persisted.file_display
            },
            tab_size: persisted.tab_size,
            editorconfig: EditorConfigCache::default(),
            line_numbers: persisted.line_numbers,
            mouse_enabled: persisted.mouse_enabled,
            trust_repo_local_bin: persisted.trust_repo_local_bin,
            theme,
            palette: Palette::for_terminal(theme),
            scroll: 0,
            cursor_row: 0,
            continuous_scroll: 0,
            continuous_cursor: 0,
            viewport_height: 1,
            render_metadata,
            diff_render_cache: DiffRenderCache::default(),
            rendered_diff_rows: Vec::new(),
            pointer_overlay_dirty: false,
            image_diff,
            image_view: ImageViewState::default(),
            active_image_key: None,
            horizontal_offset: 0,
            code_column: None,
            lsp,
            lsp_active_path: None,
            lsp_last_state: ServerState::Unavailable,
            lsp_revision: 0,
            queued_lsp: None,
            pending_lsp: None,
            hover_content: None,
            hover_scroll: 0,
            visual_anchor: None,
            pending_comment_target: None,
            pending_editor: None,
            sidebar_width: persisted.sidebar_width,
            comment_height: persisted.comment_height,
            sidebar_visible: persisted.sidebar_visible,
            comments_visible: experience == Experience::Review && persisted.comments_visible,
            regions: UiRegions::default(),
            drag: None,
            mouse_position: None,
            theme_cursor: 0,
            theme_original: theme,
            theme_return_to_settings: false,
            help_scroll: 0,
            settings_state: SettingsState::default(),
            keymap: Keymap::default(),
            modal_input: String::new(),
            modal_cursor: 0,
            search_cursor: 0,
            search_client,
            search_scope: SearchScope::All,
            search_changed_only: false,
            search_regex: false,
            repo_search_hits: Vec::new(),
            repo_search_total: None,
            repo_search_indexing: false,
            repo_search_loading: false,
            repo_search_error: None,
            repo_search_notice: None,
            repo_search_query: String::new(),
            search_request_id: 0,
            search_request_tx,
            search_result_rx,
            _search_worker: search_worker,
            changed_paths_cache: None,
            status_bar_memo: None,
            search_preview: None,
            search_preview_loading: false,
            search_preview_error: None,
            search_preview_scroll: 0,
            search_preview_focused: false,
            preview_request_id: 0,
            preview_request_tx,
            preview_result_rx,
            file_tree_scroll: 0,
            file_filter_mode: FileFilterMode::All,
            status_message: None,
            status_message_at: None,
            pending_delete_id: None,
            pending_resolve_all: false,
            last_ctrl_c_at: None,
            quit: false,
            tracker: TrackerState::new(),
            comment_detail_scroll: 0,
            comments,
            comments_revision: 1,
            comment_store: store,
            comment_form: None,
            send_review: None,
            toasts: Vec::new(),
            agent_status,
            review_round: 0,
            last_comment_count,
            watcher,
            repo_watcher,
        })
    }

    pub fn tick_index(&mut self) -> bool {
        let mut newest = None;
        while let Ok(event) = self.index_rx.try_recv() {
            match event {
                IndexEvent::Snapshot(snapshot)
                    if newest
                        .as_ref()
                        .map(|current: &DiffIndex| current.generation <= snapshot.generation)
                        .unwrap_or(true) =>
                {
                    newest = Some(snapshot)
                }
                IndexEvent::Snapshot(_) => {}
                IndexEvent::Failed(error) => {
                    self.status_message = Some(format!("diff index failed: {error}"));
                    self.indexing = false;
                    self.refresh_anchor = None;
                }
            }
        }
        let Some(snapshot) = newest else {
            return false;
        };
        let selected_path = self
            .file_tree
            .active_file_idx()
            .and_then(|index| self.files.get(index))
            .map(|file| file.display_path().to_path_buf());
        self.files = metadata_files(&snapshot);
        self.editorconfig.clear();
        self.visual_anchor = None;
        self.file_tree = FileTree::build(&self.files);
        for index in 0..self.files.len() {
            let viewed = self
                .files
                .get(index)
                .map(|file| self.viewed_paths.contains(file.display_path()))
                .unwrap_or(false);
            self.file_tree.set_viewed(index, viewed);
        }
        if let Some(path) = selected_path {
            if let Some(file_index) = self
                .files
                .iter()
                .position(|file| file.display_path() == path)
            {
                self.file_tree.jump_to_file(file_index);
            }
        }
        let complete = snapshot.complete;
        self.render_metadata.rebuild(&snapshot);
        self.index = Arc::new(snapshot);
        self.apply_file_filter();
        self.lsp_active_path = None;
        self.changed_paths_cache = None;
        self.status_bar_memo = None;
        if let Ok(mut shared) = self.shared_index.write() {
            *shared = self.index.clone();
        }
        self.clamp_cursor();
        if complete {
            self.restore_refresh_anchor();
            self.indexing = false;
            if self.reindex_pending {
                self.reindex_pending = false;
                self.start_reindex();
            }
        }
        if self.mode == Mode::Search {
            self.queue_repo_search();
        }
        true
    }

    pub fn reload_comments(&mut self) {
        self.reload_comments_with_notifications(true);
    }

    fn reload_comments_with_notifications(&mut self, notify: bool) {
        match self.comment_store.load() {
            Ok(comments) => {
                let detail_id = (self.mode == Mode::CommentDetail)
                    .then(|| {
                        self.comments
                            .get(self.tracker.cursor)
                            .map(|comment| comment.id.clone())
                    })
                    .flatten();
                let delta = comments.len() as isize - self.last_comment_count as isize;
                let reply_delta = comments
                    .iter()
                    .map(|comment| comment.replies.len())
                    .sum::<usize>()
                    .saturating_sub(
                        self.comments
                            .iter()
                            .map(|comment| comment.replies.len())
                            .sum::<usize>(),
                    );
                if notify && delta > 0 {
                    self.toasts.push(Toast::info(format!(
                        "{} new comment{}",
                        delta,
                        if delta == 1 { "" } else { "s" }
                    )));
                } else if notify && reply_delta > 0 {
                    self.toasts.push(Toast::info(format!(
                        "{} new repl{}",
                        reply_delta,
                        if reply_delta == 1 { "y" } else { "ies" }
                    )));
                } else if notify && comments != self.comments {
                    self.toasts
                        .push(Toast::info("review threads updated".to_string()));
                }
                self.comments = comments;
                self.comments_revision = self.comments_revision.wrapping_add(1);
                self.last_comment_count = self.comments.len();
                if let Some(detail_id) = detail_id {
                    if let Some(index) = self
                        .comments
                        .iter()
                        .position(|comment| comment.id == detail_id)
                    {
                        self.tracker.cursor = index;
                    } else {
                        self.mode = Mode::Normal;
                        self.pending_delete_id = None;
                        self.status_message
                            .get_or_insert_with(|| "thread was removed while open".to_string());
                    }
                }
                if !self
                    .tracker
                    .visible_indices(&self.comments)
                    .contains(&self.tracker.cursor)
                {
                    if self.mode == Mode::CommentDetail {
                        self.mode = Mode::Normal;
                        self.status_message.get_or_insert_with(|| {
                            "thread no longer matches the active filters".to_string()
                        });
                    }
                    self.tracker.normalize_filter_cursor(&self.comments);
                }
                self.apply_file_filter();
            }
            Err(e) => {
                self.status_message = Some(format!("reload failed: {e}"));
            }
        }
    }

    pub fn tick_watcher(&mut self) -> bool {
        let mut dirty = false;
        while self.watcher.try_recv().is_some() {
            dirty = true;
        }
        if dirty {
            self.reload_comments();
        }
        dirty
    }

    pub fn poll_background(&mut self) -> bool {
        let status_expired = self.tick_status_message_ttl();
        let pointer_dirty = std::mem::take(&mut self.pointer_overlay_dirty);
        let repo_dirty = self.tick_repo_watcher();
        let review_dirty = if self.experience == Experience::Review {
            self.tick_watcher()
        } else {
            false
        };
        self.tick_index()
            | self.tick_search()
            | self.tick_search_preview()
            | self.tick_lsp()
            | self.image_diff.poll()
            | self.tick_toasts()
            | review_dirty
            | repo_dirty
            | pointer_dirty
            | status_expired
    }

    fn tick_status_message_ttl(&mut self) -> bool {
        const STATUS_TTL: std::time::Duration = std::time::Duration::from_secs(4);
        if self
            .status_message_at
            .is_some_and(|started| started.elapsed() > STATUS_TTL)
        {
            self.status_message = None;
            self.status_message_at = None;
            return true;
        }
        false
    }

    fn set_status_message(&mut self, message: impl Into<String>) {
        self.status_message = Some(message.into());
        self.status_message_at = Some(std::time::Instant::now());
    }

    fn tick_search(&mut self) -> bool {
        let mut dirty = false;
        while let Ok(event) = self.search_result_rx.try_recv() {
            if event.id != self.search_request_id {
                continue;
            }
            self.repo_search_loading = false;
            match event.response {
                Ok(response) => {
                    let changed_paths = self.changed_paths_set();
                    self.repo_search_hits = diff_first_search_hits(response.hits, &changed_paths);
                    self.repo_search_total = response.total;
                    self.repo_search_indexing = response.indexing;
                    self.repo_search_error = response.error;
                    self.repo_search_notice = response.notice;
                    self.search_cursor = self
                        .search_cursor
                        .min(self.repo_search_hits.len().saturating_sub(1));
                    self.queue_search_preview();
                }
                Err(error) => {
                    self.repo_search_hits.clear();
                    self.repo_search_total = None;
                    self.repo_search_error = Some(error);
                    self.repo_search_notice = None;
                    self.clear_search_preview();
                }
            }
            dirty = true;
        }
        dirty
    }

    fn tick_search_preview(&mut self) -> bool {
        let mut dirty = false;
        while let Ok(event) = self.preview_result_rx.try_recv() {
            if event.id != self.preview_request_id {
                continue;
            }
            self.search_preview_loading = false;
            match event.response {
                Ok(preview) => {
                    self.search_preview = Some(preview);
                    self.search_preview_error = None;
                }
                Err(error) => {
                    self.search_preview = None;
                    self.search_preview_error = Some(error);
                }
            }
            dirty = true;
        }
        dirty
    }

    fn tick_lsp(&mut self) -> bool {
        let mut dirty = false;
        let revision = self.lsp.diagnostics_revision();
        if revision != self.lsp_revision {
            self.lsp_revision = revision;
            dirty = true;
        }

        let path = self
            .file_tree
            .active_file_idx()
            .and_then(|index| self.files.get(index))
            .map(|file| file.display_path().to_path_buf());
        if path != self.lsp_active_path {
            if let Some(previous) = self.lsp_active_path.take() {
                let _ = self.lsp.close_document(&previous);
            }
            self.code_column = None;
            self.queued_lsp = None;
            self.cancel_pending_language_request();
        }
        if let Some(path) = path {
            if self.lsp_active_path.is_none() || self.lsp_last_state == ServerState::Starting {
                let previous = self.lsp_last_state;
                self.lsp_last_state = match self.lsp.sync_document(&path) {
                    Ok(state) => state,
                    Err(error) => {
                        self.status_message = Some(format!("language server: {error}"));
                        ServerState::Error
                    }
                };
                self.lsp_active_path = Some(path.clone());
                dirty |= previous != self.lsp_last_state;
                if let Some(warning) = self.lsp.take_sync_warning() {
                    self.status_message = Some(warning);
                } else if self.lsp_last_state == ServerState::Ready {
                    if let Some(label) = self.lsp.resolved_command_label(&path) {
                        self.status_message = Some(format!("language server: {label}"));
                    }
                }
            }
        }

        if self.lsp_last_state == ServerState::Ready {
            if let Some(kind) = self.queued_lsp.take() {
                self.start_language_request(kind);
                dirty = true;
            }
        }

        if let Some(token) = self.pending_lsp.clone() {
            if let Some(response) = self.lsp.take_response(&token) {
                self.pending_lsp = None;
                match response {
                    Ok(LanguageResponse::Hover(Some(content))) => {
                        self.hover_content = Some(content);
                        self.hover_scroll = 0;
                        self.mode = Mode::Hover;
                    }
                    Ok(LanguageResponse::Hover(None)) => {
                        self.status_message =
                            Some("no hover information at this symbol".to_string());
                    }
                    Ok(LanguageResponse::Definition(targets)) => {
                        self.open_definition(targets);
                    }
                    Err(error) => {
                        self.status_message = Some(format!("language request failed: {error}"));
                    }
                }
                dirty = true;
            }
        }
        dirty
    }

    fn request_language(&mut self, kind: RequestKind) {
        self.cancel_pending_language_request();
        let Some((path, _, _)) = self.current_language_position() else {
            self.status_message = Some(
                "language actions require an added or context line in a supported file".to_string(),
            );
            return;
        };
        match self.lsp.sync_document(&path) {
            Ok(ServerState::Ready) => self.start_language_request(kind),
            Ok(ServerState::Starting) => {
                self.queued_lsp = Some(kind);
                self.lsp_last_state = ServerState::Starting;
                self.lsp_active_path = Some(path);
                self.status_message = Some("language server starting…".to_string());
            }
            Ok(ServerState::Off) => {
                self.status_message = Some("language intelligence is off in Settings".to_string());
            }
            Ok(ServerState::Unavailable) => {
                let server = LspManager::expected_server(&path).unwrap_or("language server");
                self.status_message = Some(if self.trust_repo_local_bin {
                    format!("{server} was not found in PATH or node_modules/.bin")
                } else {
                    format!(
                        "{server} was not found in PATH · enable repo-local trust in Settings to use node_modules/.bin"
                    )
                });
            }
            Ok(ServerState::Error) | Err(_) => {
                self.status_message = Some("language server could not start".to_string());
            }
        }
    }

    fn start_language_request(&mut self, kind: RequestKind) {
        let Some((path, line, character)) = self.current_language_position() else {
            self.status_message = Some("current diff row has no working-tree position".to_string());
            return;
        };
        let request = match kind {
            RequestKind::Hover => self.lsp.request_hover(&path, line, character),
            RequestKind::Definition => self.lsp.request_definition(&path, line, character),
        };
        match request {
            Ok(token) => {
                self.pending_lsp = Some(token);
                self.status_message = Some(match kind {
                    RequestKind::Hover => "loading hover…".to_string(),
                    RequestKind::Definition => "finding definition…".to_string(),
                });
            }
            Err(error) => {
                self.status_message = Some(format!("language request failed: {error}"));
            }
        }
    }

    fn cancel_pending_language_request(&mut self) {
        if let Some(token) = self.pending_lsp.take() {
            self.lsp.cancel_request(&token);
        }
    }

    fn current_language_position(&self) -> Option<(PathBuf, u32, u32)> {
        let file = self.current_file()?;
        let path = file.display_path().to_path_buf();
        let ViewRow::Line {
            kind,
            new_lineno,
            content,
            ..
        } = self.current_view_row()?
        else {
            return None;
        };
        if kind == IndexedLineKind::Del {
            return None;
        }
        let line = new_lineno?.checked_sub(1)?;
        let character_count = content.chars().count();
        let column = self.effective_code_column().min(character_count);
        Some((path, line, utf16_column(&content, column)))
    }

    fn effective_code_column(&self) -> usize {
        self.code_column.unwrap_or_else(|| {
            self.current_line_content()
                .chars()
                .position(|character| !character.is_whitespace())
                .unwrap_or(0)
        })
    }

    fn open_definition(&mut self, targets: Vec<DefinitionTarget>) {
        let Some(target) = targets.first() else {
            self.status_message = Some("no definition found".to_string());
            return;
        };
        let extra = targets.len().saturating_sub(1);
        let relative = target
            .path
            .strip_prefix(&self.repo_root)
            .unwrap_or(&target.path)
            .to_path_buf();
        let line_number = target.line.saturating_add(1);
        let Some(file_index) = self
            .files
            .iter()
            .position(|file| file.display_path() == relative)
        else {
            self.status_message = Some(format!(
                "definition: {}:{}:{}{}",
                relative.display(),
                line_number,
                target.character.saturating_add(1),
                if extra == 0 {
                    String::new()
                } else {
                    format!(" (+{extra})")
                }
            ));
            return;
        };
        let row = self
            .index
            .find_line_row(file_index, IndexedLineKind::Add, line_number)
            .ok()
            .flatten();
        let Some(row) = row else {
            self.status_message = Some(format!(
                "definition is outside the visible diff: {}:{}",
                relative.display(),
                line_number
            ));
            return;
        };
        self.reveal_file_for_direct_jump(file_index);
        self.focus = Focus::Diff;
        self.cursor_row = row;
        self.code_column = self
            .index
            .viewport(file_index, row, 1, 64 * 1024)
            .ok()
            .and_then(|page| page.rows.into_iter().next())
            .and_then(|view_row| match view_row {
                ViewRow::Line { content, .. } => {
                    Some(character_column_from_utf16(&content, target.character))
                }
                _ => None,
            })
            .or(Some(target.character as usize));
        if self.file_display == FileDisplay::Continuous {
            self.continuous_cursor = self.continuous_offset_for_file(file_index) + row;
            self.continuous_scroll = self
                .continuous_cursor
                .saturating_sub((self.viewport_height / 2) as u64);
        } else {
            self.scroll = row.saturating_sub((self.viewport_height / 2) as u64) as usize;
        }
        self.status_message = Some(format!("→ {}:{line_number}", relative.display()));
    }

    fn tick_toasts(&mut self) -> bool {
        let previous = self.toasts.len();
        self.toasts.retain(|toast| !toast.is_expired());
        self.toasts.len() != previous
    }

    fn tick_repo_watcher(&mut self) -> bool {
        let relevant = self
            .repo_watcher
            .as_ref()
            .is_some_and(RepoWatcher::try_recv);
        if relevant {
            if self.indexing {
                self.reindex_pending = true;
            } else {
                self.start_reindex();
            }
        }
        relevant
    }

    fn start_reindex(&mut self) {
        if self.refresh_anchor.is_none() {
            self.refresh_anchor = self.capture_refresh_anchor();
        }
        let git_diff_args = with_context_lines(&self.git_diff_args, self.context_lines);
        match spawn_index_worker(self.repo_root.clone(), git_diff_args, self.index_tx.clone()) {
            Ok(()) => {
                self.indexing = true;
                self.status_message = Some("refreshing diff index…".to_string());
            }
            Err(error) => {
                self.status_message = Some(format!("could not refresh diff: {error}"));
                self.refresh_anchor = None;
            }
        }
    }

    fn capture_refresh_anchor(&self) -> Option<RefreshAnchor> {
        let file_index = self.file_tree.active_file_idx()?;
        let path = self.files.get(file_index)?.display_path().to_path_buf();
        let ViewRow::Line {
            kind,
            old_lineno,
            new_lineno,
            ..
        } = self.current_view_row()?
        else {
            return None;
        };
        let line = match kind {
            IndexedLineKind::Del => old_lineno,
            _ => new_lineno.or(old_lineno),
        }?;
        let viewport_offset = if self.file_display == FileDisplay::Continuous {
            self.continuous_cursor
                .saturating_sub(self.continuous_scroll)
        } else {
            self.cursor_row.saturating_sub(self.scroll as u64)
        };
        Some(RefreshAnchor {
            path,
            kind,
            line,
            viewport_offset,
        })
    }

    fn restore_refresh_anchor(&mut self) {
        let Some(anchor) = self.refresh_anchor.take() else {
            return;
        };
        let Some(file_index) = self
            .files
            .iter()
            .position(|file| file.display_path() == anchor.path)
        else {
            return;
        };
        if !self
            .file_tree
            .navigable_file_indices()
            .contains(&file_index)
        {
            return;
        }
        let Some(row) = self
            .index
            .find_line_row(file_index, anchor.kind, anchor.line)
            .ok()
            .flatten()
        else {
            return;
        };
        self.file_tree.jump_to_file(file_index);
        self.cursor_row = row;
        if self.file_display == FileDisplay::Continuous {
            self.continuous_cursor = self.continuous_offset_for_file(file_index) + row;
            self.continuous_scroll = self
                .continuous_cursor
                .saturating_sub(anchor.viewport_offset);
        } else {
            self.scroll = row.saturating_sub(anchor.viewport_offset) as usize;
        }
    }

    fn change_context(&mut self, expand: bool) {
        let next = if expand {
            match self.context_lines {
                0..=3 => 10,
                4..=10 => 25,
                11..=25 => 100,
                26..=100 => 500,
                current => current.saturating_mul(2).min(10_000),
            }
        } else {
            match self.context_lines {
                0..=10 => self.default_context_lines,
                11..=25 => 10,
                26..=100 => 25,
                101..=500 => 100,
                _ => 500,
            }
            .max(self.default_context_lines)
        };
        if next == self.context_lines {
            self.status_message = Some(format!("context: {} lines", self.context_lines));
            return;
        }
        self.context_lines = next;
        if self.indexing {
            self.reindex_pending = true;
        } else {
            self.start_reindex();
        }
        self.status_message = Some(format!("loading {} lines of context…", next));
    }

    pub fn handle_key(&mut self, key: crossterm::event::KeyEvent) {
        if self.handle_global_quit(key) {
            return;
        }
        match self.mode {
            Mode::CommentForm => self.handle_form_key(key),
            Mode::SendReview => self.handle_send_review_key(key),
            Mode::Search => self.handle_search_key(key),
            Mode::Command => self.handle_command_key(key),
            Mode::ThemePicker => self.handle_theme_picker_key(key),
            Mode::Settings => self.handle_settings_key(key),
            Mode::Hover => self.handle_hover_key(key),
            Mode::ImagePreview => self.handle_image_preview_key(key),
            Mode::CommentDetail => self.handle_comment_detail_key(key),
            Mode::Help => self.handle_help_key(key),
            Mode::Normal => {
                if self.image_focus_active() && self.try_handle_image_key(key) {
                    self.keymap.clear();
                    return;
                }
                if let Some(command) = self.keymap.feed(&key) {
                    if matches!(command.action, Action::ExpandContext)
                        && self.focus == Focus::FileTree
                        && key.code == crossterm::event::KeyCode::Enter
                    {
                        if self.file_tree.selected_file_idx().is_some() {
                            self.focus = Focus::Diff;
                        } else {
                            self.file_tree.toggle_selected();
                        }
                        return;
                    }
                    self.dispatch_command(command);
                    return;
                }
                if self.keymap.pending_display().is_empty()
                    && key.code == crossterm::event::KeyCode::Esc
                    && self.visual_anchor.take().is_some()
                {
                    self.status_message = Some("line selection cancelled".to_string());
                }
            }
        }
    }

    fn handle_global_quit(&mut self, key: crossterm::event::KeyEvent) -> bool {
        use crossterm::event::{KeyCode, KeyModifiers};
        if key.code != KeyCode::Char('c') || !key.modifiers.contains(KeyModifiers::CONTROL) {
            return false;
        }
        let in_text_entry = matches!(self.mode, Mode::CommentForm | Mode::SendReview);
        if in_text_entry {
            let has_draft = self.text_entry_has_draft();
            let now = std::time::Instant::now();
            let double_tap = self.last_ctrl_c_at.is_some_and(|previous| {
                now.duration_since(previous) < std::time::Duration::from_secs(1)
            });
            self.last_ctrl_c_at = Some(now);
            if has_draft && double_tap {
                self.quit = true;
                return true;
            }
            self.cancel_text_entry();
            return true;
        }
        self.quit = true;
        true
    }

    fn text_entry_has_draft(&self) -> bool {
        if let Some(form) = &self.comment_form {
            return !form.body().trim().is_empty();
        }
        if let Some(send) = &self.send_review {
            return !send.body().trim().is_empty();
        }
        false
    }

    fn cancel_text_entry(&mut self) {
        match self.mode {
            Mode::CommentForm => {
                self.comment_form = None;
                self.pending_comment_target = None;
                self.mode = Mode::Normal;
                self.set_status_message("comment cancelled");
            }
            Mode::SendReview => {
                self.send_review = None;
                self.mode = Mode::Normal;
                self.set_status_message("send cancelled");
            }
            _ => {}
        }
    }

    /// Apply a mouse event and report whether it can change visible output.
    /// Pointer motion is common and may be emitted at a much higher rate than
    /// terminal frames; only crossing a hoverable row or toolbar target needs
    /// a redraw.
    pub fn handle_mouse(&mut self, mouse: crossterm::event::MouseEvent) -> bool {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let previous_target = self.regions.pointer_visual_target(self.mouse_position);
        let previous_diff_target = self.pointer_diff_target(self.mouse_position);
        let moved = matches!(mouse.kind, MouseEventKind::Moved);
        if !self.mouse_enabled {
            self.mouse_position = None;
            self.drag = None;
            return previous_target != PointerVisualTarget::None;
        }
        self.mouse_position = Some((mouse.column, mouse.row));

        if moved {
            return previous_target
                != self
                    .regions
                    .pointer_visual_target(Some((mouse.column, mouse.row)))
                || previous_diff_target
                    != self.pointer_diff_target(Some((mouse.column, mouse.row)));
        }

        if self.mode == Mode::ThemePicker {
            match mouse.kind {
                MouseEventKind::ScrollDown => {
                    let len = self.filtered_themes().len();
                    if len > 0 {
                        self.theme_cursor = (self.theme_cursor + 3).min(len - 1);
                        self.preview_theme_at_cursor();
                    }
                }
                MouseEventKind::ScrollUp => {
                    self.theme_cursor = self.theme_cursor.saturating_sub(3);
                    self.preview_theme_at_cursor();
                }
                MouseEventKind::Down(MouseButton::Left) => {
                    if let Some(input) = self
                        .regions
                        .modal_input
                        .filter(|area| contains(*area, mouse.column, mouse.row))
                    {
                        self.place_modal_cursor("/ ", input, mouse.column);
                    } else if let Some((_, theme)) = self
                        .regions
                        .theme_rows
                        .iter()
                        .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                        .copied()
                    {
                        self.theme = theme;
                        self.palette = Palette::for_terminal(theme);
                        self.persist_settings();
                        self.status_message = Some(format!("theme: {}", theme.display_name()));
                        self.mode = if self.theme_return_to_settings {
                            Mode::Settings
                        } else {
                            Mode::Normal
                        };
                        self.clear_modal_input();
                    }
                }
                _ => {}
            }
            return true;
        }

        if self.mode == Mode::Settings {
            match mouse.kind {
                MouseEventKind::ScrollDown => self.settings_state.move_cursor(1),
                MouseEventKind::ScrollUp => self.settings_state.move_cursor(-1),
                MouseEventKind::Down(MouseButton::Left) => {
                    if let Some(root) = self.regions.root {
                        if let Some(index) =
                            settings_row_at(&self.settings_state, root, mouse.column, mouse.row)
                        {
                            self.settings_state.cursor = index;
                            self.activate_setting(1);
                        }
                    }
                }
                _ => {}
            }
            return true;
        }

        if self.mode == Mode::Hover {
            match mouse.kind {
                MouseEventKind::ScrollDown => {
                    self.hover_scroll = self.hover_scroll.saturating_add(3)
                }
                MouseEventKind::ScrollUp => self.hover_scroll = self.hover_scroll.saturating_sub(3),
                MouseEventKind::Down(MouseButton::Left) => {
                    self.mode = Mode::Normal;
                    self.hover_content = None;
                }
                _ => {}
            }
            return true;
        }

        if self.mode == Mode::Help {
            match mouse.kind {
                MouseEventKind::ScrollDown => self.help_scroll = self.help_scroll.saturating_add(3),
                MouseEventKind::ScrollUp => self.help_scroll = self.help_scroll.saturating_sub(3),
                _ => {}
            }
            return true;
        }

        if self.mode == Mode::ImagePreview {
            match mouse.kind {
                MouseEventKind::ScrollDown => self.image_view.zoom_out(),
                MouseEventKind::ScrollUp => self.image_view.zoom_in(),
                MouseEventKind::Down(MouseButton::Left) => {
                    if let Some(control) = self
                        .regions
                        .image_controls
                        .iter()
                        .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                        .map(|(_, control)| *control)
                    {
                        match control {
                            ImageControl::Mode(mode) => self.image_view.mode = mode,
                            ImageControl::ZoomOut => self.image_view.zoom_out(),
                            ImageControl::Reset => self.image_view.reset(),
                            ImageControl::ZoomIn => self.image_view.zoom_in(),
                            ImageControl::Close => self.mode = Mode::Normal,
                        }
                    }
                }
                _ => {}
            }
            return true;
        }

        if self.mode == Mode::CommentDetail {
            match mouse.kind {
                MouseEventKind::ScrollDown => {
                    self.comment_detail_scroll = self.comment_detail_scroll.saturating_add(3)
                }
                MouseEventKind::ScrollUp => {
                    self.comment_detail_scroll = self.comment_detail_scroll.saturating_sub(3)
                }
                MouseEventKind::Down(MouseButton::Left) => {
                    if let Some(control) = self
                        .regions
                        .comment_detail_controls
                        .iter()
                        .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                        .map(|(_, control)| *control)
                    {
                        if control != CommentDetailControl::Delete {
                            self.pending_delete_id = None;
                        }
                        match control {
                            CommentDetailControl::Jump => {
                                self.mode = Mode::Normal;
                                self.jump_to_focused_comment();
                            }
                            CommentDetailControl::Edit => self.open_edit_form_for_focused(),
                            CommentDetailControl::Reply => self.open_reply_form_for_focused(),
                            CommentDetailControl::Resolve => self.resolve_focused(),
                            CommentDetailControl::Delete => self.delete_focused(),
                            CommentDetailControl::Close => self.mode = Mode::Normal,
                        }
                    }
                }
                _ => {}
            }
            return true;
        }

        if self.mode == Mode::Search {
            match mouse.kind {
                MouseEventKind::ScrollDown => {
                    if self
                        .regions
                        .search_preview
                        .is_some_and(|area| contains(area, mouse.column, mouse.row))
                    {
                        self.search_preview_scroll = self.search_preview_scroll.saturating_add(4);
                    } else {
                        self.move_search_cursor(3);
                    }
                }
                MouseEventKind::ScrollUp => {
                    if self
                        .regions
                        .search_preview
                        .is_some_and(|area| contains(area, mouse.column, mouse.row))
                    {
                        self.search_preview_scroll = self.search_preview_scroll.saturating_sub(4);
                    } else {
                        self.move_search_cursor(-3);
                    }
                }
                MouseEventKind::Down(MouseButton::Left) => {
                    if let Some(scope) = self
                        .regions
                        .search_scopes
                        .iter()
                        .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                        .map(|(_, scope)| *scope)
                    {
                        self.search_scope = scope;
                        if scope != SearchScope::Text {
                            self.search_regex = false;
                        }
                        self.search_cursor = 0;
                        self.queue_repo_search();
                    } else if self
                        .regions
                        .search_changed
                        .is_some_and(|area| contains(area, mouse.column, mouse.row))
                    {
                        self.toggle_search_changed_only();
                    } else if self
                        .regions
                        .search_regex
                        .is_some_and(|area| contains(area, mouse.column, mouse.row))
                    {
                        self.toggle_search_regex();
                    } else if let Some(index) = self
                        .regions
                        .search_results
                        .iter()
                        .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                        .map(|(_, index)| *index)
                    {
                        let activate = self.search_cursor == index;
                        self.search_cursor = index;
                        self.queue_search_preview();
                        if activate {
                            self.activate_repo_search_hit();
                        }
                    } else if let Some(input) = self
                        .regions
                        .modal_input
                        .filter(|area| contains(*area, mouse.column, mouse.row))
                    {
                        self.place_modal_cursor("/ ", input, mouse.column);
                    }
                }
                _ => {}
            }
            return true;
        }

        if self.mode == Mode::SendReview {
            if self.send_review.is_none() {
                self.mode = Mode::Normal;
                return true;
            }
            let Some(root) = self.regions.root else {
                return true;
            };
            let regions = send_review_regions(root);
            match mouse.kind {
                MouseEventKind::Down(MouseButton::Left) => {
                    if contains(regions.send_button, mouse.column, mouse.row) {
                        self.submit_send_review();
                    } else if contains(regions.cancel_button, mouse.column, mouse.row) {
                        self.send_review = None;
                        self.mode = Mode::Normal;
                        self.status_message = Some("send cancelled".to_string());
                    } else if let Some(decision) = regions
                        .verdict_rows
                        .iter()
                        .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                        .map(|(_, decision)| *decision)
                    {
                        if let Some(state) = self.send_review.as_mut() {
                            state.verdict = decision;
                            state.focused = SendField::Verdict;
                        }
                    } else if contains(regions.general, mouse.column, mouse.row) {
                        if let Some(state) = self.send_review.as_mut() {
                            state.focused = SendField::General;
                        }
                    }
                }
                MouseEventKind::ScrollDown | MouseEventKind::ScrollUp
                    if contains(regions.general, mouse.column, mouse.row) =>
                {
                    if let Some(state) = self.send_review.as_mut() {
                        state.focused = SendField::General;
                        let code = if mouse.kind == MouseEventKind::ScrollDown {
                            crossterm::event::KeyCode::PageDown
                        } else {
                            crossterm::event::KeyCode::PageUp
                        };
                        state
                            .general
                            .input(crossterm::event::KeyEvent::new(code, KeyModifiers::NONE));
                    }
                }
                MouseEventKind::ScrollDown | MouseEventKind::ScrollUp => {
                    if let Some(state) = self.send_review.as_mut() {
                        state.focused = SendField::Verdict;
                        state.cycle_verdict(if mouse.kind == MouseEventKind::ScrollDown {
                            1
                        } else {
                            -1
                        });
                    }
                }
                _ => {}
            }
            return true;
        }

        if self.mode == Mode::CommentForm {
            let Some(root) = self.regions.root else {
                return true;
            };
            let regions = comment_form_regions(root);
            match mouse.kind {
                MouseEventKind::Down(MouseButton::Left) => {
                    if contains(regions.save_button, mouse.column, mouse.row) {
                        self.submit_form();
                    } else if contains(regions.cancel_button, mouse.column, mouse.row) {
                        self.comment_form = None;
                        self.pending_comment_target = None;
                        self.mode = Mode::Normal;
                        self.status_message = Some("comment cancelled".to_string());
                    } else if contains(regions.severity_button, mouse.column, mouse.row) {
                        if let Some(form) = self.comment_form.as_mut() {
                            if form.kind == crate::ui::comment_form::FormKind::New {
                                form.cycle_severity();
                            }
                        }
                    }
                }
                MouseEventKind::ScrollDown | MouseEventKind::ScrollUp
                    if contains(regions.body, mouse.column, mouse.row) =>
                {
                    if let Some(form) = self.comment_form.as_mut() {
                        let code = if mouse.kind == MouseEventKind::ScrollDown {
                            crossterm::event::KeyCode::PageDown
                        } else {
                            crossterm::event::KeyCode::PageUp
                        };
                        form.textarea
                            .input(crossterm::event::KeyEvent::new(code, KeyModifiers::NONE));
                    }
                }
                _ => {}
            }
            return true;
        }

        // Text-entry modals own the pointer; do not let clicks leak through to
        // the diff underneath them.
        if self.mode == Mode::Command {
            if let MouseEventKind::Down(MouseButton::Left) = mouse.kind {
                if let Some(input) = self
                    .regions
                    .modal_input
                    .filter(|area| contains(*area, mouse.column, mouse.row))
                {
                    self.place_modal_cursor(":", input, mouse.column);
                }
            }
            return true;
        }

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some(toast_id) = self
                    .regions
                    .toast_rows
                    .iter()
                    .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                    .map(|(_, id)| *id)
                {
                    self.toasts.retain(|toast| toast.id != toast_id);
                    return true;
                }
                if self
                    .regions
                    .sidebar_divider
                    .map(|area| contains(area, mouse.column, mouse.row))
                    .unwrap_or(false)
                {
                    self.drag = Some(DragState::Sidebar);
                    return true;
                }
                if self
                    .regions
                    .comment_divider
                    .map(|area| contains(area, mouse.column, mouse.row))
                    .unwrap_or(false)
                {
                    self.drag = Some(DragState::Comments);
                    return true;
                }
                if let Some(action) = self
                    .regions
                    .toolbar
                    .iter()
                    .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                    .map(|(_, action)| *action)
                {
                    self.activate_toolbar(action);
                    return true;
                }
                if let Some(node) = self
                    .regions
                    .file_rows
                    .iter()
                    .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                    .map(|(_, node)| *node)
                {
                    let previous = self.file_tree.selected_file_idx();
                    self.file_tree.set_cursor(node);
                    self.focus = Focus::FileTree;
                    if self.file_tree.selected_file_idx().is_none() {
                        self.file_tree.toggle_selected();
                    } else if self.file_tree.selected_file_idx() != previous {
                        self.visual_anchor = None;
                        if self.file_display == FileDisplay::Continuous {
                            if let Some(file) = self.file_tree.selected_file_idx() {
                                let offset = self.continuous_offset_for_file(file);
                                self.continuous_cursor = offset;
                                self.continuous_scroll = offset;
                            }
                        } else {
                            self.scroll = 0;
                            self.cursor_row = 0;
                        }
                        self.horizontal_offset = 0;
                    }
                    return true;
                }
                if let Some(map) = self
                    .regions
                    .change_map
                    .filter(|area| contains(*area, mouse.column, mouse.row))
                {
                    self.jump_from_change_map(map, mouse.row);
                    return true;
                }
                if let Some((inner, _)) = self
                    .regions
                    .diff_inner
                    .zip(self.regions.diff)
                    .filter(|(inner, _)| contains(*inner, mouse.column, mouse.row))
                {
                    self.focus = Focus::Diff;
                    if let Some((file_index, logical_row)) =
                        self.diff_target_at(inner, mouse.column, mouse.row)
                    {
                        self.file_tree.jump_to_file(file_index);
                        self.cursor_row = logical_row;
                        if self.file_display == FileDisplay::Continuous {
                            self.continuous_cursor = self
                                .continuous_offset_for_file(file_index)
                                .saturating_add(logical_row)
                                .min(self.continuous_total_rows().saturating_sub(1));
                            self.sync_continuous_active();
                        }
                    }
                    return true;
                }
                if let Some(comment) = self
                    .regions
                    .comment_rows
                    .iter()
                    .find(|(area, _)| contains(*area, mouse.column, mouse.row))
                    .map(|(_, comment)| *comment)
                {
                    self.pending_delete_id = None;
                    self.tracker.cursor = comment;
                    self.focus = Focus::Tracker;
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(map) = self
                    .regions
                    .change_map
                    .filter(|area| contains(*area, mouse.column, mouse.row))
                {
                    self.jump_from_change_map(map, mouse.row);
                    return true;
                }
                match self.drag {
                    Some(DragState::Sidebar) => {
                        if let Some(root) = self.regions.root {
                            self.sidebar_width = sidebar_width_for_pointer(root, mouse.column);
                        }
                    }
                    Some(DragState::Comments) => {
                        if let Some(panel) = self.regions.comment_panel {
                            let bottom = panel.y.saturating_add(panel.height);
                            self.comment_height = bottom.saturating_sub(mouse.row).clamp(4, 20);
                        }
                    }
                    None => {}
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                if self.drag.take().is_some() {
                    self.persist_layout();
                }
            }
            MouseEventKind::ScrollDown => {
                if mouse.modifiers.contains(KeyModifiers::SHIFT) {
                    self.horizontal_offset = self.horizontal_offset.saturating_add(4);
                } else if self
                    .regions
                    .file_tree
                    .map(|area| contains(area, mouse.column, mouse.row))
                    .unwrap_or(false)
                {
                    self.focus = Focus::FileTree;
                    self.file_tree.move_cursor(3);
                } else if self
                    .regions
                    .comment_panel
                    .map(|area| contains(area, mouse.column, mouse.row))
                    .unwrap_or(false)
                {
                    self.focus = Focus::Tracker;
                    self.tracker.move_visible_cursor(3, &self.comments);
                } else if self.selected_image().is_some()
                    && self
                        .regions
                        .diff_inner
                        .map(|area| contains(area, mouse.column, mouse.row))
                        .unwrap_or(false)
                {
                    self.focus = Focus::Diff;
                    self.image_view.zoom_out();
                } else {
                    self.focus = Focus::Diff;
                    self.move_diff_cursor(3);
                }
            }
            MouseEventKind::ScrollUp => {
                if mouse.modifiers.contains(KeyModifiers::SHIFT) {
                    self.horizontal_offset = self.horizontal_offset.saturating_sub(4);
                } else if self
                    .regions
                    .file_tree
                    .map(|area| contains(area, mouse.column, mouse.row))
                    .unwrap_or(false)
                {
                    self.focus = Focus::FileTree;
                    self.file_tree.move_cursor(-3);
                } else if self
                    .regions
                    .comment_panel
                    .map(|area| contains(area, mouse.column, mouse.row))
                    .unwrap_or(false)
                {
                    self.focus = Focus::Tracker;
                    self.tracker.move_visible_cursor(-3, &self.comments);
                } else if self.selected_image().is_some()
                    && self
                        .regions
                        .diff_inner
                        .map(|area| contains(area, mouse.column, mouse.row))
                        .unwrap_or(false)
                {
                    self.focus = Focus::Diff;
                    self.image_view.zoom_in();
                } else {
                    self.focus = Focus::Diff;
                    self.move_diff_cursor(-3);
                }
            }
            MouseEventKind::ScrollLeft => {
                self.horizontal_offset = self.horizontal_offset.saturating_sub(4)
            }
            MouseEventKind::ScrollRight => {
                self.horizontal_offset = self.horizontal_offset.saturating_add(4)
            }
            _ => {}
        }
        true
    }

    fn activate_toolbar(&mut self, action: ToolbarAction) {
        match action {
            ToolbarAction::SendReview => self.open_send_review(),
        }
    }

    fn jump_from_change_map(&mut self, area: Rect, row: u16) {
        let relative = row.saturating_sub(area.y) as u64;
        let denominator = area.height.saturating_sub(1).max(1) as u64;
        if self.file_display == FileDisplay::Continuous {
            let total = self.continuous_total_rows();
            if total == 0 {
                return;
            }
            let target = relative.saturating_mul(total.saturating_sub(1)) / denominator;
            self.continuous_cursor = target;
            self.continuous_scroll = target.saturating_sub((self.viewport_height / 2) as u64);
            self.sync_continuous_active();
        } else {
            let total = self.current_file_rows();
            if total == 0 {
                return;
            }
            let target = relative.saturating_mul(total.saturating_sub(1)) / denominator;
            self.cursor_row = target;
            self.scroll = target.saturating_sub((self.viewport_height / 2) as u64) as usize;
        }
        self.focus = Focus::Diff;
        self.code_column = None;
    }

    fn dispatch_command(&mut self, command: Command) {
        if self.experience == Experience::Viewer && command.action == Action::EditComment {
            self.queue_editor_for_current_line();
            return;
        }
        if self.experience == Experience::Viewer && blocked_in_viewer(command.action) {
            self.status_message = Some("viewer mode is read-only".to_string());
            return;
        }
        if command.action != Action::DeleteComment {
            self.pending_delete_id = None;
        }
        if command.action != Action::ResolveAllComments {
            self.pending_resolve_all = false;
        }
        match command.action {
            Action::Quit => self.quit = true,
            Action::OpenSendReview => self.open_send_review(),
            Action::OpenHelp => {
                self.mode = Mode::Help;
                self.help_scroll = 0;
                self.clear_modal_input();
            }
            Action::OpenSearch => self.open_search_palette(SearchScope::All),
            Action::OpenFileFilter => self.open_search_palette(SearchScope::Files),
            Action::OpenSymbolSearch => self.open_search_palette(SearchScope::Symbols),
            Action::CycleFileFilter => {
                self.file_filter_mode = self.file_filter_mode.next();
                self.apply_file_filter();
                self.status_message = Some(format!("files: {}", self.file_filter_mode.label()));
            }
            Action::OpenCommand => {
                self.mode = Mode::Command;
                self.clear_modal_input();
            }
            Action::OpenImagePreview => self.open_image_preview(),
            Action::ToggleSidebar => self.toggle_sidebar(),
            Action::ToggleLineNumbers => {
                self.line_numbers = !self.line_numbers;
                self.persist_settings();
            }
            Action::OpenSettings => self.open_settings(),
            Action::LanguageHover => self.request_language(RequestKind::Hover),
            Action::LanguageDefinition => self.request_language(RequestKind::Definition),
            Action::CodeColumnLeft => {
                let column = self
                    .effective_code_column()
                    .saturating_sub(command.count as usize);
                self.code_column = Some(column);
                self.status_message = Some(format!("symbol column {}", column + 1));
            }
            Action::CodeColumnRight => {
                let column = self
                    .effective_code_column()
                    .saturating_add(command.count as usize);
                self.code_column = Some(column);
                self.status_message = Some(format!("symbol column {}", column + 1));
            }
            Action::ResolveAllComments => self.resolve_all_comments(),
            Action::NextSearch => self.jump_search(command.count as isize),
            Action::PrevSearch => self.jump_search(-(command.count as isize)),
            Action::NextHunk => self.jump_relative_hunk(command.count as isize),
            Action::PrevHunk => self.jump_relative_hunk(-(command.count as isize)),
            Action::CenterCursor => {
                if self.file_display == FileDisplay::Continuous {
                    self.continuous_scroll = self
                        .continuous_cursor
                        .saturating_sub((self.viewport_height / 2) as u64);
                } else {
                    self.scroll = self
                        .cursor_row
                        .saturating_sub((self.viewport_height / 2) as u64)
                        as usize;
                }
            }
            Action::ExpandContext => self.change_context(true),
            Action::CollapseContext => self.change_context(false),
            Action::ScrollLeft if self.focus == Focus::FileTree => {
                self.file_tree.navigate_left();
            }
            Action::ScrollRight if self.focus == Focus::FileTree => {
                self.file_tree.navigate_right();
            }
            Action::ScrollLeft => {
                self.horizontal_offset = self
                    .horizontal_offset
                    .saturating_sub(command.count as usize);
            }
            Action::ScrollRight => {
                self.horizontal_offset = self
                    .horizontal_offset
                    .saturating_add(command.count as usize);
            }
            Action::ScrollDown if self.focus == Focus::Diff => {
                self.move_diff_cursor(command.count as isize)
            }
            Action::ScrollUp if self.focus == Focus::Diff => {
                self.move_diff_cursor(-(command.count as isize))
            }
            Action::NextFile => self.jump_to_relative_file(command.count as isize),
            Action::PrevFile => self.jump_to_relative_file(-(command.count as isize)),
            Action::FocusFileTree if self.image_focus_active() => self.cycle_image_mode(1),
            Action::FocusDiff if self.image_focus_active() => self.cycle_image_mode(-1),
            Action::FocusFileTree => self.cycle_focus(1),
            Action::FocusDiff => self.cycle_focus(-1),
            action => {
                for _ in 0..command.count.min(10_000) {
                    match self.focus {
                        Focus::FileTree => self.handle_tree_action(action),
                        Focus::Diff => self.handle_diff_action(action),
                        Focus::Tracker => self.handle_tracker_action(action),
                    }
                }
            }
        }
    }

    fn queue_editor_for_current_line(&mut self) {
        let Some(file) = self.current_file() else {
            self.status_message = Some("no file selected".to_string());
            return;
        };
        let relative = std::path::Path::new(file.display_path());
        let path = match path_safety::resolve_within_repo(&self.repo_root, relative) {
            Ok(path) => path,
            Err(error) => {
                self.status_message = Some(format!("cannot open editor: {error:#}"));
                return;
            }
        };
        self.pending_editor = Some(EditorTarget {
            path,
            line: self.current_line().max(1),
            column: self.effective_code_column().saturating_add(1),
        });
        self.status_message = Some("opening editor…".to_string());
    }

    pub fn take_editor_target(&mut self) -> Option<EditorTarget> {
        self.pending_editor.take()
    }

    pub fn report_error(&mut self, message: impl Into<String>) {
        let message = message.into();
        self.set_status_message(message.clone());
        self.toasts.push(Toast::warn(message));
    }

    /// Route bracketed paste to the active editor without letting pasted
    /// escape sequences or newlines leak into normal-mode commands.
    pub fn handle_paste(&mut self, text: &str) {
        let mut text_buffer = String::with_capacity(text.len().min(MAX_PASTE_CHARACTERS));
        let mut truncated = false;
        for (index, character) in text
            .chars()
            .filter(|character| !character.is_control() || matches!(character, '\r' | '\n' | '\t'))
            .enumerate()
        {
            if index == MAX_PASTE_CHARACTERS {
                truncated = true;
                break;
            }
            text_buffer.push(character);
        }
        if truncated {
            self.status_message = Some("paste limited to 1,048,576 characters".to_string());
        }
        let text = text_buffer;
        match self.mode {
            Mode::CommentForm => {
                if let Some(form) = self.comment_form.as_mut() {
                    if insert_textarea_bounded(&mut form.textarea, &text) {
                        self.status_message = Some(format!(
                            "comment limited to {MAX_TEXTAREA_CHARACTERS} characters"
                        ));
                    }
                    form.refresh_char_count();
                }
            }
            Mode::SendReview => {
                if let Some(state) = self.send_review.as_mut() {
                    state.focused = SendField::General;
                    if insert_textarea_bounded(&mut state.general, &text) {
                        self.status_message = Some(format!(
                            "general comment limited to {MAX_TEXTAREA_CHARACTERS} characters"
                        ));
                    }
                    state.general_char_count = textarea_char_count(&state.general);
                }
            }
            Mode::Search => {
                self.insert_modal_text(&text);
                self.search_cursor = 0;
                self.queue_repo_search();
            }
            Mode::ThemePicker => {
                self.insert_modal_text(&text);
                self.theme_cursor = 0;
                self.preview_theme_at_cursor();
            }
            Mode::Command => self.insert_modal_text(&text),
            _ => {
                self.status_message = Some("paste is available in text fields".to_string());
            }
        }
    }

    fn clear_modal_input(&mut self) {
        self.modal_input.clear();
        self.modal_cursor = 0;
    }

    fn insert_modal_text(&mut self, text: &str) {
        let existing = self.modal_input.chars().count();
        let remaining = MAX_MODAL_INPUT_CHARACTERS.saturating_sub(existing);
        if remaining == 0 {
            self.status_message = Some(format!(
                "text field limited to {MAX_MODAL_INPUT_CHARACTERS} characters"
            ));
            return;
        }
        let mut characters = text.chars().filter_map(|character| match character {
            '\r' | '\n' | '\t' => Some(' '),
            other if other.is_control() => None,
            other => Some(other),
        });
        let text: String = characters.by_ref().take(remaining).collect();
        if characters.next().is_some() {
            self.status_message = Some(format!(
                "text field limited to {MAX_MODAL_INPUT_CHARACTERS} characters"
            ));
        }
        let byte = char_byte_index(&self.modal_input, self.modal_cursor);
        self.modal_input.insert_str(byte, &text);
        self.modal_cursor = self.modal_cursor.saturating_add(text.chars().count());
    }

    fn delete_modal_back(&mut self) {
        if self.modal_cursor == 0 {
            return;
        }
        let end = char_byte_index(&self.modal_input, self.modal_cursor);
        let start = char_byte_index(&self.modal_input, self.modal_cursor - 1);
        self.modal_input.replace_range(start..end, "");
        self.modal_cursor -= 1;
    }

    fn delete_modal_forward(&mut self) {
        let length = self.modal_input.chars().count();
        if self.modal_cursor >= length {
            return;
        }
        let start = char_byte_index(&self.modal_input, self.modal_cursor);
        let end = char_byte_index(&self.modal_input, self.modal_cursor + 1);
        self.modal_input.replace_range(start..end, "");
    }

    fn delete_modal_word(&mut self) {
        let mut characters: Vec<char> = self.modal_input.chars().collect();
        self.modal_cursor = self.modal_cursor.min(characters.len());
        let end = self.modal_cursor;
        while self.modal_cursor > 0 && characters[self.modal_cursor - 1].is_whitespace() {
            self.modal_cursor -= 1;
        }
        while self.modal_cursor > 0 && !characters[self.modal_cursor - 1].is_whitespace() {
            self.modal_cursor -= 1;
        }
        characters.drain(self.modal_cursor..end);
        self.modal_input = characters.into_iter().collect();
    }

    fn move_modal_cursor(&mut self, delta: isize) {
        let length = self.modal_input.chars().count();
        self.modal_cursor = (self.modal_cursor as isize + delta).clamp(0, length as isize) as usize;
    }

    fn place_modal_cursor(&mut self, prefix: &str, area: Rect, column: u16) {
        self.modal_cursor = modal_cursor_at(
            prefix,
            &self.modal_input,
            self.modal_cursor,
            area.width as usize,
            column.saturating_sub(area.x) as usize,
        );
    }

    fn cycle_focus(&mut self, delta: isize) {
        let mut order = vec![Focus::Diff];
        if self.sidebar_visible {
            order.push(Focus::FileTree);
        }
        if self.comments_visible && !self.comments.is_empty() {
            order.push(Focus::Tracker);
        }
        let current = order
            .iter()
            .position(|focus| *focus == self.focus)
            .unwrap_or(0);
        let next = (current as isize + delta).rem_euclid(order.len() as isize) as usize;
        self.focus = order[next];
    }

    fn toggle_sidebar(&mut self) {
        self.sidebar_visible = !self.sidebar_visible;
        if !self.sidebar_visible && self.focus == Focus::FileTree {
            self.focus = Focus::Diff;
        }
        self.persist_layout();
        self.status_message = Some(format!(
            "file sidebar: {}",
            if self.sidebar_visible {
                "shown"
            } else {
                "hidden"
            }
        ));
    }

    fn open_search_palette(&mut self, scope: SearchScope) {
        self.mode = Mode::Search;
        self.clear_modal_input();
        self.search_scope = scope;
        self.search_changed_only = true;
        self.search_regex = false;
        self.search_cursor = 0;
        self.search_preview_focused = false;
        self.clear_search_preview();
        self.queue_repo_search();
    }

    fn handle_search_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        if let Some(special) = classify_search_special(&key, self.search_preview_focused) {
            match special {
                SearchSpecialAction::ClosePalette => {
                    self.mode = Mode::Normal;
                    self.clear_modal_input();
                    self.search_preview_focused = false;
                    self.clear_search_preview();
                }
                SearchSpecialAction::UnfocusPreview => {
                    self.search_preview_focused = false;
                }
                SearchSpecialAction::PeekPreview => {
                    self.search_preview_focused = true;
                    self.queue_search_preview();
                }
                SearchSpecialAction::ClearQuery => {
                    self.clear_modal_input();
                    self.search_cursor = 0;
                    self.search_preview_focused = false;
                    self.queue_repo_search();
                }
                SearchSpecialAction::PageSelectionUp => self.move_search_cursor(-8),
            }
            return;
        }
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        let preview_scroll = key
            .modifiers
            .intersects(KeyModifiers::ALT | KeyModifiers::SHIFT);
        match key.code {
            KeyCode::Enter => self.activate_repo_search_hit(),
            KeyCode::Tab => {
                self.search_scope = self.search_scope.next(1);
                if self.search_scope != SearchScope::Text {
                    self.search_regex = false;
                }
                self.search_cursor = 0;
                self.search_preview_focused = false;
                self.queue_repo_search();
            }
            KeyCode::BackTab => {
                self.search_scope = self.search_scope.next(-1);
                if self.search_scope != SearchScope::Text {
                    self.search_regex = false;
                }
                self.search_cursor = 0;
                self.search_preview_focused = false;
                self.queue_repo_search();
            }
            KeyCode::Down if preview_scroll => {
                self.search_preview_scroll = self.search_preview_scroll.saturating_add(4);
            }
            KeyCode::Up if preview_scroll => {
                self.search_preview_scroll = self.search_preview_scroll.saturating_sub(4);
            }
            KeyCode::PageDown if preview_scroll => {
                self.search_preview_scroll = self.search_preview_scroll.saturating_add(10)
            }
            KeyCode::PageUp if preview_scroll => {
                self.search_preview_scroll = self.search_preview_scroll.saturating_sub(10)
            }
            KeyCode::PageDown => self.move_search_cursor(10),
            KeyCode::PageUp => self.move_search_cursor(-10),
            KeyCode::Home if control => {
                self.search_cursor = 0;
                self.queue_search_preview();
            }
            KeyCode::End if control => {
                self.search_cursor = self.repo_search_hits.len().saturating_sub(1);
                self.queue_search_preview();
            }
            KeyCode::Down => self.move_search_cursor(1),
            KeyCode::Up => self.move_search_cursor(-1),
            KeyCode::Char('n' | 'j') if control => self.move_search_cursor(1),
            KeyCode::Char('p' | 'k') if control => self.move_search_cursor(-1),
            KeyCode::Char('d') if control => self.move_search_cursor(8),
            KeyCode::Char('w') if control => {
                self.delete_modal_word();
                self.search_cursor = 0;
                self.search_preview_focused = false;
                self.queue_repo_search();
            }
            KeyCode::Char('a') if control => self.modal_cursor = 0,
            KeyCode::Char('e') if control => self.modal_cursor = self.modal_input.chars().count(),
            KeyCode::Char('g') if control => {
                self.toggle_search_changed_only();
            }
            KeyCode::Char('r') if control && self.search_scope == SearchScope::Text => {
                self.toggle_search_regex();
            }
            KeyCode::Left => self.move_modal_cursor(-1),
            KeyCode::Right => self.move_modal_cursor(1),
            KeyCode::Home => self.modal_cursor = 0,
            KeyCode::End => self.modal_cursor = self.modal_input.chars().count(),
            KeyCode::Backspace => {
                self.delete_modal_back();
                self.search_cursor = 0;
                self.search_preview_focused = false;
                self.queue_repo_search();
            }
            KeyCode::Delete => {
                self.delete_modal_forward();
                self.search_cursor = 0;
                self.search_preview_focused = false;
                self.queue_repo_search();
            }
            KeyCode::Char(character) if !control && !key.modifiers.contains(KeyModifiers::ALT) => {
                self.insert_modal_text(&character.to_string());
                self.search_cursor = 0;
                self.search_preview_focused = false;
                self.queue_repo_search();
            }
            _ => {}
        }
    }

    fn cached_changed_paths(&mut self) -> Arc<[String]> {
        let generation = self.index.generation;
        if self
            .changed_paths_cache
            .as_ref()
            .is_some_and(|(cached_generation, _)| *cached_generation == generation)
        {
            return self.changed_paths_cache.as_ref().unwrap().1.clone();
        }
        let paths: Arc<[String]> = self
            .index
            .files
            .iter()
            .map(|file| file.display_path().to_string_lossy().into_owned())
            .collect();
        self.changed_paths_cache = Some((generation, paths.clone()));
        paths
    }

    fn changed_paths_set(&mut self) -> HashSet<String> {
        self.cached_changed_paths()
            .iter()
            .cloned()
            .collect::<HashSet<_>>()
    }

    fn queue_repo_search(&mut self) {
        self.search_request_id = self.search_request_id.saturating_add(1);
        self.repo_search_query = self.modal_input.trim().to_string();

        if self.search_scope == SearchScope::Symbols
            && self.repo_search_query.chars().count() < 2
            && self.search_client.is_some()
            && !self.search_changed_only
        {
            self.repo_search_hits.clear();
            self.repo_search_total = None;
            self.repo_search_loading = false;
            self.repo_search_indexing = self.indexing;
            self.repo_search_error = None;
            self.repo_search_notice = None;
            self.clear_search_preview();
            return;
        }

        let use_changed_only = self.search_changed_only
            || self.search_client.is_none()
            || (self.search_scope == SearchScope::Symbols
                && self.repo_search_query.chars().count() < 2);
        self.repo_search_loading = true;
        self.repo_search_error = None;
        self.repo_search_notice = None;
        self.repo_search_hits.clear();
        self.repo_search_total = None;
        self.clear_search_preview();
        let changed_paths = use_changed_only.then(|| self.cached_changed_paths().to_vec());
        let request = SearchRequest {
            id: self.search_request_id,
            query: self.repo_search_query.clone(),
            scope: self.search_scope,
            regex: self.search_scope == SearchScope::Text && self.search_regex,
            changed_paths,
        };
        if self.search_request_tx.send(request).is_err() {
            self.repo_search_loading = false;
            self.repo_search_error = Some("search worker stopped".to_string());
        }
    }

    fn toggle_search_changed_only(&mut self) {
        if self.search_client.is_none() {
            self.status_message =
                Some("whole-repository search requires the diffing Node launcher".to_string());
            return;
        }
        self.search_changed_only = !self.search_changed_only;
        self.search_cursor = 0;
        self.queue_repo_search();
    }

    fn toggle_search_regex(&mut self) {
        if self.search_client.is_none() {
            self.status_message =
                Some("regex search requires the diffing Node launcher".to_string());
            return;
        }
        self.search_regex = !self.search_regex;
        self.search_cursor = 0;
        self.queue_repo_search();
    }

    fn move_search_cursor(&mut self, delta: isize) {
        if self.repo_search_hits.is_empty() {
            return;
        }
        self.search_cursor = (self.search_cursor as isize + delta)
            .clamp(0, self.repo_search_hits.len().saturating_sub(1) as isize)
            as usize;
        self.queue_search_preview();
    }

    fn clear_search_preview(&mut self) {
        self.preview_request_id = self.preview_request_id.saturating_add(1);
        self.search_preview = None;
        self.search_preview_loading = false;
        self.search_preview_error = None;
        self.search_preview_scroll = 0;
    }

    fn queue_search_preview(&mut self) {
        let Some(hit) = self.repo_search_hits.get(self.search_cursor).cloned() else {
            self.clear_search_preview();
            return;
        };
        self.preview_request_id = self.preview_request_id.saturating_add(1);
        self.search_preview_scroll = hit
            .line
            .map(|line| line.saturating_sub(4) as usize)
            .unwrap_or(0);
        self.search_preview_loading = true;
        self.search_preview_error = None;
        let request = PreviewRequest {
            id: self.preview_request_id,
            path: hit.path,
        };
        if self.preview_request_tx.send(request).is_err() {
            self.search_preview_loading = false;
            self.search_preview_error = Some("preview worker stopped".to_string());
        }
    }

    fn activate_repo_search_hit(&mut self) {
        if self.repo_search_hits.is_empty() {
            if self.modal_input.trim().is_empty() {
                self.mode = Mode::Normal;
            } else {
                self.status_message = Some(format!("no matches for {:?}", self.modal_input.trim()));
            }
            return;
        }
        let Some(hit) = self.repo_search_hits.get(self.search_cursor).cloned() else {
            return;
        };
        if let Some(client) = self.search_client.clone() {
            let query = self.repo_search_query.clone();
            let path = hit.path.clone();
            let _ = thread::Builder::new()
                .name("diffing-fff-track".to_string())
                .spawn(move || client.track(&query, &path));
        }
        let Some(file_index) = self
            .index
            .files
            .iter()
            .position(|file| file.display_path() == std::path::Path::new(&hit.path))
        else {
            self.status_message = Some(format!(
                "Previewing {} · Ctrl-G limits results to this diff",
                hit.path
            ));
            return;
        };
        let row = if hit.kind == SearchHitKind::File {
            0
        } else {
            let row = hit.line.and_then(|line| {
                self.index
                    .find_line_row(file_index, IndexedLineKind::Add, line)
                    .ok()
                    .flatten()
            });
            let Some(row) = row else {
                self.status_message = Some(format!(
                    "Previewing {} · match is outside changed lines",
                    hit.path
                ));
                return;
            };
            row
        };
        self.reveal_file_for_direct_jump(file_index);
        self.cursor_row = row;
        self.continuous_cursor = self.continuous_offset_for_file(file_index) + row;
        self.continuous_scroll = self
            .continuous_cursor
            .saturating_sub((self.viewport_height / 2) as u64);
        self.scroll = row.saturating_sub((self.viewport_height / 2) as u64) as usize;
        self.focus = Focus::Diff;
        self.mode = Mode::Normal;
        self.clear_search_preview();
        self.status_message = Some(match (hit.kind, hit.line) {
            (SearchHitKind::File, _) => format!("→ {}", hit.path),
            (_, Some(line)) => format!("→ {}:{line}", hit.path),
            _ => format!("→ {}", hit.path),
        });
        self.clear_modal_input();
    }

    fn handle_hover_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.mode = Mode::Normal;
                self.hover_content = None;
                self.hover_scroll = 0;
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.hover_scroll = self.hover_scroll.saturating_add(1)
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.hover_scroll = self.hover_scroll.saturating_sub(1)
            }
            KeyCode::PageDown => self.hover_scroll = self.hover_scroll.saturating_add(10),
            KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.hover_scroll = self.hover_scroll.saturating_add(10)
            }
            KeyCode::PageUp => self.hover_scroll = self.hover_scroll.saturating_sub(10),
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.hover_scroll = self.hover_scroll.saturating_sub(10)
            }
            _ => {}
        }
    }

    fn handle_help_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Esc | KeyCode::Char('q' | '?') => {
                self.mode = Mode::Normal;
                self.keymap.clear();
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.help_scroll = self.help_scroll.saturating_add(1)
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.help_scroll = self.help_scroll.saturating_sub(1)
            }
            KeyCode::PageDown | KeyCode::Char('d') => {
                self.help_scroll = self.help_scroll.saturating_add(8)
            }
            KeyCode::PageUp | KeyCode::Char('u') => {
                self.help_scroll = self.help_scroll.saturating_sub(8)
            }
            KeyCode::Home | KeyCode::Char('g') => self.help_scroll = 0,
            KeyCode::End | KeyCode::Char('G') => self.help_scroll = u16::MAX,
            _ => {}
        }
    }

    fn open_image_preview(&mut self) {
        let Some((key, _)) = self.selected_image() else {
            self.status_message = Some("select a changed image to open its comparison".to_string());
            return;
        };
        self.image_diff.request(key);
        self.mode = Mode::ImagePreview;
    }

    fn image_focus_active(&self) -> bool {
        self.mode == Mode::Normal && self.focus == Focus::Diff && self.selected_image().is_some()
    }

    fn cycle_image_mode(&mut self, delta: isize) {
        let Some((image_key, _)) = self.selected_image() else {
            return;
        };
        if let Some(data) = self.image_diff.get(&image_key) {
            self.image_view.mode = self.image_view.mode.cycle(delta, &data);
        }
    }

    fn try_handle_image_key(&mut self, key: crossterm::event::KeyEvent) -> bool {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Char('+' | '=') => {
                self.image_view.zoom_in();
                true
            }
            KeyCode::Char('-') => {
                self.image_view.zoom_out();
                true
            }
            KeyCode::Char('0') => {
                self.image_view.reset();
                true
            }
            KeyCode::Char('h') | KeyCode::Left if self.image_view.is_zoomed() => {
                self.image_view.pan(-2, 0);
                true
            }
            KeyCode::Char('l') | KeyCode::Right if self.image_view.is_zoomed() => {
                self.image_view.pan(2, 0);
                true
            }
            KeyCode::Char('k') | KeyCode::Up if self.image_view.is_zoomed() => {
                self.image_view.pan(0, -2);
                true
            }
            KeyCode::Char('j') | KeyCode::Down if self.image_view.is_zoomed() => {
                self.image_view.pan(0, 2);
                true
            }
            KeyCode::Char('1') => {
                self.image_view.mode = ImageCompareMode::Before;
                true
            }
            KeyCode::Char('2') => {
                self.image_view.mode = ImageCompareMode::After;
                true
            }
            KeyCode::Char('3') => {
                self.image_view.mode = ImageCompareMode::SideBySide;
                true
            }
            KeyCode::Char('4') => {
                self.image_view.mode = ImageCompareMode::Difference;
                true
            }
            KeyCode::Tab | KeyCode::BackTab => {
                let delta = if key.code == KeyCode::BackTab { -1 } else { 1 };
                self.cycle_image_mode(delta);
                true
            }
            _ => false,
        }
    }

    fn handle_image_preview_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Esc | KeyCode::Char('q' | 'i') => self.mode = Mode::Normal,
            _ if self.try_handle_image_key(key) => {}
            _ => {}
        }
    }

    fn open_comment_detail(&mut self) {
        if self.comments.get(self.tracker.cursor).is_none() {
            self.status_message = Some("no comment selected".to_string());
            return;
        }
        self.comment_detail_scroll = 0;
        self.mode = Mode::CommentDetail;
    }

    fn handle_comment_detail_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        if key.code != KeyCode::Delete {
            self.pending_delete_id = None;
        }
        if key.code != KeyCode::Char('X') {
            self.pending_resolve_all = false;
        }
        match key.code {
            KeyCode::Esc | KeyCode::Char('q' | 'o') => self.mode = Mode::Normal,
            KeyCode::Enter => {
                self.mode = Mode::Normal;
                self.jump_to_focused_comment();
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.comment_detail_scroll = self.comment_detail_scroll.saturating_add(1)
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.comment_detail_scroll = self.comment_detail_scroll.saturating_sub(1)
            }
            KeyCode::PageDown | KeyCode::Char('d') => {
                self.comment_detail_scroll = self.comment_detail_scroll.saturating_add(8)
            }
            KeyCode::PageUp | KeyCode::Char('u') => {
                self.comment_detail_scroll = self.comment_detail_scroll.saturating_sub(8)
            }
            KeyCode::Home | KeyCode::Char('g') => self.comment_detail_scroll = 0,
            KeyCode::End | KeyCode::Char('G') => self.comment_detail_scroll = u16::MAX,
            KeyCode::Char('e') => self.open_edit_form_for_focused(),
            KeyCode::Char('r') => self.open_reply_form_for_focused(),
            KeyCode::Char('x') => self.resolve_focused(),
            KeyCode::Delete => self.delete_focused(),
            _ => {}
        }
    }

    fn focus_comment_at_current_line(&mut self) -> bool {
        let Some(file) = self.current_file() else {
            self.status_message = Some("no file selected".to_string());
            return false;
        };
        let path = file.display_path().to_string_lossy();
        let line = self.current_line();
        let side = self.current_side();
        let selected = self
            .comments
            .iter()
            .enumerate()
            .filter(|(_, comment)| comment.file_path == path)
            .filter(|(_, comment)| {
                if comment.line_number == 0 {
                    return line == 0;
                }
                comment.side == side
                    && (comment.start_line_number.unwrap_or(comment.line_number)
                        ..=comment.line_number)
                        .contains(&line)
            })
            .min_by_key(|(_, comment)| comment.status == CommentStatus::Resolved)
            .map(|(index, _)| index);
        if let Some(index) = selected {
            self.tracker.cursor = index;
            true
        } else {
            self.status_message = Some("no comment thread on this line · c adds one".to_string());
            false
        }
    }

    fn apply_file_filter(&mut self) {
        let previous_continuous_position = self.continuous_position(self.continuous_cursor);
        let previous_viewport_offset = self
            .continuous_cursor
            .saturating_sub(self.continuous_scroll);
        let comment_counts = if self.experience == Experience::Review {
            let mut counts = HashMap::with_capacity(self.comments.len());
            for comment in &self.comments {
                *counts
                    .entry(PathBuf::from(&comment.file_path))
                    .or_insert(0u32) += 1;
            }
            counts
        } else {
            HashMap::new()
        };
        for index in 0..self.files.len() {
            let path = self.files[index].display_path();
            let count = comment_counts.get(path).copied().unwrap_or(0);
            self.file_tree.set_comment_count(index, count);
            self.file_tree.set_viewed(
                index,
                self.experience == Experience::Review && self.viewed_paths.contains(path),
            );
        }
        self.file_tree.apply_filter(
            "",
            self.file_filter_mode == FileFilterMode::Unviewed,
            self.file_filter_mode == FileFilterMode::Comments,
        );
        let visible_files = self.file_tree.navigable_file_indices().to_vec();
        self.render_metadata
            .set_visible_files(&self.index, &visible_files);
        if self.file_display == FileDisplay::Continuous {
            let target = previous_continuous_position
                .filter(|(file, _)| visible_files.contains(file))
                .or_else(|| self.file_tree.active_file_idx().map(|file| (file, 0)));
            if let Some((file, row)) = target {
                let row = row.min(
                    self.index
                        .files
                        .get(file)
                        .map(|file| file.row_count.saturating_sub(1))
                        .unwrap_or(0),
                );
                self.continuous_cursor = self.continuous_offset_for_file(file).saturating_add(row);
                self.continuous_scroll = self
                    .continuous_cursor
                    .saturating_sub(previous_viewport_offset);
                self.cursor_row = row;
            } else {
                self.continuous_cursor = 0;
                self.continuous_scroll = 0;
                self.cursor_row = 0;
            }
        }
        self.file_tree_scroll = 0;
    }

    fn reveal_file_for_direct_jump(&mut self, file_index: usize) {
        if !self
            .file_tree
            .navigable_file_indices()
            .contains(&file_index)
        {
            self.file_filter_mode = FileFilterMode::All;
            self.apply_file_filter();
        }
        self.file_tree.jump_to_file(file_index);
    }

    fn jump_search(&mut self, delta: isize) {
        if self.repo_search_hits.is_empty() {
            self.status_message = Some("no active search results".to_string());
            return;
        }
        self.search_cursor = (self.search_cursor as isize + delta)
            .rem_euclid(self.repo_search_hits.len() as isize) as usize;
        self.activate_repo_search_hit();
    }

    fn handle_command_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.clear_modal_input();
            }
            KeyCode::Enter => self.execute_ex_command(),
            KeyCode::Tab => self.complete_ex_command(),
            KeyCode::Left => self.move_modal_cursor(-1),
            KeyCode::Right => self.move_modal_cursor(1),
            KeyCode::Home => self.modal_cursor = 0,
            KeyCode::Char('a') if control => self.modal_cursor = 0,
            KeyCode::End => self.modal_cursor = self.modal_input.chars().count(),
            KeyCode::Char('e') if control => self.modal_cursor = self.modal_input.chars().count(),
            KeyCode::Char('u') if control => self.clear_modal_input(),
            KeyCode::Char('w') if control => self.delete_modal_word(),
            KeyCode::Backspace => self.delete_modal_back(),
            KeyCode::Delete => self.delete_modal_forward(),
            KeyCode::Char(character) if !control && !key.modifiers.contains(KeyModifiers::ALT) => {
                self.insert_modal_text(&character.to_string())
            }
            _ => {}
        }
    }

    fn execute_ex_command(&mut self) {
        let command = self.modal_input.trim().to_ascii_lowercase();
        self.mode = Mode::Normal;
        match command.as_str() {
            "q" | "quit" => self.quit = true,
            "w" | "wrap" => {
                self.wrap = !self.wrap;
                self.persist_settings();
            }
            "nowrap" => {
                self.wrap = false;
                self.persist_settings();
            }
            "split" => {
                self.split = true;
                self.persist_settings();
            }
            "unified" => {
                self.split = false;
                self.persist_settings();
            }
            "single" => {
                if self.file_display != FileDisplay::Single {
                    self.toggle_file_display();
                }
            }
            "continuous" => {
                if self.file_display != FileDisplay::Continuous {
                    self.toggle_file_display();
                }
            }
            "mouse" => self.set_mouse_enabled(true),
            "nomouse" => self.set_mouse_enabled(false),
            "sidebar" | "files" => self.toggle_sidebar(),
            "comments" if self.experience == Experience::Review => {
                self.comments_visible = !self.comments_visible;
                if !self.comments_visible && self.focus == Focus::Tracker {
                    self.focus = Focus::Diff;
                }
                self.persist_layout();
            }
            "refresh" | "reload" => {
                if self.indexing {
                    self.reindex_pending = true;
                    self.status_message = Some("refresh queued after current index".to_string());
                } else {
                    self.start_reindex();
                }
            }
            "image" => self.open_image_preview(),
            "theme" => self.open_theme_picker(),
            "settings" | "set" => self.open_settings(),
            "display" => self.open_settings(),
            "help" | "h" => {
                self.help_scroll = 0;
                self.mode = Mode::Help;
            }
            "top" => self.dispatch_command(Command {
                action: Action::ScrollTop,
                count: 1,
            }),
            "bottom" => self.dispatch_command(Command {
                action: Action::ScrollBottom,
                count: 1,
            }),
            "" => {}
            _ => {
                self.status_message = Some(format!(
                    "unknown command: {command} · try :help, :settings, :refresh, :image"
                ))
            }
        }
        self.clear_modal_input();
    }

    fn complete_ex_command(&mut self) {
        let query = self.modal_input.trim().to_ascii_lowercase();
        let Some(command) = ex_command_completion(&query) else {
            self.status_message = Some(if query.is_empty() {
                "type a command; suggestions appear below".to_string()
            } else {
                format!("no command starts with {query:?}")
            });
            return;
        };
        self.modal_input = command.to_string();
        self.modal_cursor = self.modal_input.chars().count();
    }

    fn handle_send_review_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        if key.code == KeyCode::Esc {
            self.send_review = None;
            self.mode = Mode::Normal;
            self.status_message = Some("send cancelled".to_string());
            return;
        }
        if key.code == KeyCode::Char('s') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.submit_send_review();
            return;
        }
        let Some(sr) = self.send_review.as_mut() else {
            return;
        };
        // Toggle focused field.
        if key.code == KeyCode::Tab
            || (key.code == KeyCode::BackTab && !key.modifiers.contains(KeyModifiers::CONTROL))
        {
            sr.focused = match sr.focused {
                SendField::Verdict => SendField::General,
                SendField::General => SendField::Verdict,
            };
            return;
        }
        if key.code == KeyCode::BackTab && key.modifiers.contains(KeyModifiers::CONTROL) {
            // Ctrl-Tab toggles back; same as Tab here.
            sr.focused = match sr.focused {
                SendField::Verdict => SendField::General,
                SendField::General => SendField::Verdict,
            };
            return;
        }
        // When the verdict is focused, ←/→ cycles the verdict radios.
        if sr.focused == SendField::Verdict {
            if key.code == KeyCode::Right {
                sr.cycle_verdict(1);
                return;
            }
            if key.code == KeyCode::Left {
                sr.cycle_verdict(-1);
                return;
            }
        }
        // Otherwise feed the key to the general-comment textarea.
        if sr.focused == SendField::General {
            if sr.general_char_count >= MAX_TEXTAREA_CHARACTERS && textarea_key_inserts(&key) {
                self.status_message = Some(format!(
                    "general comment limited to {MAX_TEXTAREA_CHARACTERS} characters"
                ));
                return;
            }
            sr.general.input(key);
            sr.general_char_count = textarea_char_count(&sr.general);
        }
    }

    fn open_send_review(&mut self) {
        let unviewed = self
            .files
            .iter()
            .filter(|file| !self.viewed_paths.contains(file.display_path()))
            .count();
        self.send_review = Some(SendReviewState::new(unviewed));
        self.mode = Mode::SendReview;
    }

    fn submit_send_review(&mut self) {
        if let Some(state) = self.send_review.as_mut() {
            if state.unviewed_files > 0 && !state.guard_acknowledged {
                state.guard_acknowledged = true;
                self.status_message = Some(format!(
                    "{} unviewed file{} · activate Send again to confirm",
                    state.unviewed_files,
                    if state.unviewed_files == 1 { "" } else { "s" }
                ));
                return;
            }
        }
        let Some(sr) = self.send_review.take() else {
            return;
        };
        let body = sr.body();
        let verdict = sr.verdict;
        let next_round = self.review_round.saturating_add(1);
        let Some(xml) = build_send_payload(&self.comments, &body, Some(verdict), next_round) else {
            self.send_review = Some(sr);
            self.status_message = Some("nothing to send (no comments, no verdict)".to_string());
            return;
        };
        // 1. Persist the XML next to comments.json.
        let path = crate::ui::send_review_popover::pending_review_path(
            self.repo_root.to_str().unwrap_or("."),
        );
        let persisted = path
            .parent()
            .map(std::fs::create_dir_all)
            .transpose()
            .and_then(|_| std::fs::write(&path, &xml));
        if let Err(e) = persisted {
            self.send_review = Some(sr);
            self.mode = Mode::SendReview;
            self.status_message = Some(format!("send failed: {e}"));
            return;
        }
        self.mode = Mode::Normal;
        // 2. Release every CLI/MCP waiter through the embedded loopback API.
        self.review_round = self
            .agent_api
            .as_ref()
            .map(|api| api.release_review(xml.clone()))
            .unwrap_or(self.review_round);
        // 3. Best-effort clipboard copy.
        let _ = copy_to_clipboard(&xml);
        // 4. Surface a toast and status message.
        self.toasts.push(Toast::success(format!(
            "review sent · {} · xml in pending-review.xml",
            verdict.as_str()
        )));
        self.status_message = Some(format!(
            "review #{} sent ({} cmts, {})",
            self.review_round,
            self.comments.len(),
            verdict.as_str()
        ));
    }

    fn handle_form_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        if key.code == KeyCode::Esc {
            self.comment_form = None;
            self.pending_comment_target = None;
            self.mode = Mode::Normal;
            self.status_message = Some("comment cancelled".to_string());
            return;
        }
        if key.code == KeyCode::Char('s') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.submit_form();
            return;
        }
        if key.code == KeyCode::Char('t') && key.modifiers.contains(KeyModifiers::CONTROL) {
            if let Some(form) = self.comment_form.as_mut() {
                if form.kind == crate::ui::comment_form::FormKind::New {
                    form.cycle_severity();
                }
            }
            return;
        }
        if let Some(form) = self.comment_form.as_mut() {
            if form.char_count >= MAX_TEXTAREA_CHARACTERS && textarea_key_inserts(&key) {
                self.status_message = Some(format!(
                    "comment limited to {MAX_TEXTAREA_CHARACTERS} characters"
                ));
                return;
            }
            form.textarea.input(key);
            form.refresh_char_count();
        }
    }

    fn submit_form(&mut self) {
        let Some(form) = self.comment_form.take() else {
            return;
        };
        let body = form.body();
        let severity = form.severity;
        if body.trim().is_empty() {
            self.comment_form = Some(form);
            self.status_message = Some("write a comment before saving · Esc cancels".to_string());
            return;
        }
        let selected_comment_id = self
            .comments
            .get(self.tracker.cursor)
            .map(|comment| comment.id.clone());
        if form.kind != crate::ui::comment_form::FormKind::New && selected_comment_id.is_none() {
            self.comment_form = Some(form);
            self.status_message =
                Some("the selected thread no longer exists · draft kept".to_string());
            return;
        }
        let success_message = match form.kind {
            crate::ui::comment_form::FormKind::New => "comment saved",
            crate::ui::comment_form::FormKind::Edit => "comment updated",
            crate::ui::comment_form::FormKind::Reply => "reply sent",
        };
        let now = now_ms();
        let result: Result<()> = match form.kind {
            crate::ui::comment_form::FormKind::New => {
                let target = self.pending_comment_target.clone().unwrap_or_else(|| {
                    let file_path = self
                        .current_file()
                        .map(|file| file.display_path().to_string_lossy().to_string())
                        .unwrap_or_default();
                    PendingCommentTarget {
                        file_path,
                        side: self.current_side(),
                        start_line_number: None,
                        line_number: self.current_line(),
                        line_content: self.current_line_content(),
                    }
                });
                self.comment_store
                    .add(
                        if target.line_number == 0 {
                            NewComment::FileLevel {
                                file_path: &target.file_path,
                                body: &body,
                                severity,
                            }
                        } else {
                            NewComment::Inline {
                                file_path: &target.file_path,
                                side: target.side,
                                start_line_number: target.start_line_number,
                                line_number: target.line_number,
                                line_content: &target.line_content,
                                body: &body,
                                severity,
                            }
                        },
                        now,
                    )
                    .map(|_| ())
            }
            crate::ui::comment_form::FormKind::Edit => match selected_comment_id.as_deref() {
                Some(id) => self
                    .comment_store
                    .update(id, Some(&body), None)
                    .and_then(|updated| {
                        updated
                            .map(|_| ())
                            .ok_or_else(|| anyhow::anyhow!("comment no longer exists"))
                    }),
                None => Err(anyhow::anyhow!("comment no longer exists")),
            },
            crate::ui::comment_form::FormKind::Reply => match selected_comment_id.as_deref() {
                Some(id) => self
                    .comment_store
                    .add_reply(id, &body, Some("user"), None, now)
                    .and_then(|updated| {
                        updated
                            .map(|_| ())
                            .ok_or_else(|| anyhow::anyhow!("comment no longer exists"))
                    }),
                None => Err(anyhow::anyhow!("comment no longer exists")),
            },
        };
        match result {
            Ok(()) => {
                self.pending_comment_target = None;
                self.mode = Mode::Normal;
                self.status_message = Some(success_message.to_string());
                self.reload_comments_with_notifications(false);
                self.toasts
                    .push(Toast::success(success_message.to_string()));
            }
            Err(e) => {
                self.comment_form = Some(form);
                self.mode = Mode::CommentForm;
                self.status_message = Some(format!("save failed: {e}"));
            }
        }
    }

    fn handle_tree_action(&mut self, action: Action) {
        match action {
            Action::ScrollDown => self.file_tree.move_cursor(1),
            Action::ScrollUp => self.file_tree.move_cursor(-1),
            Action::ScrollTop => self.file_tree.set_cursor(0),
            Action::ScrollBottom => {
                self.file_tree
                    .set_cursor(self.file_tree.nodes.len().saturating_sub(1));
            }
            Action::NextFile => self.jump_to_relative_file(1),
            Action::PrevFile => self.jump_to_relative_file(-1),
            Action::FocusDiff => self.focus = Focus::Diff,
            Action::ToggleViewed => self.toggle_viewed_current(),
            Action::OpenThemePicker => self.open_theme_picker(),
            _ => {}
        }
    }

    fn handle_diff_action(&mut self, action: Action) {
        match action {
            Action::ScrollDown => self.move_diff_cursor(1),
            Action::ScrollUp => self.move_diff_cursor(-1),
            Action::ScrollHalfDown => {
                self.move_diff_cursor((self.viewport_height / 2).max(1) as isize)
            }
            Action::ScrollHalfUp => {
                self.move_diff_cursor(-((self.viewport_height / 2).max(1) as isize))
            }
            Action::ScrollTop => {
                if self.file_display == FileDisplay::Continuous {
                    self.continuous_cursor = 0;
                    self.continuous_scroll = 0;
                    self.sync_continuous_active();
                } else {
                    self.cursor_row = 0;
                    self.scroll = 0;
                }
            }
            Action::ScrollBottom => {
                if self.file_display == FileDisplay::Continuous {
                    let last = self.continuous_total_rows().saturating_sub(1);
                    self.continuous_cursor = last;
                    self.continuous_scroll =
                        last.saturating_sub(self.viewport_height.saturating_sub(1) as u64);
                    self.sync_continuous_active();
                } else {
                    let last = self.current_file_rows().saturating_sub(1);
                    self.cursor_row = last;
                    self.scroll =
                        last.saturating_sub(self.viewport_height.saturating_sub(1) as u64) as usize;
                }
            }
            Action::NextFile => self.jump_to_relative_file(1),
            Action::PrevFile => self.jump_to_relative_file(-1),
            Action::FocusFileTree => self.focus = Focus::FileTree,
            Action::FocusTracker => {
                if self.comments.is_empty() {
                    self.status_message = Some("No comments yet · c adds one".to_string());
                    return;
                }
                self.comments_visible = true;
                self.focus = Focus::Tracker;
                self.persist_layout();
            }
            Action::ToggleWrap => {
                self.wrap = !self.wrap;
                self.persist_settings();
            }
            Action::ToggleLayout => {
                self.split = !self.split;
                self.persist_settings();
            }
            Action::ToggleViewed => self.toggle_viewed_current(),
            Action::OpenThemePicker => self.open_theme_picker(),
            Action::AddComment => self.open_new_comment_form(),
            Action::AddFileComment => self.open_file_comment_form(),
            Action::ToggleVisualSelection => self.toggle_visual_selection(),
            Action::EditComment => {
                if self.focus_comment_at_current_line() {
                    self.open_edit_form_for_focused();
                }
            }
            Action::ReplyComment => {
                if self.focus_comment_at_current_line() {
                    self.open_reply_form_for_focused();
                }
            }
            Action::ResolveComment => {
                if self.focus_comment_at_current_line() {
                    self.resolve_focused();
                }
            }
            Action::DeleteComment => {
                if self.focus_comment_at_current_line() {
                    self.delete_focused();
                }
            }
            Action::NextComment => self.jump_relative_comment(1),
            Action::PrevComment => self.jump_relative_comment(-1),
            Action::OpenCommentThread if self.focus_comment_at_current_line() => {
                self.open_comment_detail();
            }
            _ => {}
        }
    }

    fn handle_tracker_action(&mut self, action: Action) {
        match action {
            Action::ScrollDown | Action::NextComment => {
                self.tracker.move_visible_cursor(1, &self.comments);
            }
            Action::ScrollUp | Action::PrevComment => {
                self.tracker.move_visible_cursor(-1, &self.comments);
            }
            Action::ScrollTop => {
                if let Some(first) = self.tracker.visible_indices(&self.comments).first() {
                    self.tracker.cursor = *first;
                }
            }
            Action::ScrollBottom => {
                if let Some(last) = self.tracker.visible_indices(&self.comments).last() {
                    self.tracker.cursor = *last;
                }
            }
            Action::FocusDiff => self.focus = Focus::Diff,
            Action::FocusTracker | Action::FocusFileTree => self.focus = Focus::Tracker,
            Action::EditComment => self.open_edit_form_for_focused(),
            Action::ReplyComment => self.open_reply_form_for_focused(),
            Action::ResolveComment => self.resolve_focused(),
            Action::DeleteComment => self.delete_focused(),
            Action::OpenCommentThread | Action::ExpandContext => self.open_comment_detail(),
            Action::CycleCommentStatus => {
                self.tracker.status_filter = self.tracker.status_filter.next();
                self.tracker.normalize_filter_cursor(&self.comments);
            }
            Action::CycleCommentSeverity => {
                self.tracker.severity_filter = self.tracker.severity_filter.next();
                self.tracker.normalize_filter_cursor(&self.comments);
            }
            Action::OpenThemePicker => self.open_theme_picker(),
            _ => {}
        }
    }

    fn open_theme_picker(&mut self) {
        self.theme_return_to_settings = self.mode == Mode::Settings;
        self.theme_original = self.theme;
        self.theme_cursor = ThemeName::all()
            .iter()
            .position(|theme| *theme == self.theme)
            .unwrap_or(0);
        self.clear_modal_input();
        self.mode = Mode::ThemePicker;
    }

    fn open_settings(&mut self) {
        self.settings_state.cursor = 0;
        self.mode = Mode::Settings;
    }

    fn handle_settings_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Esc | KeyCode::Char(',') => self.mode = Mode::Normal,
            KeyCode::Char('r')
                if self.settings_state.cursor == 9 || self.settings_state.cursor == 10 =>
            {
                self.lsp.retry_failed_servers();
                self.lsp_active_path = None;
                self.lsp_last_state = if self.lsp.mode() == crate::lsp::IntelligenceMode::Off {
                    ServerState::Off
                } else {
                    ServerState::Unavailable
                };
                self.queued_lsp = None;
                self.cancel_pending_language_request();
                self.status_message = Some("retrying language servers…".to_string());
            }
            KeyCode::Up | KeyCode::Char('k') => self.settings_state.move_cursor(-1),
            KeyCode::Down | KeyCode::Char('j') => self.settings_state.move_cursor(1),
            KeyCode::Left => self.activate_setting(-1),
            KeyCode::Right | KeyCode::Enter | KeyCode::Char(' ') => self.activate_setting(1),
            _ => {}
        }
    }

    fn activate_setting(&mut self, direction: isize) {
        match self.settings_state.cursor {
            0 => self.toggle_file_display(),
            1 => {
                self.split = !self.split;
                self.persist_settings();
            }
            2 => {
                self.wrap = !self.wrap;
                self.persist_settings();
            }
            3 => {
                self.tab_size = match self.tab_size {
                    2 => 4,
                    4 => 8,
                    _ => 2,
                };
                self.persist_settings();
            }
            4 => {
                self.line_numbers = !self.line_numbers;
                self.persist_settings();
            }
            5 => {
                self.set_mouse_enabled(!self.mouse_enabled);
            }
            6 => {
                self.toggle_sidebar();
            }
            7 => {
                self.sidebar_width = if direction < 0 {
                    self.sidebar_width.saturating_sub(2)
                } else {
                    self.sidebar_width.saturating_add(2)
                }
                .clamp(22, 72);
                self.persist_layout();
                self.status_message =
                    Some(format!("sidebar width: {} columns", self.sidebar_width));
            }
            8 => {
                if self.experience == Experience::Viewer {
                    self.status_message =
                        Some("review drawer is available in review mode".to_string());
                    return;
                }
                self.comments_visible = !self.comments_visible;
                if !self.comments_visible && self.focus == Focus::Tracker {
                    self.focus = Focus::Diff;
                }
                self.persist_layout();
            }
            9 => {
                let mode = self.lsp.mode().toggle();
                self.lsp.set_mode(mode);
                self.lsp_active_path = None;
                self.lsp_last_state = if mode == crate::lsp::IntelligenceMode::Off {
                    ServerState::Off
                } else {
                    ServerState::Unavailable
                };
                self.queued_lsp = None;
                self.cancel_pending_language_request();
                self.persist_settings();
                self.status_message = Some(format!("language intelligence: {}", mode.label()));
            }
            10 => {
                self.trust_repo_local_bin = !self.trust_repo_local_bin;
                self.lsp.set_trust_repo_local_bin(self.trust_repo_local_bin);
                self.lsp_active_path = None;
                self.lsp_last_state = if self.lsp.mode() == crate::lsp::IntelligenceMode::Off {
                    ServerState::Off
                } else {
                    ServerState::Unavailable
                };
                self.queued_lsp = None;
                self.cancel_pending_language_request();
                if let Err(error) = crate::persistence::save_trust_repo_local_bin(
                    self.repo_root.to_str().unwrap_or("."),
                    self.trust_repo_local_bin,
                ) {
                    self.report_error(format!("could not save trust setting: {error}"));
                }
                self.status_message = Some(format!(
                    "repo-local language servers: {}",
                    if self.trust_repo_local_bin {
                        "trusted"
                    } else {
                        "blocked"
                    }
                ));
            }
            11 => self.open_theme_picker(),
            _ => {}
        }
    }

    fn set_mouse_enabled(&mut self, enabled: bool) {
        self.mouse_enabled = enabled;
        self.mouse_position = None;
        self.drag = None;
        self.persist_settings();
        self.status_message = Some(format!(
            "mouse input: {}",
            if enabled { "enabled" } else { "disabled" }
        ));
    }

    fn toggle_file_display(&mut self) {
        self.file_display = self.file_display.toggle();
        match self.file_display {
            FileDisplay::Single => {
                if let Some((file, row)) = self.continuous_position(self.continuous_cursor) {
                    self.file_tree.jump_to_file(file);
                    self.cursor_row = row;
                    self.scroll = row.saturating_sub((self.viewport_height / 3) as u64) as usize;
                }
            }
            FileDisplay::Continuous => {
                let file = self.file_tree.active_file_idx().unwrap_or(0);
                self.continuous_cursor = self.continuous_offset_for_file(file) + self.cursor_row;
                self.continuous_scroll = self
                    .continuous_cursor
                    .saturating_sub((self.viewport_height / 3) as u64);
            }
        }
        self.persist_layout();
        self.status_message = Some(format!("file display: {}", self.file_display.label()));
    }

    fn filtered_themes(&self) -> Vec<ThemeName> {
        let query = self.modal_input.trim().to_ascii_lowercase();
        ThemeName::all()
            .iter()
            .copied()
            .filter(|theme| {
                query.is_empty()
                    || theme.label().contains(&query)
                    || theme.display_name().to_ascii_lowercase().contains(&query)
            })
            .collect()
    }

    fn preview_theme_at_cursor(&mut self) {
        let themes = self.filtered_themes();
        if themes.is_empty() {
            self.theme_cursor = 0;
            return;
        }
        self.theme_cursor = self.theme_cursor.min(themes.len() - 1);
        self.theme = themes[self.theme_cursor];
        self.palette = Palette::for_terminal(self.theme);
    }

    fn handle_theme_picker_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => {
                self.theme = self.theme_original;
                self.palette = Palette::for_terminal(self.theme);
                self.mode = if self.theme_return_to_settings {
                    Mode::Settings
                } else {
                    Mode::Normal
                };
                self.clear_modal_input();
            }
            KeyCode::Enter => {
                if self.filtered_themes().is_empty() {
                    self.status_message = Some("no themes match this filter".to_string());
                    return;
                }
                self.preview_theme_at_cursor();
                self.persist_settings();
                self.status_message = Some(format!("theme: {}", self.theme.display_name()));
                self.mode = if self.theme_return_to_settings {
                    Mode::Settings
                } else {
                    Mode::Normal
                };
                self.clear_modal_input();
            }
            KeyCode::Down => {
                let len = self.filtered_themes().len();
                if len > 0 {
                    self.theme_cursor = (self.theme_cursor + 1).min(len - 1);
                    self.preview_theme_at_cursor();
                }
            }
            KeyCode::Up => {
                self.theme_cursor = self.theme_cursor.saturating_sub(1);
                self.preview_theme_at_cursor();
            }
            KeyCode::PageDown => {
                let len = self.filtered_themes().len();
                if len > 0 {
                    self.theme_cursor = self.theme_cursor.saturating_add(8).min(len - 1);
                    self.preview_theme_at_cursor();
                }
            }
            KeyCode::PageUp => {
                self.theme_cursor = self.theme_cursor.saturating_sub(8);
                self.preview_theme_at_cursor();
            }
            KeyCode::Left => self.move_modal_cursor(-1),
            KeyCode::Right => self.move_modal_cursor(1),
            KeyCode::Home => self.modal_cursor = 0,
            KeyCode::End => self.modal_cursor = self.modal_input.chars().count(),
            KeyCode::Char('a') if control => self.modal_cursor = 0,
            KeyCode::Char('e') if control => self.modal_cursor = self.modal_input.chars().count(),
            KeyCode::Char('u') if control => {
                self.clear_modal_input();
                self.theme_cursor = 0;
                self.preview_theme_at_cursor();
            }
            KeyCode::Char('w') if control => {
                self.delete_modal_word();
                self.theme_cursor = 0;
                self.preview_theme_at_cursor();
            }
            KeyCode::Backspace => {
                self.delete_modal_back();
                self.theme_cursor = 0;
                self.preview_theme_at_cursor();
            }
            KeyCode::Delete => {
                self.delete_modal_forward();
                self.theme_cursor = 0;
                self.preview_theme_at_cursor();
            }
            KeyCode::Char(character) if !control && !key.modifiers.contains(KeyModifiers::ALT) => {
                self.insert_modal_text(&character.to_string());
                self.theme_cursor = 0;
                self.preview_theme_at_cursor();
            }
            _ => {}
        }
    }

    fn toggle_viewed_current(&mut self) {
        let Some(index) = self.file_tree.selected_file_idx() else {
            return;
        };
        let Some(path) = self
            .files
            .get(index)
            .map(|file| file.display_path().to_path_buf())
        else {
            return;
        };
        let viewed = if self.viewed_paths.remove(&path) {
            false
        } else {
            self.viewed_paths.insert(path.clone());
            true
        };
        self.file_tree.set_viewed(index, viewed);
        if let Err(error) = crate::persistence::save_viewed(
            self.repo_root.to_str().unwrap_or("."),
            &self.viewed_paths,
        ) {
            self.report_error(format!("could not save viewed files: {error}"));
        }
        self.apply_file_filter();
    }

    fn persist_settings(&mut self) {
        if let Err(error) = crate::persistence::save_settings(
            self.theme,
            self.wrap,
            self.split,
            self.tab_size,
            self.line_numbers,
            self.mouse_enabled,
            self.lsp.mode(),
        ) {
            self.report_error(format!("could not save settings: {error}"));
        }
    }

    fn persist_layout(&mut self) {
        if let Err(error) = crate::persistence::save_layout(
            self.repo_root.to_str().unwrap_or("."),
            self.sidebar_width,
            self.comment_height,
            self.sidebar_visible,
            self.comments_visible,
            self.file_display,
        ) {
            self.report_error(format!("could not save layout: {error}"));
        }
    }

    fn jump_to_relative_file(&mut self, delta: isize) {
        let Some(next) = self.file_tree.relative_file_idx(delta) else {
            self.status_message = Some(format!(
                "no files match the {} filter",
                self.file_filter_mode.label().to_ascii_lowercase()
            ));
            return;
        };
        self.file_tree.jump_to_file(next);
        self.visual_anchor = None;
        if self.file_display == FileDisplay::Continuous {
            let offset = self.continuous_offset_for_file(next);
            self.continuous_cursor = offset;
            self.continuous_scroll = offset;
            self.sync_continuous_active();
        } else {
            self.scroll = 0;
            self.cursor_row = 0;
        }
        self.horizontal_offset = 0;
        self.code_column = None;
    }

    fn move_diff_cursor(&mut self, delta: isize) {
        self.code_column = None;
        if self.file_display == FileDisplay::Continuous {
            let rows = self.continuous_total_rows();
            if rows == 0 {
                return;
            }
            self.continuous_cursor = (self.continuous_cursor as isize + delta)
                .clamp(0, rows.saturating_sub(1) as isize)
                as u64;
            let visible = self.rendered_diff_rows.iter().flat_map(|rendered| {
                rendered.logical_rows.iter().flatten().map(|logical| {
                    self.continuous_offset_for_file(rendered.file_index)
                        .saturating_add(*logical)
                })
            });
            let bounds = visible.fold(None, |bounds, row| match bounds {
                None => Some((row, row)),
                Some((minimum, maximum)) => Some((minimum.min(row), maximum.max(row))),
            });
            if let Some((minimum, maximum)) = bounds {
                if self.continuous_cursor < minimum {
                    self.continuous_scroll = self.continuous_cursor;
                } else if self.continuous_cursor > maximum {
                    self.continuous_scroll = self
                        .continuous_scroll
                        .saturating_add(self.continuous_cursor.saturating_sub(maximum));
                }
            } else {
                let top = self.continuous_scroll;
                let height = self.viewport_height.max(1) as u64;
                if self.continuous_cursor < top {
                    self.continuous_scroll = self.continuous_cursor;
                } else if self.continuous_cursor >= top + height {
                    self.continuous_scroll = self
                        .continuous_cursor
                        .saturating_add(1)
                        .saturating_sub(height);
                }
            }
            self.sync_continuous_active();
            return;
        }
        let rows = self.current_file_rows();
        if rows == 0 {
            return;
        }
        let next =
            (self.cursor_row as isize + delta).clamp(0, rows.saturating_sub(1) as isize) as u64;
        self.cursor_row = next;
        let selected_file = self.file_tree.active_file_idx();
        let bounds = self
            .rendered_diff_rows
            .iter()
            .filter(|rendered| Some(rendered.file_index) == selected_file)
            .flat_map(|rendered| rendered.logical_rows.iter().flatten().copied())
            .fold(None, |bounds, row| match bounds {
                None => Some((row, row)),
                Some((minimum, maximum)) => Some((minimum.min(row), maximum.max(row))),
            });
        if let Some((minimum, maximum)) = bounds {
            if next < minimum {
                self.scroll = next as usize;
            } else if next > maximum {
                self.scroll =
                    (self.scroll as u64).saturating_add(next.saturating_sub(maximum)) as usize;
            }
        } else {
            let top = self.scroll as u64;
            let height = self.viewport_height.max(1) as u64;
            if next < top {
                self.scroll = next as usize;
            } else if next >= top + height {
                self.scroll = next.saturating_add(1).saturating_sub(height) as usize;
            }
        }
    }

    fn continuous_total_rows(&self) -> u64 {
        self.render_metadata.total_rows()
    }

    fn continuous_offset_for_file(&self, file_index: usize) -> u64 {
        self.render_metadata.file_offset(file_index)
    }

    fn continuous_position(&self, global_row: u64) -> Option<(usize, u64)> {
        self.render_metadata.position(global_row)
    }

    fn sync_continuous_active(&mut self) {
        if let Some((file, row)) = self.continuous_position(self.continuous_cursor) {
            if self
                .visual_anchor
                .is_some_and(|(anchor_file, _)| anchor_file != file)
            {
                self.visual_anchor = None;
            }
            self.file_tree.jump_to_file(file);
            self.cursor_row = row;
        }
    }

    fn current_file_rows(&self) -> u64 {
        self.file_tree
            .active_file_idx()
            .and_then(|index| self.index.files.get(index))
            .map(|file| file.row_count)
            .unwrap_or(0)
    }

    fn clamp_cursor(&mut self) {
        let rows = self.current_file_rows();
        self.cursor_row = self.cursor_row.min(rows.saturating_sub(1));
        self.scroll = (self.scroll as u64).min(rows.saturating_sub(1)) as usize;
    }

    fn jump_relative_comment(&mut self, delta: isize) {
        if self.comments.is_empty() {
            return;
        }
        let n = self.comments.len() as isize;
        let cur = self.tracker.cursor as isize;
        let next = (cur + delta).rem_euclid(n);
        self.tracker.cursor = next as usize;
        self.jump_to_focused_comment();
    }

    fn jump_relative_hunk(&mut self, delta: isize) {
        let Some(file_index) = self.file_tree.active_file_idx() else {
            return;
        };
        let Some(file) = self.index.files.get(file_index) else {
            return;
        };
        if file.hunks.is_empty() {
            self.status_message = Some("file has no textual hunks".to_string());
            return;
        }
        let count = file.hunks.len() as isize;
        let next = if delta > 0 {
            let first_after = file
                .hunks
                .partition_point(|hunk| hunk.row_start <= self.cursor_row)
                as isize;
            (first_after + delta - 1).rem_euclid(count) as usize
        } else {
            let first_at_or_after = file
                .hunks
                .partition_point(|hunk| hunk.row_start < self.cursor_row)
                as isize;
            (first_at_or_after + delta).rem_euclid(count) as usize
        };
        self.code_column = None;
        self.cursor_row = file.hunks[next].row_start;
        if self.file_display == FileDisplay::Continuous {
            self.continuous_cursor = self.continuous_offset_for_file(file_index) + self.cursor_row;
            self.continuous_scroll = self
                .continuous_cursor
                .saturating_sub((self.viewport_height / 3) as u64);
        } else {
            self.scroll =
                self.cursor_row
                    .saturating_sub((self.viewport_height / 3) as u64) as usize;
        }
    }

    fn jump_to_focused_comment(&mut self) {
        let Some(c) = self.comments.get(self.tracker.cursor).cloned() else {
            return;
        };
        if let Some(file_idx) = self
            .files
            .iter()
            .position(|f| f.display_path() == std::path::Path::new(&c.file_path))
        {
            self.reveal_file_for_direct_jump(file_idx);
            self.focus = Focus::Diff;
            let target_row = if c.line_number == 0 {
                Some(0)
            } else {
                self.find_comment_row(file_idx, &c)
            };
            match target_row {
                Some(row) => {
                    self.cursor_row = row;
                    if self.file_display == FileDisplay::Continuous {
                        self.continuous_cursor = self.continuous_offset_for_file(file_idx) + row;
                        self.continuous_scroll = self
                            .continuous_cursor
                            .saturating_sub((self.viewport_height / 2) as u64);
                    } else {
                        self.scroll =
                            row.saturating_sub((self.viewport_height / 2) as u64) as usize;
                    }
                    self.status_message = Some(format!("→ {}:{}", c.file_path, c.line_number));
                }
                None => {
                    self.status_message = Some(format!(
                        "comment target is outdated: {}:{}",
                        c.file_path, c.line_number
                    ));
                }
            }
        } else {
            self.status_message = Some(format!("file not in current diff: {}", c.file_path));
        }
    }

    fn open_new_comment_form(&mut self) {
        let Some(target) = self.build_comment_target(false) else {
            return;
        };
        let label = if let Some(start) = target.start_line_number {
            format!(
                "new comment · {}:{start}-{}",
                target.file_path, target.line_number
            )
        } else {
            format!("new comment · {}:{}", target.file_path, target.line_number)
        };
        self.pending_comment_target = Some(target);
        self.visual_anchor = None;
        self.comment_form = Some(CommentFormState::new(label));
        self.mode = Mode::CommentForm;
    }

    fn open_file_comment_form(&mut self) {
        let Some(target) = self.build_comment_target(true) else {
            return;
        };
        let label = format!("new file comment · {}", target.file_path);
        self.pending_comment_target = Some(target);
        self.comment_form = Some(CommentFormState::new(label));
        self.mode = Mode::CommentForm;
    }

    fn toggle_visual_selection(&mut self) {
        let Some(file) = self.file_tree.selected_file_idx() else {
            return;
        };
        if self.visual_anchor.take().is_some() {
            self.status_message = Some("line selection cancelled".to_string());
        } else {
            self.visual_anchor = Some((file, self.cursor_row));
            self.status_message =
                Some("line selection started · move, then c to comment".to_string());
        }
    }

    fn build_comment_target(&mut self, file_level: bool) -> Option<PendingCommentTarget> {
        let file_index = self.file_tree.selected_file_idx()?;
        let file_path = self
            .files
            .get(file_index)?
            .display_path()
            .to_string_lossy()
            .to_string();
        if file_level {
            return Some(PendingCommentTarget {
                file_path,
                side: CommentSide::Additions,
                start_line_number: None,
                line_number: 0,
                line_content: String::new(),
            });
        }

        let (start_row, end_row) = match self.visual_anchor {
            Some((anchor_file, anchor_row)) if anchor_file == file_index => (
                anchor_row.min(self.cursor_row),
                anchor_row.max(self.cursor_row),
            ),
            Some(_) => {
                self.status_message = Some("line selection cannot cross files".to_string());
                return None;
            }
            None => (self.cursor_row, self.cursor_row),
        };
        let Ok(count) = usize::try_from(end_row.saturating_sub(start_row).saturating_add(1)) else {
            self.status_message = Some("selected range is too large".to_string());
            return None;
        };
        let viewport =
            match self
                .index
                .viewport(file_index, start_row, count, DEFAULT_VIEWPORT_MAX_BYTES)
            {
                Ok(viewport) => viewport,
                Err(error) => {
                    self.status_message = Some(format!("could not select lines: {error}"));
                    return None;
                }
            };
        if viewport.truncated || viewport.rows.len() != count {
            self.status_message = Some(
                "selection exceeds the safe comment range; choose fewer or smaller lines"
                    .to_string(),
            );
            return None;
        }
        match inline_comment_target(file_path, viewport.rows) {
            Ok(target) => Some(target),
            Err(message) => {
                self.status_message = Some(message.to_string());
                None
            }
        }
    }

    fn open_edit_form_for_focused(&mut self) {
        let Some(c) = self.comments.get(self.tracker.cursor) else {
            self.status_message = Some("no comment focused".to_string());
            return;
        };
        let label = format!("edit · {}:{}", c.file_path, c.line_number);
        let body = c.body.clone();
        self.comment_form = Some(CommentFormState::edit(label, &body));
        self.mode = Mode::CommentForm;
    }

    fn open_reply_form_for_focused(&mut self) {
        let Some(c) = self.comments.get(self.tracker.cursor) else {
            self.status_message = Some("no comment focused".to_string());
            return;
        };
        let label = format!("reply · {}:{}", c.file_path, c.line_number);
        self.comment_form = Some(CommentFormState::reply(label));
        self.mode = Mode::CommentForm;
    }

    fn resolve_focused(&mut self) {
        let Some(c) = self.comments.get(self.tracker.cursor) else {
            self.status_message = Some("no comment focused".to_string());
            return;
        };
        let id = c.id.clone();
        let next_status = match c.status {
            CommentStatus::Open => CommentStatus::Resolved,
            CommentStatus::Resolved => CommentStatus::Open,
        };
        match self.comment_store.update(&id, None, Some(next_status)) {
            Ok(Some(_)) => {
                self.status_message = Some(format!(
                    "comment {}",
                    if matches!(next_status, CommentStatus::Resolved) {
                        "resolved"
                    } else {
                        "reopened"
                    }
                ));
                self.reload_comments_with_notifications(false);
            }
            Ok(None) => self.report_error("resolve failed: comment no longer exists"),
            Err(error) => self.report_error(format!("resolve failed: {error}")),
        }
    }

    fn resolve_all_comments(&mut self) {
        if !self.pending_resolve_all {
            let open = self
                .comments
                .iter()
                .filter(|comment| comment.status == CommentStatus::Open)
                .count();
            if open == 0 {
                self.set_status_message("no open comments");
                return;
            }
            self.pending_resolve_all = true;
            self.set_status_message(format!(
                "press X again to resolve {open} open thread{}",
                if open == 1 { "" } else { "s" }
            ));
            return;
        }
        self.pending_resolve_all = false;
        match self.comment_store.resolve_all() {
            Ok(0) => self.set_status_message("no open comments"),
            Ok(count) => {
                self.set_status_message(format!("resolved {count} comment threads"));
                self.reload_comments_with_notifications(false);
            }
            Err(error) => self.report_error(format!("resolve all failed: {error}")),
        }
    }

    fn comment_is_outdated(&self, comment: &ReviewComment) -> bool {
        let Some(file_index) = self
            .files
            .iter()
            .position(|file| file.display_path() == std::path::Path::new(&comment.file_path))
        else {
            return true;
        };
        if comment.line_number == 0 {
            return false;
        }
        let end = comment
            .line_number
            .max(comment.start_line_number.unwrap_or(comment.line_number));
        let start = comment
            .line_number
            .min(comment.start_line_number.unwrap_or(comment.line_number));
        self.find_comment_line_row(file_index, comment.side, start)
            .zip(self.find_comment_line_row(file_index, comment.side, end))
            .is_none()
    }

    fn find_comment_row(&self, file_index: usize, comment: &ReviewComment) -> Option<u64> {
        self.find_comment_line_row(
            file_index,
            comment.side,
            comment
                .line_number
                .max(comment.start_line_number.unwrap_or(comment.line_number)),
        )
    }

    fn find_comment_line_row(
        &self,
        file_index: usize,
        side: CommentSide,
        line_number: u32,
    ) -> Option<u64> {
        let kinds: &[IndexedLineKind] = match side {
            CommentSide::Deletions => &[IndexedLineKind::Del],
            CommentSide::Additions => &[IndexedLineKind::Add, IndexedLineKind::Context],
        };
        kinds.iter().find_map(|kind| {
            self.index
                .find_line_row(file_index, *kind, line_number)
                .ok()
                .flatten()
        })
    }

    fn delete_focused(&mut self) {
        let Some(c) = self.comments.get(self.tracker.cursor) else {
            self.status_message = Some("no comment focused".to_string());
            return;
        };
        let id = c.id.clone();
        if self.pending_delete_id.as_deref() != Some(&id) {
            self.pending_delete_id = Some(id);
            self.status_message = Some(if self.mode == Mode::CommentDetail {
                "delete requires confirmation · press Delete or activate Delete again".to_string()
            } else {
                "delete requires confirmation · press d again".to_string()
            });
            return;
        }
        self.pending_delete_id = None;
        match self.comment_store.remove(&id) {
            Ok(true) => {
                self.status_message = Some("comment deleted".to_string());
                if self.mode == Mode::CommentDetail {
                    self.mode = Mode::Normal;
                }
                self.reload_comments_with_notifications(false);
            }
            Ok(false) => self.report_error("delete failed: comment no longer exists"),
            Err(error) => self.report_error(format!("delete failed: {error}")),
        }
    }

    fn current_line(&self) -> u32 {
        match self.current_view_row() {
            Some(ViewRow::Line {
                old_lineno,
                new_lineno,
                ..
            }) => new_lineno.or(old_lineno).unwrap_or(1),
            Some(ViewRow::FileHeader { .. }) => 0,
            _ => 1,
        }
    }

    fn current_location_label(&self) -> String {
        match self.current_view_row() {
            Some(ViewRow::Line {
                kind: IndexedLineKind::Add,
                new_lineno: Some(line),
                ..
            }) => format!("new +{line}"),
            Some(ViewRow::Line {
                kind: IndexedLineKind::Del,
                old_lineno: Some(line),
                ..
            }) => format!("old -{line}"),
            Some(ViewRow::Line {
                old_lineno,
                new_lineno,
                ..
            }) => format!("line {}", new_lineno.or(old_lineno).unwrap_or(0)),
            Some(ViewRow::HunkHeader {
                old_start,
                new_start,
                ..
            }) => format!("hunk -{old_start}/+{new_start}"),
            Some(ViewRow::FileHeader { binary: true, .. }) => "binary file".to_string(),
            Some(ViewRow::FileHeader { .. }) => "file header".to_string(),
            Some(ViewRow::NoNewline { .. }) => "newline marker".to_string(),
            None => "no line".to_string(),
        }
    }

    fn current_line_content(&self) -> String {
        match self.current_view_row() {
            Some(ViewRow::Line { content, .. }) => content,
            _ => String::new(),
        }
    }

    fn current_side(&self) -> CommentSide {
        match self.current_view_row() {
            Some(ViewRow::Line {
                kind: IndexedLineKind::Del,
                ..
            }) => CommentSide::Deletions,
            _ => CommentSide::Additions,
        }
    }

    fn current_view_row(&self) -> Option<ViewRow> {
        let file_index = self.file_tree.active_file_idx()?;
        self.index
            .viewport(file_index, self.cursor_row, 1, 64 * 1024)
            .ok()?
            .rows
            .into_iter()
            .next()
    }

    fn status_bar_hints(&mut self) -> (String, Option<String>) {
        let file_index = self.file_tree.active_file_idx().unwrap_or(usize::MAX);
        let lsp_revision = self.lsp.diagnostics_revision();
        let generation = self.index.generation;
        let cursor_row = self.cursor_row;
        if let Some(memo) = &self.status_bar_memo {
            if memo.generation == generation
                && memo.file_index == file_index
                && memo.cursor_row == cursor_row
                && memo.lsp_revision == lsp_revision
            {
                return (memo.location_label.clone(), memo.diagnostic_hint.clone());
            }
        }
        let location_label = self.current_location_label();
        let diagnostic_hint = self.current_diagnostic_hint();
        self.status_bar_memo = Some(StatusBarMemo {
            generation,
            file_index,
            cursor_row,
            lsp_revision,
            location_label: location_label.clone(),
            diagnostic_hint: diagnostic_hint.clone(),
        });
        (location_label, diagnostic_hint)
    }

    fn current_diagnostic_hint(&self) -> Option<String> {
        let file = self.current_file()?;
        let ViewRow::Line {
            kind, new_lineno, ..
        } = self.current_view_row()?
        else {
            return None;
        };
        if kind == IndexedLineKind::Del {
            return None;
        }
        let line = new_lineno?.checked_sub(1)?;
        let diagnostics = self.lsp.diagnostics_for(file.display_path());
        let diagnostic = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.line == line)
            .min_by_key(|diagnostic| diagnostic.severity)?;
        Some(format!(
            "{} {}{}",
            diagnostic.marker(),
            diagnostic
                .source
                .as_deref()
                .map(|source| format!("{source}: "))
                .unwrap_or_default(),
            diagnostic.message.replace(['\n', '\r'], " ")
        ))
    }

    fn annotation_revision(&self) -> u64 {
        if self.experience == Experience::Viewer {
            0
        } else {
            self.comments_revision.rotate_left(17) ^ self.lsp.diagnostics_revision()
        }
    }

    fn current_file(&self) -> Option<&diffing_core::diff::FileDiff> {
        let idx = self.file_tree.active_file_idx()?;
        self.files.get(idx)
    }

    fn selected_image(&self) -> Option<(ImageKey, PathBuf)> {
        let file_index = self.file_tree.active_file_idx()?;
        let file = self.index.files.get(file_index)?;
        let path = file.display_path().to_path_buf();
        is_image_path(&path).then(|| (ImageKey::new(self.index.generation, file), path))
    }

    fn diff_target_at(&self, area: Rect, column: u16, row: u16) -> Option<(usize, u64)> {
        rendered_diff_target_at(&self.rendered_diff_rows, area, column, row)
    }

    fn pointer_diff_target(&self, position: Option<(u16, u16)>) -> Option<(usize, u64)> {
        let (column, row) = position?;
        let area = self
            .regions
            .diff_inner
            .filter(|area| contains(*area, column, row))?;
        self.diff_target_at(area, column, row)
    }

    fn prepare_selected_image(&mut self) -> Option<(PathBuf, Option<Arc<ImageDiffData>>)> {
        let Some((key, path)) = self.selected_image() else {
            return None;
        };
        let key_changed = self.active_image_key.as_ref() != Some(&key);
        if key_changed {
            self.image_view = ImageViewState::default();
            self.active_image_key = Some(key.clone());
        }
        self.image_diff.request(key.clone());
        let data = self.image_diff.get(&key);
        if let Some(data) = data.as_ref() {
            self.image_view.mode = if key_changed {
                default_compare_mode(data)
            } else {
                self.image_view.mode.normalize(data)
            };
        }
        Some((path, data))
    }

    fn render_prepared_image(
        &self,
        path: &PathBuf,
        data: Option<&Arc<ImageDiffData>>,
        area: Rect,
        presentation: ImagePresentation,
        buf: &mut Buffer,
    ) {
        if let Some(data) = data {
            render_image_diff(
                data,
                path,
                &self.image_view,
                area,
                self.theme,
                &self.palette,
                presentation,
                buf,
            );
        } else {
            Paragraph::new("◌  Loading image comparison…")
                .style(Style::default().fg(self.palette.dim).bg(self.palette.bg))
                .centered()
                .render(area, buf);
        }
    }

    fn render_selected_image(&mut self, area: Rect, buf: &mut Buffer) {
        let Some((path, data)) = self.prepare_selected_image() else {
            return;
        };
        self.render_prepared_image(&path, data.as_ref(), area, ImagePresentation::Inline, buf);
    }

    fn render_image_preview(&mut self, area: Rect, buf: &mut Buffer) {
        let prepared = self.prepare_selected_image();
        dim_buffer(area, buf);
        let popup = inset(area, 1);
        Clear.render(popup, buf);
        let tokens = GridlineTokens::from(&self.palette);
        fill(popup, tokens.canvas, buf);
        let controls_height = u16::from(popup.height >= 4);
        let content = Rect::new(
            popup.x,
            popup.y + controls_height,
            popup.width,
            popup.height.saturating_sub(controls_height),
        );
        if controls_height > 0 {
            let controls = Rect::new(popup.x, popup.y, popup.width, 1);
            let data = prepared.as_ref().and_then(|(_, data)| data.as_deref());
            let mut labels = Vec::new();
            let mut mapped = Vec::new();
            for (label, mode, control) in [
                (
                    "1 Before",
                    ImageCompareMode::Before,
                    ImageControl::Mode(ImageCompareMode::Before),
                ),
                (
                    "2 After",
                    ImageCompareMode::After,
                    ImageControl::Mode(ImageCompareMode::After),
                ),
                (
                    "3 Side",
                    ImageCompareMode::SideBySide,
                    ImageControl::Mode(ImageCompareMode::SideBySide),
                ),
                (
                    "4 Diff",
                    ImageCompareMode::Difference,
                    ImageControl::Mode(ImageCompareMode::Difference),
                ),
            ] {
                if data.is_none_or(|data| mode.is_available(data)) {
                    labels.push((label, self.image_view.mode == mode));
                    mapped.push(control);
                }
            }
            labels.push(("-", false));
            mapped.push(ImageControl::ZoomOut);
            labels.push(("0 Fit", false));
            mapped.push(ImageControl::Reset);
            labels.push(("+", false));
            mapped.push(ImageControl::ZoomIn);
            let regions = chip_row(controls, &labels, self.mouse_position, &self.palette, buf);
            for (region, control) in regions.into_iter().zip(mapped) {
                self.regions.image_controls.push((region, control));
            }
            let close_label = "Esc close";
            let close_width = UnicodeWidthStr::width(close_label) as u16 + 2;
            let close_x = popup
                .x
                .saturating_add(popup.width)
                .saturating_sub(close_width + 1);
            if close_x > controls.x.saturating_add(2) {
                let region = Rect::new(close_x, controls.y, close_width, 1);
                fill(region, tokens.canvas, buf);
                let line = crate::ui::gridline::chip(close_label, false, false, &self.palette);
                let mut offset = close_x + 1;
                for span in line.spans {
                    buf.set_string(offset, controls.y, span.content.as_ref(), span.style);
                    offset =
                        offset.saturating_add(UnicodeWidthStr::width(span.content.as_ref()) as u16);
                }
                self.regions
                    .image_controls
                    .push((region, ImageControl::Close));
            }
        }
        if let Some((path, data)) = prepared.as_ref() {
            self.render_prepared_image(
                path,
                data.as_ref(),
                content,
                ImagePresentation::Fullscreen,
                buf,
            );
        } else {
            Paragraph::new("Selected image is no longer in this diff · Esc closes")
                .style(Style::default().fg(self.palette.dim).bg(self.palette.bg))
                .centered()
                .render(content, buf);
        }
    }

    fn render_comment_detail(&mut self, area: Rect, buf: &mut Buffer) {
        let Some(comment) = self.comments.get(self.tracker.cursor) else {
            return;
        };
        dim_buffer(area, buf);
        let width = area.width.saturating_sub(METRICS.modal_margin_x).min(104);
        let height = area
            .height
            .saturating_sub(METRICS.modal_margin_y)
            .clamp(7, 30);
        let popup = Rect::new(
            area.x + area.width.saturating_sub(width) / 2,
            area.y + area.height.saturating_sub(height) / 2,
            width,
            height,
        );
        Clear.render(popup, buf);
        let max_scroll = render_thread(
            comment,
            self.comment_detail_scroll,
            popup,
            &self.palette,
            buf,
        );
        self.comment_detail_scroll = self.comment_detail_scroll.min(max_scroll);
        if popup.width > 20 && popup.height > 0 {
            let y = popup.y + popup.height.saturating_sub(1);
            let end = popup.x + popup.width.saturating_sub(1);
            let resolve_label = if comment.status == CommentStatus::Resolved {
                "x Reopen"
            } else {
                "x Resolve"
            };
            let delete_label = if self.pending_delete_id.as_deref() == Some(&comment.id) {
                "Del Confirm"
            } else {
                "Del Delete"
            };
            let mut x = popup.x + 1;
            for (label, control) in [
                ("Enter Jump", CommentDetailControl::Jump),
                ("e Edit", CommentDetailControl::Edit),
                ("r Reply", CommentDetailControl::Reply),
                (resolve_label, CommentDetailControl::Resolve),
                (delete_label, CommentDetailControl::Delete),
            ] {
                let width = UnicodeWidthStr::width(label) as u16 + 2;
                if x.saturating_add(width) >= end {
                    break;
                }
                let region =
                    render_chip(x, y, label, false, self.mouse_position, &self.palette, buf);
                self.regions.comment_detail_controls.push((region, control));
                x = x.saturating_add(width + 1);
            }
            let close_label = "Esc Close";
            let close_width = UnicodeWidthStr::width(close_label) as u16 + 2;
            let close_x = end.saturating_sub(close_width);
            if close_x > x {
                let region = render_chip(
                    close_x,
                    y,
                    close_label,
                    false,
                    self.mouse_position,
                    &self.palette,
                    buf,
                );
                self.regions
                    .comment_detail_controls
                    .push((region, CommentDetailControl::Close));
            }
        }
    }

    pub fn render(&mut self, area: Rect, buf: &mut Buffer) {
        self.regions = UiRegions::default();
        self.regions.root = Some(area);
        fill_area(area, self.palette.bg, buf);
        if area.width < METRICS.content_min_width || area.height < 8 {
            Paragraph::new(format!(
                "diffing needs at least {}×8 cells",
                METRICS.content_min_width
            ))
            .style(Style::default().fg(self.palette.fg).bg(self.palette.bg))
            .render(area, buf);
            return;
        }

        if self.comments.is_empty() && self.focus == Focus::Tracker {
            self.focus = Focus::Diff;
        }

        let header_height = METRICS.header_height;
        let header = Rect::new(area.x, area.y, area.width, header_height);
        let status = Rect::new(
            area.x,
            area.y + area.height - METRICS.status_height,
            area.width,
            METRICS.status_height,
        );
        let comments_requested = self.experience == Experience::Review
            && self.comments_visible
            && !self.comments.is_empty();
        let (mut show_sidebar, mut show_comments) = panel_visibility(
            area.width,
            area.height,
            self.sidebar_visible,
            comments_requested,
        );
        if self.experience == Experience::Viewer {
            show_sidebar = self.sidebar_visible && area.width >= 84;
            show_comments = false;
        }
        let compact_workspace = area.width < 88;
        let show_diff = !compact_workspace || self.focus == Focus::Diff;
        if compact_workspace {
            show_sidebar = self.sidebar_visible && self.focus == Focus::FileTree;
            show_comments = self.comments_visible && self.focus == Focus::Tracker;
        }
        if header.height > 0 {
            self.render_header(header, buf);
        }

        let comments_right = show_comments && area.width >= 132;
        let comments_workspace = compact_workspace && show_comments;
        let tracker_height = if show_comments && !comments_right && !comments_workspace {
            self.comment_height
                .clamp(4, area.height.saturating_sub(18).min(20))
        } else {
            0
        };
        let body_height = area
            .height
            .saturating_sub(header_height + METRICS.status_height + tracker_height);
        let body = Rect::new(area.x, area.y + header_height, area.width, body_height);
        let sidebar_width = if show_sidebar && compact_workspace {
            body.width
        } else if show_sidebar {
            self.sidebar_width.clamp(
                METRICS.sidebar_min_width,
                area.width.saturating_sub(METRICS.content_min_width),
            )
        } else {
            0
        };
        let sidebar_divider_width = u16::from(show_sidebar && !compact_workspace);
        let review_width = if comments_right {
            METRICS.review_width.min(
                body.width
                    .saturating_sub(sidebar_width + METRICS.content_min_width + 2),
            )
        } else {
            0
        };
        let file_area = show_sidebar.then(|| Rect::new(body.x, body.y, sidebar_width, body.height));
        let divider = show_sidebar.then(|| {
            Rect::new(
                body.x + sidebar_width,
                body.y,
                sidebar_divider_width,
                body.height,
            )
        });
        let diff_area = Rect::new(
            body.x + sidebar_width + sidebar_divider_width,
            body.y,
            if show_diff {
                body.width
                    .saturating_sub(sidebar_width + sidebar_divider_width + review_width)
            } else {
                0
            },
            body.height,
        );
        if let Some(file_area) = file_area {
            let minimal_tree = self.experience == Experience::Viewer;
            self.sync_file_tree_scroll_for(
                file_tree_content_area(file_area, minimal_tree).height as usize,
            );
            render_file_tree(
                &self.file_tree,
                file_area,
                FileTreeRenderOptions {
                    focused: matches!(self.focus, Focus::FileTree),
                    scroll: self.file_tree_scroll,
                    minimal: minimal_tree,
                    file_count: self.files.len(),
                    visible_file_count: self.file_tree.filtered_file_count(),
                    filter_label: self.file_filter_mode.label(),
                },
                &self.palette,
                buf,
            );
            self.regions.file_tree = Some(file_area);
            let inner = file_tree_content_area(file_area, minimal_tree);
            self.regions.file_rows = (0..inner.height as usize)
                .filter_map(|offset| {
                    let node = self.file_tree_scroll + offset;
                    (node < self.file_tree.nodes.len()).then_some((
                        Rect::new(inner.x, inner.y + offset as u16, inner.width, 1),
                        node,
                    ))
                })
                .collect();
        }
        if let Some(divider) = divider {
            vertical_rule(divider, &self.palette, self.palette.bg, buf);
            self.regions.sidebar_divider = Some(divider);
        }
        if show_diff && diff_area.width > 0 {
            let diff_header_height = if self.experience == Experience::Review
                || self.file_display != FileDisplay::Continuous
            {
                2
            } else {
                0
            };
            let diff_header = Rect::new(
                diff_area.x,
                diff_area.y,
                diff_area.width,
                diff_header_height,
            );
            let diff_content = Rect::new(
                diff_area.x,
                diff_area.y + diff_header_height,
                diff_area.width,
                diff_area.height.saturating_sub(diff_header_height),
            );
            if diff_header.height > 0 {
                self.render_active_file_header(diff_header, buf);
            }
            self.regions.diff = Some(diff_content);
            self.regions.diff_inner = Some(diff_content);
            self.regions.change_map = (diff_content.width >= 8).then(|| {
                Rect::new(
                    diff_content.x + diff_content.width.saturating_sub(1),
                    diff_content.y,
                    1,
                    diff_content.height,
                )
            });
            self.render_diff(diff_content, buf);
        }

        if show_comments {
            let tracker_area = if comments_workspace {
                body
            } else if comments_right {
                Rect::new(
                    diff_area.x + diff_area.width,
                    body.y,
                    review_width,
                    body.height,
                )
            } else {
                let divider_y = body.y + body.height;
                let divider = Rect::new(area.x, divider_y, area.width, 1);
                self.regions.comment_divider = Some(divider);
                Rect::new(area.x, divider_y, area.width, tracker_height)
            };
            let tracker_inner = inset(tracker_area, 1);
            self.tracker
                .keep_cursor_visible(&self.comments, tracker_inner.height as usize);
            let visible_comments = self.tracker.visible_indices(&self.comments);
            let outdated_comments: HashSet<String> = visible_comments
                .iter()
                .skip(self.tracker.scroll)
                .take(tracker_inner.height as usize)
                .filter_map(|index| self.comments.get(*index))
                .filter(|comment| self.comment_is_outdated(comment))
                .map(|comment| comment.id.clone())
                .collect();
            render_tracker(
                &self.comments,
                &visible_comments,
                &outdated_comments,
                &mut self.tracker,
                matches!(self.focus, Focus::Tracker),
                tracker_area,
                &self.palette,
                buf,
            );
            self.regions.comment_panel = Some(tracker_area);
            let inner = tracker_inner;
            self.regions.comment_rows = (0..inner.height as usize)
                .filter_map(|offset| {
                    visible_comments
                        .get(self.tracker.scroll + offset)
                        .copied()
                        .map(|comment| {
                            (
                                Rect::new(inner.x, inner.y + offset as u16, inner.width, 1),
                                comment,
                            )
                        })
                })
                .collect();
        }

        // Agent status indicator in the status line.
        let mode_str = if self.experience == Experience::Viewer && self.mode == Mode::Normal {
            ""
        } else if self.mode == Mode::Normal && self.visual_anchor.is_some() {
            "VISUAL"
        } else {
            match self.mode {
                Mode::Normal => "NORMAL",
                Mode::CommentForm => "EDIT",
                Mode::SendReview => "SEND",
                Mode::Search => "SEARCH",
                Mode::Command => "COMMAND",
                Mode::Help => "HELP",
                Mode::ThemePicker => "THEME",
                Mode::Settings => "SETTINGS",
                Mode::Hover => "HOVER",
                Mode::ImagePreview => "IMAGE",
                Mode::CommentDetail => "THREAD",
            }
        };
        self.agent_status = if self
            .agent_api
            .as_ref()
            .is_some_and(|api| api.waiter_count() > 0)
        {
            AgentStatus::Waiting
        } else {
            AgentStatus::Idle
        };
        let active_file_idx = self.file_tree.active_file_idx();
        let navigable_files = self.file_tree.navigable_file_indices().to_vec();
        let (status_location_label, diagnostic_hint) = self.status_bar_hints();
        let file_idx = active_file_idx
            .and_then(|selected| navigable_files.iter().position(|index| *index == selected))
            .unwrap_or(0);
        let file_count = navigable_files.len();
        let hint = match self.mode {
            Mode::ThemePicker => "type to filter · ↑↓ preview · Enter apply · Esc restore",
            Mode::CommentForm => "Ctrl-S save · Esc cancel",
            Mode::SendReview => "Tab field · ←→ verdict · Ctrl-S send · Esc cancel",
            // Search owns its keyboard reference inside the overlay. Keeping
            // the dimmed application strip quiet avoids duplicate controls.
            Mode::Search => "",
            Mode::Settings => "↑↓ select · ←→ change · Esc close",
            Mode::Hover => "j/k or wheel scroll · Esc close",
            Mode::ImagePreview => "Tab mode · +/- zoom · hjkl pan · 0 fit · Esc close",
            Mode::CommentDetail => {
                "j/k scroll · Enter jump · e edit · r reply · x resolve · Esc close"
            }
            _ if self.image_focus_active() => {
                "Tab mode · +/- zoom · hjkl pan · 0 fit · i fullscreen"
            }
            _ => match self.focus {
                Focus::FileTree if self.experience == Experience::Viewer => {
                    "jk select · Enter open · h parent/collapse · l expand · Tab diff · / search"
                }
                Focus::FileTree => {
                    "click/jk select · h parent/collapse · l expand · v viewed · Tab diff"
                }
                Focus::Tracker => "jk select · s status · p severity · o open · x resolve",
                Focus::Diff if self.experience == Experience::Viewer => {
                    "jk move · J/K files · ]h/[h hunks · / search · ? help"
                }
                Focus::Diff => "wheel/jk move · c comment · / search · , settings · ? help",
            },
        };
        let pending_key_hint = self.keymap.pending_hint();
        let selection_hint = self.visual_anchor.map(|(_, anchor)| {
            let rows = anchor.abs_diff(self.cursor_row).saturating_add(1);
            format!("{rows} rows selected · c comment · V/Esc cancel")
        });
        let hint = self
            .status_message
            .as_deref()
            .or(selection_hint.as_deref())
            .or(diagnostic_hint.as_deref())
            .or(pending_key_hint)
            .unwrap_or(hint);
        let status_location = if self.files.is_empty() {
            Some(if self.indexing {
                "indexing changes…".to_string()
            } else {
                "working tree clean".to_string()
            })
        } else if navigable_files.is_empty() {
            Some(format!(
                "{} filter · no matching files",
                self.file_filter_mode.label()
            ))
        } else {
            active_file_idx.map(|_| {
                format!(
                    "{}{}{}",
                    status_location_label,
                    if self.experience == Experience::Viewer || self.comments.is_empty() {
                        String::new()
                    } else {
                        format!(" · {} comments", self.comments.len())
                    },
                    if self.keymap.pending_display().is_empty() {
                        String::new()
                    } else {
                        format!(" · keys {}", self.keymap.pending_display())
                    }
                )
            })
        };
        render_status_bar(
            status,
            StatusBarContext {
                mode: mode_str,
                current_file: status_location.as_deref(),
                file_idx,
                file_count,
                hint,
            },
            &self.palette,
            buf,
        );

        // Modals.
        if let Some(form) = self.comment_form.as_mut() {
            render_form(form, area, &self.palette, buf);
        }
        if let Some(sr) = self.send_review.as_mut() {
            render_send_popover(sr, area, &self.palette, &self.comments, &self.files, buf);
        }
        match self.mode {
            Mode::Help => self.render_help(area, buf),
            Mode::Search => self.render_search_palette(area, buf),
            Mode::Command => self.render_prompt(area, ':', "command", buf),
            Mode::ThemePicker => self.render_theme_picker(area, buf),
            Mode::Settings => render_settings(
                &self.settings_state,
                SettingsValues {
                    file_display: self.file_display,
                    split: self.split,
                    wrap: self.wrap,
                    tab_size: self.tab_size,
                    line_numbers: self.line_numbers,
                    mouse_enabled: self.mouse_enabled,
                    sidebar_visible: self.sidebar_visible,
                    sidebar_width: self.sidebar_width,
                    comments_visible: self.comments_visible,
                    review_enabled: self.experience == Experience::Review,
                    intelligence_mode: self.lsp.mode(),
                    trust_repo_local_bin: self.trust_repo_local_bin,
                    theme_name: self.theme.display_name(),
                },
                area,
                &self.palette,
                buf,
            ),
            Mode::Hover => self.render_hover(area, buf),
            Mode::ImagePreview => self.render_image_preview(area, buf),
            Mode::CommentDetail => self.render_comment_detail(area, buf),
            _ => {}
        }

        // Toasts: bottom-right overlay.
        if self.mode == Mode::Normal && !self.toasts.is_empty() {
            let visible = self
                .toasts
                .len()
                .min(3)
                .min(area.height.saturating_sub(1) as usize);
            let toast_height = visible as u16;
            let toast_area = Rect {
                x: area.x + area.width.saturating_sub(40),
                y: area.y + area.height.saturating_sub(toast_height + 1),
                width: 38.min(area.width),
                height: toast_height,
            };
            for (i, toast) in self
                .toasts
                .iter()
                .skip(self.toasts.len().saturating_sub(visible))
                .enumerate()
            {
                let row = Rect {
                    x: toast_area.x,
                    y: toast_area.y + i as u16,
                    width: toast_area.width,
                    height: 1,
                };
                render_toast(toast, row, &self.palette, buf);
                self.regions.toast_rows.push((row, toast.id));
            }
        }
    }

    fn render_diff(&mut self, area: Rect, buf: &mut Buffer) {
        let hovered_target = self
            .mouse_position
            .and_then(|(column, row)| self.diff_target_at(area, column, row));
        self.rendered_diff_rows.clear();
        for y in area.y..area.y + area.height {
            for x in area.x..area.x + area.width {
                let cell = &mut buf[(x, y)];
                cell.set_symbol(" ");
                cell.set_style(ratatui::style::Style::default().bg(self.palette.bg));
            }
        }
        let Some(idx) = self.file_tree.active_file_idx() else {
            let (marker, title, detail, tone) = if !self.index.files.is_empty() {
                (
                    "›",
                    "Choose a file",
                    "Select a change from the file rail",
                    self.palette.accent,
                )
            } else if self.index.complete {
                (
                    "✓",
                    "Working tree clean",
                    "No changes to review",
                    self.palette.added,
                )
            } else {
                (
                    "◌",
                    "Indexing changes",
                    "The first files will appear as they are ready",
                    self.palette.comment,
                )
            };
            render_empty_diff_state(marker, title, detail, tone, area, &self.palette, buf);
            self.finish_pointer_mapping(area, hovered_target);
            return;
        };
        if self.file_display == FileDisplay::Continuous {
            self.render_continuous_diff(area, hovered_target, buf);
            self.finish_pointer_mapping(area, hovered_target);
            return;
        }
        let Some(file) = self.index.files.get(idx) else {
            self.finish_pointer_mapping(area, hovered_target);
            return;
        };
        if file.is_binary && is_image_path(file.display_path()) {
            self.viewport_height = area.height.max(1) as usize;
            self.render_selected_image(area, buf);
            self.finish_pointer_mapping(area, hovered_target);
            return;
        }
        let file_row_count = file.row_count;
        self.viewport_height = area.height.max(1) as usize;
        let total = file.row_count as usize;
        let effective_split = self.split && area.width >= 76;
        if !self.wrap && !effective_split && self.scroll + self.viewport_height > total {
            self.scroll = total.saturating_sub(self.viewport_height);
        } else if total > 0 {
            self.scroll = self.scroll.min(total - 1);
        }
        let hovered_row = hovered_target
            .filter(|(file_index, _)| *file_index == idx)
            .map(|(_, row)| row);
        let diagnostics = self.lsp.diagnostics_for(file.display_path());
        let tab_size =
            self.editorconfig
                .tab_size_for(&self.repo_root, file.display_path(), self.tab_size);
        let comments: &[ReviewComment] = if self.experience == Experience::Viewer {
            &[]
        } else {
            &self.comments
        };
        let annotation_revision = self.annotation_revision();
        render_card(
            &self.index,
            &mut self.diff_render_cache,
            idx,
            area,
            self.scroll as u64,
            self.cursor_row,
            self.visual_anchor.and_then(|(file, anchor)| {
                (file == idx).then_some((anchor.min(self.cursor_row), anchor.max(self.cursor_row)))
            }),
            hovered_row,
            self.horizontal_offset,
            self.wrap,
            effective_split,
            self.line_numbers,
            tab_size,
            self.theme,
            comments,
            &diagnostics,
            annotation_revision,
            &self.palette,
            buf,
        );
        self.rendered_diff_rows.extend(
            self.diff_render_cache
                .rendered_logical_rows()
                .iter()
                .copied()
                .map(|logical_rows| RenderedDiffRow {
                    file_index: idx,
                    logical_rows,
                    split: effective_split,
                }),
        );
        self.render_change_map(area, Some(idx), self.scroll as u64, file_row_count, buf);
        self.finish_pointer_mapping(area, hovered_target);
    }

    fn finish_pointer_mapping(&mut self, area: Rect, previous: Option<(usize, u64)>) {
        let current = self
            .mouse_position
            .and_then(|(column, row)| self.diff_target_at(area, column, row));
        self.pointer_overlay_dirty |= current != previous;
    }

    fn render_active_file_header(&self, area: Rect, buf: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        let tokens = GridlineTokens::from(&self.palette);
        fill_area(area, tokens.surface, buf);
        if self.focus == Focus::Diff {
            for y in area.y..area.y.saturating_add(area.height) {
                buf[(area.x, y)]
                    .set_symbol(GLYPHS.focus_rail)
                    .set_style(Style::default().fg(tokens.focus).bg(tokens.surface));
            }
        }
        let Some(index) = self.file_tree.active_file_idx() else {
            buf.set_string(
                area.x + 2,
                area.y,
                "Local changes",
                Style::default().fg(tokens.muted).bg(tokens.surface),
            );
            return;
        };
        let Some(file) = self.index.files.get(index) else {
            return;
        };
        let path = file.display_path().to_string_lossy();
        let marker = match file.kind {
            IndexedChangeKind::Modified => "M",
            IndexedChangeKind::Added => "A",
            IndexedChangeKind::Deleted => "D",
            IndexedChangeKind::Renamed => "R",
            IndexedChangeKind::Untracked => "U",
            IndexedChangeKind::Binary => "B",
        };
        let comments = self
            .comments
            .iter()
            .filter(|comment| comment.file_path == path)
            .count();
        let diagnostics = self.lsp.diagnostic_count(file.display_path());
        let language_state = self.lsp.state_for_path(file.display_path());
        let viewed = self.viewed_paths.contains(file.display_path());
        let marker_color = match file.kind {
            IndexedChangeKind::Added | IndexedChangeKind::Untracked => tokens.positive,
            IndexedChangeKind::Deleted => tokens.negative,
            IndexedChangeKind::Binary => tokens.warning,
            IndexedChangeKind::Modified | IndexedChangeKind::Renamed => tokens.accent,
        };
        buf.set_string(
            area.x + 2,
            area.y,
            marker,
            Style::default()
                .fg(marker_color)
                .bg(tokens.surface)
                .add_modifier(Modifier::BOLD),
        );
        let path_x = area.x + 5;
        let path_width = area.width.saturating_sub(7) as usize;
        let (directory, basename) = compact_path(&path, path_width);
        buf.set_string(
            path_x,
            area.y,
            &directory,
            Style::default().fg(tokens.muted).bg(tokens.surface),
        );
        buf.set_string(
            path_x + UnicodeWidthStr::width(directory.as_str()) as u16,
            area.y,
            basename,
            Style::default()
                .fg(tokens.text)
                .bg(tokens.surface)
                .add_modifier(Modifier::BOLD),
        );
        if area.height < 2 {
            return;
        }
        let mut x = if file.is_binary {
            area.x + 5
        } else {
            render_change_counts(
                area.x + 5,
                area.y + 1,
                file.additions,
                file.deletions,
                tokens.surface,
                &self.palette,
                buf,
            )
        };
        let end = area.x.saturating_add(area.width).saturating_sub(2);
        let mut metadata = vec![(
            if is_image_path(file.display_path()) {
                "  image · Tab mode · i fullscreen".to_string()
            } else if file.is_binary {
                "  binary file".to_string()
            } else {
                format!("  {} hunks", file.hunks.len())
            },
            Style::default()
                .fg(if is_image_path(file.display_path()) {
                    tokens.info
                } else {
                    tokens.muted
                })
                .bg(tokens.surface),
        )];
        if self.split && area.width < 76 {
            metadata.push((
                "  unified · widen for split".to_string(),
                Style::default().fg(tokens.warning).bg(tokens.surface),
            ));
        }
        if self.experience == Experience::Viewer {
            render_metadata_segments(&mut x, end, area.y + 1, metadata, buf);
            return;
        }
        if comments > 0 {
            metadata.push((
                format!("  {comments} comments"),
                Style::default().fg(tokens.info).bg(tokens.surface),
            ));
        }
        if diagnostics > 0 {
            metadata.push((
                format!("  {diagnostics} diagnostics"),
                Style::default().fg(tokens.warning).bg(tokens.surface),
            ));
        }
        if matches!(language_state, ServerState::Starting | ServerState::Error) {
            metadata.push((
                format!("  lsp {}", language_state.label()),
                Style::default().fg(tokens.warning).bg(tokens.surface),
            ));
        }
        metadata.push((
            if viewed {
                "  ✓ viewed".to_string()
            } else {
                "  unviewed".to_string()
            },
            Style::default()
                .fg(if viewed {
                    tokens.positive
                } else {
                    tokens.muted
                })
                .bg(tokens.surface),
        ));
        render_metadata_segments(&mut x, end, area.y + 1, metadata, buf);
    }

    fn render_continuous_diff(
        &mut self,
        area: Rect,
        hovered_target: Option<(usize, u64)>,
        buf: &mut Buffer,
    ) {
        self.viewport_height = area.height.max(1) as usize;
        let total = self.continuous_total_rows();
        if total == 0 {
            return;
        }
        self.continuous_cursor = self.continuous_cursor.min(total.saturating_sub(1));
        let layout_expands_physical_rows = self.wrap || (self.split && area.width >= 76);
        let max_scroll = if layout_expands_physical_rows {
            total.saturating_sub(1)
        } else {
            total.saturating_sub(area.height.max(1) as u64)
        };
        self.continuous_scroll = self.continuous_scroll.min(max_scroll);
        self.sync_continuous_active();
        let effective_split = self.split && area.width >= 76;
        let active_cursor = self.continuous_position(self.continuous_cursor);

        let mut global = self.continuous_scroll;
        let mut y = area.y;
        let bottom = area.y.saturating_add(area.height);
        while y < bottom && global < total {
            let Some((file_index, local_start)) = self.continuous_position(global) else {
                break;
            };
            let Some(file) = self.index.files.get(file_index) else {
                break;
            };
            let available = file.row_count.saturating_sub(local_start);
            if available == 0 {
                global = self.continuous_offset_for_file(file_index.saturating_add(1));
                continue;
            }
            let remaining_height = bottom.saturating_sub(y);
            let height = if layout_expands_physical_rows {
                remaining_height
            } else {
                available.min(u64::from(remaining_height)) as u16
            };
            let segment = Rect::new(area.x, y, area.width, height);
            let cursor = active_cursor
                .filter(|(active_file, active_row)| {
                    *active_file == file_index && *active_row >= local_start
                })
                .map(|(_, active_row)| active_row)
                .unwrap_or(u64::MAX);
            let hovered = hovered_target
                .filter(|(hovered_file, _)| *hovered_file == file_index)
                .map(|(_, row)| row);
            let diagnostics = self.lsp.diagnostics_for(file.display_path());
            let tab_size =
                self.editorconfig
                    .tab_size_for(&self.repo_root, file.display_path(), self.tab_size);
            let comments: &[ReviewComment] = if self.experience == Experience::Viewer {
                &[]
            } else {
                &self.comments
            };
            let annotation_revision = self.annotation_revision();
            render_card(
                &self.index,
                &mut self.diff_render_cache,
                file_index,
                segment,
                local_start,
                cursor,
                self.visual_anchor.and_then(|(anchor_file, anchor)| {
                    (anchor_file == file_index)
                        .then_some((anchor.min(self.cursor_row), anchor.max(self.cursor_row)))
                }),
                hovered,
                self.horizontal_offset,
                self.wrap,
                effective_split,
                self.line_numbers,
                tab_size,
                self.theme,
                comments,
                &diagnostics,
                annotation_revision,
                &self.palette,
                buf,
            );
            let logical_rows = self.diff_render_cache.rendered_logical_rows();
            self.rendered_diff_rows
                .extend(
                    logical_rows
                        .iter()
                        .copied()
                        .map(|logical_rows| RenderedDiffRow {
                            file_index,
                            logical_rows,
                            split: effective_split,
                        }),
                );
            let physical_rows = logical_rows.len() as u16;
            let last_logical = logical_rows.iter().flatten().flatten().copied().max();
            let consumed_logical = last_logical
                .map(|last| last.saturating_sub(local_start).saturating_add(1))
                .unwrap_or(0);
            if physical_rows == 0 || consumed_logical == 0 {
                break;
            }
            y = y.saturating_add(physical_rows);
            global = global.saturating_add(consumed_logical);
        }
        self.render_change_map(area, None, self.continuous_scroll, total, buf);
    }

    fn render_change_map(
        &mut self,
        area: Rect,
        single_file: Option<usize>,
        scroll: u64,
        total_rows: u64,
        buf: &mut Buffer,
    ) {
        if area.width < 8 || area.height < 3 || total_rows == 0 {
            return;
        }
        let tokens = GridlineTokens::from(&self.palette);
        let x = area.x + area.width - 1;
        for y in area.y..area.y + area.height {
            buf[(x, y)]
                .set_symbol("│")
                .set_style(Style::default().fg(tokens.rule_subtle).bg(tokens.canvas));
        }
        let markers = self
            .render_metadata
            .change_map(&self.index, single_file, area.height);
        for (offset, marker) in markers.iter().enumerate() {
            let Some(marker) = marker else {
                continue;
            };
            let color = match marker {
                ChangeMapMarker::Added => tokens.positive,
                ChangeMapMarker::Removed => tokens.negative,
                ChangeMapMarker::Modified => tokens.accent,
            };
            let y = area.y.saturating_add(offset as u16);
            if y < area.y.saturating_add(area.height) {
                buf[(x, y)]
                    .set_symbol("▪")
                    .set_style(Style::default().fg(color).bg(tokens.canvas));
            }
        }
        let viewport_start = ((scroll
            .min(total_rows.saturating_sub(1))
            .saturating_mul(area.height.saturating_sub(1) as u64)
            / total_rows.saturating_sub(1).max(1)) as u16)
            .min(area.height.saturating_sub(1));
        let visible_logical_rows = self
            .rendered_diff_rows
            .iter()
            .flat_map(|rendered| {
                rendered.logical_rows.iter().flatten().map(|row| {
                    if single_file.is_some() {
                        *row
                    } else {
                        self.continuous_offset_for_file(rendered.file_index)
                            .saturating_add(*row)
                    }
                })
            })
            .fold(None, |bounds, row| match bounds {
                None => Some((row, row)),
                Some((minimum, maximum)) => Some((minimum.min(row), maximum.max(row))),
            })
            .map(|(minimum, maximum)| maximum.saturating_sub(minimum).saturating_add(1))
            .unwrap_or(self.viewport_height as u64);
        let viewport_rows = (visible_logical_rows
            .saturating_mul(area.height as u64)
            .div_ceil(total_rows))
        .max(1) as u16;
        for offset in 0..viewport_rows.min(area.height) {
            let y = area.y + (viewport_start + offset).min(area.height.saturating_sub(1));
            let color = if buf[(x, y)].symbol() == "▪" {
                buf[(x, y)].style().fg.unwrap_or(tokens.muted)
            } else {
                tokens.muted
            };
            buf[(x, y)]
                .set_symbol("┃")
                .set_style(Style::default().fg(color).bg(tokens.canvas));
        }
    }

    fn sync_file_tree_scroll_for(&mut self, body_height: usize) {
        let body_height = body_height.max(1);
        if self.file_tree.cursor < self.file_tree_scroll {
            self.file_tree_scroll = self.file_tree.cursor;
        } else if self.file_tree.cursor >= self.file_tree_scroll + body_height {
            self.file_tree_scroll = self.file_tree.cursor + 1 - body_height;
        }
    }

    fn render_header(&mut self, area: Rect, buf: &mut Buffer) {
        let tokens = GridlineTokens::from(&self.palette);
        fill_area(area, self.palette.bg, buf);
        let repo = safe_terminal_text(
            self.repo_root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("repository"),
        );
        let title = if repo == "diffing" {
            "diffing".to_string()
        } else {
            format!("diffing · {repo}")
        };
        buf.set_string(
            area.x + 2,
            area.y,
            "diffing",
            Style::default()
                .fg(tokens.accent)
                .bg(tokens.canvas)
                .add_modifier(Modifier::BOLD),
        );
        if repo != "diffing" {
            buf.set_string(
                area.x + 9,
                area.y,
                "·",
                Style::default().fg(tokens.rule).bg(tokens.canvas),
            );
            buf.set_string(
                area.x + 11,
                area.y,
                &repo,
                Style::default().fg(tokens.text).bg(tokens.canvas),
            );
        }
        let agent = if self.experience == Experience::Review
            && self
                .agent_api
                .as_ref()
                .is_some_and(|api| api.waiter_count() > 0)
        {
            "  ● agent"
        } else {
            ""
        };
        let file_count = format!(
            "{} {}",
            self.files.len(),
            if self.files.len() == 1 {
                "file"
            } else {
                "files"
            }
        );
        let additions = format!("+{}", self.index.additions);
        let deletions = format!("-{}", self.index.deletions);
        let indexing = if self.indexing { "  ◌ indexing" } else { "" };
        let summary_width: u16 = [
            file_count.as_str(),
            "  ",
            additions.as_str(),
            "  ",
            deletions.as_str(),
            agent,
            indexing,
        ]
        .iter()
        .map(|part| UnicodeWidthStr::width(*part) as u16)
        .sum();
        let summary_x = area
            .x
            .saturating_add(area.width.saturating_sub(summary_width + 1));
        if summary_width + 14 < area.width {
            let mut x = summary_x;
            buf.set_string(
                x,
                area.y,
                &file_count,
                Style::default()
                    .fg(tokens.text_subtle)
                    .bg(tokens.canvas)
                    .add_modifier(Modifier::BOLD),
            );
            x += UnicodeWidthStr::width(file_count.as_str()) as u16 + 2;
            x = render_change_counts(
                x,
                area.y,
                self.index.additions,
                self.index.deletions,
                self.palette.bg,
                &self.palette,
                buf,
            );
            if !agent.is_empty() {
                buf.set_string(
                    x,
                    area.y,
                    agent,
                    Style::default().fg(tokens.info).bg(tokens.canvas),
                );
                x += UnicodeWidthStr::width(agent) as u16;
            }
            if !indexing.is_empty() {
                buf.set_string(
                    x,
                    area.y,
                    indexing,
                    Style::default().fg(tokens.warning).bg(tokens.canvas),
                );
            }
        }
        let action_x = area.x + UnicodeWidthStr::width(title.as_str()) as u16 + 5;
        if self.experience == Experience::Review && action_x + 15 < summary_x {
            let rect = render_chip(
                action_x,
                area.y,
                "S send review",
                true,
                self.mouse_position,
                &self.palette,
                buf,
            );
            self.regions.toolbar.push((rect, ToolbarAction::SendReview));
        }
        if area.height >= 2 {
            let detail = self
                .diff_context
                .detail
                .as_deref()
                .map(|detail| format!(" · {detail}"))
                .unwrap_or_default();
            let context = format!("{}{}", self.diff_context.headline, detail);
            let context = ellipsize(&context, area.width.saturating_sub(6) as usize);
            buf.set_string(
                area.x + 2,
                area.y + 1,
                self.diff_context.marker(),
                Style::default()
                    .fg(tokens.accent)
                    .bg(tokens.canvas)
                    .add_modifier(Modifier::BOLD),
            );
            buf.set_string(
                area.x + 4,
                area.y + 1,
                context,
                Style::default().fg(tokens.text_subtle).bg(tokens.canvas),
            );
        }
        horizontal_rule(
            Rect::new(
                area.x,
                area.y + area.height.saturating_sub(1),
                area.width,
                1,
            ),
            &self.palette,
            buf,
        );
    }

    fn render_theme_picker(&mut self, area: Rect, buf: &mut Buffer) {
        let tokens = GridlineTokens::from(&self.palette);
        dim_buffer(area, buf);
        let width = area.width.saturating_sub(METRICS.modal_margin_x).min(72);
        let height = area
            .height
            .saturating_sub(METRICS.modal_margin_y)
            .clamp(8, 24);
        let popup = Rect::new(
            area.x + area.width.saturating_sub(width) / 2,
            area.y + area.height.saturating_sub(height) / 2,
            width,
            height,
        );
        Clear.render(popup, buf);
        let block = overlay_block(" Themes ", &self.palette);
        let inner = block.inner(popup);
        block.render(popup, buf);
        buf.set_string(
            inner.x + 1,
            inner.y,
            modal_input_display(
                "/ ",
                &self.modal_input,
                self.modal_cursor,
                inner.width.saturating_sub(2) as usize,
            ),
            Style::default().fg(tokens.text).bg(tokens.element),
        );
        self.regions.modal_input = Some(Rect::new(
            inner.x + 1,
            inner.y,
            inner.width.saturating_sub(2),
            1,
        ));
        let themes = self.filtered_themes();
        self.theme_cursor = self.theme_cursor.min(themes.len().saturating_sub(1));
        let body_y = inner.y + 1 + METRICS.section_gap;
        let body_height = inner.height.saturating_sub(2 + METRICS.section_gap) as usize;
        let scroll = self
            .theme_cursor
            .saturating_sub(body_height.saturating_sub(1));
        self.regions.theme_rows.clear();
        if themes.is_empty() && body_height > 0 {
            buf.set_stringn(
                inner.x + 2,
                body_y,
                "No themes match this filter",
                inner.width.saturating_sub(4) as usize,
                Style::default().fg(tokens.muted).bg(tokens.raised),
            );
        }
        for (visible, theme) in themes.iter().skip(scroll).take(body_height).enumerate() {
            let index = scroll + visible;
            let row = Rect::new(inner.x, body_y + visible as u16, inner.width, 1);
            let selected = index == self.theme_cursor;
            fill_area(
                row,
                if selected {
                    tokens.selected
                } else {
                    tokens.raised
                },
                buf,
            );
            let swatch = Palette::for_terminal(*theme);
            buf.set_string(
                row.x + 1,
                row.y,
                if selected { GLYPHS.cursor } else { " " },
                Style::default().fg(tokens.focus),
            );
            let row_bg = if selected {
                tokens.selected
            } else {
                tokens.raised
            };
            for (offset, color) in [(3, swatch.bg), (5, swatch.accent), (7, swatch.added)] {
                buf.set_string(
                    row.x + offset,
                    row.y,
                    "●",
                    Style::default().fg(color).bg(row_bg),
                );
            }
            buf.set_string(
                row.x + 10,
                row.y,
                theme.display_name(),
                Style::default().fg(tokens.text).bg(row_bg),
            );
            let kind = if theme.is_light() { "LIGHT" } else { "DARK" };
            let kind_x = row.x + row.width.saturating_sub(kind.len() as u16 + 2);
            buf.set_string(
                kind_x,
                row.y,
                kind,
                Style::default().fg(tokens.muted).bg(if selected {
                    tokens.selected
                } else {
                    tokens.raised
                }),
            );
            self.regions.theme_rows.push((row, *theme));
        }
        let footer = hint_line(
            "↑↓ preview · Enter apply · Esc restore",
            tokens.raised,
            &self.palette,
        );
        Paragraph::new(footer).render(
            Rect::new(
                inner.x + 1,
                inner.y + inner.height.saturating_sub(1),
                inner.width.saturating_sub(2),
                1,
            ),
            buf,
        );
    }

    fn render_help(&mut self, area: Rect, buf: &mut Buffer) {
        dim_buffer(area, buf);
        let width = area
            .width
            .saturating_sub(METRICS.modal_margin_x)
            .min(if area.width >= 78 { 112 } else { 72 });
        let height = area.height.saturating_sub(METRICS.modal_margin_y).min(32);
        let popup = Rect::new(
            area.x + area.width.saturating_sub(width) / 2,
            area.y + area.height.saturating_sub(height) / 2,
            width,
            height,
        );
        Clear.render(popup, buf);
        let block = overlay_block(" Help ", &self.palette);
        let inner = block.inner(popup);
        block.render(popup, buf);
        fill_area(inner, self.palette.elevated, buf);
        let help = if self.experience == Experience::Viewer {
            viewer_help_text()
        } else {
            help_text()
        };
        let inner_width = popup.width.saturating_sub(2) as usize;
        let help = if inner_width >= 72 {
            shortcut_help_columns(help, inner_width.saturating_sub(2) / 2, &self.palette)
        } else {
            shortcut_help(help, &self.palette)
        };
        let body = Rect::new(
            inner.x,
            inner.y,
            inner.width,
            inner.height.saturating_sub(1),
        );
        let max_scroll = help
            .lines
            .len()
            .saturating_sub(body.height as usize)
            .min(u16::MAX as usize) as u16;
        self.help_scroll = self.help_scroll.min(max_scroll);
        let scroll = self.help_scroll;
        Paragraph::new(help)
            .style(
                Style::default()
                    .fg(self.palette.fg)
                    .bg(self.palette.elevated),
            )
            .scroll((scroll, 0))
            .render(body, buf);
        if inner.height > 0 {
            let footer = format!(
                "j/k scroll · PgUp/PgDn page · Esc close · {}/{}",
                scroll.saturating_add(1),
                max_scroll.saturating_add(1)
            );
            Paragraph::new(hint_line(&footer, self.palette.elevated, &self.palette)).render(
                Rect::new(
                    inner.x,
                    inner.y + inner.height.saturating_sub(1),
                    inner.width,
                    1,
                ),
                buf,
            );
        }
    }

    fn render_search_palette(&mut self, area: Rect, buf: &mut Buffer) {
        let tokens = GridlineTokens::from(&self.palette);
        dim_buffer(area, buf);
        let popup = search_popup_rect(area);
        Clear.render(popup, buf);
        fill_area(popup, tokens.raised, buf);
        let block = overlay_block(
            Span::styled(
                " Search ",
                Style::default()
                    .fg(tokens.text)
                    .add_modifier(Modifier::BOLD),
            ),
            &self.palette,
        );
        let inner = block.inner(popup);
        block.render(popup, buf);

        // The query owns the first row: search is an editing task before it is
        // a filtering task. A focus rail makes that clear without boxing the
        // field inside the already-bordered overlay.
        let input_y = inner.y;
        let input = Rect::new(inner.x, input_y, inner.width, 1);
        fill_area(input, tokens.element, buf);
        buf[(input.x, input.y)]
            .set_symbol(GLYPHS.focus_rail)
            .set_style(Style::default().fg(tokens.focus).bg(tokens.element));
        self.regions.modal_input = Some(Rect::new(
            inner.x + 2,
            input_y,
            inner.width.saturating_sub(3),
            1,
        ));
        buf.set_string(
            inner.x + 2,
            input_y,
            modal_input_display(
                "/ ",
                &self.modal_input,
                self.modal_cursor,
                inner.width.saturating_sub(3) as usize,
            ),
            Style::default().fg(tokens.text).bg(tokens.element),
        );

        let controls_y = input_y.saturating_add(1);
        let scopes = [
            SearchScope::All,
            SearchScope::Files,
            SearchScope::Text,
            SearchScope::Symbols,
        ];
        let changed_label = if self.search_changed_only {
            "^G changed"
        } else {
            "^G repository"
        };
        let regex_label = if self.search_scope == SearchScope::Text {
            Some("^R regex")
        } else {
            None
        };
        let changed_width = UnicodeWidthStr::width(changed_label) as u16 + 2;
        let regex_width = regex_label
            .map(|label| UnicodeWidthStr::width(label) as u16 + 2)
            .unwrap_or(0);
        let controls_width = changed_width
            .saturating_add(regex_width)
            .saturating_add(u16::from(regex_label.is_some()));
        let scopes_width = scopes
            .iter()
            .map(|scope| UnicodeWidthStr::width(format!(" {} ", scope.label()).as_str()) as u16 + 1)
            .sum::<u16>();
        let controls_fit = scopes_width
            .saturating_add(controls_width)
            .saturating_add(2)
            < inner.width;
        let controls_x = controls_fit.then(|| inner.x + inner.width - controls_width - 1);
        let scope_end = controls_x.unwrap_or_else(|| inner.x.saturating_add(inner.width));
        let mut x = inner.x + 1;
        for scope in scopes {
            let active = scope == self.search_scope;
            let label = format!(" {} ", scope.label());
            let label_width = UnicodeWidthStr::width(label.as_str()) as u16;
            if x + label_width >= scope_end {
                break;
            }
            buf.set_string(
                x,
                controls_y,
                &label,
                Style::default()
                    .fg(if active { tokens.text } else { tokens.muted })
                    .bg(if active {
                        tokens.selected
                    } else {
                        tokens.raised
                    })
                    .add_modifier(if active {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            );
            self.regions
                .search_scopes
                .push((Rect::new(x, controls_y, label_width, 1), scope));
            x += label_width + 1;
        }
        if let Some(mut control_x) = controls_x {
            if let Some(regex_label) = regex_label {
                let region = render_chip(
                    control_x,
                    controls_y,
                    regex_label,
                    self.search_regex,
                    self.mouse_position,
                    &self.palette,
                    buf,
                );
                self.regions.search_regex = Some(region);
                control_x = control_x.saturating_add(region.width + 1);
            }
            let region = render_chip(
                control_x,
                controls_y,
                changed_label,
                self.search_changed_only,
                self.mouse_position,
                &self.palette,
                buf,
            );
            self.regions.search_changed = Some(region);
        }

        let divider_y = controls_y.saturating_add(1);
        horizontal_rule(
            Rect::new(inner.x, divider_y, inner.width, 1),
            &self.palette,
            buf,
        );
        let result_y = divider_y.saturating_add(1);
        let footer_y = inner.y.saturating_add(inner.height.saturating_sub(1));
        let result_height = footer_y.saturating_sub(result_y);
        let body = Rect::new(inner.x, result_y, inner.width, result_height);
        let (list, divider, preview) = search_result_regions(body);
        self.render_search_results(list, buf);
        if let Some(divider) = divider {
            vertical_rule(divider, &self.palette, tokens.raised, buf);
        }
        if let Some(preview) = preview {
            self.regions.search_preview = Some(preview);
            self.render_search_preview(preview, buf);
        }

        let shown = self.repo_search_hits.len();
        let count = match self.repo_search_total {
            Some(total) if total > shown => format!("{shown} of {total}"),
            _ => format!("{shown}"),
        };
        let (state, state_color) = if self.repo_search_loading {
            ("  ◌ searching".to_string(), tokens.info)
        } else if self.repo_search_indexing {
            ("  ◌ indexing".to_string(), tokens.info)
        } else if let Some(notice) = self.repo_search_notice.as_deref() {
            (format!("  ⚠ {}", ellipsize(notice, 36)), tokens.warning)
        } else {
            (String::new(), tokens.info)
        };
        let mut footer = Line::from(vec![
            Span::styled(
                format!(
                    " {count} result{}",
                    if self.repo_search_total.unwrap_or(shown.max(1)) == 1 {
                        ""
                    } else {
                        "s"
                    }
                ),
                Style::default().fg(tokens.text_subtle).bg(tokens.raised),
            ),
            Span::styled(state, Style::default().fg(state_color).bg(tokens.raised)),
            Span::styled("  ·  ", Style::default().fg(tokens.rule).bg(tokens.raised)),
        ]);
        let footer_hint = if inner.width >= 96 {
            "Tab scope · ↑↓/Pg select · ⇧↑↓ preview · ^L clear · ^U page · Alt-Enter peek · Enter open · Esc close/unfocus"
                .to_string()
        } else if inner.width >= 88 {
            "Tab scope · ↑↓/Pg select · ⇧↑↓ preview · ^L clear · ^U page · Alt-Enter peek · Enter open · Esc close"
                .to_string()
        } else {
            let source = if self.search_changed_only {
                "^G repository"
            } else {
                "^G changed"
            };
            let regex = if self.search_scope == SearchScope::Text {
                " · ^R regex"
            } else {
                ""
            };
            format!("Tab scope · {source}{regex} · ↑↓ select · Enter open · Esc close")
        };
        footer
            .spans
            .extend(hint_line(&footer_hint, tokens.raised, &self.palette).spans);
        Paragraph::new(footer).render(
            Rect::new(inner.x, footer_y, inner.width, u16::from(inner.height > 0)),
            buf,
        );
    }

    fn render_search_results(&mut self, area: Rect, buf: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        let tokens = GridlineTokens::from(&self.palette);
        if let Some(error) = self.repo_search_error.as_deref() {
            buf.set_string(
                area.x + 1,
                area.y,
                ellipsize(error, area.width.saturating_sub(2) as usize),
                Style::default().fg(tokens.warning).bg(tokens.raised),
            );
        } else if self.repo_search_hits.is_empty() && !self.repo_search_loading {
            let (primary, secondary) = search_empty_copy(
                self.search_scope,
                self.modal_input.trim(),
                self.search_changed_only,
            );
            buf.set_string(
                area.x + 1,
                area.y,
                ellipsize(&primary, area.width.saturating_sub(2) as usize),
                Style::default().fg(tokens.text_subtle).bg(tokens.raised),
            );
            if area.height > 1 && !secondary.is_empty() {
                buf.set_string(
                    area.x + 1,
                    area.y + 1,
                    ellipsize(&secondary, area.width.saturating_sub(2) as usize),
                    Style::default().fg(tokens.muted).bg(tokens.raised),
                );
            }
        } else {
            let scroll = self
                .search_cursor
                .saturating_sub(area.height.saturating_sub(1) as usize);
            for (visible, hit) in self
                .repo_search_hits
                .iter()
                .skip(scroll)
                .take(area.height as usize)
                .enumerate()
            {
                let index = scroll + visible;
                let row = Rect::new(area.x, area.y + visible as u16, area.width, 1);
                self.regions.search_results.push((row, index));
                let selected = index == self.search_cursor;
                let background = if selected {
                    tokens.selected
                } else {
                    tokens.raised
                };
                fill_area(row, background, buf);
                let (icon, color) = match hit.kind {
                    SearchHitKind::File => ("F", tokens.accent),
                    SearchHitKind::Text => ("T", tokens.positive),
                    SearchHitKind::Symbol => ("S", tokens.info),
                };
                buf.set_string(
                    row.x + 1,
                    row.y,
                    if selected { GLYPHS.focus_rail } else { " " },
                    Style::default().fg(tokens.focus).bg(background),
                );
                buf.set_string(
                    row.x + 3,
                    row.y,
                    icon,
                    Style::default()
                        .fg(color)
                        .bg(background)
                        .add_modifier(Modifier::BOLD),
                );
                let title_width = row.width.saturating_mul(2) / 3;
                let title = ellipsize(&hit.title, title_width.saturating_sub(6) as usize);
                render_query_text(
                    row.x + 5,
                    row.y,
                    &title,
                    self.modal_input.trim(),
                    title_width.saturating_sub(6),
                    Style::default().fg(tokens.text).bg(background),
                    Style::default()
                        .fg(tokens.focus)
                        .bg(background)
                        .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                    true,
                    buf,
                );
                let detail_x = row.x + title_width;
                let in_diff = self
                    .index
                    .files
                    .iter()
                    .any(|file| file.display_path() == std::path::Path::new(&hit.path));
                let badge = if in_diff {
                    "DIFF"
                } else {
                    match hit.git_status.as_str() {
                        "modified" => "M",
                        "untracked" => "U",
                        "staged_new" | "added" => "A",
                        "deleted" => "D",
                        "renamed" => "R",
                        _ => "",
                    }
                };
                let badge_width = badge.len() as u16;
                let detail_end = row
                    .x
                    .saturating_add(row.width)
                    .saturating_sub(badge_width + 1);
                if detail_x < detail_end {
                    let detail = ellipsize(
                        &hit.detail,
                        detail_end.saturating_sub(detail_x + 1) as usize,
                    );
                    render_query_text(
                        detail_x,
                        row.y,
                        &detail,
                        self.modal_input.trim(),
                        detail_end.saturating_sub(detail_x + 1),
                        Style::default().fg(tokens.muted).bg(background),
                        Style::default()
                            .fg(tokens.focus)
                            .bg(background)
                            .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                        true,
                        buf,
                    );
                }
                if !badge.is_empty() {
                    buf.set_string(
                        detail_end,
                        row.y,
                        badge,
                        Style::default()
                            .fg(if in_diff {
                                tokens.accent
                            } else {
                                tokens.warning
                            })
                            .bg(background)
                            .add_modifier(Modifier::BOLD),
                    );
                }
            }
        }
    }

    fn render_search_preview(&mut self, area: Rect, buf: &mut Buffer) {
        if area.width < 8 || area.height == 0 {
            return;
        }
        let tokens = GridlineTokens::from(&self.palette);
        fill_area(area, tokens.surface, buf);
        let selected = self.repo_search_hits.get(self.search_cursor);
        let path = self
            .search_preview
            .as_ref()
            .map(|preview| preview.path.as_str())
            .or_else(|| selected.map(|hit| hit.path.as_str()))
            .unwrap_or("Preview");
        let target_line = selected.and_then(|hit| hit.line);
        let preview_query = selected
            .filter(|hit| hit.kind == SearchHitKind::Symbol)
            .map(|hit| hit.title.clone())
            .unwrap_or_else(|| self.modal_input.trim().to_string());
        let location = target_line
            .map(|line| format!(":{line}"))
            .unwrap_or_default();
        let path_width = area
            .width
            .saturating_sub(3 + UnicodeWidthStr::width(location.as_str()) as u16)
            as usize;
        let (directory, basename) = compact_path(path, path_width);
        buf.set_string(
            area.x + 1,
            area.y,
            &directory,
            Style::default().fg(tokens.muted).bg(tokens.surface),
        );
        let basename_x = area.x + 1 + UnicodeWidthStr::width(directory.as_str()) as u16;
        buf.set_string(
            basename_x,
            area.y,
            &basename,
            Style::default()
                .fg(tokens.text)
                .bg(tokens.surface)
                .add_modifier(Modifier::BOLD),
        );
        if !location.is_empty() {
            buf.set_string(
                basename_x + UnicodeWidthStr::width(basename.as_str()) as u16,
                area.y,
                location,
                Style::default()
                    .fg(tokens.accent)
                    .bg(tokens.surface)
                    .add_modifier(Modifier::BOLD),
            );
        }
        let content_y = area.y.saturating_add(1);
        if self.search_preview_loading {
            buf.set_string(
                area.x + 1,
                content_y,
                "Loading preview…",
                Style::default().fg(tokens.muted).bg(tokens.surface),
            );
            return;
        }
        if let Some(error) = self.search_preview_error.as_deref() {
            buf.set_string(
                area.x + 1,
                content_y,
                ellipsize(error, area.width.saturating_sub(2) as usize),
                Style::default().fg(tokens.warning).bg(tokens.surface),
            );
            return;
        }
        let Some(preview) = self.search_preview.as_ref() else {
            buf.set_string(
                area.x + 1,
                content_y,
                "Select a result to preview",
                Style::default().fg(tokens.muted).bg(tokens.surface),
            );
            return;
        };
        let footer_height = u16::from(preview.truncated && area.height > 2);
        let content_height = area.height.saturating_sub(1 + footer_height);
        let max_scroll = preview
            .content
            .lines()
            .count()
            .saturating_sub(content_height as usize);
        self.search_preview_scroll = self.search_preview_scroll.min(max_scroll);
        if preview.binary || preview.missing {
            let changed_image = preview.binary
                && is_image_path(std::path::Path::new(path))
                && self
                    .index
                    .files
                    .iter()
                    .any(|file| file.display_path() == std::path::Path::new(path));
            let message = if changed_image {
                "Changed image · Tab mode · i fullscreen"
            } else if preview.binary {
                "Binary file — no text preview"
            } else {
                "File not present in the working tree"
            };
            buf.set_string(
                area.x + 1,
                content_y,
                message,
                Style::default().fg(tokens.muted).bg(tokens.surface),
            );
            return;
        }

        for (visible, (line_index, line)) in preview
            .content
            .lines()
            .enumerate()
            .skip(self.search_preview_scroll)
            .take(content_height as usize)
            .enumerate()
        {
            let y = content_y + visible as u16;
            let line_number = line_index + 1;
            let highlighted = target_line == Some(line_number as u32);
            let background = if highlighted {
                tokens.selected
            } else {
                tokens.surface
            };
            fill_area(Rect::new(area.x, y, area.width, 1), background, buf);
            if highlighted {
                buf[(area.x, y)]
                    .set_symbol(GLYPHS.focus_rail)
                    .set_style(Style::default().fg(tokens.focus).bg(background));
            }
            let gutter_width = 7u16.min(area.width);
            buf.set_string(
                area.x.saturating_add(1),
                y,
                format!("{line_number:>4} "),
                Style::default().fg(tokens.gutter).bg(background),
            );
            let mut x = area.x.saturating_add(gutter_width);
            let end = area.x.saturating_add(area.width);
            let source_line = line.trim_end_matches('\r');
            let ranges = literal_query_match_ranges(source_line, &preview_query);
            let mut source_offset = 0usize;
            for span in highlight_line(
                &preview.path,
                source_line,
                self.theme,
                &self.palette,
                background,
            )
            .iter()
            {
                if x >= end {
                    break;
                }
                x = render_preview_span(
                    x,
                    y,
                    end,
                    &span.text,
                    source_offset,
                    &ranges,
                    span.style.bg(background),
                    Style::default()
                        .fg(tokens.canvas)
                        .bg(tokens.focus)
                        .add_modifier(Modifier::BOLD),
                    buf,
                );
                source_offset = source_offset.saturating_add(span.text.len());
            }
        }
        if footer_height > 0 {
            let label = " preview truncated ";
            let width = label.len() as u16;
            if width + 1 < area.width {
                buf.set_string(
                    area.x + area.width - width - 1,
                    area.y + area.height - 1,
                    label,
                    Style::default().fg(tokens.warning).bg(tokens.surface),
                );
            }
        }
    }

    fn render_hover(&mut self, area: Rect, buf: &mut Buffer) {
        let Some(content) = self.hover_content.as_deref() else {
            return;
        };
        dim_buffer(area, buf);
        let width = area.width.saturating_sub(METRICS.modal_margin_x).min(84);
        let height = area
            .height
            .saturating_sub(METRICS.modal_margin_y)
            .clamp(6, 24);
        let popup = Rect::new(
            area.x + area.width.saturating_sub(width) / 2,
            area.y + area.height.saturating_sub(height) / 2,
            width,
            height,
        );
        Clear.render(popup, buf);
        let block = overlay_block(" Hover ", &self.palette);
        let inner = block.inner(popup);
        let line_width = inner.width.max(1) as usize;
        let visual_lines = content
            .lines()
            .map(|line| UnicodeWidthStr::width(line).max(1).div_ceil(line_width))
            .sum::<usize>();
        let max_scroll = visual_lines
            .saturating_sub(inner.height as usize)
            .min(u16::MAX as usize) as u16;
        self.hover_scroll = self.hover_scroll.min(max_scroll);
        block.render(popup, buf);
        Paragraph::new(content)
            .style(
                Style::default()
                    .fg(self.palette.fg)
                    .bg(self.palette.elevated),
            )
            .wrap(Wrap { trim: false })
            .scroll((self.hover_scroll, 0))
            .render(inner, buf);
    }

    fn render_prompt(&mut self, area: Rect, prefix: char, title: &str, buf: &mut Buffer) {
        dim_buffer(area, buf);
        let width = area.width.saturating_sub(METRICS.modal_margin_x).min(90);
        let height = 4.min(area.height);
        let popup = Rect::new(
            area.x + area.width.saturating_sub(width) / 2,
            area.y + area.height.saturating_sub(height),
            width,
            height,
        );
        Clear.render(popup, buf);
        let block = overlay_block(format!(" {title} · Tab completes "), &self.palette);
        let inner = block.inner(popup);
        block.render(popup, buf);
        self.regions.modal_input = Some(Rect::new(inner.x, inner.y, inner.width, 1));
        buf.set_string(
            inner.x,
            inner.y,
            modal_input_display(
                &prefix.to_string(),
                &self.modal_input,
                self.modal_cursor,
                inner.width as usize,
            ),
            Style::default()
                .fg(self.palette.fg)
                .bg(self.palette.elevated),
        );
        if inner.height > 1 {
            let query = self.modal_input.trim().to_ascii_lowercase();
            let matches = EX_COMMANDS
                .iter()
                .filter(|command| command.starts_with(&query))
                .take(8)
                .copied()
                .collect::<Vec<_>>();
            let suggestions = if matches.is_empty() {
                "No matching commands".to_string()
            } else {
                matches.join("  ")
            };
            buf.set_stringn(
                inner.x,
                inner.y + 1,
                suggestions,
                inner.width as usize,
                Style::default()
                    .fg(self.palette.dim)
                    .bg(self.palette.elevated),
            );
        }
    }
}

fn ex_command_completion(query: &str) -> Option<&'static str> {
    if query.is_empty() {
        return None;
    }
    EX_COMMANDS
        .iter()
        .find(|command| command.starts_with(query) && **command != query)
        .or_else(|| {
            EX_COMMANDS
                .iter()
                .find(|command| command.starts_with(query))
        })
        .copied()
}

fn inset(area: Rect, amount: u16) -> Rect {
    Rect::new(
        area.x.saturating_add(amount),
        area.y.saturating_add(amount),
        area.width.saturating_sub(amount.saturating_mul(2)),
        area.height.saturating_sub(amount.saturating_mul(2)),
    )
}

fn char_byte_index(value: &str, character_index: usize) -> usize {
    value
        .char_indices()
        .nth(character_index)
        .map(|(byte, _)| byte)
        .unwrap_or(value.len())
}

fn textarea_character_count(textarea: &tui_textarea::TextArea<'_>) -> usize {
    textarea
        .lines()
        .iter()
        .fold(0usize, |total, line| {
            total.saturating_add(line.chars().count())
        })
        .saturating_add(textarea.lines().len().saturating_sub(1))
}

fn insert_textarea_bounded(textarea: &mut tui_textarea::TextArea<'_>, text: &str) -> bool {
    let remaining = MAX_TEXTAREA_CHARACTERS.saturating_sub(textarea_character_count(textarea));
    let mut characters = text.chars();
    let accepted: String = characters.by_ref().take(remaining).collect();
    let truncated = characters.next().is_some();
    if !accepted.is_empty() {
        textarea.insert_str(accepted);
    }
    truncated
}

fn textarea_key_inserts(key: &crossterm::event::KeyEvent) -> bool {
    use crossterm::event::{KeyCode, KeyModifiers};
    matches!(key.code, KeyCode::Enter | KeyCode::Tab)
        || (matches!(key.code, KeyCode::Char(_))
            && !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ModalInputLayout {
    text: String,
    cursor_by_cell: Vec<usize>,
    trailing_cursor: usize,
}

fn push_modal_token(
    text: &mut String,
    cells: &mut Vec<usize>,
    character: char,
    before: usize,
    after: usize,
) {
    text.push(character);
    let width = UnicodeWidthChar::width(character).unwrap_or(0);
    for cell in 0..width {
        cells.push(if cell.saturating_mul(2) >= width {
            after
        } else {
            before
        });
    }
}

fn modal_input_layout(prefix: &str, value: &str, cursor: usize, width: usize) -> ModalInputLayout {
    let characters: Vec<char> = value.chars().collect();
    let widths: Vec<usize> = characters
        .iter()
        .map(|character| UnicodeWidthChar::width(*character).unwrap_or(0))
        .collect();
    let cursor = cursor.min(characters.len());
    let prefix = truncate_cells(prefix, width);
    let prefix_width = UnicodeWidthStr::width(prefix.as_str());
    let available = width.saturating_sub(prefix_width);

    let full_width = widths
        .iter()
        .fold(1usize, |total, width| total.saturating_add(*width));
    let (start, end, left_overflow, right_overflow) = if full_width <= available {
        (0, characters.len(), false, false)
    } else if available <= 1 {
        (cursor, cursor, false, false)
    } else if available == 2 {
        if cursor > 0 {
            (cursor, cursor, true, false)
        } else {
            (0, 0, false, !characters.is_empty())
        }
    } else {
        let reserve_right = usize::from(cursor < characters.len());
        let left_budget = available.saturating_sub(1 + reserve_right);
        let mut start = cursor;
        let mut left_width = 0usize;
        while start > 0 {
            let next = widths[start - 1];
            if left_width.saturating_add(next) > left_budget {
                break;
            }
            start -= 1;
            left_width = left_width.saturating_add(next);
        }
        let left_overflow = start > 0;
        if left_overflow {
            while start < cursor && left_width.saturating_add(1) > left_budget {
                left_width = left_width.saturating_sub(widths[start]);
                start += 1;
            }
        }

        let used = 1usize
            .saturating_add(left_width)
            .saturating_add(usize::from(left_overflow));
        let mut forward_budget = available.saturating_sub(used);
        if cursor < characters.len() {
            forward_budget = forward_budget.saturating_sub(1);
        }
        let mut end = cursor;
        let mut forward_width = 0usize;
        while end < characters.len() {
            let next = widths[end];
            if forward_width.saturating_add(next) > forward_budget {
                break;
            }
            end += 1;
            forward_width = forward_width.saturating_add(next);
        }
        (start, end, left_overflow, end < characters.len())
    };

    let mut text = String::new();
    let mut cursor_by_cell = Vec::with_capacity(width);
    for character in prefix.chars() {
        push_modal_token(&mut text, &mut cursor_by_cell, character, start, start);
    }
    if available > 0 {
        if left_overflow {
            push_modal_token(&mut text, &mut cursor_by_cell, '‹', start, start);
        }
        for (index, character) in characters
            .iter()
            .copied()
            .enumerate()
            .take(cursor)
            .skip(start)
        {
            push_modal_token(&mut text, &mut cursor_by_cell, character, index, index + 1);
        }
        push_modal_token(&mut text, &mut cursor_by_cell, '│', cursor, cursor);
        for (index, character) in characters
            .iter()
            .copied()
            .enumerate()
            .take(end)
            .skip(cursor)
        {
            push_modal_token(&mut text, &mut cursor_by_cell, character, index, index + 1);
        }
        if right_overflow {
            push_modal_token(&mut text, &mut cursor_by_cell, '›', end, end);
        }
    }
    ModalInputLayout {
        text,
        cursor_by_cell,
        trailing_cursor: if right_overflow {
            end
        } else {
            characters.len()
        },
    }
}

fn modal_input_display(prefix: &str, value: &str, cursor: usize, width: usize) -> String {
    modal_input_layout(prefix, value, cursor, width).text
}

fn modal_cursor_at(prefix: &str, value: &str, cursor: usize, width: usize, cell: usize) -> usize {
    let layout = modal_input_layout(prefix, value, cursor, width);
    layout
        .cursor_by_cell
        .get(cell)
        .copied()
        .unwrap_or(layout.trailing_cursor)
}

fn rendered_diff_target_at(
    rows: &[RenderedDiffRow],
    area: Rect,
    column: u16,
    row: u16,
) -> Option<(usize, u64)> {
    if !contains(area, column, row) {
        return None;
    }
    let rendered = rows.get(row.saturating_sub(area.y) as usize)?;
    let logical =
        if rendered.split && column.saturating_sub(area.x) >= area.width.saturating_sub(2) / 2 {
            rendered.logical_rows[1].or(rendered.logical_rows[0])
        } else {
            rendered.logical_rows[0].or(rendered.logical_rows[1])
        }?;
    Some((rendered.file_index, logical))
}

fn contains(area: Rect, column: u16, row: u16) -> bool {
    column >= area.x
        && column < area.x.saturating_add(area.width)
        && row >= area.y
        && row < area.y.saturating_add(area.height)
}

fn sidebar_width_for_pointer(root: Rect, column: u16) -> u16 {
    column.saturating_sub(root.x).clamp(
        METRICS.sidebar_min_width,
        root.width
            .saturating_sub(METRICS.content_min_width)
            .clamp(METRICS.sidebar_min_width, 72),
    )
}

fn panel_visibility(
    width: u16,
    height: u16,
    sidebar_preference: bool,
    comments_preference: bool,
) -> (bool, bool) {
    (
        sidebar_preference && width >= 96,
        comments_preference && height >= 22,
    )
}

fn search_popup_rect(area: Rect) -> Rect {
    let width = area.width.saturating_sub(METRICS.modal_margin_x).min(132);
    let height = area
        .height
        .saturating_sub(METRICS.modal_margin_y)
        .min(24)
        .max(10.min(area.height));
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

fn search_result_regions(body: Rect) -> (Rect, Option<Rect>, Option<Rect>) {
    if body.width < 88 {
        return (body, None, None);
    }
    let list_width = body.width.saturating_mul(43) / 100;
    let list = Rect::new(body.x, body.y, list_width, body.height);
    let divider = Rect::new(list.x + list.width, body.y, 1, body.height);
    let preview = Rect::new(
        divider.x.saturating_add(1),
        body.y,
        body.width.saturating_sub(list.width + 1),
        body.height,
    );
    (list, Some(divider), Some(preview))
}

fn search_empty_copy(scope: SearchScope, query: &str, changed_only: bool) -> (String, String) {
    let source = if changed_only {
        "changed files"
    } else {
        "the repository"
    };
    match scope {
        SearchScope::All if query.is_empty() => (
            format!("Nothing to browse in {source}"),
            "Press ^G to change the search source".to_string(),
        ),
        SearchScope::All => (
            format!("No files, text, or symbols match “{query}”"),
            "Try another scope or press ^G to change the source".to_string(),
        ),
        SearchScope::Files if query.is_empty() => (
            format!("No files to browse in {source}"),
            "Press ^G to change the search source".to_string(),
        ),
        SearchScope::Files => (
            format!("No files match “{query}”"),
            "File matching is fuzzy; try fewer characters".to_string(),
        ),
        SearchScope::Text if query.is_empty() => (
            "Type to search file contents".to_string(),
            format!("Searching {source} · ^R toggles regex"),
        ),
        SearchScope::Text => (
            format!("No text matches “{query}”"),
            "Try ^R for regex or ^G to change the source".to_string(),
        ),
        SearchScope::Symbols if query.chars().count() < 2 && changed_only => (
            "No definitions found in changed lines".to_string(),
            "Type 2+ characters to search all changed files".to_string(),
        ),
        SearchScope::Symbols if query.chars().count() < 2 => (
            "Type at least 2 characters to search symbols".to_string(),
            "Press ^G to browse definitions in changed lines".to_string(),
        ),
        SearchScope::Symbols => (
            format!("No symbols match “{query}”"),
            "Symbols include functions, types, classes, and variables".to_string(),
        ),
    }
}

fn query_char_eq(left: char, right: char) -> bool {
    left == right || (left.is_ascii() && right.is_ascii() && left.eq_ignore_ascii_case(&right))
}

fn literal_query_match_ranges(text: &str, query: &str) -> Vec<(usize, usize)> {
    let text_chars: Vec<(usize, char)> = text.char_indices().collect();
    let query_chars: Vec<char> = query.chars().collect();
    if query_chars.is_empty() || query_chars.len() > text_chars.len() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut start = 0usize;
    while start + query_chars.len() <= text_chars.len() {
        let matches = query_chars
            .iter()
            .enumerate()
            .all(|(offset, query)| query_char_eq(text_chars[start + offset].1, *query));
        if matches {
            let start_byte = text_chars[start].0;
            let end_index = start + query_chars.len();
            let end_byte = text_chars
                .get(end_index)
                .map(|(byte, _)| *byte)
                .unwrap_or(text.len());
            ranges.push((start_byte, end_byte));
            start = end_index;
        } else {
            start += 1;
        }
    }
    ranges
}

fn query_match_ranges(text: &str, query: &str, fuzzy: bool) -> Vec<(usize, usize)> {
    let exact = literal_query_match_ranges(text, query);
    if !exact.is_empty() || !fuzzy || query.is_empty() {
        return exact;
    }
    let text_chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut cursor = 0usize;
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for query_character in query.chars() {
        let Some(relative) = text_chars[cursor..]
            .iter()
            .position(|(_, character)| query_char_eq(*character, query_character))
        else {
            return Vec::new();
        };
        let index = cursor + relative;
        let start = text_chars[index].0;
        let end = text_chars
            .get(index + 1)
            .map(|(byte, _)| *byte)
            .unwrap_or(text.len());
        if let Some((_, previous_end)) = ranges.last_mut().filter(|(_, end)| *end == start) {
            *previous_end = end;
        } else {
            ranges.push((start, end));
        }
        cursor = index + 1;
    }
    ranges
}

#[allow(clippy::too_many_arguments)]
fn render_query_text(
    x: u16,
    y: u16,
    text: &str,
    query: &str,
    max_width: u16,
    base_style: Style,
    match_style: Style,
    fuzzy: bool,
    buf: &mut Buffer,
) {
    let text = safe_terminal_text(text);
    let ranges = query_match_ranges(&text, query, fuzzy);
    let _ = render_preview_span(
        x,
        y,
        x.saturating_add(max_width),
        &text,
        0,
        &ranges,
        base_style,
        match_style,
        buf,
    );
}

#[allow(clippy::too_many_arguments)]
fn render_preview_span(
    mut x: u16,
    y: u16,
    end: u16,
    text: &str,
    source_offset: usize,
    ranges: &[(usize, usize)],
    base_style: Style,
    match_style: Style,
    buf: &mut Buffer,
) -> u16 {
    for (byte, character) in text.char_indices() {
        let character = safe_terminal_character(character);
        let width = UnicodeWidthChar::width(character).unwrap_or(0) as u16;
        if width == 0 {
            continue;
        }
        if x.saturating_add(width) > end {
            break;
        }
        let position = source_offset.saturating_add(byte);
        let matched = ranges
            .iter()
            .any(|(start, end)| position >= *start && position < *end);
        buf[(x, y)]
            .set_char(character)
            .set_style(if matched { match_style } else { base_style });
        x = x.saturating_add(width);
    }
    x
}

fn truncate_cells(value: &str, max_width: usize) -> String {
    let mut output = String::new();
    let mut width = 0usize;
    for character in value.chars().map(safe_terminal_character) {
        let character_width = UnicodeWidthChar::width(character).unwrap_or(0);
        if width.saturating_add(character_width) > max_width {
            break;
        }
        output.push(character);
        width = width.saturating_add(character_width);
    }
    output
}

fn ellipsize(value: &str, max_width: usize) -> String {
    let value = safe_terminal_text(value);
    if UnicodeWidthStr::width(value.as_str()) <= max_width {
        return value;
    }
    if max_width == 0 {
        return String::new();
    }
    let mut shortened = truncate_cells(&value, max_width.saturating_sub(1));
    shortened.push('…');
    shortened
}

fn compact_path(value: &str, max_width: usize) -> (String, String) {
    let value = safe_terminal_text(value);
    if max_width == 0 {
        return (String::new(), String::new());
    }
    let split = value.rfind(['/', '\\']).map(|index| index + 1).unwrap_or(0);
    let (directory, basename) = value.split_at(split);
    if UnicodeWidthStr::width(basename) >= max_width {
        return (String::new(), ellipsize(basename, max_width));
    }
    let basename_width = UnicodeWidthStr::width(basename);
    let directory_budget = max_width.saturating_sub(basename_width);
    let directory = tail_ellipsize(directory, directory_budget);
    (directory, basename.to_string())
}

fn render_empty_diff_state(
    marker: &str,
    title: &str,
    detail: &str,
    tone: Color,
    area: Rect,
    palette: &Palette,
    buf: &mut Buffer,
) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let tokens = GridlineTokens::from(palette);
    let y = area.y.saturating_add(area.height.saturating_sub(2) / 2);
    let height = area.height.min(2);
    let lines = vec![
        Line::from(vec![
            Span::styled(
                format!("{marker}  "),
                Style::default().fg(tone).bg(tokens.canvas),
            ),
            Span::styled(
                title.to_string(),
                Style::default()
                    .fg(tokens.text)
                    .bg(tokens.canvas)
                    .add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(Span::styled(
            detail.to_string(),
            Style::default().fg(tokens.muted).bg(tokens.canvas),
        )),
    ];
    Paragraph::new(lines)
        .centered()
        .render(Rect::new(area.x, y, area.width, height), buf);
}

fn render_change_counts(
    mut x: u16,
    y: u16,
    additions: u64,
    deletions: u64,
    background: Color,
    palette: &Palette,
    buf: &mut Buffer,
) -> u16 {
    let tokens = GridlineTokens::from(palette);
    let added = format!("+{additions}");
    buf.set_string(
        x,
        y,
        &added,
        Style::default()
            .fg(tokens.positive)
            .bg(background)
            .add_modifier(Modifier::BOLD),
    );
    x = x.saturating_add(added.chars().count() as u16 + 2);
    let removed = format!("-{deletions}");
    buf.set_string(
        x,
        y,
        &removed,
        Style::default()
            .fg(tokens.negative)
            .bg(background)
            .add_modifier(Modifier::BOLD),
    );
    x.saturating_add(removed.chars().count() as u16)
}

fn render_metadata_segments(
    x: &mut u16,
    end: u16,
    y: u16,
    segments: Vec<(String, Style)>,
    buf: &mut Buffer,
) {
    for (text, style) in segments {
        let width = UnicodeWidthStr::width(text.as_str()) as u16;
        if (*x).saturating_add(width) > end {
            break;
        }
        buf.set_string(*x, y, text, style);
        *x = (*x).saturating_add(width);
    }
}

fn fill_area(area: Rect, color: ratatui::style::Color, buf: &mut Buffer) {
    for y in area.y..area.y.saturating_add(area.height) {
        for x in area.x..area.x.saturating_add(area.width) {
            buf[(x, y)]
                .set_symbol(" ")
                .set_style(Style::default().bg(color));
        }
    }
}

fn render_chip(
    x: u16,
    y: u16,
    label: &str,
    active: bool,
    pointer: Option<(u16, u16)>,
    palette: &Palette,
    buf: &mut Buffer,
) -> Rect {
    let tokens = GridlineTokens::from(palette);
    let width = UnicodeWidthStr::width(label) as u16 + 2;
    let area = Rect::new(x, y, width, 1);
    let hovered = pointer
        .map(|(column, row)| contains(area, column, row))
        .unwrap_or(false);
    let background = if hovered {
        tokens.selected
    } else if active {
        tokens.surface
    } else {
        tokens.canvas
    };
    fill_area(area, background, buf);
    if let Some((key, description)) = label.split_once(' ') {
        buf.set_string(
            x + 1,
            y,
            key,
            Style::default()
                .fg(if active || hovered {
                    tokens.accent
                } else {
                    tokens.muted
                })
                .bg(background)
                .add_modifier(Modifier::BOLD),
        );
        buf.set_string(
            x + 1 + UnicodeWidthStr::width(key) as u16,
            y,
            format!(" {description}"),
            Style::default()
                .fg(if active || hovered {
                    tokens.text
                } else {
                    tokens.muted
                })
                .bg(background),
        );
    } else {
        buf.set_string(
            x + 1,
            y,
            label,
            Style::default().fg(tokens.text).bg(background),
        );
    }
    area
}

fn metadata_files(index: &DiffIndex) -> Vec<FileDiff> {
    index
        .files
        .iter()
        .map(|file| FileDiff {
            old_path: file.old_path.clone(),
            new_path: file.new_path.clone(),
            kind: match file.kind {
                IndexedChangeKind::Modified => ChangeKind::Modified,
                IndexedChangeKind::Added => ChangeKind::Added,
                IndexedChangeKind::Deleted => ChangeKind::Deleted,
                IndexedChangeKind::Renamed => ChangeKind::Renamed,
                IndexedChangeKind::Untracked => ChangeKind::Untracked,
                IndexedChangeKind::Binary => ChangeKind::Binary,
            },
            is_binary: file.is_binary,
            hunks: Vec::new(),
        })
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn copy_to_clipboard(text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    for cmd in clipboard_candidates() {
        let argv = cmd.argv();
        if let Ok(mut child) = Command::new(argv[0])
            .args(&argv[1..])
            .stdin(Stdio::piped())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let payload = if cmd.want_crlf() {
                    // `clip.exe` reads raw stdin; pasting into typical Windows
                    // apps works best with CRLF endings.
                    text.replace('\n', "\r\n")
                } else {
                    text.to_string()
                };
                if stdin.write_all(payload.as_bytes()).is_ok() {
                    let _ = stdin.flush();
                    drop(stdin);
                    if child.wait().map(|s| s.success()).unwrap_or(false) {
                        return Ok(());
                    }
                }
            }
        }
    }
    Err(std::io::Error::other(
        "no clipboard tool found (tried pbcopy / wl-copy / xclip / xsel / clip / powershell)",
    ))
}

/// One clipboard tool candidate. We model the `clip.exe` line-ending quirk
/// explicitly so tests can verify it without spawning a real child process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClipboardCandidate {
    pub argv: &'static [&'static str],
    pub crlf: bool,
}

impl ClipboardCandidate {
    pub(crate) fn argv(&self) -> &'static [&'static str] {
        self.argv
    }
    pub(crate) fn want_crlf(&self) -> bool {
        self.crlf
    }
}

/// Ordered list of clipboard tools to try. Order matters: the *first*
/// successful spawn wins, so platform-native tools should come first.
pub(crate) fn clipboard_candidates() -> &'static [ClipboardCandidate] {
    #[cfg(target_os = "macos")]
    {
        const CANDS: &[ClipboardCandidate] = &[ClipboardCandidate {
            argv: &["pbcopy"],
            crlf: false,
        }];
        CANDS
    }
    #[cfg(target_os = "windows")]
    {
        const CANDS: &[ClipboardCandidate] = &[
            ClipboardCandidate {
                argv: &["clip"],
                crlf: true,
            },
            ClipboardCandidate {
                argv: &[
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "$input | Set-Clipboard",
                ],
                crlf: true,
            },
        ];
        CANDS
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Wayland first (modern desktops), then the two X11 tools. Either
        // ordering of xclip/xsel is fine; xclip is more common.
        const CANDS: &[ClipboardCandidate] = &[
            ClipboardCandidate {
                argv: &["wl-copy"],
                crlf: false,
            },
            ClipboardCandidate {
                argv: &["xclip", "-selection", "clipboard"],
                crlf: false,
            },
            ClipboardCandidate {
                argv: &["xsel", "--clipboard", "--input"],
                crlf: false,
            },
        ];
        CANDS
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
    {
        const CANDS: &[ClipboardCandidate] = &[];
        CANDS
    }
}

#[allow(dead_code)]
fn _quiet_duration(_: Duration) {}

fn context_lines_from_args(args: &[String]) -> Option<u32> {
    let mut index = 0;
    let mut context = None;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--unified=") {
            context = value.parse().ok();
        } else if arg == "--unified" || arg == "-U" {
            if let Some(value) = args.get(index + 1) {
                context = value.parse().ok();
                index += 1;
            }
        } else if let Some(value) = arg.strip_prefix("-U") {
            if !value.is_empty() {
                context = value.parse().ok();
            }
        }
        index += 1;
    }
    context
}

fn with_context_lines(args: &[String], context: u32) -> Vec<String> {
    let mut output = Vec::with_capacity(args.len() + 1);
    let mut index = 0;
    let mut inserted = false;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" && !inserted {
            output.push(format!("--unified={context}"));
            inserted = true;
        }
        if arg == "--unified" || arg == "-U" {
            index += 2;
            continue;
        }
        if arg.starts_with("--unified=")
            || (arg.starts_with("-U") && arg.len() > 2 && arg[2..].parse::<u32>().is_ok())
        {
            index += 1;
            continue;
        }
        output.push(arg.clone());
        index += 1;
    }
    if !inserted {
        output.push(format!("--unified={context}"));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::interleave_search_hits;

    #[test]
    fn context_arguments_are_replaced_without_moving_pathspecs() {
        let args = vec![
            "--no-color".to_string(),
            "-U3".to_string(),
            "--".to_string(),
            "src/lib.rs".to_string(),
        ];
        assert_eq!(context_lines_from_args(&args), Some(3));
        assert_eq!(
            with_context_lines(&args, 25),
            vec!["--no-color", "--unified=25", "--", "src/lib.rs"]
        );
    }

    fn diff_line(kind: IndexedLineKind, old: Option<u32>, new: Option<u32>, text: &str) -> ViewRow {
        ViewRow::Line {
            hunk_index: 0,
            kind,
            old_lineno: old,
            new_lineno: new,
            content: text.to_string(),
        }
    }

    #[test]
    fn multi_line_comment_target_is_inclusive_and_preserves_source() {
        let target = inline_comment_target(
            "src/lib.rs".to_string(),
            vec![
                diff_line(IndexedLineKind::Context, Some(11), Some(11), "alpha"),
                diff_line(IndexedLineKind::Add, None, Some(12), "beta"),
                diff_line(IndexedLineKind::Add, None, Some(13), "gamma"),
            ],
        )
        .unwrap();
        assert_eq!(target.side, CommentSide::Additions);
        assert_eq!(target.start_line_number, Some(11));
        assert_eq!(target.line_number, 13);
        assert_eq!(target.line_content, "alpha\nbeta\ngamma");
    }

    #[test]
    fn deletion_ranges_keep_old_side_anchors() {
        let target = inline_comment_target(
            "src/lib.rs".to_string(),
            vec![
                diff_line(IndexedLineKind::Del, Some(7), None, "old one"),
                diff_line(IndexedLineKind::Del, Some(8), None, "old two"),
            ],
        )
        .unwrap();
        assert_eq!(target.side, CommentSide::Deletions);
        assert_eq!(target.start_line_number, Some(7));
        assert_eq!(target.line_number, 8);
    }

    #[test]
    fn multi_line_comment_target_rejects_cross_side_and_gapped_ranges() {
        let cross_side = inline_comment_target(
            "src/lib.rs".to_string(),
            vec![
                diff_line(IndexedLineKind::Del, Some(7), None, "old"),
                diff_line(IndexedLineKind::Add, None, Some(7), "new"),
            ],
        );
        assert_eq!(
            cross_side.unwrap_err(),
            "selection must stay on one diff side"
        );

        let gapped = inline_comment_target(
            "src/lib.rs".to_string(),
            vec![
                diff_line(IndexedLineKind::Add, None, Some(7), "one"),
                diff_line(IndexedLineKind::Add, None, Some(9), "three"),
            ],
        );
        assert_eq!(
            gapped.unwrap_err(),
            "selection must be contiguous on one diff side"
        );
    }

    #[test]
    fn responsive_panels_preserve_the_diff_on_compact_terminals() {
        assert_eq!(panel_visibility(80, 24, true, true), (false, true));
        assert_eq!(panel_visibility(120, 20, true, true), (true, false));
        assert_eq!(panel_visibility(120, 40, false, true), (false, true));
    }

    #[test]
    fn search_layout_adds_preview_only_when_it_stays_readable() {
        let popup = search_popup_rect(Rect::new(0, 0, 160, 40));
        assert_eq!(popup, Rect::new(14, 8, 132, 24));

        let wide = Rect::new(4, 6, 120, 16);
        let (list, divider, preview) = search_result_regions(wide);
        assert_eq!(list.width, 51);
        assert_eq!(divider, Some(Rect::new(55, 6, 1, 16)));
        assert_eq!(preview, Some(Rect::new(56, 6, 68, 16)));

        let compact = Rect::new(4, 6, 72, 16);
        assert_eq!(search_result_regions(compact), (compact, None, None));
    }

    #[test]
    fn search_query_ranges_support_literal_and_fuzzy_emphasis() {
        let text = "Result and result";
        let ranges = literal_query_match_ranges(text, "result");
        assert_eq!(
            ranges
                .iter()
                .map(|(start, end)| &text[*start..*end])
                .collect::<Vec<_>>(),
            ["Result", "result"]
        );
        assert_eq!(
            query_match_ranges("file_tree_render.rs", "ftr", true),
            vec![(0, 1), (5, 7)]
        );
    }

    #[test]
    fn search_open_defaults_use_all_files_and_symbols_with_changed_only() {
        use crate::keys::Action;

        fn scope_for(action: Action) -> Option<SearchScope> {
            match action {
                Action::OpenSearch => Some(SearchScope::All),
                Action::OpenFileFilter => Some(SearchScope::Files),
                Action::OpenSymbolSearch => Some(SearchScope::Symbols),
                _ => None,
            }
        }

        assert_eq!(scope_for(Action::OpenSearch), Some(SearchScope::All));
        assert_eq!(scope_for(Action::OpenFileFilter), Some(SearchScope::Files));
        assert_eq!(
            scope_for(Action::OpenSymbolSearch),
            Some(SearchScope::Symbols)
        );
    }

    #[test]
    fn search_scope_empty_states_explain_the_next_keyboard_action() {
        assert_eq!(
            search_empty_copy(SearchScope::Text, "", true),
            (
                "Type to search file contents".to_string(),
                "Searching changed files · ^R toggles regex".to_string(),
            )
        );
        assert_eq!(
            search_empty_copy(SearchScope::Symbols, "", false),
            (
                "Type at least 2 characters to search symbols".to_string(),
                "Press ^G to browse definitions in changed lines".to_string(),
            )
        );
    }

    #[test]
    fn fallback_search_implements_files_text_and_symbols() {
        use crate::search::{
            changed_file_search_hits, changed_symbol_search_hits, changed_text_search_hits,
        };
        use diffing_core::index::build_index_from_reader;
        use std::collections::HashMap;
        use std::io::Cursor;

        let directory = tempfile::tempdir().unwrap();
        let spool = directory.path().join("search.patch");
        let patch = b"diff --git a/src/search.rs b/src/search.rs\nindex 1..2 100644\n--- a/src/search.rs\n+++ b/src/search.rs\n@@ -1 +1,3 @@\n context\n+pub fn render_search() {}\n+render_search();\n";
        let index = build_index_from_reader(Cursor::new(patch), &spool, 1, |_| {}).unwrap();

        let (files, file_total) = changed_file_search_hits(&index, "srs");
        assert_eq!(file_total, 1);
        assert_eq!(files[0].path, "src/search.rs");

        let mut symbol_cache = HashMap::new();
        let (symbols, symbol_total) =
            changed_symbol_search_hits(&index, "render", &mut symbol_cache).unwrap();
        assert_eq!(symbol_total, 1);
        assert_eq!(symbols[0].title, "render_search");
        assert_eq!(symbols[0].line, Some(2));

        let (text, text_total) = changed_text_search_hits(&index, "render_search").unwrap();
        assert_eq!(text_total, 2);
        assert_eq!(text.len(), 2);
    }

    #[test]
    fn preview_query_matches_override_syntax_style() {
        let area = Rect::new(0, 0, 24, 1);
        let mut buffer = Buffer::empty(area);
        let source = "let result = render();";
        let ranges = literal_query_match_ranges(source, "result");
        let base = Style::default().fg(Color::Blue).bg(Color::Black);
        let matched = Style::default().fg(Color::Black).bg(Color::Yellow);
        render_preview_span(
            0,
            0,
            area.width,
            source,
            0,
            &ranges,
            base,
            matched,
            &mut buffer,
        );
        assert_eq!(buffer[(3, 0)].style().bg, Some(Color::Black));
        for x in 4..10 {
            assert_eq!(buffer[(x, 0)].style().bg, Some(Color::Yellow));
        }
        assert_eq!(buffer[(10, 0)].style().bg, Some(Color::Black));
    }

    #[test]
    fn pointer_geometry_clamps_sidebar_and_uses_half_open_rects() {
        let root = Rect::new(10, 0, 120, 40);
        assert_eq!(sidebar_width_for_pointer(root, 12), 22);
        assert_eq!(sidebar_width_for_pointer(root, 50), 40);
        assert_eq!(sidebar_width_for_pointer(root, 129), 72);
        let area = Rect::new(5, 7, 4, 3);
        assert!(contains(area, 5, 7));
        assert!(contains(area, 8, 9));
        assert!(!contains(area, 9, 9));
        assert!(!contains(area, 8, 10));

        let regions = UiRegions {
            toolbar: vec![(Rect::new(2, 1, 12, 1), ToolbarAction::SendReview)],
            diff_inner: Some(Rect::new(20, 4, 80, 20)),
            ..UiRegions::default()
        };
        assert_eq!(
            regions.pointer_visual_target(Some((3, 1))),
            PointerVisualTarget::Toolbar(ToolbarAction::SendReview)
        );
        assert_eq!(
            regions.pointer_visual_target(Some((40, 9))),
            PointerVisualTarget::DiffRow(9)
        );
        assert_eq!(
            regions.pointer_visual_target(Some((19, 9))),
            PointerVisualTarget::None
        );
    }

    #[test]
    fn rendered_pointer_rows_preserve_wrap_and_split_targets() {
        let area = Rect::new(10, 4, 80, 4);
        let rows = vec![
            RenderedDiffRow {
                file_index: 2,
                logical_rows: [Some(10), Some(11)],
                split: true,
            },
            RenderedDiffRow {
                file_index: 2,
                logical_rows: [Some(10), Some(11)],
                split: true,
            },
            RenderedDiffRow {
                file_index: 3,
                logical_rows: [Some(5), None],
                split: false,
            },
        ];
        assert_eq!(rendered_diff_target_at(&rows, area, 20, 4), Some((2, 10)));
        assert_eq!(rendered_diff_target_at(&rows, area, 75, 5), Some((2, 11)));
        assert_eq!(rendered_diff_target_at(&rows, area, 75, 6), Some((3, 5)));
        assert_eq!(rendered_diff_target_at(&rows, area, 20, 7), None);
    }

    #[test]
    fn modal_editor_display_keeps_a_unicode_cursor_visible() {
        assert_eq!(char_byte_index("aλb", 2), 3);
        assert_eq!(modal_input_display("/ ", "alpha", 2, 12), "/ al│pha");
        let scrolled = modal_input_display("/ ", "abcdefghijk", 10, 8);
        assert!(scrolled.contains('‹'));
        assert!(scrolled.contains('│'));
        assert!(UnicodeWidthStr::width(scrolled.as_str()) <= 8);

        let wide = modal_input_display("/ ", "界面alpha", 2, 8);
        assert!(wide.contains('│'));
        assert!(UnicodeWidthStr::width(wide.as_str()) <= 8);
        assert_eq!(modal_cursor_at("/ ", "alpha", 2, 12, 3), 1);
    }

    #[test]
    fn render_metadata_maps_global_rows_with_prefix_offsets() {
        let metadata = DiffRenderMetadata {
            file_indices: vec![0, 1, 2],
            file_offsets: vec![0, 3, 3, 8],
            change_maps: VecDeque::new(),
        };
        assert_eq!(metadata.total_rows(), 8);
        assert_eq!(metadata.file_offset(0), 0);
        assert_eq!(metadata.file_offset(2), 3);
        assert_eq!(metadata.position(0), Some((0, 0)));
        assert_eq!(metadata.position(2), Some((0, 2)));
        assert_eq!(metadata.position(3), Some((2, 0)));
        assert_eq!(metadata.position(99), Some((2, 4)));

        let filtered = DiffRenderMetadata {
            file_indices: vec![2],
            file_offsets: vec![0, 5],
            change_maps: VecDeque::new(),
        };
        assert_eq!(filtered.position(0), Some((2, 0)));
        assert_eq!(filtered.position(99), Some((2, 4)));
        assert_eq!(filtered.file_offset(0), 5);
    }

    #[test]
    fn viewer_keeps_settings_and_commands_available() {
        assert!(!blocked_in_viewer(Action::OpenSettings));
        assert!(!blocked_in_viewer(Action::OpenCommand));
        assert!(!blocked_in_viewer(Action::LanguageHover));
        assert!(!blocked_in_viewer(Action::LanguageDefinition));
        assert!(blocked_in_viewer(Action::AddComment));
    }

    #[test]
    fn command_completion_is_bounded_and_keeps_short_aliases_discoverable() {
        assert_eq!(ex_command_completion(""), None);
        assert_eq!(ex_command_completion("ref"), Some("refresh"));
        assert_eq!(ex_command_completion("w"), Some("wrap"));
        assert_eq!(ex_command_completion("not-a-command"), None);
        assert!(EX_COMMANDS.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn toolbar_labels_are_bounded_without_splitting_characters() {
        assert_eq!(ellipsize("GitHub Dark", 16), "GitHub Dark");
        assert_eq!(ellipsize("A very long theme", 8), "A very …");
        assert_eq!(ellipsize("界面theme", 6), "界面t…");
        assert!(UnicodeWidthStr::width(ellipsize("界面theme", 5).as_str()) <= 5);
    }

    #[test]
    fn active_file_paths_keep_the_filename_and_nearest_directory() {
        assert_eq!(
            compact_path("crates/diffing-tui/src/app.rs", 18),
            ("…ng-tui/src/".to_string(), "app.rs".to_string())
        );
        assert_eq!(
            compact_path("src/a-very-long-renderer.rs", 12),
            (String::new(), "a-very-long…".to_string())
        );
        let (directory, basename) = compact_path("界面/renderer.rs", 12);
        assert!(UnicodeWidthStr::width(format!("{directory}{basename}").as_str()) <= 12);
        assert_eq!(basename, "renderer.rs");
    }

    #[test]
    fn change_counts_use_semantic_colors_and_generous_spacing() {
        let area = Rect::new(0, 0, 40, 1);
        let mut buffer = Buffer::empty(area);
        let palette = Palette::default();
        let end = render_change_counts(0, 0, 3290, 456, palette.bg, &palette, &mut buffer);

        assert_eq!(end, 11);
        assert_eq!(buffer[(0, 0)].symbol(), "+");
        assert_eq!(buffer[(0, 0)].style().fg, Some(palette.added));
        assert_eq!(buffer[(7, 0)].symbol(), "-");
        assert_eq!(buffer[(7, 0)].style().fg, Some(palette.removed));
    }

    #[test]
    fn search_results_keep_fff_order_with_changed_files_first() {
        let hit = |path: &str| SearchHit {
            kind: SearchHitKind::File,
            path: path.to_string(),
            line: None,
            title: path.to_string(),
            detail: String::new(),
            git_status: String::new(),
        };
        let changed = HashSet::from(["src/changed.rs".to_string()]);
        let ranked = diff_first_search_hits(
            vec![
                hit("src/outside-a.rs"),
                hit("src/changed.rs"),
                hit("src/outside-b.rs"),
            ],
            &changed,
        );
        assert_eq!(
            ranked
                .iter()
                .map(|hit| hit.path.as_str())
                .collect::<Vec<_>>(),
            ["src/changed.rs", "src/outside-a.rs", "src/outside-b.rs"]
        );
    }

    #[test]
    fn all_scope_interleaves_result_kinds_without_starvation() {
        let hit = |kind, title: &str| SearchHit {
            kind,
            path: format!("src/{title}"),
            line: None,
            title: title.to_string(),
            detail: String::new(),
            git_status: String::new(),
        };
        let hits = interleave_search_hits(
            vec![
                vec![
                    hit(SearchHitKind::File, "file-a"),
                    hit(SearchHitKind::File, "file-b"),
                ],
                vec![
                    hit(SearchHitKind::Symbol, "symbol-a"),
                    hit(SearchHitKind::Symbol, "symbol-b"),
                ],
                vec![
                    hit(SearchHitKind::Text, "text-a"),
                    hit(SearchHitKind::Text, "text-b"),
                ],
            ],
            6,
        );
        assert_eq!(
            hits.iter()
                .map(|hit| hit.title.as_str())
                .collect::<Vec<_>>(),
            ["file-a", "symbol-a", "text-a", "file-b", "symbol-b", "text-b"]
        );
    }

    // Sanity-check that the platform-conditional candidate list never ships
    // a binary that obviously doesn't belong on this OS. These tests are
    // intentionally compiled per-platform so each host asserts only its own
    // expected toolchain — if someone reshuffles the cfg blocks and breaks
    // a platform, the test for that platform will fail.

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_clipboard_uses_pbcopy() {
        let cands = clipboard_candidates();
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].argv(), ["pbcopy"]);
        assert!(!cands[0].want_crlf());
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_clipboard_prefers_clip_then_powershell() {
        let cands = clipboard_candidates();
        assert!(cands.len() >= 2);
        assert_eq!(cands[0].argv()[0], "clip");
        assert!(cands[0].want_crlf(), "clip.exe wants CRLF endings");
        assert_eq!(cands[1].argv()[0], "powershell");
        assert!(
            cands[1].argv().iter().any(|a| a.contains("Set-Clipboard")),
            "PowerShell fallback must use Set-Clipboard"
        );
    }

    #[test]
    #[cfg(all(unix, not(target_os = "macos")))]
    fn linux_clipboard_offers_wayland_and_x11() {
        let cands = clipboard_candidates();
        let names: Vec<&str> = cands.iter().map(|c| c.argv()[0]).collect();
        assert!(names.contains(&"wl-copy"), "wl-copy missing: {:?}", names);
        assert!(names.contains(&"xclip"), "xclip missing: {:?}", names);
        // wl-copy must come before the X11 tools so Wayland-only sessions
        // don't trip over an X11 fallback that silently writes to the wrong
        // clipboard.
        let wl = names.iter().position(|&n| n == "wl-copy").unwrap();
        let xclip = names.iter().position(|&n| n == "xclip").unwrap();
        assert!(wl < xclip, "wl-copy must be tried before xclip");
        assert!(cands.iter().all(|c| !c.want_crlf()));
    }
}
