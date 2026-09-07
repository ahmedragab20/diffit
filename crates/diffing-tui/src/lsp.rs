//! Optional local Language Server Protocol client.
//!
//! Servers are discovered from PATH first. Repository-local `node_modules/.bin`
//! binaries are used only when the repository is explicitly trusted in
//! `ui-state.json`. Nothing is downloaded and no repository content leaves the
//! machine.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::path_safety;
use anyhow::{Context, Result};
use serde_json::{json, Value};

const MAX_DIAGNOSTICS_PER_FILE: usize = 200;
const MAX_MESSAGE_CHARS: usize = 512;
const MAX_LSP_BODY_BYTES: usize = 32 * 1024 * 1024;
const MAX_LSP_HEADER_BYTES: usize = 8 * 1024;
const MAX_LSP_HEADER_LINES: usize = 64;
const LSP_INIT_TIMEOUT: Duration = Duration::from_secs(30);
const LSP_RESPAWN_COOLDOWN: Duration = Duration::from_secs(45);
const LSP_WRITE_QUEUE_CAPACITY: usize = 64;
const MAX_OPEN_DOCUMENTS: usize = 8;
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

enum LspWriteJob {
    Message(Value),
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntelligenceMode {
    Auto,
    Off,
}

impl IntelligenceMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Auto => "Auto",
            Self::Off => "Off",
        }
    }

    pub fn toggle(self) -> Self {
        match self {
            Self::Auto => Self::Off,
            Self::Off => Self::Auto,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerState {
    Off,
    Starting,
    Unavailable,
    Ready,
    Error,
}

impl ServerState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Starting => "starting",
            Self::Unavailable => "unavailable",
            Self::Ready => "ready",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LspDiagnostic {
    pub line: u32,
    pub start_character: u32,
    pub end_character: u32,
    pub severity: u8,
    pub message: String,
    pub source: Option<String>,
}

type DiagnosticStore = Arc<Mutex<HashMap<PathBuf, Arc<[LspDiagnostic]>>>>;

impl LspDiagnostic {
    pub fn marker(&self) -> char {
        match self.severity {
            1 => 'E',
            2 => 'W',
            3 => 'I',
            _ => 'H',
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefinitionTarget {
    pub path: PathBuf,
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestKind {
    Hover,
    Definition,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestToken {
    server: String,
    id: u64,
    pub kind: RequestKind,
    started: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LanguageResponse {
    Hover(Option<String>),
    Definition(Vec<DefinitionTarget>),
}

#[derive(Clone)]
struct ServerSpec {
    key: &'static str,
    command: &'static str,
    args: &'static [&'static str],
}

struct OpenDocument {
    version: i32,
    text: String,
}

struct LspSession {
    child: Child,
    write_tx: SyncSender<LspWriteJob>,
    writer_handle: Option<JoinHandle<()>>,
    responses: Arc<Mutex<HashMap<u64, Value>>>,
    reader_alive: Arc<AtomicBool>,
    opened: HashMap<PathBuf, OpenDocument>,
    open_order: VecDeque<PathBuf>,
    initialize_id: Option<u64>,
    started: Instant,
}

impl LspSession {
    fn spawn(
        spec: ServerSpec,
        command: &Path,
        repo_root: &Path,
        diagnostics: DiagnosticStore,
        diagnostics_revision: Arc<AtomicU64>,
    ) -> Result<Self> {
        let mut child = Command::new(command)
            .args(spec.args)
            .current_dir(repo_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("starting {}", command.display()))?;
        let stdin = child.stdin.take().context("language server has no stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("language server has no stdout")?;
        let (write_tx, write_rx) = mpsc::sync_channel(LSP_WRITE_QUEUE_CAPACITY);
        let writer_handle = thread::Builder::new()
            .name(format!("diffing-lsp-write-{}", spec.key))
            .spawn(move || run_lsp_writer(stdin, write_rx))?;
        let reader_responses = Arc::new(Mutex::new(HashMap::new()));
        let responses = reader_responses.clone();
        let reader_diagnostics = diagnostics;
        let reader_revision = diagnostics_revision;
        let reader_alive = Arc::new(AtomicBool::new(true));
        let reader_alive_flag = reader_alive.clone();
        let reader_write_tx = write_tx.clone();
        let root = repo_root.to_path_buf();
        thread::Builder::new()
            .name(format!("diffing-lsp-{}", spec.key))
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    match read_message(&mut reader) {
                        Ok(Some(message)) => {
                            if message.get("method").is_some() && message.get("id").is_some() {
                                respond_to_server_request(&message, &reader_write_tx);
                                continue;
                            }
                            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                                if let Ok(mut values) = reader_responses.lock() {
                                    values.insert(id, message);
                                }
                                continue;
                            }
                            if message.get("method").and_then(Value::as_str)
                                == Some("textDocument/publishDiagnostics")
                            {
                                record_diagnostics(
                                    &message,
                                    &root,
                                    &reader_diagnostics,
                                    &reader_revision,
                                );
                            }
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
                reader_alive_flag.store(false, Ordering::Release);
            })?;

        let mut session = Self {
            child,
            write_tx,
            writer_handle: Some(writer_handle),
            responses,
            reader_alive,
            opened: HashMap::new(),
            open_order: VecDeque::new(),
            initialize_id: None,
            started: Instant::now(),
        };
        let initialize_id = session.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": path_to_uri(repo_root),
                "capabilities": {
                    "textDocument": {
                        "publishDiagnostics": { "relatedInformation": false },
                        "hover": { "contentFormat": ["markdown", "plaintext"] },
                        "definition": { "linkSupport": true }
                    }
                },
                "clientInfo": { "name": "diffing-tui", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        session.initialize_id = Some(initialize_id);
        Ok(session)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<u64> {
        let id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        Ok(id)
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn send(&mut self, message: &Value) -> Result<()> {
        self.write_tx
            .try_send(LspWriteJob::Message(message.clone()))
            .map_err(|_| anyhow::anyhow!("language server write queue is full"))?;
        Ok(())
    }

    fn take_raw_response(&self, id: u64) -> Option<Value> {
        self.responses.lock().ok()?.remove(&id)
    }

    fn poll_initialized(&mut self) -> Result<bool> {
        self.ensure_running()?;
        let Some(id) = self.initialize_id else {
            return Ok(true);
        };
        if let Some(response) = self.take_raw_response(id) {
            if let Some(error) = response.get("error") {
                anyhow::bail!("language server initialization failed: {error}");
            }
            self.initialize_id = None;
            self.notify("initialized", json!({}))?;
            return Ok(true);
        }
        if self.started.elapsed() > LSP_INIT_TIMEOUT {
            anyhow::bail!("language server initialization timed out");
        }
        Ok(false)
    }

    fn is_ready(&self) -> bool {
        self.initialize_id.is_none()
    }

    fn close_document(&mut self, path: &Path) -> Result<()> {
        if !self.opened.contains_key(path) {
            return Ok(());
        }
        self.notify(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": path_to_uri(path) } }),
        )?;
        self.opened.remove(path);
        self.open_order.retain(|entry| entry != path);
        Ok(())
    }

    fn touch_open_document(&mut self, path: PathBuf) {
        self.open_order.retain(|entry| entry != &path);
        self.open_order.push_back(path);
    }

    fn evict_oldest_document(&mut self) -> Result<()> {
        let Some(path) = self.open_order.pop_front() else {
            return Ok(());
        };
        if self.opened.contains_key(&path) {
            self.close_document(&path)?;
        }
        Ok(())
    }

    fn sync_document(&mut self, path: &Path, content: Result<String>) -> Result<bool> {
        self.ensure_running()?;
        let text = match content {
            Ok(text) => text,
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "skipping unreadable file for language server"
                );
                return Ok(false);
            }
        };
        let uri = path_to_uri(path);
        if let Some(document) = self.opened.get_mut(path) {
            if document.text == text {
                return Ok(true);
            }
            document.version = document.version.saturating_add(1);
            document.text = text.clone();
            let version = document.version;
            self.touch_open_document(path.to_path_buf());
            self.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": uri, "version": version },
                    "contentChanges": [{ "text": text }]
                }),
            )?;
        } else {
            while self.opened.len() >= MAX_OPEN_DOCUMENTS {
                self.evict_oldest_document()?;
            }
            self.notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language_id(path).unwrap_or("plaintext"),
                        "version": 1,
                        "text": text
                    }
                }),
            )?;
            self.opened
                .insert(path.to_path_buf(), OpenDocument { version: 1, text });
            self.touch_open_document(path.to_path_buf());
        }
        Ok(true)
    }

    fn ensure_running(&mut self) -> Result<()> {
        if !self.reader_alive.load(Ordering::Acquire) {
            anyhow::bail!("language server reader stopped");
        }
        if let Some(status) = self.child.try_wait()? {
            anyhow::bail!("language server exited with {status}");
        }
        Ok(())
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        let write_tx = self.write_tx.clone();
        let writer_handle = self.writer_handle.take();
        thread::Builder::new()
            .name("diffing-lsp-shutdown".into())
            .spawn(move || {
                let _ = write_tx.send(LspWriteJob::Shutdown);
                if let Some(handle) = writer_handle {
                    let _ = handle.join();
                }
            })
            .ok();
        let _ = self.child.kill();
    }
}

pub struct LspManager {
    repo_root: PathBuf,
    mode: IntelligenceMode,
    trust_repo_local_bin: bool,
    sessions: HashMap<String, LspSession>,
    unavailable: HashMap<String, String>,
    unavailable_until: HashMap<String, Instant>,
    resolved_commands: HashMap<String, ResolvedCommand>,
    diagnostics: DiagnosticStore,
    diagnostics_revision: Arc<AtomicU64>,
    sync_warning: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedCommand {
    pub path: PathBuf,
    pub repo_local: bool,
}

impl LspManager {
    pub fn new(repo_root: PathBuf, mode: IntelligenceMode, trust_repo_local_bin: bool) -> Self {
        Self {
            repo_root,
            mode,
            trust_repo_local_bin,
            sessions: HashMap::new(),
            unavailable: HashMap::new(),
            unavailable_until: HashMap::new(),
            resolved_commands: HashMap::new(),
            diagnostics: Arc::new(Mutex::new(HashMap::new())),
            diagnostics_revision: Arc::new(AtomicU64::new(0)),
            sync_warning: None,
        }
    }

    pub fn take_sync_warning(&mut self) -> Option<String> {
        self.sync_warning.take()
    }

    pub fn retry_failed_servers(&mut self) {
        self.unavailable
            .retain(|_, reason| reason.ends_with("not found"));
        self.unavailable_until.clear();
        self.sessions.clear();
    }

    pub fn trust_repo_local_bin(&self) -> bool {
        self.trust_repo_local_bin
    }

    pub fn set_trust_repo_local_bin(&mut self, trusted: bool) {
        if self.trust_repo_local_bin == trusted {
            return;
        }
        self.trust_repo_local_bin = trusted;
        self.sessions.clear();
        self.unavailable.clear();
        self.unavailable_until.clear();
        self.resolved_commands.clear();
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.clear();
        }
    }

    pub fn resolved_command_for_path(&self, path: &Path) -> Option<&ResolvedCommand> {
        server_spec(path).and_then(|spec| self.resolved_commands.get(spec.key))
    }

    pub fn resolved_command_label(&self, path: &Path) -> Option<String> {
        self.resolved_command_for_path(path).map(|resolved| {
            if resolved.repo_local {
                format!("{} (repo-local)", resolved.path.display())
            } else {
                resolved.path.display().to_string()
            }
        })
    }

    pub fn mode(&self) -> IntelligenceMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: IntelligenceMode) {
        self.mode = mode;
        if mode == IntelligenceMode::Off {
            self.sessions.clear();
            self.unavailable.clear();
            self.unavailable_until.clear();
            if let Ok(mut diagnostics) = self.diagnostics.lock() {
                diagnostics.clear();
            }
        }
    }

    pub fn state_for_path(&self, path: &Path) -> ServerState {
        if self.mode == IntelligenceMode::Off {
            return ServerState::Off;
        }
        let Some(spec) = server_spec(path) else {
            return ServerState::Unavailable;
        };
        if self.sessions.contains_key(spec.key) {
            if self
                .sessions
                .get(spec.key)
                .is_some_and(LspSession::is_ready)
            {
                ServerState::Ready
            } else {
                ServerState::Starting
            }
        } else if self
            .unavailable
            .get(spec.key)
            .is_some_and(|reason| reason.ends_with("not found"))
        {
            ServerState::Unavailable
        } else if self.unavailable.contains_key(spec.key) {
            ServerState::Error
        } else {
            ServerState::Unavailable
        }
    }

    pub fn sync_document(&mut self, relative_path: &Path) -> Result<ServerState> {
        if self.mode == IntelligenceMode::Off {
            return Ok(ServerState::Off);
        }
        let absolute = path_safety::resolve_within_repo(&self.repo_root, relative_path)
            .with_context(|| format!("invalid document path {}", relative_path.display()))?;
        let Some(spec) = server_spec(&absolute) else {
            return Ok(ServerState::Unavailable);
        };
        if !self.sessions.contains_key(spec.key) {
            if self.unavailable.contains_key(spec.key)
                && !self
                    .unavailable
                    .get(spec.key)
                    .is_some_and(|reason| reason.ends_with("not found"))
            {
                if let Some(until) = self.unavailable_until.get(spec.key) {
                    if Instant::now() < *until {
                        return Ok(ServerState::Error);
                    }
                }
                self.unavailable.remove(spec.key);
                self.unavailable_until.remove(spec.key);
            }
            let Some(resolved) =
                resolve_command(spec.command, &self.repo_root, self.trust_repo_local_bin)
            else {
                self.unavailable
                    .insert(spec.key.to_string(), format!("{} not found", spec.command));
                return Ok(ServerState::Unavailable);
            };
            self.resolved_commands
                .insert(spec.key.to_string(), resolved.clone());
            match LspSession::spawn(
                spec.clone(),
                &resolved.path,
                &self.repo_root,
                self.diagnostics.clone(),
                self.diagnostics_revision.clone(),
            ) {
                Ok(session) => {
                    self.sessions.insert(spec.key.to_string(), session);
                }
                Err(error) => {
                    self.mark_unavailable(spec.key, error.to_string());
                    return Ok(ServerState::Error);
                }
            }
        }
        let initialized = self
            .sessions
            .get_mut(spec.key)
            .context("language server session disappeared")?
            .poll_initialized();
        match initialized {
            Ok(false) => return Ok(ServerState::Starting),
            Ok(true) => {}
            Err(error) => {
                self.teardown_session(spec.key, error.to_string());
                return Ok(ServerState::Error);
            }
        }
        let Some(session) = self.sessions.get_mut(spec.key) else {
            return Ok(ServerState::Error);
        };
        let content = path_safety::read_text_within_repo(&self.repo_root, relative_path);
        match session.sync_document(&absolute, content) {
            Ok(true) => {
                self.sync_warning = None;
                Ok(ServerState::Ready)
            }
            Ok(false) => {
                self.sync_warning = Some(format!(
                    "could not read {} for language server",
                    relative_path.display()
                ));
                Ok(ServerState::Ready)
            }
            Err(error) => {
                self.teardown_session(spec.key, error.to_string());
                Ok(ServerState::Error)
            }
        }
    }

    fn mark_unavailable(&mut self, key: &str, reason: String) {
        self.unavailable.insert(key.to_string(), reason);
        self.unavailable_until
            .insert(key.to_string(), Instant::now() + LSP_RESPAWN_COOLDOWN);
    }

    fn teardown_session(&mut self, key: &str, reason: String) {
        self.sessions.remove(key);
        self.mark_unavailable(key, reason);
    }

    pub fn request_hover(
        &mut self,
        relative_path: &Path,
        line: u32,
        character: u32,
    ) -> Result<RequestToken> {
        self.request_position(relative_path, line, character, RequestKind::Hover)
    }

    pub fn request_definition(
        &mut self,
        relative_path: &Path,
        line: u32,
        character: u32,
    ) -> Result<RequestToken> {
        self.request_position(relative_path, line, character, RequestKind::Definition)
    }

    fn request_position(
        &mut self,
        relative_path: &Path,
        line: u32,
        character: u32,
        kind: RequestKind,
    ) -> Result<RequestToken> {
        let state = self.sync_document(relative_path)?;
        if state != ServerState::Ready {
            anyhow::bail!("language server {}", state.label());
        }
        let absolute = self.repo_root.join(relative_path);
        let spec = server_spec(&absolute).context("unsupported file type")?;
        let session = self
            .sessions
            .get_mut(spec.key)
            .context("language server unavailable")?;
        let method = match kind {
            RequestKind::Hover => "textDocument/hover",
            RequestKind::Definition => "textDocument/definition",
        };
        let id = session.request(
            method,
            json!({
                "textDocument": { "uri": path_to_uri(&absolute) },
                "position": { "line": line, "character": character }
            }),
        )?;
        Ok(RequestToken {
            server: spec.key.to_string(),
            id,
            kind,
            started: Instant::now(),
        })
    }

    pub fn take_response(&self, token: &RequestToken) -> Option<Result<LanguageResponse, String>> {
        let Some(session) = self.sessions.get(&token.server) else {
            return Some(Err("language server stopped".to_string()));
        };
        let Some(value) = session.take_raw_response(token.id) else {
            return (token.started.elapsed() > Duration::from_secs(5))
                .then(|| Err("language request timed out".to_string()));
        };
        if let Some(error) = value.get("error") {
            return Some(Err(error.to_string()));
        }
        let result = value.get("result").cloned().unwrap_or(Value::Null);
        Some(match token.kind {
            RequestKind::Hover => Ok(LanguageResponse::Hover(parse_hover(&result))),
            RequestKind::Definition => Ok(LanguageResponse::Definition(parse_definitions(&result))),
        })
    }

    pub fn cancel_request(&mut self, token: &RequestToken) {
        if let Some(session) = self.sessions.get_mut(&token.server) {
            let _ = session.notify("$/cancelRequest", json!({ "id": token.id }));
            let _ = session.take_raw_response(token.id);
        }
    }

    pub fn close_document(&mut self, relative_path: &Path) -> Result<()> {
        if self.mode == IntelligenceMode::Off {
            return Ok(());
        }
        let absolute = path_safety::resolve_within_repo(&self.repo_root, relative_path)
            .with_context(|| format!("invalid document path {}", relative_path.display()))?;
        let Some(spec) = server_spec(&absolute) else {
            return Ok(());
        };
        if let Some(session) = self.sessions.get_mut(spec.key) {
            session.close_document(&absolute)?;
        }
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            if diagnostics.remove(&absolute).is_some() {
                self.diagnostics_revision.fetch_add(1, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    pub fn diagnostics_for(&self, relative_path: &Path) -> Arc<[LspDiagnostic]> {
        let absolute = self.repo_root.join(relative_path);
        self.diagnostics
            .lock()
            .ok()
            .and_then(|diagnostics| diagnostics.get(&absolute).cloned())
            .unwrap_or_else(|| Arc::from([]))
    }

    pub fn diagnostic_count(&self, relative_path: &Path) -> usize {
        self.diagnostics_for(relative_path).len()
    }

    pub fn diagnostics_revision(&self) -> u64 {
        self.diagnostics_revision.load(Ordering::Relaxed)
    }

    pub fn expected_server(relative_path: &Path) -> Option<&'static str> {
        server_spec(relative_path).map(|spec| spec.command)
    }
}

fn server_spec(path: &Path) -> Option<ServerSpec> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "rs" => Some(ServerSpec {
            key: "rust",
            command: "rust-analyzer",
            args: &[],
        }),
        "ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "mjs" | "cjs" => Some(ServerSpec {
            key: "typescript",
            command: "typescript-language-server",
            args: &["--stdio"],
        }),
        "py" | "pyi" => Some(ServerSpec {
            key: "python",
            command: "pyright-langserver",
            args: &["--stdio"],
        }),
        "go" => Some(ServerSpec {
            key: "go",
            command: "gopls",
            args: &[],
        }),
        "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hxx" => Some(ServerSpec {
            key: "clangd",
            command: "clangd",
            args: &[],
        }),
        _ => None,
    }
}

