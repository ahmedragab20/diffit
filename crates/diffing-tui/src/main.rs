//! `diffing-tui` — opt-in terminal UI for `diffing`.
//!
//! Invoked by the Node CLI when the user passes `--tui`. The Node CLI is the
//! single source of truth for arg parsing, lockfile discovery, and agent
//! handoff; this binary is a leaf renderer that reads `~/.diffing/<repo>/*`
//! on disk and registers itself in the shared session registry. `server.json`
//! points agent subcommands (`diffing await-review`, `diffing inspect`,
//! `diffing mcp`) at the selected active session.
//!
//! The renderer consumes a disk-backed sparse diff index, while a
//! capability-scoped loopback API exposes the same bounded views to headless
//! agents and CLI/MCP clients.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::Parser;
use diffing_tui::{app, diff_context, fs_rpc, search, server_lock, tui};
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(
    name = "diffing-tui",
    about = "Terminal User Interface for diffing.",
    long_about = None,
    version,
)]
struct Args {
    /// Path to the git repository whose diff is being reviewed. Must match
    /// the value the Node CLI computed via `git rev-parse --show-toplevel`.
    #[arg(long, env = "DIFFING_REPO")]
    repo: String,

    /// Open the focused read-only diff browser instead of the review surface.
    #[arg(long)]
    view_only: bool,

    /// Serve bounded file-access RPC on stdin/stdout without starting a TUI.
    #[arg(long, conflicts_with = "view_only")]
    fs_rpc: bool,

    /// All other arguments are forwarded verbatim to `git diff` (e.g.
    /// `--staged`, `-- <pathspec>`, `--diff-algorithm=patience`).
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    git_diff_args: Vec<String>,
}

fn main() -> ExitCode {
    init_tracing();
    match real_main() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("diffing-tui: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn real_main() -> Result<()> {
    let args = Args::parse();
    if args.fs_rpc {
        anyhow::ensure!(
            args.git_diff_args.is_empty(),
            "filesystem RPC does not accept diff arguments"
        );
        return fs_rpc::run(std::path::Path::new(&args.repo));
    }
    let repo_root = std::fs::canonicalize(&args.repo)
        .with_context(|| format!("resolving --repo {}", args.repo))?;
    let repo_root_str = repo_root
        .to_str()
        .context("--repo path is not valid UTF-8")?
        .to_string();

    // Indexing happens on a worker and publishes usable partial generations,
    // so even a million-line diff does not delay terminal startup.
    let experience = if args.view_only {
        app::Experience::Viewer
    } else {
        app::Experience::Review
    };
    let diff_context = diff_context::DiffContext::from_env_or_args(&args.git_diff_args);
    let mut app = app::App::new(
        PathBuf::from(&repo_root_str),
        args.git_diff_args,
        experience,
        diff_context,
        search::SearchClient::from_env(),
    )
    .with_context(|| format!("initialising diffing-tui for {}", repo_root_str))?;

    let lock = (!args.view_only).then(|| {
        let agent_api = app
            .agent_api
            .as_ref()
            .expect("review experience starts the agent API");
        server_lock::ServerLock {
            port: agent_api.port,
            host: "127.0.0.1".to_string(),
            pid: std::process::id(),
            repo_root: repo_root_str.clone(),
            started_at: now_ms(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            mode: Some("tui".to_string()),
            capability: Some(agent_api.capability.clone()),
            auth_token: None,
            session_id: Some(
                std::env::var("DIFFING_TUI_SESSION_ID")
                    .ok()
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        server_lock::new_session_id().expect("generating TUI session id")
                    }),
            ),
            scope: std::env::var("DIFFING_TUI_SESSION_SCOPE").ok(),
            diff_args: std::env::var("DIFFING_TUI_SESSION_ARGS")
                .ok()
                .and_then(|value| serde_json::from_str(&value).ok()),
            pr_ref: None,
            owner: None,
            owner_id: None,
        }
    });
    if let Some(lock) = &lock {
        let lock_path = server_lock::write_server_lock(&repo_root_str, lock)
            .with_context(|| format!("registering TUI session for {}", repo_root_str))?;
        tracing::info!(path = %lock_path.display(), port = lock.port, "registered TUI session");
    }

    let tui_result = tui::run(&repo_root_str, &mut app);

    if let Err(ref e) = tui_result {
        tracing::warn!(error = %e, "TUI loop exited with error");
    }
    if let Some(lock) = &lock {
        if let Err(e) = server_lock::remove_server_lock_if_owned(&repo_root_str, lock) {
            tracing::warn!(error = %e, "failed to unregister TUI session on exit");
        } else {
            tracing::info!("unregistered TUI session");
        }
    }

    tui_result
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn init_tracing() {
    let filter =
        EnvFilter::try_from_env("DIFFING_TUI_LOG").unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(std::io::stderr)
        .try_init();
}
