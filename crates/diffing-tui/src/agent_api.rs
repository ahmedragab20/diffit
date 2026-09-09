//! Capability-scoped loopback API for headless agents.
//!
//! This intentionally serves small, paginated views backed by the same sparse
//! index as the TUI.  It is not a second diff engine and never binds beyond
//! loopback.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::inspect_scope::{
    directories, display_path, is_lockfile_noise, matching_indexes, parse_exclude, resolve_file,
    FileResolve,
};
use anyhow::{Context, Result};
use diffing_core::comments::{
    CommentSeverity, CommentSide, CommentStatus, FileCommentStore, NewComment,
};
use diffing_core::index::DiffIndex;
use serde_json::{json, Value};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_PAGE_LINES: usize = 1_000;
const MAX_CONCURRENT_CONNECTIONS: usize = 32;

#[derive(Clone)]
pub struct AgentApi {
    pub port: u16,
    pub capability: String,
    review: Arc<(Mutex<ReviewState>, Condvar)>,
    shutdown: Arc<Mutex<Option<mpsc::Sender<()>>>>,
}

impl Drop for AgentApi {
    fn drop(&mut self) {
        if Arc::strong_count(&self.shutdown) == 1 {
            if let Ok(mut guard) = self.shutdown.lock() {
                if let Some(shutdown) = guard.take() {
                    let _ = shutdown.send(());
                }
            }
        }
    }
}

#[derive(Default)]
struct ReviewState {
    round: u32,
    payload: Option<String>,
    waiters: u32,
}

struct ApiState {
    capability: String,
    repo_root: String,
    index: Arc<RwLock<Arc<DiffIndex>>>,
    review: Arc<(Mutex<ReviewState>, Condvar)>,
}

