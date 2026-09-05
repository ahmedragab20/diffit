//! Streaming, disk-backed unified-diff index.
//!
//! The interactive renderer must never own the complete patch or rebuild a
//! complete file for each frame.  This module spools Git's stdout as bytes and
//! retains only file/hunk metadata plus sparse line checkpoints in memory.
//! Viewport reads seek to the nearest checkpoint and decode a bounded number
//! of rows.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::diff::{ChangeKind, LineKind};
use crate::project_storage_dir;

pub const CHECKPOINT_INTERVAL: u64 = 128;
pub const DEFAULT_VIEWPORT_MAX_BYTES: usize = 256 * 1024;
const SNAPSHOT_ROW_INTERVAL: u64 = 8_192;
#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffIndex {
    pub generation: u64,
    #[serde(skip)]
    pub spool_path: PathBuf,
    pub files: Vec<IndexedFile>,
    pub total_rows: u64,
    pub total_hunks: u64,
    pub additions: u64,
    pub deletions: u64,
    pub patch_bytes: u64,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFile {
    pub old_path: Option<PathBuf>,
    pub new_path: Option<PathBuf>,
    /// Blob identifiers advertised by Git's `index <old>..<new>` header.
    ///
    /// They are renderer implementation details rather than part of the
    /// bounded inspect API. The TUI uses them to load the exact before/after
    /// bytes for binary previews (falling back to the index or worktree when
    /// Git has not materialized a worktree blob).
    #[serde(skip)]
    pub old_oid: Option<String>,
    #[serde(skip)]
    pub new_oid: Option<String>,
    pub kind: IndexedChangeKind,
    pub is_binary: bool,
    pub hunks: Vec<IndexedHunk>,
    /// Logical rows including the file header and each hunk header.
    pub row_count: u64,
    pub additions: u64,
    pub deletions: u64,
}

