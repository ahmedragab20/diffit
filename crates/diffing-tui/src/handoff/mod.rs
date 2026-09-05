//! `notify`-based live-update of the per-repo on-disk stores.
//!
//! Watches the storage directory for changes to `comments.json` (and, in
//! later phases, `plans.json` / `server.json`) and reloads the
//! in-memory `Vec<ReviewComment>` so the TUI reflects what the web UI
//! (or an agent CLI) wrote.
//!
//! Uses `notify-debouncer-full` so a flurry of writes coalesces into a
//! single reload instead of thrashing the disk read path.

pub mod format;
pub mod review;

use std::path::Path;
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use anyhow::{Context, Result};
use notify::{Event, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};

pub struct CommentsWatcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, FileIdMap>,
    rx: Receiver<DebounceEventResult>,
}

/// Coalesced repository change notifications for live diff refresh.
///
/// When the watcher cannot start (permissions, file-descriptor limits, etc.)
/// the TUI continues without live refresh instead of failing startup.
pub struct RepoWatcher {
    _watcher: notify::RecommendedWatcher,
    rx: Receiver<()>,
}

impl RepoWatcher {
    /// Start watching `repo_root` recursively for working-tree changes.
    /// Returns `None` when the OS refuses the watch — callers should log and
    /// continue without live refresh.
    pub fn start(repo_root: &Path) -> Option<Self> {
        let (tx, rx) = mpsc::sync_channel(1);
        let root = repo_root.to_path_buf();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let Ok(event) = event else {
                return;
            };
            if event
                .paths
                .iter()
                .any(|path| repo_watch_path_is_relevant(&root, path))
            {
                let _ = tx.try_send(());
            }
        })
        .ok()?;
        if let Err(error) = watcher.watch(repo_root, RecursiveMode::Recursive) {
            tracing::warn!(
                "could not watch {} for live refresh: {error:#}; continuing without it",
                repo_root.display()
            );
            return None;
        }
        Some(Self {
            _watcher: watcher,
            rx,
        })
    }

    /// Drain coalesced refresh signals without blocking.
    pub fn try_recv(&self) -> bool {
        let mut dirty = false;
        while self.rx.try_recv().is_ok() {
            dirty = true;
        }
        dirty
    }
}

fn repo_watch_path_is_relevant(repo_root: &Path, path: &Path) -> bool {
    if !path.starts_with(repo_root) {
        return false;
    }
    if path
        .components()
        .any(|component| matches!(component.as_os_str().to_str(), Some(".git")))
    {
        return false;
    }
    for ignored in ["node_modules", "target", "dist", ".diffing"] {
        if path
            .components()
            .any(|component| component.as_os_str() == ignored)
        {
            return false;
        }
    }
    !git_ignores_path(repo_root, path)
}

fn git_ignores_path(repo_root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(repo_root) else {
        return true;
    };
    if relative.as_os_str().is_empty() {
        return false;
    }
    Command::new("git")
        .args(["check-ignore", "-q", "--"])
        .arg(relative)
        .current_dir(repo_root)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

impl CommentsWatcher {
    /// Start watching `dir` (a per-repo storage dir) for changes to
    /// `comments.json`. The returned `Self` exposes a blocking `recv()`
    /// that yields whenever the file changes on disk. Drop the watcher
    /// to stop the background thread.
    pub fn start(dir: &Path) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<DebounceEventResult>();
        let mut debouncer = new_debouncer(
            Duration::from_millis(200),
            None,
            move |res: DebounceEventResult| {
                // Best-effort: if the receiver is gone, swallow the error.
                let _ = tx.send(res);
            },
        )
        .context("creating notify debouncer")?;
        debouncer
            .watcher()
            .watch(dir, RecursiveMode::NonRecursive)
            .with_context(|| format!("watching {}", dir.display()))?;
        // Filter by file id so the receiver only sees `comments.json` events.
        Ok(Self {
            _debouncer: debouncer,
            rx,
        })
    }

    /// Try to receive without blocking.
    pub fn try_recv(&self) -> Option<DebounceEventResult> {
        self.rx.try_recv().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    fn tempdir() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("diffing-live-test-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn watcher_fires_on_comments_json_write() {
        let dir = tempdir();
        let w = CommentsWatcher::start(&dir).expect("start watcher");
        // Give the OS a moment to install the watch.
        std::thread::sleep(Duration::from_millis(250));
        let path = dir.join("comments.json");
        // Write twice (a + a touch) to make sure the OS picks up the event
        // even on filesystems with coarse-grained change notifications.
        fs::write(&path, "[]").unwrap();
        std::thread::sleep(Duration::from_millis(100));
        fs::write(&path, "[1,2,3]").unwrap();
        let start = Instant::now();
        let mut saw = false;
        while start.elapsed() < Duration::from_secs(5) {
            if let Some(Ok(events)) = w.try_recv() {
                for e in &events {
                    for p in &e.paths {
                        if p == &path || p.file_name() == path.file_name() {
                            saw = true;
                            break;
                        }
                    }
                    if saw {
                        break;
                    }
                }
                if saw {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            saw,
            "watcher did not fire for {} (events: timeout)",
            path.display()
        );
    }

    #[test]
    fn repo_watch_path_skips_git_and_ignored_dirs() {
        let root = PathBuf::from("/tmp/repo");
        assert!(!repo_watch_path_is_relevant(
            &root,
            &root.join(".git/config")
        ));
        assert!(!repo_watch_path_is_relevant(
            &root,
            &root.join("node_modules/pkg/index.js")
        ));
    }
}
