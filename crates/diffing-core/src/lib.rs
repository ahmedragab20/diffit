//! Shared library for the diffing Rust tooling (TUI and beyond).
//!
//! Resolves the on-disk storage path so the Rust side matches the Node CLI's
//! `getProjectStorageDir` exactly:
//!
//!   `~/.diffing/<repoBasename>-<sha256(repoRoot)[:8]>/`
//!
//! Keeping this in a single crate (rather than duplicated in `diffing-tui`)
//! means future Rust components (a CLI flag, an MCP bridge, a long-running
//! indexer) read and write the same files the web server does.

pub mod comments;
pub mod diff;
pub mod index;
/// Capability-confined repository file access shared by native consumers.
pub mod repo_fs;
pub mod storage;

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Resolve the per-repo storage directory used by the Node CLI.
///
/// `repo_root` must be the canonical absolute path returned by
/// `git rev-parse --show-toplevel`; the Node CLI computes the same string
/// before invoking the TUI, so the two implementations stay in lock-step.
pub fn project_storage_dir(repo_root: &str) -> PathBuf {
    let hash = sha256_first_8_hex(repo_root);
    let basename = Path::new(repo_root)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repo");
    let storage_root = std::env::var_os("DIFFING_STORAGE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            directories::UserDirs::new()
                .map(|u| u.home_dir().join(".diffing"))
                .unwrap_or_else(|| PathBuf::from(".diffing"))
        });
    storage_root.join(format!("{}-{}", basename, hash))
}

fn sha256_first_8_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(8);
    for byte in digest.iter().take(4) {
        use std::fmt::Write as _;
        let _ = write!(out, "{:02x}", byte);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_hash_format() {
        // Hash is first 8 hex chars of SHA-256. Reference: empty string.
        assert_eq!(sha256_first_8_hex(""), "e3b0c442");
    }

    #[test]
    fn stable_for_same_input() {
        let a = project_storage_dir("/Users/me/projects/diffing");
        let b = project_storage_dir("/Users/me/projects/diffing");
        assert_eq!(a, b);
    }

    #[test]
    fn differs_for_different_input() {
        let a = project_storage_dir("/Users/me/projects/diffing");
        let b = project_storage_dir("/Users/me/projects/other");
        assert_ne!(a, b);
    }

    #[test]
    fn dir_basename_uses_repo_name() {
        let dir = project_storage_dir("/Users/me/projects/my-app");
        // The last path component is "my-app-<8hex>"
        let name = dir.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("my-app-"), "got {}", name);
        assert_eq!(name.len(), "my-app-".len() + 8, "got {}", name);
    }
}