fn language_id(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "rs" => Some("rust"),
        "ts" | "mts" | "cts" => Some("typescript"),
        "tsx" => Some("typescriptreact"),
        "js" | "mjs" | "cjs" => Some("javascript"),
        "jsx" => Some("javascriptreact"),
        "py" | "pyi" => Some("python"),
        "go" => Some("go"),
        "c" | "h" => Some("c"),
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => Some("cpp"),
        _ => None,
    }
}

fn resolve_command(
    command: &str,
    repo_root: &Path,
    trust_repo_local: bool,
) -> Option<ResolvedCommand> {
    if let Some(path) = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|directory| executable_in(&directory, command))
    }) {
        return Some(ResolvedCommand {
            path,
            repo_local: false,
        });
    }
    if !trust_repo_local {
        return None;
    }
    let local_bin = repo_root.join("node_modules").join(".bin");
    executable_in(&local_bin, command).map(|path| ResolvedCommand {
        path,
        repo_local: true,
    })
}

fn executable_in(directory: &Path, command: &str) -> Option<PathBuf> {
    let direct = directory.join(command);
    if is_executable_file(&direct) {
        return Some(direct);
    }
    if !cfg!(windows) {
        return None;
    }
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(|extension| directory.join(format!("{command}{extension}")))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn record_diagnostics(
    message: &Value,
    repo_root: &Path,
    store: &DiagnosticStore,
    revision: &Arc<AtomicU64>,
) {
    let Some(params) = message.get("params") else {
        return;
    };
    let Some(uri) = params.get("uri").and_then(Value::as_str) else {
        return;
    };
    let Some(path) = uri_to_path(uri) else {
        return;
    };
    if !path.starts_with(repo_root) {
        return;
    }
    let diagnostics = params
        .get("diagnostics")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_DIAGNOSTICS_PER_FILE)
        .filter_map(parse_diagnostic)
        .collect::<Vec<_>>()
        .into();
    if let Ok(mut values) = store.lock() {
        values.insert(path, diagnostics);
        revision.fetch_add(1, Ordering::Relaxed);
    }
}

