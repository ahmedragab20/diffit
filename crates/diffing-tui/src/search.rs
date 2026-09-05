//! Client for the capability-scoped fff bridge owned by the Node launcher.
//!
//! The web UI and TUI intentionally share one search implementation and one
//! frecency database. Keeping the native fff binding in Node avoids shipping a
//! second platform-specific ABI while this small loopback client keeps the
//! Rust renderer self-contained.

use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use diffing_core::index::{DiffIndex, IndexedChangeKind, IndexedLineKind, ViewRow};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CAPABILITY_BYTES: usize = 256;
const MAX_SEARCH_HITS: usize = 80;
const MAX_PREVIEW_BYTES: usize = 2 * 1024 * 1024;
const BINARY_SAMPLE_BYTES: usize = 8 * 1024;
const SEARCH_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const SEARCH_READ_DEADLINE: Duration = Duration::from_secs(30);
const SEARCH_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const SEARCH_READ_CHUNK_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchScope {
    All,
    Files,
    Text,
    Symbols,
}

impl SearchScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Files => "Files",
            Self::Text => "Text",
            Self::Symbols => "Symbols",
        }
    }

    pub fn next(self, delta: isize) -> Self {
        let scopes = [Self::All, Self::Files, Self::Text, Self::Symbols];
        let index = scopes.iter().position(|scope| *scope == self).unwrap_or(0);
        scopes[(index as isize + delta).rem_euclid(scopes.len() as isize) as usize]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchHitKind {
    File,
    Text,
    Symbol,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub kind: SearchHitKind,
    pub path: String,
    pub line: Option<u32>,
    pub title: String,
    pub detail: String,
    pub git_status: String,
}

#[derive(Debug, Clone)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub total: Option<usize>,
    pub indexing: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchPreview {
    pub path: String,
    pub content: String,
    pub missing: bool,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolDefinition {
    pub name: String,
    pub kind: &'static str,
}

#[derive(Debug, Clone)]
pub struct SearchClient {
    host: String,
    port: u16,
    capability: String,
}

impl SearchClient {
    pub fn from_env() -> Option<Self> {
        let endpoint = std::env::var("DIFFING_TUI_SEARCH_ENDPOINT").ok()?;
        let capability = std::env::var("DIFFING_TUI_SEARCH_CAPABILITY").ok()?;
        Self::new(&endpoint, capability).ok()
    }

    pub fn new(endpoint: &str, capability: String) -> Result<Self> {
        if capability.is_empty()
            || capability.len() > MAX_CAPABILITY_BYTES
            || !capability.bytes().all(|byte| byte.is_ascii_graphic())
        {
            bail!("TUI search capability is invalid");
        }
        let authority = endpoint
            .strip_prefix("http://")
            .ok_or_else(|| anyhow!("TUI search endpoint must use http://"))?
            .trim_end_matches('/');
        let (host, port) = authority
            .rsplit_once(':')
            .ok_or_else(|| anyhow!("TUI search endpoint is missing a port"))?;
        if host != "127.0.0.1" && host != "localhost" {
            bail!("TUI search endpoint must be loopback");
        }
        let port = port.parse().context("invalid TUI search endpoint port")?;
        if port == 0 {
            bail!("TUI search endpoint port must be non-zero");
        }
        Ok(Self {
            host: host.to_string(),
            port,
            capability,
        })
    }

    pub fn search(
        &self,
        query: &str,
        scope: SearchScope,
        regex: bool,
        changed_paths: Option<&[String]>,
    ) -> Result<SearchResponse> {
        let value = self.post(
            "/search",
            json!({
                "scope": scope,
                "query": query,
                "limit": 80,
                "regex": regex,
                "changedPaths": changed_paths,
            }),
        )?;
        decode_response(value, scope)
    }

    pub fn preview(&self, path: &str) -> Result<SearchPreview> {
        let value = self.post("/preview", json!({ "path": path }))?;
        Ok(decode_preview(value, path))
    }

    pub fn track(&self, query: &str, path: &str) {
        let _ = self.post("/track", json!({ "query": query, "path": path }));
    }

    fn post(&self, path: &str, body: Value) -> Result<Value> {
        let body = serde_json::to_vec(&body)?;
        let address: SocketAddr = format!("{}:{}", self.host, self.port)
            .parse()
            .context("invalid fff search endpoint address")?;
        let mut stream = TcpStream::connect_timeout(&address, SEARCH_CONNECT_TIMEOUT)
            .context("connecting to fff search bridge")?;
        stream.set_write_timeout(Some(SEARCH_WRITE_TIMEOUT))?;
        write!(
            stream,
            "POST {path} HTTP/1.1\r\nHost: {}:{}\r\nX-Diffing-Capability: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.host,
            self.port,
            self.capability,
            body.len()
        )?;
        stream.write_all(&body)?;
        stream.flush()?;

        let deadline = Instant::now() + SEARCH_READ_DEADLINE;
        let mut response = Vec::new();
        let mut buffer = [0u8; 8192];
        while response.len() <= MAX_RESPONSE_BYTES {
            if Instant::now() >= deadline {
                bail!("fff search response timed out");
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            stream.set_read_timeout(Some(
                remaining
                    .min(SEARCH_READ_CHUNK_TIMEOUT)
                    .max(Duration::from_millis(1)),
            ))?;
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => response.extend_from_slice(&buffer[..count]),
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
                        && Instant::now() < deadline =>
                {
                    continue;
                }
                Err(error) => return Err(error.into()),
            }
        }
        if response.len() > MAX_RESPONSE_BYTES {
            bail!("fff search response is too large");
        }
        let header_end = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .ok_or_else(|| anyhow!("invalid response from fff search bridge"))?;
        let headers = String::from_utf8_lossy(&response[..header_end]);
        let status = headers
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(500);
        let payload = &response[header_end + 4..];
        let value: Value =
            serde_json::from_slice(payload).context("decoding response from fff search bridge")?;
        if !(200..300).contains(&status) {
            bail!(
                "{}",
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("fff search request failed")
            );
        }
        Ok(value)
    }
}

fn decode_response(value: Value, scope: SearchScope) -> Result<SearchResponse> {
    let total = value
        .get("total")
        .and_then(Value::as_u64)
        .and_then(|total| usize::try_from(total).ok());
    let indexing = value
        .get("indexing")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let error = value
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string);
    let notice = value
        .get("regexError")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map(|message| format!("invalid regex; searched literally: {message}"));
    let mut hits = Vec::new();
    for item in value
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_SEARCH_HITS)
    {
        let (kind, hit) = if scope == SearchScope::All {
            let kind = match item.get("kind").and_then(Value::as_str) {
                Some("text") => SearchHitKind::Text,
                Some("symbol") => SearchHitKind::Symbol,
                _ => SearchHitKind::File,
            };
            (kind, item.get("hit").unwrap_or(item))
        } else {
            (
                match scope {
                    SearchScope::Files => SearchHitKind::File,
                    SearchScope::Text => SearchHitKind::Text,
                    SearchScope::Symbols => SearchHitKind::Symbol,
                    SearchScope::All => SearchHitKind::File,
                },
                item,
            )
        };
        let Some(path) = hit.get("path").and_then(Value::as_str) else {
            continue;
        };
        let line = hit
            .get("line")
            .and_then(Value::as_u64)
            .and_then(|line| u32::try_from(line).ok());
        let content = hit
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let git_status = hit
            .get("gitStatus")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let title = match kind {
            SearchHitKind::File => hit
                .get("fileName")
                .and_then(Value::as_str)
                .or_else(|| path.rsplit('/').next())
                .unwrap_or(path)
                .to_string(),
            SearchHitKind::Text => content.clone(),
            SearchHitKind::Symbol => hit
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&content)
                .to_string(),
        };
        let detail = match (kind.clone(), line) {
            (SearchHitKind::File, _) => path
                .rsplit_once('/')
                .map(|(directory, _)| format!("{directory}/"))
                .unwrap_or_else(|| "./".to_string()),
            (SearchHitKind::Symbol, Some(line)) => {
                let symbol_kind = hit.get("kind").and_then(Value::as_str).unwrap_or("symbol");
                format!("{symbol_kind} · {path}:{line}")
            }
            (_, Some(line)) => format!("{path}:{line}"),
            _ => path.to_string(),
        };
        hits.push(SearchHit {
            kind,
            path: path.to_string(),
            line,
            title,
            detail,
            git_status,
        });
    }
    Ok(SearchResponse {
        hits,
        total,
        indexing,
        error,
        notice,
    })
}

