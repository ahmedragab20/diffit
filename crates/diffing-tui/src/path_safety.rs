//! Repository path handling for editor/LSP names and capability-based readers.

use std::fs::File;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use diffing_core::repo_fs::RepoFs;

pub fn safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

/// Resolve a name for trusted external tools. This is not a file-access guard:
/// actual reads must use an opened capability through the functions below.
pub fn resolve_within_repo(repo_root: &Path, relative: &Path) -> Result<PathBuf> {
    if !safe_relative_path(relative) {
        bail!("path must stay inside the repository");
    }
    let canonical_repo = repo_root.canonicalize().context("resolving repository")?;
    let canonical = repo_root
        .join(relative)
        .canonicalize()
        .with_context(|| format!("resolving path {}", relative.display()))?;
    if !canonical.starts_with(&canonical_repo) {
        bail!("path escapes the repository");
    }
    Ok(canonical)
}

/// Open a regular file through no-follow directory capabilities on every
/// supported platform. Callers reading prefixes must keep their own byte limit.
pub fn open_file_within_repo(repo_root: &Path, relative: &Path) -> Result<File> {
    RepoFs::open(repo_root)
        .context("opening repository capability")?
        .open_read_file(relative)
        .context("opening repository file")
}

pub fn read_text_within_repo(repo_root: &Path, relative: &Path) -> Result<String> {
    let file = RepoFs::open(repo_root)
        .context("opening repository capability")?
        .read(relative)
        .context("reading repository file")?;
    String::from_utf8(file.bytes).context("repository file is not UTF-8")
}