fn parse_diagnostic(value: &Value) -> Option<LspDiagnostic> {
    let range = value.get("range")?;
    let start = range.get("start")?;
    let end = range.get("end")?;
    Some(LspDiagnostic {
        line: start.get("line")?.as_u64()? as u32,
        start_character: start.get("character")?.as_u64()? as u32,
        end_character: end.get("character")?.as_u64()? as u32,
        severity: value.get("severity").and_then(Value::as_u64).unwrap_or(3) as u8,
        message: value
            .get("message")?
            .as_str()?
            .chars()
            .take(MAX_MESSAGE_CHARS)
            .collect(),
        source: value
            .get("source")
            .and_then(Value::as_str)
            .map(String::from),
    })
}

fn parse_hover(value: &Value) -> Option<String> {
    let contents = value.get("contents")?;
    let text = if let Some(text) = contents.as_str() {
        text.to_string()
    } else if let Some(markup) = contents.get("value").and_then(Value::as_str) {
        markup.to_string()
    } else if let Some(items) = contents.as_array() {
        items
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .or_else(|| item.get("value").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    } else {
        return None;
    };
    Some(text.chars().take(8_192).collect())
}

fn parse_definitions(value: &Value) -> Vec<DefinitionTarget> {
    let values: Vec<&Value> = if let Some(values) = value.as_array() {
        values.iter().collect()
    } else if value.is_object() {
        vec![value]
    } else {
        Vec::new()
    };
    values
        .into_iter()
        .filter_map(|target| {
            let uri = target
                .get("uri")
                .or_else(|| target.get("targetUri"))?
                .as_str()?;
            let range = target
                .get("range")
                .or_else(|| target.get("targetSelectionRange"))?;
            let start = range.get("start")?;
            Some(DefinitionTarget {
                path: uri_to_path(uri)?,
                line: start.get("line")?.as_u64()? as u32,
                character: start.get("character")?.as_u64()? as u32,
            })
        })
        .collect()
}

fn respond_to_server_request(message: &Value, writer: &SyncSender<LspWriteJob>) {
    let Some(id) = message.get("id").cloned() else {
        return;
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "workspace/configuration" => Value::Array(
            message
                .pointer("/params/items")
                .and_then(Value::as_array)
                .map(|items| vec![Value::Null; items.len()])
                .unwrap_or_default(),
        ),
        "workspace/applyEdit" => json!({
            "applied": false,
            "failureReason": "diffing is a read-only review client"
        }),
        _ => Value::Null,
    };
    let _ = writer.try_send(LspWriteJob::Message(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })));
}