impl AgentApi {
    pub fn start(repo_root: String, index: Arc<RwLock<Arc<DiffIndex>>>) -> Result<Self> {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).context("binding TUI agent API to loopback")?;
        let port = listener.local_addr()?.port();
        let capability = new_capability()?;
        let review = Arc::new((Mutex::new(ReviewState::default()), Condvar::new()));
        let state = Arc::new(ApiState {
            capability: capability.clone(),
            repo_root,
            index,
            review: review.clone(),
        });
        let connection_slots = Arc::new(Mutex::new(0usize));
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let shutdown = Arc::new(Mutex::new(Some(shutdown_tx)));
        listener
            .set_nonblocking(true)
            .context("configuring TUI agent API listener")?;
        thread::Builder::new()
            .name("diffing-agent-api".to_string())
            .spawn(move || loop {
                if shutdown_rx.try_recv().is_ok() {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let state = state.clone();
                        let slots = connection_slots.clone();
                        let mut guard = match slots.lock() {
                            Ok(guard) => guard,
                            Err(_) => continue,
                        };
                        if *guard >= MAX_CONCURRENT_CONNECTIONS {
                            continue;
                        }
                        *guard += 1;
                        drop(guard);
                        let slots_for_handler = connection_slots.clone();
                        let spawned = thread::Builder::new()
                            .name("diffing-agent-request".to_string())
                            .spawn(move || {
                                let _ = handle_connection(stream, &state);
                                if let Ok(mut guard) = slots_for_handler.lock() {
                                    *guard = guard.saturating_sub(1);
                                }
                            });
                        if spawned.is_err() {
                            if let Ok(mut guard) = connection_slots.lock() {
                                *guard = guard.saturating_sub(1);
                            }
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            })?;
        Ok(Self {
            port,
            capability,
            review,
            shutdown,
        })
    }

    pub fn release_review(&self, payload: String) -> u32 {
        let (lock, wake) = &*self.review;
        let mut state = lock.lock().expect("review state poisoned");
        state.round = state.round.saturating_add(1);
        state.payload = Some(payload);
        let round = state.round;
        wake.notify_all();
        round
    }

    pub fn waiter_count(&self) -> u32 {
        self.review.0.lock().map(|state| state.waiters).unwrap_or(0)
    }
}

fn handle_connection(mut stream: TcpStream, state: &ApiState) -> Result<()> {
    // Accepted sockets inherit the listener's O_NONBLOCK.  A WouldBlock on the
    // first read used to drop the connection with no HTTP response.
    stream
        .set_nonblocking(false)
        .context("configuring TUI agent API connection")?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let request = read_request(&mut stream)?;
    let authorized = request
        .headers
        .get("x-diffing-capability")
        .is_some_and(|value| constant_time_eq(value, &state.capability));
    if !authorized {
        return write_json(
            &mut stream,
            401,
            json!({ "error": "invalid TUI session capability" }),
        );
    }
    let (path, query) = split_target(&request.target);
    let params = parse_query(query);
    let response = route(&request.method, path, &params, &request.body, state);
    match response {
        Ok((status, body)) => write_json(&mut stream, status, body),
        Err(error) => {
            let message = error.to_string();
            let status = if message.starts_with("stale generation ") {
                409
            } else {
                500
            };
            write_json(&mut stream, status, json!({ "error": message }))
        }
    }
}

fn route(
    method: &str,
    path: &str,
    params: &HashMap<String, String>,
    body: &[u8],
    state: &ApiState,
) -> Result<(u16, Value)> {
    if method == "GET" && path == "/api/diff/summary" {
        let index = current_index(state);
        let exclude = match parse_exclude(params.get("exclude").map(String::as_str)) {
            Ok(value) => value,
            Err(error) => return Ok((400, json!({ "error": error }))),
        };
        let skip_lockfiles = exclude.iter().any(|value| value == "lockfiles");
        let mut changes: HashMap<String, usize> = HashMap::new();
        let mut files = 0usize;
        let mut hunks = 0usize;
        let mut rows = 0u64;
        let mut additions = 0u64;
        let mut deletions = 0u64;
        for file in &index.files {
            if skip_lockfiles && is_lockfile_noise(&display_path(file)) {
                continue;
            }
            files += 1;
            hunks += file.hunks.len();
            rows += file.row_count;
            additions += file.additions;
            deletions += file.deletions;
            *changes
                .entry(format!("{:?}", file.kind).to_lowercase())
                .or_default() += 1;
        }
        let mut body = json!({
            "generation": index.generation,
            "complete": index.complete,
            "files": files,
            "hunks": hunks,
            "rows": rows,
            "additions": additions,
            "deletions": deletions,
            "patchBytes": index.patch_bytes,
            "changes": changes,
            "directories": directories(&index.files, skip_lockfiles),
            "next": ["diff_files", "diff_search", "diff_slice"]
        });
        if !exclude.is_empty() {
            body["exclude"] = json!(exclude);
        }
        return Ok((200, body));
    }
    if method == "GET" && path == "/api/diff/files" {
        let index = current_index(state);
        let matched_indexes = match matching_indexes(&index, params.get("path").map(String::as_str))
        {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let cursor = usize_param(params, "cursor", 0);
        let limit = usize_param(params, "limit", 100).clamp(1, MAX_PAGE_LINES);
        let start = cursor.min(matched_indexes.len());
        let end = start.saturating_add(limit).min(matched_indexes.len());
        let files: Vec<Value> = matched_indexes[start..end]
            .iter()
            .map(|&file_index| {
                let file = &index.files[file_index];
                json!({
                    "index": file_index,
                    "path": display_path(file),
                    "oldPath": file.old_path,
                    "newPath": file.new_path,
                    "kind": file.kind,
                    "binary": file.is_binary,
                    "hunks": file.hunks.len(),
                    "rows": file.row_count,
                    "additions": file.additions,
                    "deletions": file.deletions,
                })
            })
            .collect();
        let mut body = json!({
            "generation": index.generation,
            "returned": files.len(),
            "total": index.files.len(),
            "matched": matched_indexes.len(),
            "nextCursor": (end < matched_indexes.len()).then_some(end),
            "files": files,
        });
        if let Some(path) = params.get("path") {
            if !path.is_empty() {
                body["path"] = json!(path);
            }
        }
        return Ok((200, body));
    }
    if method == "GET" && path == "/api/diff/hunks" {
        let index = current_index(state);
        generation_guard(params, &index)?;
        let file_index = match resolve_file(
            &index,
            optional_usize(params, "file"),
            params.get("path").map(String::as_str),
        ) {
            FileResolve::Index(value) => value,
            FileResolve::Error { status, body } => return Ok((status, body)),
        };
        let Some(file) = index.files.get(file_index) else {
            return Ok((404, json!({ "error": "file index not found" })));
        };
        let cursor = usize_param(params, "cursor", 0).min(file.hunks.len());
        let limit = usize_param(params, "limit", 100).clamp(1, MAX_PAGE_LINES);
        let end = cursor.saturating_add(limit).min(file.hunks.len());
        return Ok((
            200,
            json!({
                "generation": index.generation,
                "file": file_index,
                "path": display_path(file),
                "returned": end - cursor,
                "total": file.hunks.len(),
                "nextCursor": (end < file.hunks.len()).then_some(end),
                "hunks": &file.hunks[cursor..end],
            }),
        ));
    }
    if method == "GET" && path == "/api/diff/slice" {
        let index = current_index(state);
        generation_guard(params, &index)?;
        let file = match resolve_file(
            &index,
            optional_usize(params, "file"),
            params.get("path").map(String::as_str),
        ) {
            FileResolve::Index(value) => value,
            FileResolve::Error { status, body } => return Ok((status, body)),
        };
        let start = u64_param(params, "start", 0);
        let max_lines = usize_param(params, "maxLines", 120).clamp(1, MAX_PAGE_LINES);
        let max_bytes = usize_param(params, "maxBytes", 256 * 1024).clamp(1, MAX_BODY_BYTES);
        let viewport = index.viewport(file, start, max_lines, max_bytes)?;
        return Ok((200, serde_json::to_value(viewport)?));
    }
    if method == "GET" && path == "/api/diff/search" {
        let index = current_index(state);
        generation_guard(params, &index)?;
        let query = params.get("q").map(String::as_str).unwrap_or("");
        let file = usize_param(params, "file", 0);
        let row = u64_param(params, "row", 0);
        let limit = usize_param(params, "limit", 100).clamp(1, MAX_PAGE_LINES);
        let max_bytes = usize_param(params, "maxBytes", 256 * 1024).clamp(1, MAX_BODY_BYTES);
        let allowed: HashSet<usize> =
            match matching_indexes(&index, params.get("path").map(String::as_str)) {
                Ok(indexes) => indexes.into_iter().collect(),
                Err(response) => return Ok(response),
            };
        let page =
            index.search_literal_filtered(query, file, row, limit, max_bytes, Some(&allowed))?;
        return Ok((200, serde_json::to_value(page)?));
    }
    let store = FileCommentStore::new(&state.repo_root);
    if method == "GET" && path == "/api/comments" {
        return Ok((200, serde_json::to_value(store.load()?)?));
    }
    if method == "POST" && path == "/api/comments" {
        let value = match parse_json_body(body) {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let file_path = value.get("filePath").and_then(Value::as_str).unwrap_or("");
        let line_number = match optional_u32_field(&value, "lineNumber") {
            Ok(value) => value.unwrap_or(0),
            Err(response) => return Ok(response),
        };
        let start_line_number = match optional_u32_field(&value, "startLineNumber") {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let comment_body = value.get("body").and_then(Value::as_str).unwrap_or("");
        if file_path.is_empty() || comment_body.trim().is_empty() {
            return Ok((400, json!({ "error": "filePath and body are required" })));
        }
        let side = if value.get("side").and_then(Value::as_str) == Some("deletions") {
            CommentSide::Deletions
        } else {
            CommentSide::Additions
        };
        let severity = match value.get("severity").and_then(Value::as_str) {
            Some("blocking") => Some(CommentSeverity::Blocking),
            Some("nit") => Some(CommentSeverity::Nit),
            Some("question") => Some(CommentSeverity::Question),
            Some("praise") => Some(CommentSeverity::Praise),
            _ => None,
        };
        let new_comment = if line_number == 0 {
            NewComment::FileLevel {
                file_path,
                body: comment_body,
                severity,
            }
        } else {
            NewComment::Inline {
                file_path,
                side,
                start_line_number,
                line_number,
                line_content: value
                    .get("lineContent")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                body: comment_body,
                severity,
            }
        };
        let comment = store.add(new_comment, now_ms())?;
        return Ok((200, serde_json::to_value(comment)?));
    }
    if let Some(id) = path.strip_prefix("/api/comments/") {
        if let Some(id) = id.strip_suffix("/replies") {
            if method == "POST" {
                let value = match parse_json_body(body) {
                    Ok(value) => value,
                    Err(response) => return Ok(response),
                };
                let reply = store.add_reply(
                    id,
                    value.get("body").and_then(Value::as_str).unwrap_or(""),
                    value.get("role").and_then(Value::as_str),
                    value.get("model").and_then(Value::as_str),
                    now_ms(),
                )?;
                return Ok((
                    if reply.is_some() { 200 } else { 404 },
                    serde_json::to_value(reply)?,
                ));
            }
        } else if method == "PUT" {
            let value = match parse_json_body(body) {
                Ok(value) => value,
                Err(response) => return Ok(response),
            };
            let status = match value.get("status").and_then(Value::as_str) {
                Some("resolved") => Some(CommentStatus::Resolved),
                Some("open") => Some(CommentStatus::Open),
                _ => None,
            };
            let updated = store.update(id, value.get("body").and_then(Value::as_str), status)?;
            return Ok((
                if updated.is_some() { 200 } else { 404 },
                serde_json::to_value(updated)?,
            ));
        } else if method == "DELETE" {
            let removed = store.remove(id)?;
            return Ok((
                if removed { 200 } else { 404 },
                json!({ "removed": removed }),
            ));
        }
    }
    if method == "GET" && path == "/api/review/status" {
        let review = state.review.0.lock().expect("review state poisoned");
        return Ok((
            200,
            json!({ "round": review.round, "waiters": review.waiters }),
        ));
    }
    if method == "GET" && path == "/api/review/await" {
        let since = u32_param(params, "sinceRound", 0);
        let timeout = u64_param(params, "timeoutMs", 25_000).clamp(1, 30_000);
        let (lock, wake) = &*state.review;
        let mut review = lock.lock().expect("review state poisoned");
        review.waiters = review.waiters.saturating_add(1);
        if review.round <= since {
            let result = wake
                .wait_timeout(review, Duration::from_millis(timeout))
                .expect("review state poisoned");
            review = result.0;
        }
        review.waiters = review.waiters.saturating_sub(1);
        if review.round > since {
            return Ok((
                200,
                json!({
                    "status": "released",
                    "payload": { "round": review.round, "commentXml": review.payload.clone().unwrap_or_default() }
                }),
            ));
        }
        return Ok((200, json!({ "status": "timeout", "round": review.round })));
    }
    Ok((404, json!({ "error": "unknown TUI API route" })))
}

fn current_index(state: &ApiState) -> Arc<DiffIndex> {
    state.index.read().expect("index state poisoned").clone()
}

fn generation_guard(params: &HashMap<String, String>, index: &DiffIndex) -> Result<()> {
    if let Some(generation) = params
        .get("generation")
        .and_then(|value| value.parse::<u64>().ok())
    {
        anyhow::ensure!(
            generation == index.generation,
            "stale generation {generation}; current generation is {}",
            index.generation
        );
    }
    Ok(())
}

struct Request {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<Request> {
    let mut bytes = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk)?;
        anyhow::ensure!(read > 0, "client closed before sending headers");
        bytes.extend_from_slice(&chunk[..read]);
        anyhow::ensure!(bytes.len() <= MAX_HEADER_BYTES, "request headers too large");
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers_text = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = headers_text.split("\r\n");
    let request_line = lines.next().context("missing HTTP request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().context("missing HTTP method")?.to_string();
    let target = parts.next().context("missing HTTP target")?.to_string();
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    anyhow::ensure!(content_length <= MAX_BODY_BYTES, "request body too large");
    while bytes.len() - header_end < content_length {
        let read = stream.read(&mut chunk)?;
        anyhow::ensure!(read > 0, "client closed before request body completed");
        bytes.extend_from_slice(&chunk[..read]);
    }
    Ok(Request {
        method,
        target,
        headers,
        body: bytes[header_end..header_end + content_length].to_vec(),
    })
}

fn write_json(stream: &mut TcpStream, status: u16, body: Value) -> Result<()> {
    let bytes = serde_json::to_vec(&body)?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Internal Server Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    )?;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}

fn split_target(target: &str) -> (&str, &str) {
    target.split_once('?').unwrap_or((target, ""))
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' => {
                let hex = match bytes.get(index + 1..index + 3) {
                    Some(slice) => std::str::from_utf8(slice).ok(),
                    None => None,
                };
                if let Some(hex) = hex {
                    if let Ok(byte) = u8::from_str_radix(hex, 16) {
                        decoded.push(byte);
                        index += 3;
                        continue;
                    }
                }
                decoded.push(bytes[index]);
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left_byte, right_byte) in left.bytes().zip(right.bytes()) {
        diff |= left_byte ^ right_byte;
    }
    diff == 0
}

fn usize_param(params: &HashMap<String, String>, name: &str, default: usize) -> usize {
    params
        .get(name)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn optional_usize(params: &HashMap<String, String>, name: &str) -> Option<usize> {
    params.get(name).and_then(|value| value.parse().ok())
}

fn u64_param(params: &HashMap<String, String>, name: &str, default: u64) -> u64 {
    params
        .get(name)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn u32_param(params: &HashMap<String, String>, name: &str, default: u32) -> u32 {
    params
        .get(name)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn parse_json_body(body: &[u8]) -> Result<Value, (u16, Value)> {
    serde_json::from_slice(body).map_err(|error| {
        (
            400,
            json!({ "error": format!("invalid JSON body: {error}") }),
        )
    })
}

fn optional_u32_field(value: &Value, field: &str) -> Result<Option<u32>, (u16, Value)> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(number) => number
            .as_u64()
            .ok_or_else(|| {
                (
                    400,
                    json!({ "error": format!("{field} must be a non-negative integer") }),
                )
            })
            .and_then(|line| {
                u32::try_from(line)
                    .map_err(|_| (400, json!({ "error": format!("{field} out of range") })))
            })
            .map(Some),
    }
}

fn new_capability() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| anyhow::anyhow!("generating TUI session capability: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn query_decoder_handles_spaces_multibyte_and_percent_encoding() {
        let params = parse_query("q=hello+world%21&limit=10");
        assert_eq!(params.get("q").map(String::as_str), Some("hello world!"));
        assert_eq!(usize_param(&params, "limit", 1), 10);

        let adversarial = parse_query("q=%E2%82%AC&broken=%E");
        assert_eq!(adversarial.get("q").map(String::as_str), Some("€"));
        assert_eq!(adversarial.get("broken").map(String::as_str), Some("%E"));
    }

    #[test]
    fn constant_time_capability_compare_matches_equal_values() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }

    #[test]
    fn capabilities_are_full_width_and_unique() {
        let first = new_capability().unwrap();
        let second = new_capability().unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn malformed_comment_json_returns_400() {
        let index = Arc::new(DiffIndex::empty(1, PathBuf::from("/tmp/repo"), true));
        let shared = Arc::new(RwLock::new(index));
        let state = ApiState {
            repo_root: "/tmp/repo".to_string(),
            index: shared,
            capability: "cap".to_string(),
            review: Arc::new((Mutex::new(ReviewState::default()), Condvar::new())),
        };
        let (status, body) = route(
            "POST",
            "/api/comments",
            &HashMap::new(),
            b"{not json",
            &state,
        )
        .unwrap();
        assert_eq!(status, 400);
        assert!(body.get("error").is_some());
    }

    #[test]
    fn oversized_line_number_returns_400() {
        let index = Arc::new(DiffIndex::empty(1, PathBuf::from("/tmp/repo"), true));
        let shared = Arc::new(RwLock::new(index));
        let state = ApiState {
            repo_root: "/tmp/repo".to_string(),
            index: shared,
            capability: "cap".to_string(),
            review: Arc::new((Mutex::new(ReviewState::default()), Condvar::new())),
        };
        let payload = json!({
            "filePath": "a.rs",
            "lineNumber": u64::MAX,
            "body": "note"
        });
        let (status, body) = route(
            "POST",
            "/api/comments",
            &HashMap::new(),
            &serde_json::to_vec(&payload).unwrap(),
            &state,
        )
        .unwrap();
        assert_eq!(status, 400);
        assert!(body.get("error").is_some());
    }

    #[test]
    fn review_release_wakes_and_caches_round() {
        let review = Arc::new((Mutex::new(ReviewState::default()), Condvar::new()));
        let api = AgentApi {
            port: 1,
            capability: "test".to_string(),
            review: review.clone(),
            shutdown: Arc::new(Mutex::new(None)),
        };
        assert_eq!(api.release_review("<review/>".to_string()), 1);
        let state = review.0.lock().unwrap();
        assert_eq!(state.round, 1);
        assert_eq!(state.payload.as_deref(), Some("<review/>"));
    }

    #[test]
    fn inspect_path_and_file_are_mutually_exclusive() {
        let index = Arc::new(DiffIndex::empty(7, PathBuf::from("/tmp/repo"), true));
        let shared = Arc::new(RwLock::new(index));
        let state = ApiState {
            repo_root: "/tmp/repo".to_string(),
            index: shared,
            capability: "cap".to_string(),
            review: Arc::new((Mutex::new(ReviewState::default()), Condvar::new())),
        };
        let mut both = HashMap::new();
        both.insert("file".to_string(), "0".to_string());
        both.insert("path".to_string(), "src/a.ts".to_string());
        let (status, body) = route("GET", "/api/diff/slice", &both, b"", &state).unwrap();
        assert_eq!(status, 400);
        assert_eq!(
            body.get("error").and_then(Value::as_str),
            Some("path and file are mutually exclusive")
        );

        let mut missing = HashMap::new();
        missing.insert("path".to_string(), "src/a.ts".to_string());
        let (status, body) = route("GET", "/api/diff/hunks", &missing, b"", &state).unwrap();
        assert_eq!(status, 404);
        assert_eq!(
            body.get("error").and_then(Value::as_str),
            Some("path matched no files")
        );

        let mut files = HashMap::new();
        files.insert("path".to_string(), "src/**".to_string());
        let (status, body) = route("GET", "/api/diff/files", &files, b"", &state).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body.get("matched").and_then(Value::as_u64), Some(0));
        assert_eq!(body.get("total").and_then(Value::as_u64), Some(0));
        assert_eq!(body.get("path").and_then(Value::as_str), Some("src/**"));
    }

    #[test]
    fn loopback_api_requires_capability_and_returns_bounded_summary() {
        let index = Arc::new(DiffIndex::empty(42, PathBuf::from("unused"), true));
        let shared = Arc::new(RwLock::new(index));
        let api = AgentApi::start("/tmp/repo".to_string(), shared).unwrap();

        let authorized = raw_get(api.port, "/api/diff/summary", Some(api.capability.as_str()));
        assert!(authorized.starts_with("HTTP/1.1 200"), "{authorized}");
        assert!(authorized.contains("\"generation\":42"), "{authorized}");

        let denied = raw_get(api.port, "/api/diff/summary", None);
        assert!(denied.starts_with("HTTP/1.1 401"), "{denied}");
    }

    fn raw_get(port: u16, path: &str, capability: Option<&str>) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        // Pause after accept so the handler must wait for headers.  Without a
        // blocking socket this used to close the connection with an empty body.
        thread::sleep(Duration::from_millis(20));
        let capability = capability
            .map(|value| format!("X-Diffing-Capability: {value}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{capability}Connection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }
}