/// Lightweight definition recognition shared by the TUI's changed-line
/// fallback. Repository-wide symbol search remains owned by the fff bridge;
/// this keeps Symbols useful while the query is empty or the bridge is absent.
pub fn classify_symbol_line(line: &str) -> Option<SymbolDefinition> {
    let line = line.trim_start();
    if line.is_empty() || line.starts_with("//") || line.starts_with('#') {
        return None;
    }

    let declaration = strip_declaration_modifiers(line);
    let function = strip_function_modifiers(declaration);
    for (keyword, kind) in [
        ("function", "function"),
        ("def", "function"),
        ("fn", "function"),
    ] {
        if let Some(rest) = after_keyword(function, keyword) {
            if let Some(name) = take_identifier(rest) {
                return Some(SymbolDefinition {
                    name: name.to_string(),
                    kind,
                });
            }
        }
    }

    // Go functions may place a receiver between `func` and the method name.
    if let Some(mut rest) = after_keyword(function, "func") {
        let is_method = rest.starts_with('(');
        if is_method {
            rest = rest.split_once(')')?.1.trim_start();
        }
        if let Some(name) = take_identifier(rest) {
            return Some(SymbolDefinition {
                name: name.to_string(),
                kind: if is_method { "method" } else { "function" },
            });
        }
    }

    let method = strip_method_modifiers(declaration);
    if let Some((prefix, suffix)) = method.split_once('(') {
        let prefix = prefix.trim();
        let name = prefix.split('<').next().unwrap_or(prefix).trim();
        let tail = suffix.split_once(')').map(|(_, tail)| tail.trim_start());
        let declaration_tail = tail.is_some_and(|tail| {
            tail.starts_with('{')
                || (tail.starts_with(':') && (tail.contains('{') || tail.ends_with(';')))
        });
        if declaration_tail
            && take_identifier(name) == Some(name)
            && !matches!(name, "if" | "for" | "while" | "switch" | "catch")
        {
            return Some(SymbolDefinition {
                name: name.to_string(),
                kind: "method",
            });
        }
    }

    for (keyword, kind) in [
        ("class", "class"),
        ("interface", "interface"),
        ("struct", "struct"),
        ("enum", "enum"),
        ("trait", "trait"),
        ("union", "union"),
        ("type", "type"),
        ("namespace", "namespace"),
        ("module", "module"),
        ("mod", "module"),
    ] {
        if let Some(rest) = after_keyword(declaration, keyword) {
            let name = if keyword == "namespace" {
                take_php_namespace(rest)
            } else {
                take_identifier(rest)
            };
            if let Some(name) = name {
                return Some(SymbolDefinition {
                    name: name.to_string(),
                    kind,
                });
            }
        }
    }

    if let Some(rest) = declaration
        .strip_prefix("impl")
        .filter(|rest| rest.starts_with(char::is_whitespace) || rest.starts_with('<'))
        .map(str::trim_start)
    {
        let rest = if rest.starts_with('<') {
            rest.split_once('>')?.1.trim_start()
        } else {
            rest
        };
        let target = rest
            .split_once(" for ")
            .map(|(_, target)| target)
            .unwrap_or(rest)
            .trim_start();
        let target = target
            .split(|character: char| character.is_whitespace() || matches!(character, '<' | '{'))
            .next()
            .unwrap_or(target);
        let name = target.rsplit("::").next().and_then(take_identifier);
        if let Some(name) = name {
            return Some(SymbolDefinition {
                name: name.to_string(),
                kind: "impl",
            });
        }
    }

    for keyword in ["const", "let", "var", "static"] {
        if let Some(rest) = after_keyword(declaration, keyword) {
            let name = take_identifier(rest)?;
            let tail = rest[name.len()..].trim_start();
            let function_like = tail
                .strip_prefix('=')
                .map(str::trim_start)
                .is_some_and(|value| {
                    value.starts_with("function")
                        || value.starts_with("async function")
                        || value.contains("=>")
                });
            return Some(SymbolDefinition {
                name: name.to_string(),
                kind: if function_like {
                    "function"
                } else {
                    "variable"
                },
            });
        }
    }

    None
}