fn run_lsp_writer(mut stdin: ChildStdin, rx: mpsc::Receiver<LspWriteJob>) {
    while let Ok(job) = rx.recv() {
        match job {
            LspWriteJob::Message(message) => {
                let _ = write_message(&mut stdin, &message);
            }
            LspWriteJob::Shutdown => break,
        }
    }
}

fn write_message(writer: &mut impl Write, message: &Value) -> Result<()> {
    let body = serde_json::to_vec(message)?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

fn read_message(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut content_length = None;
    let mut header_bytes = 0usize;
    let mut header_lines = 0usize;
    loop {
        if header_lines >= MAX_LSP_HEADER_LINES {
            anyhow::bail!("LSP header line limit exceeded");
        }
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            return Ok(None);
        }
        header_bytes += header.len();
        if header_bytes > MAX_LSP_HEADER_BYTES {
            anyhow::bail!("LSP header byte limit exceeded");
        }
        header_lines += 1;
        if header == "\r\n" || header == "\n" {
            break;
        }
        if let Some(value) = header.trim().strip_prefix("Content-Length:").map(str::trim) {
            content_length = value.parse::<usize>().ok();
        }
    }
    let Some(content_length) = content_length else {
        anyhow::bail!("LSP message missing Content-Length");
    };
    if content_length > MAX_LSP_BODY_BYTES {
        anyhow::bail!("LSP Content-Length exceeds limit");
    }
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn path_to_uri(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    let root = if cfg!(windows) && !value.starts_with('/') {
        "/"
    } else {
        ""
    };
    format!("file://{root}{}", percent_encode(value.as_bytes()))
}

fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let encoded = uri.strip_prefix("file://")?;
    let mut decoded = percent_decode(encoded)?;
    if cfg!(windows) {
        if decoded.starts_with('/') && decoded.as_bytes().get(2) == Some(&b':') {
            decoded.remove(0);
        }
        decoded = decoded.replace('/', "\\");
    }
    Some(PathBuf::from(decoded))
}