impl IndexedFile {
    pub fn display_path(&self) -> &Path {
        self.new_path
            .as_deref()
            .or(self.old_path.as_deref())
            .unwrap_or_else(|| Path::new(""))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexedChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Binary,
}

impl From<ChangeKind> for IndexedChangeKind {
    fn from(value: ChangeKind) -> Self {
        match value {
            ChangeKind::Modified => Self::Modified,
            ChangeKind::Added => Self::Added,
            ChangeKind::Deleted => Self::Deleted,
            ChangeKind::Renamed => Self::Renamed,
            ChangeKind::Untracked => Self::Untracked,
            ChangeKind::Binary => Self::Binary,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub heading: String,
    /// Logical row of this hunk's header within its file.
    pub row_start: u64,
    pub line_count: u64,
    pub body_offset: u64,
    pub body_end: u64,
    pub checkpoints: Vec<LineCheckpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineCheckpoint {
    /// Zero-based body row within the hunk.
    pub row: u64,
    pub offset: u64,
    pub old_lineno: u32,
    pub new_lineno: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ViewRow {
    FileHeader {
        file_index: usize,
        path: String,
        kind: IndexedChangeKind,
        binary: bool,
    },
    HunkHeader {
        hunk_index: usize,
        old_start: u32,
        old_lines: u32,
        new_start: u32,
        new_lines: u32,
        heading: String,
    },
    Line {
        hunk_index: usize,
        kind: IndexedLineKind,
        old_lineno: Option<u32>,
        new_lineno: Option<u32>,
        content: String,
    },
    NoNewline {
        hunk_index: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexedLineKind {
    Context,
    Add,
    Del,
}

impl From<LineKind> for IndexedLineKind {
    fn from(value: LineKind) -> Self {
        match value {
            LineKind::Context => Self::Context,
            LineKind::Add => Self::Add,
            LineKind::Del => Self::Del,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub generation: u64,
    pub file_index: usize,
    pub start_row: u64,
    pub next_row: Option<u64>,
    pub total_rows: u64,
    pub truncated: bool,
    pub estimated_bytes: usize,
    pub rows: Vec<ViewRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub file_index: usize,
    pub path: String,
    pub row: u64,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub generation: u64,
    pub hits: Vec<SearchHit>,
    pub next_file: Option<usize>,
    pub next_row: Option<u64>,
    pub truncated: bool,
    pub estimated_bytes: usize,
}

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("malformed hunk header: {0}")]
    HunkHeader(String),
    #[error("git diff failed (exit {code:?}): {stderr}")]
    Git { code: Option<i32>, stderr: String },
    #[error("git diff stdout was unavailable")]
    MissingStdout,
    #[error("git diff stderr was unavailable")]
    MissingStderr,
}

impl DiffIndex {
    pub fn empty(generation: u64, spool_path: PathBuf, complete: bool) -> Self {
        Self {
            generation,
            spool_path,
            files: Vec::new(),
            total_rows: 0,
            total_hunks: 0,
            additions: 0,
            deletions: 0,
            patch_bytes: 0,
            complete,
        }
    }

    /// Decode at most `limit` logical rows and `max_bytes` of visible text.
    /// Work is proportional to the requested viewport plus at most one sparse
    /// checkpoint interval.
    pub fn viewport(
        &self,
        file_index: usize,
        start_row: u64,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Viewport, IndexError> {
        self.viewport_impl(file_index, start_row, limit, max_bytes, None)
    }

    /// Decode a viewport for terminal rendering while retaining at most
    /// `max_line_bytes` from any individual diff line. The reader still
    /// consumes the complete source line, so row offsets and line numbers stay
    /// exact, but a malicious or generated multi-megabyte line cannot force a
    /// multi-megabyte per-frame allocation.
    pub fn viewport_for_render(
        &self,
        file_index: usize,
        start_row: u64,
        limit: usize,
        max_bytes: usize,
        max_line_bytes: usize,
    ) -> Result<Viewport, IndexError> {
        self.viewport_impl(
            file_index,
            start_row,
            limit,
            max_bytes,
            Some(max_line_bytes.max(1)),
        )
    }

    fn viewport_impl(
        &self,
        file_index: usize,
        start_row: u64,
        limit: usize,
        max_bytes: usize,
        max_line_bytes: Option<usize>,
    ) -> Result<Viewport, IndexError> {
        let Some(file) = self.files.get(file_index) else {
            return Ok(Viewport {
                generation: self.generation,
                file_index,
                start_row,
                next_row: None,
                total_rows: 0,
                truncated: false,
                estimated_bytes: 0,
                rows: Vec::new(),
            });
        };
        let max_bytes = max_bytes.max(1);
        let start = start_row.min(file.row_count);
        let end = start.saturating_add(limit as u64).min(file.row_count);
        let mut rows = Vec::with_capacity(limit.min(256));
        let mut estimated_bytes = 0usize;
        let mut cursor = start;
        let mut truncated = false;

        if cursor == 0 && cursor < end {
            let path = file.display_path().to_string_lossy().into_owned();
            estimated_bytes = estimated_bytes.saturating_add(path.len() + 32);
            rows.push(ViewRow::FileHeader {
                file_index,
                path,
                kind: file.kind,
                binary: file.is_binary,
            });
            cursor += 1;
        }

        let mut spool: Option<BufReader<File>> = None;
        // Hunk row ranges are ordered and non-overlapping. Jump directly to
        // the first range that can intersect this viewport instead of walking
        // every preceding hunk on each scroll frame.
        let first_hunk = first_intersecting_hunk(&file.hunks, cursor);
        for (hunk_index, hunk) in file.hunks.iter().enumerate().skip(first_hunk) {
            if cursor >= end {
                break;
            }
            let hunk_end = hunk.row_start + 1 + hunk.line_count;
            if cursor >= hunk_end || end <= hunk.row_start {
                continue;
            }
            if cursor <= hunk.row_start && hunk.row_start < end {
                let row = ViewRow::HunkHeader {
                    hunk_index,
                    old_start: hunk.old_start,
                    old_lines: hunk.old_lines,
                    new_start: hunk.new_start,
                    new_lines: hunk.new_lines,
                    heading: hunk.heading.clone(),
                };
                let cost = hunk.heading.len() + 48;
                if estimated_bytes.saturating_add(cost) > max_bytes && !rows.is_empty() {
                    truncated = true;
                    break;
                }
                estimated_bytes = estimated_bytes.saturating_add(cost);
                rows.push(row);
                cursor = hunk.row_start + 1;
            }
            let body_start = cursor.max(hunk.row_start + 1) - (hunk.row_start + 1);
            let body_end = end.min(hunk_end) - (hunk.row_start + 1);
            if body_start >= body_end {
                continue;
            }
            if spool.is_none() {
                spool = Some(BufReader::new(File::open(&self.spool_path)?));
            }
            let reader = spool.as_mut().expect("spool initialized");
            let decoded = decode_hunk_rows(
                reader,
                hunk,
                hunk_index,
                body_start,
                body_end,
                max_line_bytes,
            )?;
            for row in decoded {
                let cost = view_row_cost(&row);
                if estimated_bytes.saturating_add(cost) > max_bytes && !rows.is_empty() {
                    truncated = true;
                    break;
                }
                estimated_bytes = estimated_bytes.saturating_add(cost);
                rows.push(row);
                cursor += 1;
            }
            if truncated {
                break;
            }
        }

        let next_row = (cursor < file.row_count).then_some(cursor);
        Ok(Viewport {
            generation: self.generation,
            file_index,
            start_row: start,
            next_row,
            total_rows: file.row_count,
            truncated,
            estimated_bytes,
            rows,
        })
    }

    /// Literal case-insensitive search with a bounded result and byte budget.
    /// The `(start_file, start_row)` pair is a stable cursor within a
    /// generation and allows callers to page without retransmitting matches.
    pub fn search_literal(
        &self,
        query: &str,
        start_file: usize,
        start_row: u64,
        max_hits: usize,
        max_bytes: usize,
    ) -> Result<SearchPage, IndexError> {
        self.search_literal_filtered(query, start_file, start_row, max_hits, max_bytes, None)
    }

    pub fn search_literal_filtered(
        &self,
        query: &str,
        start_file: usize,
        start_row: u64,
        max_hits: usize,
        max_bytes: usize,
        allowed_files: Option<&HashSet<usize>>,
    ) -> Result<SearchPage, IndexError> {
        let needle = query.to_lowercase();
        if needle.is_empty() || max_hits == 0 {
            return Ok(SearchPage {
                generation: self.generation,
                hits: Vec::new(),
                next_file: None,
                next_row: None,
                truncated: false,
                estimated_bytes: 0,
            });
        }
        let mut hits = Vec::new();
        let mut estimated_bytes = 0usize;
        for file_index in start_file..self.files.len() {
            if let Some(allowed) = allowed_files {
                if !allowed.contains(&file_index) {
                    continue;
                }
            }
            let file = &self.files[file_index];
            let path = file.display_path().to_string_lossy().into_owned();
            let mut row = if file_index == start_file {
                start_row
            } else {
                0
            };
            if row == 0 && path.to_lowercase().contains(&needle) {
                let hit = SearchHit {
                    file_index,
                    path: path.clone(),
                    row: 0,
                    old_lineno: None,
                    new_lineno: None,
                    preview: path.clone(),
                };
                let cost = path.len().saturating_mul(2) + 48;
                if cost <= max_bytes || hits.is_empty() {
                    estimated_bytes += cost;
                    hits.push(hit);
                }
            }
            while row < file.row_count {
                let page = self.viewport(file_index, row, 512, 1024 * 1024)?;
                if page.rows.is_empty() {
                    break;
                }
                for (offset, view_row) in page.rows.iter().enumerate() {
                    let ViewRow::Line {
                        old_lineno,
                        new_lineno,
                        content,
                        ..
                    } = view_row
                    else {
                        continue;
                    };
                    if !content.to_lowercase().contains(&needle) {
                        continue;
                    }
                    let cost = path.len() + content.len() + 48;
                    if hits.len() >= max_hits
                        || (estimated_bytes.saturating_add(cost) > max_bytes && !hits.is_empty())
                    {
                        return Ok(SearchPage {
                            generation: self.generation,
                            hits,
                            next_file: Some(file_index),
                            next_row: Some(row + offset as u64),
                            truncated: true,
                            estimated_bytes,
                        });
                    }
                    estimated_bytes = estimated_bytes.saturating_add(cost);
                    hits.push(SearchHit {
                        file_index,
                        path: path.clone(),
                        row: row + offset as u64,
                        old_lineno: *old_lineno,
                        new_lineno: *new_lineno,
                        preview: content.clone(),
                    });
                }
                let Some(next) = page.next_row else {
                    break;
                };
                if next <= row {
                    break;
                }
                row = next;
            }
        }
        Ok(SearchPage {
            generation: self.generation,
            hits,
            next_file: None,
            next_row: None,
            truncated: false,
            estimated_bytes,
        })
    }

    /// Locate a side-specific source line and return its logical file row.
    /// Sparse viewport paging keeps memory bounded even for unusually large
    /// hunks.
    pub fn find_line_row(
        &self,
        file_index: usize,
        side: IndexedLineKind,
        line_number: u32,
    ) -> Result<Option<u64>, IndexError> {
        let Some(file) = self.files.get(file_index) else {
            return Ok(None);
        };
        for hunk in &file.hunks {
            let in_range = match side {
                IndexedLineKind::Del => {
                    line_number >= hunk.old_start
                        && line_number < hunk.old_start.saturating_add(hunk.old_lines)
                }
                IndexedLineKind::Add | IndexedLineKind::Context => {
                    line_number >= hunk.new_start
                        && line_number < hunk.new_start.saturating_add(hunk.new_lines)
                }
            };
            if !in_range {
                continue;
            }
            let mut row = hunk.row_start + 1;
            let end = row + hunk.line_count;
            while row < end {
                let page =
                    self.viewport(file_index, row, (end - row).min(512) as usize, 1024 * 1024)?;
                if page.rows.is_empty() {
                    break;
                }
                for (offset, view_row) in page.rows.iter().enumerate() {
                    let ViewRow::Line {
                        kind,
                        old_lineno,
                        new_lineno,
                        ..
                    } = view_row
                    else {
                        continue;
                    };
                    let matches = match side {
                        IndexedLineKind::Del => {
                            *kind == IndexedLineKind::Del && *old_lineno == Some(line_number)
                        }
                        IndexedLineKind::Add => {
                            *kind != IndexedLineKind::Del && *new_lineno == Some(line_number)
                        }
                        IndexedLineKind::Context => *new_lineno == Some(line_number),
                    };
                    if matches {
                        return Ok(Some(row + offset as u64));
                    }
                }
                let Some(next) = page.next_row else {
                    break;
                };
                if next <= row {
                    break;
                }
                row = next;
            }
        }
        Ok(None)
    }
}

fn first_intersecting_hunk(hunks: &[IndexedHunk], row: u64) -> usize {
    hunks.partition_point(|hunk| {
        hunk.row_start
            .saturating_add(1)
            .saturating_add(hunk.line_count)
            <= row
    })
}

fn view_row_cost(row: &ViewRow) -> usize {
    match row {
        ViewRow::FileHeader { path, .. } => path.len() + 32,
        ViewRow::HunkHeader { heading, .. } => heading.len() + 48,
        ViewRow::Line { content, .. } => content.len() + 32,
        ViewRow::NoNewline { .. } => 40,
    }
}

fn decode_hunk_rows(
    reader: &mut BufReader<File>,
    hunk: &IndexedHunk,
    hunk_index: usize,
    start: u64,
    end: u64,
    max_line_bytes: Option<usize>,
) -> Result<Vec<ViewRow>, IndexError> {
    let checkpoint = hunk
        .checkpoints
        .partition_point(|cp| cp.row <= start)
        .checked_sub(1)
        .and_then(|idx| hunk.checkpoints.get(idx))
        .cloned()
        .unwrap_or(LineCheckpoint {
            row: 0,
            offset: hunk.body_offset,
            old_lineno: hunk.old_start,
            new_lineno: hunk.new_start,
        });
    reader.seek(SeekFrom::Start(checkpoint.offset))?;
    let mut logical_row = checkpoint.row;
    let mut old_lineno = checkpoint.old_lineno;
    let mut new_lineno = checkpoint.new_lineno;
    let mut offset = checkpoint.offset;
    let mut raw = Vec::new();
    let mut out = Vec::with_capacity((end - start) as usize);
    while logical_row < end && offset < hunk.body_end {
        let retained_bytes = if logical_row < start {
            max_line_bytes.map(|_| 1)
        } else {
            max_line_bytes
        };
        let read = read_line_bounded(reader, &mut raw, retained_bytes)?;
        if read == 0 {
            break;
        }
        offset += read as u64;
        trim_line_ending(&mut raw);
        let decoded = decode_body_line(&raw, hunk_index, &mut old_lineno, &mut new_lineno);
        if logical_row >= start {
            out.push(decoded);
        }
        logical_row += 1;
    }
    Ok(out)
}

/// Consume one complete line while retaining only its useful prefix. This is
/// equivalent to `read_until(b'\n', ...)` when `max_bytes` is `None`, but it
/// avoids growing the destination to the full length of pathological lines.
fn read_line_bounded(
    reader: &mut BufReader<File>,
    output: &mut Vec<u8>,
    max_bytes: Option<usize>,
) -> io::Result<usize> {
    output.clear();
    let mut total = 0usize;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(total);
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |position| position + 1);
        let retained = max_bytes
            .map(|limit| limit.saturating_sub(output.len()).min(consumed))
            .unwrap_or(consumed);
        output.extend_from_slice(&available[..retained]);
        reader.consume(consumed);
        total = total.saturating_add(consumed);
        if newline.is_some() {
            return Ok(total);
        }
    }
}

fn decode_body_line(
    raw: &[u8],
    hunk_index: usize,
    old_lineno: &mut u32,
    new_lineno: &mut u32,
) -> ViewRow {
    if raw == b"\\ No newline at end of file" {
        return ViewRow::NoNewline { hunk_index };
    }
    let (kind, content, old, new) = match raw.first().copied() {
        Some(b'+') => {
            let line = *new_lineno;
            *new_lineno = new_lineno.saturating_add(1);
            (IndexedLineKind::Add, &raw[1..], None, Some(line))
        }
        Some(b'-') => {
            let line = *old_lineno;
            *old_lineno = old_lineno.saturating_add(1);
            (IndexedLineKind::Del, &raw[1..], Some(line), None)
        }
        Some(b' ') => {
            let old = *old_lineno;
            let new = *new_lineno;
            *old_lineno = old_lineno.saturating_add(1);
            *new_lineno = new_lineno.saturating_add(1);
            (IndexedLineKind::Context, &raw[1..], Some(old), Some(new))
        }
        _ => {
            let old = *old_lineno;
            let new = *new_lineno;
            *old_lineno = old_lineno.saturating_add(1);
            *new_lineno = new_lineno.saturating_add(1);
            (IndexedLineKind::Context, raw, Some(old), Some(new))
        }
    };
    ViewRow::Line {
        hunk_index,
        kind,
        old_lineno: old,
        new_lineno: new,
        content: String::from_utf8_lossy(content).into_owned(),
    }
}

/// Stream Git into a disk-backed index. `on_snapshot` receives usable partial
/// generations while a large patch is still being ingested.
pub fn build_git_diff_index<F>(
    repo_root: &str,
    args: &[String],
    mut on_snapshot: F,
) -> Result<DiffIndex, IndexError>
where
    F: FnMut(DiffIndex),
{
    let generation = next_generation();
    let cache_dir = project_storage_dir(repo_root).join("diff-index");
    fs::create_dir_all(&cache_dir)?;
    cleanup_stale_spools(&cache_dir, generation);
    let temp_path = cache_dir.join(format!("{generation}.patch.tmp"));
    let final_path = cache_dir.join(format!("{generation}.patch"));

    let mut cmd = Command::new("git");
    // The index consumes a machine-stable unified patch. Never allow a user
    // color configuration to inject ANSI bytes into structural headers, or
    // repository-configured diff drivers / textconv filters to run.
    cmd.arg("diff")
        .arg("--no-color")
        .arg("--no-ext-diff")
        .arg("--no-textconv");
    for arg in args {
        if arg != "--no-color" && arg != "--no-ext-diff" && arg != "--no-textconv" {
            cmd.arg(arg);
        }
    }
    let mut child = cmd
        .current_dir(repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().ok_or(IndexError::MissingStdout)?;
    let stderr = child.stderr.take().ok_or(IndexError::MissingStderr)?;
    let stderr_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr)
            .take(4 * 1024 * 1024)
            .read_to_end(&mut bytes);
        bytes
    });

    let untracked = if args.is_empty() {
        list_untracked_files(repo_root).unwrap_or_default()
    } else {
        Vec::new()
    };
    let untracked_paths: HashSet<PathBuf> = untracked.iter().cloned().collect();
    let source = GitAndUntrackedReader::new(stdout, repo_root.to_string(), untracked);
    let build_result = build_index_from_reader(
        BufReader::with_capacity(256 * 1024, source),
        &temp_path,
        generation,
        &mut on_snapshot,
    );
    let status = child.wait()?;
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() && status.code() != Some(1) {
        let _ = fs::remove_file(&temp_path);
        return Err(IndexError::Git {
            code: status.code(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        });
    }
    let mut index = build_result?;
    for file in &mut index.files {
        if untracked_paths.contains(file.display_path()) {
            file.kind = IndexedChangeKind::Untracked;
        }
    }
    fs::rename(&temp_path, &final_path)?;
    index.spool_path = final_path;
    index.complete = true;
    on_snapshot(index.clone());
    Ok(index)
}

fn list_untracked_files(repo_root: &str) -> Result<Vec<PathBuf>, IndexError> {
    let output = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .current_dir(repo_root)
        .output()?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(bytes_path)
        .collect())
}

/// Concatenate the primary `git diff` stream with one `git diff --no-index`
/// child per untracked file. This keeps untracked content streaming and avoids
/// constructing a second patch in memory.
struct GitAndUntrackedReader<R> {
    primary: R,
    primary_done: bool,
    repo_root: String,
    untracked: Vec<PathBuf>,
    next_untracked: usize,
    child: Option<Child>,
    stdout: Option<ChildStdout>,
}

impl<R> GitAndUntrackedReader<R> {
    fn new(primary: R, repo_root: String, untracked: Vec<PathBuf>) -> Self {
        Self {
            primary,
            primary_done: false,
            repo_root,
            untracked,
            next_untracked: 0,
            child: None,
            stdout: None,
        }
    }

    fn start_next(&mut self) -> io::Result<bool> {
        let Some(path) = self.untracked.get(self.next_untracked) else {
            return Ok(false);
        };
        self.next_untracked += 1;
        let mut child = Command::new("git")
            .args([
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--",
                NULL_DEVICE,
            ])
            .arg(path)
            .current_dir(&self.repo_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        self.stdout = child.stdout.take();
        self.child = Some(child);
        Ok(true)
    }

    fn finish_child(&mut self) -> io::Result<()> {
        self.stdout = None;
        if let Some(mut child) = self.child.take() {
            let status = child.wait()?;
            if !status.success() && status.code() != Some(1) {
                return Err(io::Error::other(format!(
                    "git diff --no-index failed with {status}"
                )));
            }
        }
        Ok(())
    }
}

impl<R: Read> Read for GitAndUntrackedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if !self.primary_done {
            let read = self.primary.read(buffer)?;
            if read > 0 {
                return Ok(read);
            }
            self.primary_done = true;
        }
        loop {
            if let Some(stdout) = self.stdout.as_mut() {
                let read = stdout.read(buffer)?;
                if read > 0 {
                    return Ok(read);
                }
                self.finish_child()?;
            }
            if !self.start_next()? {
                return Ok(0);
            }
        }
    }
}

/// Index any unified-diff byte stream. Primarily used by tests, benchmarks,
/// and non-Git producers.
pub fn build_index_from_reader<R, F>(
    mut input: R,
    spool_path: &Path,
    generation: u64,
    mut on_snapshot: F,
) -> Result<DiffIndex, IndexError>
where
    R: BufRead,
    F: FnMut(DiffIndex),
{
    let spool = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(spool_path)?;
    let mut spool = BufWriter::with_capacity(256 * 1024, spool);
    let mut files = Vec::new();
    let mut current_file: Option<IndexedFile> = None;
    let mut current_hunk: Option<IndexedHunk> = None;
    let mut old_lineno = 0u32;
    let mut new_lineno = 0u32;
    let mut offset = 0u64;
    let mut raw = Vec::with_capacity(4096);
    let mut rows_since_snapshot = 0u64;

    loop {
        raw.clear();
        let read = input.read_until(b'\n', &mut raw)?;
        if read == 0 {
            break;
        }
        let line_offset = offset;
        offset += read as u64;
        spool.write_all(&raw)?;
        let mut line = raw.as_slice();
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line = &line[..line.len() - 1];
        }

        if let Some(rest) = line.strip_prefix(b"diff --git ") {
            finish_hunk(&mut current_file, &mut current_hunk, line_offset);
            finish_file(&mut files, &mut current_file);
            current_file = Some(parse_file_header_bytes(rest));
            continue;
        }
        let Some(file) = current_file.as_mut() else {
            continue;
        };
        if line.starts_with(b"@@") {
            finish_hunk_in_file(file, &mut current_hunk, line_offset);
            let mut hunk = parse_hunk_header_bytes(line)?;
            hunk.row_start = file.row_count;
            hunk.body_offset = offset;
            old_lineno = hunk.old_start;
            new_lineno = hunk.new_start;
            file.row_count += 1;
            current_hunk = Some(hunk);
            continue;
        }

        if line.starts_with(b"new file mode") {
            file.kind = IndexedChangeKind::Added;
            continue;
        }
        if line.starts_with(b"deleted file mode") {
            file.kind = IndexedChangeKind::Deleted;
            continue;
        }
        if let Some(rest) = line.strip_prefix(b"rename from ") {
            file.kind = IndexedChangeKind::Renamed;
            file.old_path = Some(bytes_path(rest));
            continue;
        }
        if let Some(rest) = line.strip_prefix(b"rename to ") {
            file.kind = IndexedChangeKind::Renamed;
            file.new_path = Some(bytes_path(rest));
            continue;
        }
        if line.starts_with(b"Binary files ") && line.ends_with(b" differ") {
            // Keep Added/Deleted so binary previews know which side exists.
            // Modified binary files retain the dedicated Binary marker.
            if file.kind == IndexedChangeKind::Modified {
                file.kind = IndexedChangeKind::Binary;
            }
            file.is_binary = true;
            continue;
        }
        if let Some(rest) = line.strip_prefix(b"index ") {
            if let Some((old_oid, new_oid)) = parse_index_oids(rest) {
                file.old_oid = old_oid;
                file.new_oid = new_oid;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix(b"--- ") {
            let rest = trim_ascii(rest);
            if rest == b"/dev/null" {
                file.kind = IndexedChangeKind::Added;
                file.old_path = None;
            } else {
                file.old_path = Some(diff_marker_path(rest, b"a/"));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix(b"+++ ") {
            let rest = trim_ascii(rest);
            if rest == b"/dev/null" {
                file.kind = IndexedChangeKind::Deleted;
                file.new_path = None;
            } else {
                file.new_path = Some(diff_marker_path(rest, b"b/"));
            }
            continue;
        }

        let Some(hunk) = current_hunk.as_mut() else {
            continue;
        };
        if hunk.line_count % CHECKPOINT_INTERVAL == 0 {
            hunk.checkpoints.push(LineCheckpoint {
                row: hunk.line_count,
                offset: line_offset,
                old_lineno,
                new_lineno,
            });
        }
        match line.first().copied() {
            Some(b'+') => {
                new_lineno = new_lineno.saturating_add(1);
                file.additions += 1;
            }
            Some(b'-') => {
                old_lineno = old_lineno.saturating_add(1);
                file.deletions += 1;
            }
            Some(b' ') => {
                old_lineno = old_lineno.saturating_add(1);
                new_lineno = new_lineno.saturating_add(1);
            }
            _ if line == b"\\ No newline at end of file" => {}
            _ => {
                old_lineno = old_lineno.saturating_add(1);
                new_lineno = new_lineno.saturating_add(1);
            }
        }
        hunk.line_count += 1;
        file.row_count += 1;
        rows_since_snapshot += 1;

        if rows_since_snapshot >= SNAPSHOT_ROW_INTERVAL {
            spool.flush()?;
            let snapshot = partial_snapshot(
                generation,
                spool_path,
                offset,
                &files,
                current_file.as_ref(),
                current_hunk.as_ref(),
            );
            on_snapshot(snapshot);
            rows_since_snapshot = 0;
        }
    }

    finish_hunk(&mut current_file, &mut current_hunk, offset);
    finish_file(&mut files, &mut current_file);
    spool.flush()?;
    spool.get_ref().sync_data()?;
    let mut index = summarize_index(generation, spool_path.to_path_buf(), files, offset, false);
    index.complete = false;
    Ok(index)
}

fn partial_snapshot(
    generation: u64,
    spool_path: &Path,
    offset: u64,
    files: &[IndexedFile],
    current_file: Option<&IndexedFile>,
    current_hunk: Option<&IndexedHunk>,
) -> DiffIndex {
    let mut snapshot_files = files.to_vec();
    if let Some(file) = current_file {
        let mut file = file.clone();
        if let Some(hunk) = current_hunk {
            let mut hunk = hunk.clone();
            hunk.body_end = offset;
            file.hunks.push(hunk);
        }
        snapshot_files.push(file);
    }
    summarize_index(
        generation,
        spool_path.to_path_buf(),
        snapshot_files,
        offset,
        false,
    )
}

fn summarize_index(
    generation: u64,
    spool_path: PathBuf,
    files: Vec<IndexedFile>,
    patch_bytes: u64,
    complete: bool,
) -> DiffIndex {
    DiffIndex {
        generation,
        total_rows: files.iter().map(|f| f.row_count).sum(),
        total_hunks: files.iter().map(|f| f.hunks.len() as u64).sum(),
        additions: files.iter().map(|f| f.additions).sum(),
        deletions: files.iter().map(|f| f.deletions).sum(),
        patch_bytes,
        files,
        spool_path,
        complete,
    }
}

fn finish_hunk(file: &mut Option<IndexedFile>, hunk: &mut Option<IndexedHunk>, body_end: u64) {
    if let Some(file) = file.as_mut() {
        finish_hunk_in_file(file, hunk, body_end);
    }
}

fn finish_hunk_in_file(file: &mut IndexedFile, hunk: &mut Option<IndexedHunk>, body_end: u64) {
    if let Some(mut hunk) = hunk.take() {
        hunk.body_end = body_end;
        file.hunks.push(hunk);
    }
}

fn finish_file(files: &mut Vec<IndexedFile>, file: &mut Option<IndexedFile>) {
    if let Some(file) = file.take() {
        files.push(file);
    }
}

fn parse_file_header_bytes(rest: &[u8]) -> IndexedFile {
    let (old, new) = if rest.starts_with(b"\"") {
        parse_git_header_tokens(rest).unwrap_or_else(|| (rest.to_vec(), Vec::new()))
    } else {
        let split = rest.windows(3).rposition(|window| window == b" b/");
        match split {
            Some(index) => (rest[..index].to_vec(), rest[index + 1..].to_vec()),
            None => (rest.to_vec(), Vec::new()),
        }
    };
    let old = old.strip_prefix(b"a/").unwrap_or(&old);
    let new = new.strip_prefix(b"b/").unwrap_or(&new);
    let old_path = (!old.is_empty() && old != b"/dev/null").then(|| bytes_path(old));
    let new_path = (!new.is_empty() && new != b"/dev/null").then(|| bytes_path(new));
    let kind = match (old_path.is_some(), new_path.is_some()) {
        (false, true) => IndexedChangeKind::Added,
        (true, false) => IndexedChangeKind::Deleted,
        _ => IndexedChangeKind::Modified,
    };
    IndexedFile {
        old_path,
        new_path,
        old_oid: None,
        new_oid: None,
        kind,
        is_binary: false,
        hunks: Vec::new(),
        row_count: 1,
        additions: 0,
        deletions: 0,
    }
}

fn parse_index_oids(input: &[u8]) -> Option<(Option<String>, Option<String>)> {
    let token = input.split(|byte| byte.is_ascii_whitespace()).next()?;
    let separator = token.windows(2).position(|window| window == b"..")?;
    let old = &token[..separator];
    let new = &token[separator + 2..];
    let parse = |value: &[u8]| {
        (!value.is_empty()
            && value.iter().all(u8::is_ascii_hexdigit)
            && value.iter().any(|byte| *byte != b'0'))
        .then(|| String::from_utf8_lossy(value).into_owned())
    };
    Some((parse(old), parse(new)))
}

fn parse_git_header_tokens(input: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let (old, consumed) = parse_git_token(input)?;
    let remainder = input.get(consumed..)?;
    let spaces = remainder.iter().take_while(|byte| **byte == b' ').count();
    let (new, _) = parse_git_token(remainder.get(spaces..)?)?;
    Some((old, new))
}

fn parse_git_token(input: &[u8]) -> Option<(Vec<u8>, usize)> {
    if input.first() != Some(&b'"') {
        let end = input
            .iter()
            .position(|byte| *byte == b' ')
            .unwrap_or(input.len());
        return Some((input[..end].to_vec(), end));
    }
    let mut output = Vec::new();
    let mut cursor = 1;
    while cursor < input.len() {
        match input[cursor] {
            b'"' => return Some((output, cursor + 1)),
            b'\\' if cursor + 1 < input.len() => {
                cursor += 1;
                match input[cursor] {
                    b'n' => output.push(b'\n'),
                    b'r' => output.push(b'\r'),
                    b't' => output.push(b'\t'),
                    b'b' => output.push(8),
                    b'f' => output.push(12),
                    b'v' => output.push(11),
                    b'\\' => output.push(b'\\'),
                    b'"' => output.push(b'"'),
                    digit @ b'0'..=b'7' => {
                        let mut value = (digit - b'0') as u16;
                        let mut count = 1;
                        while count < 3
                            && cursor + 1 < input.len()
                            && matches!(input[cursor + 1], b'0'..=b'7')
                        {
                            cursor += 1;
                            value = value * 8 + (input[cursor] - b'0') as u16;
                            count += 1;
                        }
                        output.push(value as u8);
                    }
                    escaped => output.push(escaped),
                }
            }
            byte => output.push(byte),
        }
        cursor += 1;
    }
    None
}

fn parse_hunk_header_bytes(line: &[u8]) -> Result<IndexedHunk, IndexError> {
    let text = String::from_utf8_lossy(line).into_owned();
    let after = text
        .strip_prefix("@@")
        .ok_or_else(|| IndexError::HunkHeader(text.clone()))?;
    let (body, heading) = after
        .split_once("@@")
        .ok_or_else(|| IndexError::HunkHeader(text.clone()))?;
    let (old, new) = body
        .trim()
        .split_once(' ')
        .ok_or_else(|| IndexError::HunkHeader(text.clone()))?;
    let (old_start, old_lines) = parse_range(old.trim_start_matches('-'), &text)?;
    let (new_start, new_lines) = parse_range(new.trim_start_matches('+'), &text)?;
    Ok(IndexedHunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        heading: heading.trim().to_string(),
        row_start: 0,
        line_count: 0,
        body_offset: 0,
        body_end: 0,
        checkpoints: Vec::new(),
    })
}

fn parse_range(range: &str, header: &str) -> Result<(u32, u32), IndexError> {
    let (start, lines) = range.split_once(',').unwrap_or((range, "1"));
    let start = start
        .parse()
        .map_err(|_| IndexError::HunkHeader(header.to_string()))?;
    let lines = lines
        .parse()
        .map_err(|_| IndexError::HunkHeader(header.to_string()))?;
    Ok((start, lines))
}

fn bytes_path(bytes: &[u8]) -> PathBuf {
    let bytes = trim_ascii(bytes);
    let decoded = parse_git_token(bytes)
        .filter(|(_, consumed)| *consumed == bytes.len())
        .map(|(decoded, _)| decoded);
    PathBuf::from(String::from_utf8_lossy(decoded.as_deref().unwrap_or(bytes)).into_owned())
}

fn diff_marker_path(bytes: &[u8], prefix: &[u8]) -> PathBuf {
    let bytes = trim_ascii(bytes);
    let decoded = parse_git_token(bytes)
        .filter(|(_, consumed)| *consumed == bytes.len())
        .map(|(decoded, _)| decoded);
    let decoded = decoded.as_deref().unwrap_or(bytes);
    bytes_path(decoded.strip_prefix(prefix).unwrap_or(decoded))
}

fn trim_ascii(mut bytes: &[u8]) -> &[u8] {
    while matches!(bytes.first(), Some(b' ' | b'\t')) {
        bytes = &bytes[1..];
    }
    while matches!(bytes.last(), Some(b' ' | b'\t')) {
        bytes = &bytes[..bytes.len() - 1];
    }
    bytes
}

fn trim_line_ending(bytes: &mut Vec<u8>) {
    while matches!(bytes.last(), Some(b'\n' | b'\r')) {
        bytes.pop();
    }
}

fn next_generation() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0)
}

fn cleanup_stale_spools(cache_dir: &Path, keep_generation: u64) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    let keep_generation = keep_generation.to_string();
    let mut complete = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with(&keep_generation) {
            continue;
        }
        if name.ends_with(".patch.tmp") {
            let _ = fs::remove_file(path);
        } else if name.ends_with(".patch") {
            complete.push(path);
        }
    }
    complete.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for stale in complete.into_iter().skip(1) {
        let _ = fs::remove_file(stale);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn indexed(patch: &[u8]) -> (tempfile::TempDir, DiffIndex) {
        let dir = tempfile::tempdir().unwrap();
        let spool = dir.path().join("test.patch");
        let mut index = build_index_from_reader(Cursor::new(patch), &spool, 7, |_| {}).unwrap();
        index.complete = true;
        (dir, index)
    }

    #[test]
    fn indexes_and_pages_visible_rows() {
        let patch = b"diff --git a/a.rs b/a.rs\nindex 1..2 100644\n--- a/a.rs\n+++ b/a.rs\n@@ -1,2 +1,2 @@ fn a\n-old\n+new\n same\n";
        let (_dir, index) = indexed(patch);
        assert_eq!(index.files.len(), 1);
        assert_eq!(index.total_hunks, 1);
        assert_eq!(index.additions, 1);
        assert_eq!(index.deletions, 1);
        assert_eq!(index.files[0].row_count, 5);
        assert_eq!(index.files[0].old_oid.as_deref(), Some("1"));
        assert_eq!(index.files[0].new_oid.as_deref(), Some("2"));
        let page = index.viewport(0, 1, 2, 4096).unwrap();
        assert_eq!(page.rows.len(), 2);
        assert!(matches!(page.rows[0], ViewRow::HunkHeader { .. }));
        assert!(matches!(
            page.rows[1],
            ViewRow::Line {
                kind: IndexedLineKind::Del,
                old_lineno: Some(1),
                ..
            }
        ));
        let serialized = serde_json::to_value(&page.rows[1]).unwrap();
        assert!(serialized.get("oldLineno").is_some());
        assert!(serialized.get("old_lineno").is_none());
        assert_eq!(page.next_row, Some(3));
    }

    #[test]
    fn binary_index_keeps_side_existence_and_blob_ids() {
        let patch = b"diff --git a/new.png b/new.png\nnew file mode 100644\nindex 0000000..abc1234\nBinary files /dev/null and b/new.png differ\ndiff --git a/old.png b/old.png\ndeleted file mode 100644\nindex def5678..0000000\nBinary files a/old.png and /dev/null differ\n";
        let (_dir, index) = indexed(patch);

        assert_eq!(index.files[0].kind, IndexedChangeKind::Added);
        assert!(index.files[0].is_binary);
        assert_eq!(index.files[0].old_oid, None);
        assert_eq!(index.files[0].new_oid.as_deref(), Some("abc1234"));
        assert_eq!(index.files[1].kind, IndexedChangeKind::Deleted);
        assert!(index.files[1].is_binary);
        assert_eq!(index.files[1].old_oid.as_deref(), Some("def5678"));
        assert_eq!(index.files[1].new_oid, None);
    }

    #[test]
    fn sparse_checkpoint_keeps_line_numbers_correct() {
        let mut patch = b"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,400 +1,400 @@\n".to_vec();
        for line in 0..400 {
            patch.extend_from_slice(format!(" line-{line}\n").as_bytes());
        }
        let (_dir, index) = indexed(&patch);
        let page = index.viewport(0, 302, 1, 4096).unwrap();
        assert!(matches!(
            &page.rows[0],
            ViewRow::Line { old_lineno: Some(301), new_lineno: Some(301), content, .. }
                if content == "line-300"
        ));
        assert!(index.files[0].hunks[0].checkpoints.len() >= 4);
    }

    #[test]
    fn viewport_finds_a_late_hunk_without_starting_from_the_first() {
        let mut patch = b"diff --git a/a b/a\n--- a/a\n+++ b/a\n".to_vec();
        for line in 1..=1_000 {
            patch
                .extend_from_slice(format!("@@ -{line},1 +{line},1 @@\n line-{line}\n").as_bytes());
        }
        let (_dir, index) = indexed(&patch);
        let hunks = &index.files[0].hunks;
        let target = 900;
        let row = hunks[target].row_start;

        assert_eq!(first_intersecting_hunk(hunks, row), target);
        let page = index.viewport(0, row, 2, 4_096).unwrap();
        assert!(
            matches!(page.rows[0], ViewRow::HunkHeader { hunk_index, .. } if hunk_index == target)
        );
        assert!(matches!(&page.rows[1], ViewRow::Line { content, .. } if content == "line-901"));
    }

    #[test]
    fn viewport_honors_byte_budget() {
        let patch =
            b"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n first\n second\n third\n";
        let (_dir, index) = indexed(patch);
        let page = index.viewport(0, 2, 10, 40).unwrap();
        assert!(page.truncated);
        assert!(page.rows.len() < 3);
        assert!(page.next_row.is_some());
    }

    #[test]
    fn render_viewport_caps_pathological_lines_without_losing_rows() {
        let mut patch = b"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n+".to_vec();
        patch.extend(std::iter::repeat(b'x').take(128 * 1024));
        patch.extend_from_slice(b"\n+tail\n");
        let (_dir, index) = indexed(&patch);

        let bounded = index
            .viewport_for_render(0, 2, 2, 256 * 1024, 1_024)
            .unwrap();
        assert_eq!(bounded.rows.len(), 2);
        assert!(matches!(
            &bounded.rows[0],
            ViewRow::Line { content, .. } if content.len() <= 1_024
        ));
        assert!(matches!(
            &bounded.rows[1],
            ViewRow::Line { content, .. } if content == "tail"
        ));

        let exact = index.viewport(0, 2, 1, 256 * 1024).unwrap();
        assert!(matches!(
            &exact.rows[0],
            ViewRow::Line { content, .. } if content.len() == 128 * 1024
        ));
    }

    #[test]
    fn non_utf8_content_is_indexed_without_rejecting_patch() {
        let mut patch = b"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-".to_vec();
        patch.extend_from_slice(&[0xff, b'\n', b'+', 0xfe, b'\n']);
        let (_dir, index) = indexed(&patch);
        let page = index.viewport(0, 0, 10, 4096).unwrap();
        assert_eq!(page.rows.len(), 4);
        assert!(
            matches!(&page.rows[2], ViewRow::Line { content, .. } if content.contains('\u{fffd}'))
        );
    }

    #[test]
    fn decodes_git_quoted_paths_without_loading_file_content() {
        let patch = b"diff --git \"a/a\\tb.txt\" \"b/a\\tb.txt\"\n--- \"a/a\\tb.txt\"\n+++ \"b/a\\tb.txt\"\n@@ -1 +1 @@\n-old\n+new\n";
        let (_dir, index) = indexed(patch);
        assert_eq!(index.files[0].display_path(), Path::new("a\tb.txt"));
    }

    #[test]
    fn partial_snapshots_are_usable_for_single_huge_file() {
        let mut patch = b"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,9000 +1,9000 @@\n".to_vec();
        for _ in 0..9000 {
            patch.extend_from_slice(b" line\n");
        }
        let dir = tempfile::tempdir().unwrap();
        let spool = dir.path().join("test.patch");
        let mut snapshots = Vec::new();
        let _ = build_index_from_reader(Cursor::new(patch), &spool, 9, |snapshot| {
            snapshots.push(snapshot)
        })
        .unwrap();
        assert!(!snapshots.is_empty());
        assert_eq!(snapshots[0].files.len(), 1);
        assert!(snapshots[0].files[0].row_count >= SNAPSHOT_ROW_INTERVAL);
        assert!(!snapshots[0].complete);
    }

    #[test]
    fn search_is_bounded_and_cursor_addressable() {
        let patch = b"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n alpha\n needle one\n needle two\n";
        let (_dir, index) = indexed(patch);
        let page = index.search_literal("needle", 0, 0, 1, 4096).unwrap();
        assert_eq!(page.hits.len(), 1);
        assert!(page.truncated);
        assert_eq!(page.hits[0].new_lineno, Some(2));
        assert!(page.next_row.is_some());
    }

    #[test]
    fn git_diff_index_uses_safe_diff_flags() {
        let repo = tempfile::tempdir().unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
        Command::new("git")
            .args(["config", "user.email", "t@example.com"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "test"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        std::fs::write(repo.path().join(".gitattributes"), "*.txt diff=mock\n").unwrap();
        std::fs::write(repo.path().join("secret.txt"), "PLAIN\n").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(repo.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        std::fs::write(repo.path().join("secret.txt"), "PLAIN\nCHANGED\n").unwrap();
        // A textconv filter would replace every character with X when enabled.
        Command::new("git")
            .args(["config", "diff.mock.textconv", "sed 's/./X/g'"])
            .current_dir(repo.path())
            .status()
            .unwrap();

        let root = repo.path().to_string_lossy().into_owned();
        let index = build_git_diff_index(&root, &[], |_| {}).unwrap();
        assert_eq!(index.files.len(), 1);
        let patch = std::fs::read_to_string(&index.spool_path).unwrap();
        assert!(
            patch.contains("CHANGED"),
            "expected raw file content, not textconv-transformed output: {patch}"
        );
        assert!(
            !patch.contains("XXXX"),
            "textconv filter must not run when building the diff index: {patch}"
        );
        let _ = std::fs::remove_dir_all(crate::project_storage_dir(&root));
    }

    #[test]
    fn default_git_index_streams_untracked_files() {
        let repo = tempfile::tempdir().unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
        std::fs::write(repo.path().join("new.txt"), "first\nsecond\n").unwrap();
        let root = repo.path().to_string_lossy().into_owned();
        let index = build_git_diff_index(&root, &[], |_| {}).unwrap();
        assert_eq!(index.files.len(), 1);
        assert_eq!(index.files[0].display_path(), Path::new("new.txt"));
        assert_eq!(index.files[0].kind, IndexedChangeKind::Untracked);
        assert_eq!(index.files[0].additions, 2);
        let _ = std::fs::remove_dir_all(crate::project_storage_dir(&root));
    }
}