/// Load a bounded preview when the native TUI is launched without the Node
/// bridge. Paths are repository-relative and may not escape the repository.
pub fn load_local_preview(repo_root: &Path, path: &str) -> Result<SearchPreview> {
    let relative = Path::new(path);
    if !crate::path_safety::safe_relative_path(relative) {
        bail!("preview path must stay inside the repository");
    }

    let filesystem =
        diffing_core::repo_fs::RepoFs::open(repo_root).context("opening preview repository")?;
    let mut file = match filesystem.open_read_file(relative) {
        Ok(file) => file,
        Err(diffing_core::repo_fs::RepoFsError::NotFound) => {
            return Ok(SearchPreview {
                path: path.to_string(),
                content: String::new(),
                missing: true,
                binary: false,
                truncated: false,
            });
        }
        Err(error) => return Err(error).context("opening search preview"),
    };
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .context("reading search preview")?;
    let binary = bytes
        .iter()
        .take(BINARY_SAMPLE_BYTES)
        .any(|byte| *byte == 0);
    let truncated = bytes.len() > MAX_PREVIEW_BYTES;
    bytes.truncate(MAX_PREVIEW_BYTES);
    Ok(SearchPreview {
        path: path.to_string(),
        content: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        },
        missing: false,
        binary,
        truncated,
    })
}