fn percent_encode(value: &[u8]) -> String {
    let mut output = String::new();
    for byte in value {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~')
        {
            output.push(*byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            output.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

pub fn utf16_column(text: &str, character_column: usize) -> u32 {
    text.chars()
        .take(character_column)
        .map(char::len_utf16)
        .sum::<usize>() as u32
}

pub fn character_column_from_utf16(text: &str, utf16_column: u32) -> usize {
    let mut consumed = 0u32;
    let mut characters = 0usize;
    for character in text.chars() {
        let width = character.len_utf16() as u32;
        if consumed.saturating_add(width) > utf16_column {
            break;
        }
        consumed = consumed.saturating_add(width);
        characters += 1;
    }
    characters
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn json_rpc_framing_round_trips() {
        let message = json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}});
        let mut bytes = Vec::new();
        write_message(&mut bytes, &message).unwrap();
        let parsed = read_message(&mut BufReader::new(Cursor::new(bytes)))
            .unwrap()
            .unwrap();
        assert_eq!(parsed, message);
    }

    #[test]
    fn file_uri_round_trips_spaces_and_unicode() {
        let path = PathBuf::from("/tmp/a path/λ.rs");
        assert_eq!(uri_to_path(&path_to_uri(&path)), Some(path));
    }

    #[test]
    fn utf16_columns_count_surrogate_pairs() {
        assert_eq!(utf16_column("a😀b", 0), 0);
        assert_eq!(utf16_column("a😀b", 2), 3);
        assert_eq!(utf16_column("a😀b", 3), 4);
        assert_eq!(character_column_from_utf16("a😀b", 0), 0);
        assert_eq!(character_column_from_utf16("a😀b", 1), 1);
        assert_eq!(character_column_from_utf16("a😀b", 3), 2);
        assert_eq!(character_column_from_utf16("a😀b", 4), 3);
    }

    #[test]
    fn diagnostics_are_bounded_and_truncated() {
        let root = PathBuf::from("/tmp/repo");
        let uri = path_to_uri(&root.join("a.rs"));
        let diagnostic = json!({
            "range": {"start":{"line":2,"character":1},"end":{"line":2,"character":4}},
            "severity": 1,
            "message": "x".repeat(1000),
            "source": "test"
        });
        let message = json!({
            "method": "textDocument/publishDiagnostics",
            "params": {"uri": uri, "diagnostics": vec![diagnostic; 250]}
        });
        let store = Arc::new(Mutex::new(HashMap::new()));
        let revision = Arc::new(AtomicU64::new(0));
        record_diagnostics(&message, &root, &store, &revision);
        let diagnostics = store.lock().unwrap();
        let values = diagnostics.get(&root.join("a.rs")).unwrap();
        assert_eq!(values.len(), MAX_DIAGNOSTICS_PER_FILE);
        assert_eq!(values[0].message.chars().count(), MAX_MESSAGE_CHARS);
        assert_eq!(revision.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn hover_and_definition_shapes_are_supported() {
        assert_eq!(
            parse_hover(&json!({"contents":{"kind":"markdown","value":"**type**"}})),
            Some("**type**".to_string())
        );
        let path = PathBuf::from("/tmp/definition.rs");
        let targets = parse_definitions(&json!({
            "uri": path_to_uri(&path),
            "range": {"start":{"line":4,"character":2},"end":{"line":4,"character":5}}
        }));
        assert_eq!(targets[0].path, path);
        assert_eq!(targets[0].line, 4);
    }

    #[test]
    fn path_language_server_is_preferred_over_repo_local_bin() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let local_executable = bin.join("typescript-language-server");
        std::fs::write(&local_executable, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&local_executable, std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }

        let path_dir = tempfile::tempdir().unwrap();
        let path_executable = path_dir.path().join("typescript-language-server");
        std::fs::write(&path_executable, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path_executable, std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }

        let previous_path = std::env::var_os("PATH");
        std::env::set_var("PATH", path_dir.path());
        let resolved = resolve_command("typescript-language-server", root.path(), true);
        if let Some(previous_path) = previous_path {
            std::env::set_var("PATH", previous_path);
        } else {
            std::env::remove_var("PATH");
        }

        let resolved = resolved.expect("expected PATH binary");
        assert_eq!(resolved.path, path_executable);
        assert!(!resolved.repo_local);
    }

    #[test]
    fn repo_local_language_server_requires_trust() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let executable = bin.join("typescript-language-server");
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let previous_path = std::env::var_os("PATH");
        std::env::set_var("PATH", "/usr/bin:/bin");
        let untrusted = resolve_command("typescript-language-server", root.path(), false);
        let trusted = resolve_command("typescript-language-server", root.path(), true);
        if let Some(previous_path) = previous_path {
            std::env::set_var("PATH", previous_path);
        } else {
            std::env::remove_var("PATH");
        }

        assert!(untrusted.is_none());
        let trusted = trusted.expect("trusted repo-local binary");
        assert_eq!(trusted.path, executable);
        assert!(trusted.repo_local);
    }
}