fn strip_declaration_modifiers(mut line: &str) -> &str {
    loop {
        let previous = line;
        line = strip_rust_visibility(line);
        for modifier in [
            "export",
            "default",
            "declare",
            "abstract",
            "public",
            "private",
            "protected",
            "internal",
            "final",
            "readonly",
            "static",
            "sealed",
            "open",
            "data",
        ] {
            if let Some(rest) = after_keyword(line, modifier) {
                line = rest;
                break;
            }
        }
        if line == previous {
            return line;
        }
    }
}

fn strip_function_modifiers(mut line: &str) -> &str {
    loop {
        let previous = line;
        for modifier in ["async", "const", "unsafe"] {
            if let Some(rest) = after_keyword(line, modifier) {
                line = rest;
                break;
            }
        }
        if let Some(rest) = after_keyword(line, "extern") {
            line = rest.trim_start_matches(|character: char| {
                character == '"' || character.is_ascii_alphanumeric()
            });
            line = line.trim_start_matches('"').trim_start();
        }
        if line == previous {
            return line;
        }
    }
}

fn strip_method_modifiers(mut line: &str) -> &str {
    loop {
        let previous = line;
        for modifier in [
            "static", "async", "abstract", "readonly", "override", "get", "set",
        ] {
            if let Some(rest) = after_keyword(line, modifier) {
                line = rest;
                break;
            }
        }
        if line == previous {
            return line;
        }
    }
}

fn strip_rust_visibility(line: &str) -> &str {
    let Some(rest) = line.strip_prefix("pub") else {
        return line;
    };
    if let Some(rest) = rest.strip_prefix(char::is_whitespace) {
        return rest.trim_start();
    }
    if let Some(rest) = rest.strip_prefix('(') {
        if let Some((_, tail)) = rest.split_once(')') {
            return tail.trim_start();
        }
    }
    line
}

fn after_keyword<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(keyword)?;
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then(|| rest.trim_start())
}

fn take_identifier(value: &str) -> Option<&str> {
    let end = value
        .char_indices()
        .take_while(|(index, character)| {
            (*index == 0 && (character.is_alphabetic() || *character == '_' || *character == '$'))
                || (*index > 0 && is_identifier_character(*character))
        })
        .map(|(index, character)| index + character.len_utf8())
        .last()?;
    Some(&value[..end])
}

fn take_php_namespace(value: &str) -> Option<&str> {
    let mut rest = value;
    let mut consumed = 0usize;
    loop {
        let segment = take_identifier(rest)?;
        consumed += segment.len();
        rest = &rest[segment.len()..];
        if let Some(tail) = rest.strip_prefix('\\') {
            consumed += 1;
            rest = tail;
            continue;
        }
        break;
    }
    (consumed > 0).then(|| &value[..consumed])
}

fn is_identifier_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_' || character == '$'
}

fn decode_preview(value: Value, fallback_path: &str) -> SearchPreview {
    SearchPreview {
        path: value
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(fallback_path)
            .to_string(),
        content: value
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        missing: value
            .get("missing")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        binary: value
            .get("binary")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        truncated: value
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn indexed_git_status(kind: IndexedChangeKind) -> &'static str {
    match kind {
        IndexedChangeKind::Modified => "modified",
        IndexedChangeKind::Added => "added",
        IndexedChangeKind::Deleted => "deleted",
        IndexedChangeKind::Renamed => "renamed",
        IndexedChangeKind::Untracked => "untracked",
        IndexedChangeKind::Binary => "binary",
    }
}

fn fuzzy_path_score(path: &str, query: &str) -> Option<i64> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Some(0);
    }
    let path_lower = path.to_lowercase();
    let path_chars: Vec<char> = path_lower.chars().collect();
    let mut cursor = 0usize;
    let mut previous = None;
    let mut score = 0i64;
    for needle in query.chars() {
        let offset = path_chars
            .get(cursor..)?
            .iter()
            .position(|character| *character == needle)?;
        let index = cursor + offset;
        score += 8;
        if previous == Some(index.saturating_sub(1)) {
            score += 12;
        }
        if index == 0 || matches!(path_chars[index - 1], '/' | '_' | '-' | '.') {
            score += 16;
        }
        previous = Some(index);
        cursor = index + 1;
    }
    if path_lower.contains(&query) {
        score += 80;
    }
    let basename = path_lower.rsplit('/').next().unwrap_or(&path_lower);
    if basename.starts_with(&query) {
        score += 120;
    }
    Some(score - path_chars.len().min(i64::MAX as usize) as i64)
}

pub fn changed_file_search_hits(index: &DiffIndex, query: &str) -> (Vec<SearchHit>, usize) {
    let mut ranked = index
        .files
        .iter()
        .enumerate()
        .filter_map(|(order, file)| {
            let path = file.display_path().to_string_lossy().into_owned();
            let score = fuzzy_path_score(&path, query)?;
            let title = file
                .display_path()
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&path)
                .to_string();
            let detail = file
                .display_path()
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(|parent| format!("{}/", parent.to_string_lossy()))
                .unwrap_or_else(|| "./".to_string());
            Some((
                score,
                order,
                SearchHit {
                    kind: SearchHitKind::File,
                    path,
                    line: None,
                    title,
                    detail,
                    git_status: indexed_git_status(file.kind).to_string(),
                },
            ))
        })
        .collect::<Vec<_>>();
    if !query.trim().is_empty() {
        ranked.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    }
    let total = ranked.len();
    let hits = ranked
        .into_iter()
        .take(MAX_SEARCH_HITS)
        .map(|(_, _, hit)| hit)
        .collect();
    (hits, total)
}

pub fn interleave_search_hits(groups: Vec<Vec<SearchHit>>, limit: usize) -> Vec<SearchHit> {
    let mut groups = groups.into_iter().map(Vec::into_iter).collect::<Vec<_>>();
    let mut hits = Vec::new();
    while hits.len() < limit {
        let mut appended = false;
        for group in &mut groups {
            if let Some(hit) = group.next() {
                hits.push(hit);
                appended = true;
                if hits.len() == limit {
                    break;
                }
            }
        }
        if !appended {
            break;
        }
    }
    hits
}

pub fn changed_symbol_search_hits(
    index: &DiffIndex,
    query: &str,
    symbol_cache: &mut HashMap<(u64, String), (Vec<SearchHit>, usize)>,
) -> Result<(Vec<SearchHit>, usize)> {
    let cache_key = (index.generation, query.trim().to_lowercase());
    if let Some(cached) = symbol_cache.get(&cache_key) {
        return Ok(cached.clone());
    }
    let needle = query.trim().to_lowercase();
    let mut hits = Vec::new();
    let mut total = 0usize;
    'files: for (file_index, file) in index.files.iter().enumerate() {
        let path = file.display_path().to_string_lossy().into_owned();
        let mut row = 0u64;
        while row < file.row_count {
            let page = index.viewport(file_index, row, 512, 1024 * 1024)?;
            if page.rows.is_empty() {
                break;
            }
            for view_row in page.rows {
                let ViewRow::Line {
                    kind: IndexedLineKind::Add,
                    new_lineno: Some(line),
                    content,
                    ..
                } = view_row
                else {
                    continue;
                };
                let Some(symbol) = classify_symbol_line(&content) else {
                    continue;
                };
                if !needle.is_empty() && !symbol.name.to_lowercase().contains(&needle) {
                    continue;
                }
                total = total.saturating_add(1);
                if total > MAX_SEARCH_HITS {
                    break 'files;
                }
                if hits.len() < MAX_SEARCH_HITS {
                    hits.push(SearchHit {
                        kind: SearchHitKind::Symbol,
                        path: path.clone(),
                        line: Some(line),
                        title: symbol.name,
                        detail: format!("{} · {path}:{line}", symbol.kind),
                        git_status: indexed_git_status(file.kind).to_string(),
                    });
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
    let result = (hits, total);
    symbol_cache.insert(cache_key, result.clone());
    Ok(result)
}

pub fn changed_text_search_hits(index: &DiffIndex, query: &str) -> Result<(Vec<SearchHit>, usize)> {
    if query.trim().is_empty() {
        return Ok((Vec::new(), 0));
    }
    let page = index.search_literal(query, 0, 0, 512, 2 * 1024 * 1024)?;
    let truncated = page.truncated;
    let hits = page
        .hits
        .into_iter()
        .filter_map(|hit| {
            let line = hit.new_lineno.or(hit.old_lineno)?;
            let git_status = index
                .files
                .get(hit.file_index)
                .map(|file| indexed_git_status(file.kind))
                .unwrap_or("")
                .to_string();
            Some(SearchHit {
                kind: SearchHitKind::Text,
                path: hit.path.clone(),
                line: Some(line),
                title: hit.preview.trim().to_string(),
                detail: format!("{}:{line}", hit.path),
                git_status,
            })
        })
        .collect::<Vec<_>>();
    let total = hits.len().saturating_add(usize::from(truncated));
    Ok((hits, total))
}

pub fn execute_local_search(
    index: &DiffIndex,
    query: &str,
    scope: SearchScope,
    regex: bool,
    symbol_cache: &mut HashMap<(u64, String), (Vec<SearchHit>, usize)>,
) -> Result<(Vec<SearchHit>, usize)> {
    if regex {
        bail!("Regex search requires the diffing Node launcher");
    }
    match scope {
        SearchScope::Files => Ok(changed_file_search_hits(index, query)),
        SearchScope::Text => changed_text_search_hits(index, query),
        SearchScope::Symbols => changed_symbol_search_hits(index, query, symbol_cache),
        SearchScope::All if query.is_empty() => Ok(changed_file_search_hits(index, query)),
        SearchScope::All => {
            let (files, file_total) = changed_file_search_hits(index, query);
            let (symbols, symbol_total) = changed_symbol_search_hits(index, query, symbol_cache)?;
            let symbol_locations = symbols
                .iter()
                .filter_map(|hit| hit.line.map(|line| (hit.path.clone(), line)))
                .collect::<HashSet<_>>();
            let (mut text, text_total) = changed_text_search_hits(index, query)?;
            let before_dedup = text.len();
            text.retain(|hit| {
                !hit.line
                    .is_some_and(|line| symbol_locations.contains(&(hit.path.clone(), line)))
            });
            let deduplicated = before_dedup.saturating_sub(text.len());
            let total = file_total
                .saturating_add(symbol_total)
                .saturating_add(text_total.saturating_sub(deduplicated));
            let hits = interleave_search_hits(vec![files, symbols, text], MAX_SEARCH_HITS);
            Ok((hits, total))
        }
    }
}

fn should_search_locally(request: &SearchRequest, bridge: Option<&SearchClient>) -> bool {
    bridge.is_none()
        || request.changed_paths.is_some()
        || (request.scope == SearchScope::Symbols && request.query.chars().count() < 2)
}

pub struct SearchRequest {
    pub id: u64,
    pub query: String,
    pub scope: SearchScope,
    pub regex: bool,
    pub changed_paths: Option<Vec<String>>,
}

pub struct SearchWorkerContext {
    pub bridge: Option<SearchClient>,
    pub index: Arc<RwLock<Arc<DiffIndex>>>,
    pub symbol_cache: Mutex<HashMap<(u64, String), (Vec<SearchHit>, usize)>>,
}

pub fn execute_search_request(
    ctx: &SearchWorkerContext,
    request: &SearchRequest,
) -> Result<SearchResponse> {
    if should_search_locally(request, ctx.bridge.as_ref()) {
        let index = ctx
            .index
            .read()
            .map_err(|_| anyhow!("diff index lock poisoned"))?;
        let (hits, total) = {
            let mut symbol_cache = ctx
                .symbol_cache
                .lock()
                .map_err(|_| anyhow!("symbol cache lock poisoned"))?;
            execute_local_search(
                &index,
                &request.query,
                request.scope,
                request.regex,
                &mut symbol_cache,
            )?
        };
        return Ok(SearchResponse {
            hits,
            total: Some(total),
            indexing: !index.complete,
            error: None,
            notice: None,
        });
    }
    let client = ctx
        .bridge
        .as_ref()
        .expect("bridge required for remote search");
    client.search(
        &request.query,
        request.scope,
        request.regex,
        request.changed_paths.as_deref(),
    )
}

pub fn diff_first_search_hits(
    hits: Vec<SearchHit>,
    changed_paths: &HashSet<String>,
) -> Vec<SearchHit> {
    let (mut in_diff, outside_diff): (Vec<_>, Vec<_>) = hits
        .into_iter()
        .partition(|hit| changed_paths.contains(&hit.path));
    in_diff.extend(outside_diff);
    in_diff
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_cycles_in_both_directions() {
        assert_eq!(SearchScope::All.next(1), SearchScope::Files);
        assert_eq!(SearchScope::All.next(-1), SearchScope::Symbols);
    }

    #[test]
    fn rejects_non_loopback_endpoints() {
        assert!(SearchClient::new("http://example.com:80", "token".into()).is_err());
        assert!(SearchClient::new("https://127.0.0.1:80", "token".into()).is_err());
    }

    #[test]
    fn rejects_header_injection_and_invalid_ports() {
        assert!(SearchClient::new("http://127.0.0.1:80", "token\r\nInjected: yes".into()).is_err());
        assert!(SearchClient::new("http://127.0.0.1:80", "".into()).is_err());
        assert!(SearchClient::new("http://127.0.0.1:0", "token".into()).is_err());
    }

    #[test]
    fn rejects_overflowing_line_numbers_and_bounds_hits() {
        let items: Vec<Value> = (0..100)
            .map(|index| {
                json!({
                    "path": format!("src/{index}.rs"),
                    "line": u64::from(u32::MAX) + 1,
                })
            })
            .collect();
        let response = decode_response(
            json!({ "total": u64::MAX, "items": items }),
            SearchScope::Files,
        )
        .unwrap();

        assert_eq!(response.hits.len(), MAX_SEARCH_HITS);
        assert!(response.hits.iter().all(|hit| hit.line.is_none()));
    }

    #[test]
    fn decodes_mixed_web_search_shape() {
        let response = decode_response(
            json!({
                "total": 2,
                "indexing": false,
                "items": [
                    { "kind": "file", "hit": { "path": "src/app.rs", "matchType": "fuzzy" } },
                    { "kind": "text", "hit": { "path": "src/app.rs", "line": 42, "content": "fn render()" } }
                ]
            }),
            SearchScope::All,
        )
        .unwrap();
        assert_eq!(response.hits.len(), 2);
        assert_eq!(response.total, Some(2));
        assert_eq!(response.hits[0].title, "app.rs");
        assert_eq!(response.hits[0].detail, "src/");
        assert_eq!(response.hits[1].line, Some(42));
        assert_eq!(response.hits[1].detail, "src/app.rs:42");
    }

    #[test]
    fn decodes_symbol_kind_as_compact_metadata() {
        let response = decode_response(
            json!({
                "total": 1,
                "items": [{
                    "name": "render_search",
                    "kind": "function",
                    "path": "src/app.rs",
                    "line": 42,
                    "content": "pub fn render_search()"
                }]
            }),
            SearchScope::Symbols,
        )
        .unwrap();
        assert_eq!(response.hits[0].title, "render_search");
        assert_eq!(response.hits[0].detail, "function · src/app.rs:42");
    }

    #[test]
    fn classifies_common_language_definitions() {
        let cases = [
            (
                "export const loadData = async (id: string) => {",
                "loadData",
                "function",
            ),
            (
                "pub(crate) async fn render_search() {",
                "render_search",
                "function",
            ),
            ("impl<T> SearchService<T> {", "SearchService", "impl"),
            ("async def fetch_user(user_id):", "fetch_user", "function"),
            ("func (s *Server) Start() error {", "Start", "method"),
            ("type SearchResult struct {", "SearchResult", "type"),
            (
                "export default class SearchPalette {",
                "SearchPalette",
                "class",
            ),
            ("function helpers($x) {", "helpers", "function"),
            ("public function handle(): void {", "handle", "function"),
            ("private static function boot(): void", "boot", "function"),
            ("abstract class BaseController", "BaseController", "class"),
            ("final readonly class Dto", "Dto", "class"),
            (
                "interface RepositoryInterface",
                "RepositoryInterface",
                "interface",
            ),
            ("trait HasFactory", "HasFactory", "trait"),
            ("enum Status: string", "Status", "enum"),
            (
                "namespace App\\Http\\Controllers;",
                "App\\Http\\Controllers",
                "namespace",
            ),
        ];
        for (line, name, kind) in cases {
            let symbol = classify_symbol_line(line)
                .unwrap_or_else(|| panic!("expected symbol for {line:?}"));
            assert_eq!(symbol.name, name);
            assert_eq!(symbol.kind, kind);
        }
        for line in [
            "render_search();",
            "if ($ready) {",
            "new class {",
            "use App\\Models\\User;",
            "fn () => 1",
        ] {
            assert_eq!(
                classify_symbol_line(line),
                None,
                "expected reject for {line:?}"
            );
        }
    }

    #[test]
    fn local_preview_is_bounded_and_rejects_escaping_paths() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("source.rs"), "fn main() {}\n").unwrap();
        let preview = load_local_preview(directory.path(), "source.rs").unwrap();
        assert_eq!(preview.content, "fn main() {}\n");
        assert!(!preview.binary);
        assert!(load_local_preview(directory.path(), "../secret").is_err());
    }

    #[test]
    fn decodes_preview_shape() {
        let preview = decode_preview(
            json!({
                "path": "src/app.rs",
                "content": "fn main() {}",
                "missing": false,
                "binary": false,
                "truncated": true
            }),
            "fallback.rs",
        );
        assert_eq!(preview.path, "src/app.rs");
        assert_eq!(preview.content, "fn main() {}");
        assert!(preview.truncated);
    }

    #[test]
    fn preserves_regex_fallback_as_a_non_fatal_notice() {
        let response = decode_response(
            json!({
                "total": 1,
                "regexError": "unclosed group",
                "items": [{ "path": "src/app.rs", "line": 42, "content": "(" }]
            }),
            SearchScope::Text,
        )
        .unwrap();
        assert_eq!(response.hits.len(), 1);
        assert_eq!(
            response.notice.as_deref(),
            Some("invalid regex; searched literally: unclosed group")
        );
        assert_eq!(response.error, None);
    }
}
