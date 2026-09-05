//! Tests for the lead-owned native filesystem core (`diffing_core::repo_fs`).
//!
//! Contract under test (owned by the lead; absent from this worktree):
//! - `RepoFs::open(&Path) -> Result<RepoFs, RepoFsError>`
//! - `RepoFs::read(&Path) -> Result<RepoFile { bytes: Vec<u8>, sha256: String }, RepoFsError>`
//! - `RepoFs::write(&Path, &[u8], WriteOptions) -> Result<RepoFileInfo { sha256: String, size: u64 }, RepoFsError>`
//! - `WriteOptions { create_parents: bool, expected_sha256: Option<String> }` + `Default`
//! - `RepoFsError::code() -> &str` (named codes: `not-found`, `too-large`)
//! - `repo_fs::MAX_FILE_BYTES: u64`
//!
//! All filesystem activity happens inside an owned `tempfile::TempDir`;
//! no real user files are touched and no uncontrolled threads are spawned.

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use diffing_core::repo_fs::{RepoFs, WriteOptions, MAX_FILE_BYTES};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

/// Owned sandbox: a repo dir and a sibling outside dir under one TempDir.
struct Sandbox {
    _root: TempDir,
    repo: std::path::PathBuf,
    outside: std::path::PathBuf,
}

impl Sandbox {
    fn new() -> Sandbox {
        let root = TempDir::new().expect("tempdir");
        let repo = root.path().join("repo");
        let outside = root.path().join("outside");
        fs::create_dir(&repo).expect("create repo dir");
        fs::create_dir(&outside).expect("create outside dir");
        Sandbox {
            _root: root,
            repo,
            outside,
        }
    }

    fn opened(&self) -> RepoFs {
        RepoFs::open(&self.repo).expect("open RepoFs")
    }

    fn seed(&self, rel: &str, bytes: &[u8]) {
        let p = self.repo.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("seed parent dir");
        }
        fs::write(&p, bytes).expect("seed file");
    }

    fn sentinel(&self) -> Vec<u8> {
        fs::read(self.outside.join("sentinel")).expect("read outside sentinel")
    }

    fn plant_sentinel(&self) {
        fs::write(self.outside.join("sentinel"), b"outside").expect("plant sentinel");
    }
}

// ---------------------------------------------------------------------------
// 1. Safe read/hash, not-found, path validation, .git metadata rejection
// ---------------------------------------------------------------------------

#[test]
fn read_returns_bytes_and_sha256() {
    let sb = Sandbox::new();
    sb.seed("hello.txt", b"hello world");
    let repo = sb.opened();
    let file = repo.read(Path::new("hello.txt")).expect("read");
    assert_eq!(file.bytes, b"hello world");
    // SHA-256 of "hello world".
    assert_eq!(
        file.sha256,
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
}

#[test]
fn read_missing_file_gives_not_found_code() {
    let sb = Sandbox::new();
    let repo = sb.opened();
    let err = repo.read(Path::new("nope.txt")).expect_err("must fail");
    assert_eq!(err.code(), "not-found");
}

#[test]
fn empty_relative_and_dotdot_paths_are_rejected() {
    let sb = Sandbox::new();
    sb.seed("a.txt", b"x");
    sb.plant_sentinel();
    let repo = sb.opened();

    assert!(repo.read(Path::new("")).is_err(), "empty read path");
    assert!(repo.write(Path::new(""), b"x", WriteOptions::default()).is_err(), "empty write path");
    assert!(repo.read(Path::new("/etc/hostname")).is_err(), "absolute read path");
    assert!(
        repo.write(Path::new("/etc/hostname"), b"x", WriteOptions::default())
            .is_err(),
        "absolute write path"
    );
    assert!(repo.read(Path::new("../outside/sentinel")).is_err(), ".. read");
    assert!(
        repo.write(Path::new("../outside/escape.txt"), b"x", WriteOptions::default())
            .is_err(),
        ".. write"
    );
    assert!(
        repo.write(Path::new("sub/../../escape.txt"), b"x", WriteOptions::default())
            .is_err(),
        "nested .. write"
    );
    // Outside sentinel untouched by every rejected attempt.
    assert_eq!(sb.sentinel(), b"outside");
}

#[test]
fn git_metadata_names_are_rejected() {
    let sb = Sandbox::new();
    sb.seed(".git/config", b"[core]");
    sb.seed("sub/.git/config", b"[core]");
    let repo = sb.opened();

    assert!(repo.read(Path::new(".git/config")).is_err(), ".git read");
    assert!(
        repo.write(Path::new(".git/config"), b"x", WriteOptions::default())
            .is_err(),
        ".git write"
    );
    assert!(
        repo.write(Path::new(".git/HEAD"), b"x", WriteOptions::default())
            .is_err(),
        ".git/HEAD write"
    );
    assert!(repo.read(Path::new("sub/.git/config")).is_err(), "nested .git read");
    assert!(
        repo.write(Path::new("sub/.git/config"), b"x", WriteOptions::default())
            .is_err(),
        "nested .git write"
    );
}

// ---------------------------------------------------------------------------
// 2. Write semantics: create/overwrite, create_parents, expected_sha256
// ---------------------------------------------------------------------------

#[test]
fn write_creates_then_overwrites() {
    let sb = Sandbox::new();
    let repo = sb.opened();

    let info = repo
        .write(Path::new("file.txt"), b"first", WriteOptions::default())
        .expect("create");
    assert_eq!(info.size, 5);
    assert_eq!(fs::read(sb.repo.join("file.txt")).unwrap(), b"first");

    let info = repo
        .write(Path::new("file.txt"), b"second!", WriteOptions::default())
        .expect("overwrite");
    assert_eq!(info.size, 7);
    assert_eq!(fs::read(sb.repo.join("file.txt")).unwrap(), b"second!");
    // sha256("second!") — hardcoded because sha2 is not an integration-test dep.
    assert_eq!(
        info.sha256,
        "d8470465f9e7614921a043dd05deb31e1f8926c516afc00432359aa2ebb07d30"
    );
}

#[test]
fn nested_dirs_require_create_parents_flag() {
    let sb = Sandbox::new();
    let repo = sb.opened();

    // Without create_parents: rejected, nothing created.
    assert!(
        repo.write(Path::new("deep/dir/file.txt"), b"x", WriteOptions::default())
            .is_err(),
        "write into missing parents must fail"
    );
    assert!(!sb.repo.join("deep").exists(), "no dirs created on failure");

    // With create_parents: succeeds.
    let opts = WriteOptions {
        create_parents: true,
        ..WriteOptions::default()
    };
    repo.write(Path::new("deep/dir/file.txt"), b"nested", opts)
        .expect("nested creation");
    assert_eq!(fs::read(sb.repo.join("deep/dir/file.txt")).unwrap(), b"nested");
}

#[test]
fn stale_expected_sha256_conflicts_and_preserves_bytes() {
    let sb = Sandbox::new();
    sb.seed("guarded.txt", b"original");
    let repo = sb.opened();

    let opts = WriteOptions {
        create_parents: false,
        // sha256("stale") — deliberately not the current file's hash.
        expected_sha256: Some(
            "a03f2386ae06b21109577020844df367857b72c2fcce384c1896fed98a89c82b".to_string(),
        ),
    };
    let result = repo.write(Path::new("guarded.txt"), b"new bytes", opts);
    assert!(result.is_err(), "stale expected_sha256 must conflict");
    // Original bytes preserved.
    assert_eq!(
        fs::read(sb.repo.join("guarded.txt")).unwrap(),
        b"original",
        "conflict must preserve existing bytes"
    );

    // Correct hash allows the update.
    let opts = WriteOptions {
        create_parents: false,
        // sha256("original") — matches the current file's hash.
        expected_sha256: Some(
            "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5".to_string(),
        ),
    };
    let info = repo
        .write(Path::new("guarded.txt"), b"updated", opts)
        .expect("matching hash must allow write");
    assert_eq!(fs::read(sb.repo.join("guarded.txt")).unwrap(), b"updated");
    // sha256("updated").
    assert_eq!(
        info.sha256,
        "27eb5e51506c911f6fc4bb345c0d9db6f60415fceab7c18e1e9b862637415777"
    );
}

#[test]
fn oversized_sparse_file_read_gives_too_large() {
    let sb = Sandbox::new();
    // Sparse file: metadata size exceeds MAX_FILE_BYTES but occupies no blocks.
    let f = fs::File::create(sb.repo.join("huge.bin")).expect("create sparse file");
    f.set_len(MAX_FILE_BYTES + 1).expect("set_len");
    drop(f);

    let repo = sb.opened();
    let err = repo.read(Path::new("huge.bin")).expect_err("must be rejected");
    assert_eq!(err.code(), "too-large");
}

// ---------------------------------------------------------------------------
// 3. Unix-only: symlinks, hardlinks, mode preservation
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod unix {
    use super::*;

    #[test]
    fn leaf_symlinks_inside_and_outside_are_rejected() {
        let sb = Sandbox::new();
        sb.seed("real.txt", b"real");
        sb.plant_sentinel();
        std::os::unix::fs::symlink(sb.outside.join("sentinel"), sb.repo.join("out-link"))
            .expect("outside leaf symlink");
        std::os::unix::fs::symlink("real.txt", sb.repo.join("in-link"))
            .expect("inside leaf symlink");

        let repo = sb.opened();
        assert!(repo.read(Path::new("out-link")).is_err(), "outside leaf symlink read");
        assert!(
            repo.write(Path::new("out-link"), b"x", WriteOptions::default())
                .is_err(),
            "outside leaf symlink write"
        );
        assert!(repo.read(Path::new("in-link")).is_err(), "inside leaf symlink read");
        assert!(
            repo.write(Path::new("in-link"), b"x", WriteOptions::default())
                .is_err(),
            "inside leaf symlink write"
        );
        assert_eq!(sb.sentinel(), b"outside", "sentinel untouched");
        assert_eq!(fs::read(sb.repo.join("real.txt")).unwrap(), b"real");
    }

    #[test]
    fn symlink_parent_dirs_rejected_for_read_write_and_nested_creation() {
        let sb = Sandbox::new();
        sb.seed("target/inside.txt", b"inside");
        sb.plant_sentinel();
        // Parent symlink pointing at the sibling outside dir.
        std::os::unix::fs::symlink(&sb.outside, sb.repo.join("linkdir"))
            .expect("parent dir symlink");

        let repo = sb.opened();
        assert!(repo.read(Path::new("linkdir/sentinel")).is_err(), "symlink parent read");
        assert!(
            repo.write(Path::new("linkdir/escape.txt"), b"x", WriteOptions::default())
                .is_err(),
            "symlink parent write"
        );
        let opts = WriteOptions {
            create_parents: true,
            ..WriteOptions::default()
        };
        assert!(
            repo.write(Path::new("linkdir/new/file.txt"), b"x", opts).is_err(),
            "nested creation through symlink parent"
        );
        // Outside sentinel unchanged, no escape file created there.
        assert_eq!(sb.sentinel(), b"outside");
        assert!(!sb.outside.join("escape.txt").exists());
        assert!(!sb.outside.join("new").exists());
    }

    #[test]
    fn atomic_write_to_in_repo_hardlink_leaves_outside_alias_unchanged() {
        let sb = Sandbox::new();
        sb.seed("hard-target.txt", b"before");
        fs::hard_link(sb.repo.join("hard-target.txt"), sb.outside.join("alias.txt"))
            .expect("hardlink");

        let repo = sb.opened();
        repo.write(Path::new("hard-target.txt"), b"after", WriteOptions::default())
            .expect("atomic overwrite");

        assert_eq!(
            fs::read(sb.repo.join("hard-target.txt")).unwrap(),
            b"after",
            "in-repo path updated"
        );
        assert_eq!(
            fs::read(sb.outside.join("alias.txt")).unwrap(),
            b"before",
            "outside hardlink alias must keep old bytes (atomic rename, not in-place write)"
        );
    }

    #[test]
    fn existing_executable_mode_is_preserved_on_overwrite() {
        let sb = Sandbox::new();
        sb.seed("script.sh", b"#!/bin/sh\necho v1\n");
        let p = sb.repo.join("script.sh");
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).expect("chmod 755");

        let repo = sb.opened();
        repo.write(Path::new("script.sh"), b"#!/bin/sh\necho v2\n", WriteOptions::default())
            .expect("overwrite");

        let mode = fs::metadata(&p).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755, "executable bit must survive overwrite");
    }
}

// ---------------------------------------------------------------------------
// 4. Root-handle test: rename repo, symlink at old pathname, existing handle
//    must keep using the original directory.
// ---------------------------------------------------------------------------

#[test]
fn existing_handle_survives_root_rename_and_old_path_symlink() {
    let sb = Sandbox::new();
    sb.plant_sentinel();

    let repo = sb.opened();
    // Give the handle something to read back later.
    repo.write(Path::new("keep.txt"), b"keep", WriteOptions::default())
        .expect("seed via handle");

    // Rename the repo directory within the owned temp parent.
    let moved = sb._root.path().join("repo-moved");
    fs::rename(&sb.repo, &moved).expect("rename repo dir");

    // Put an outside-dir symlink at the old root pathname.
    #[cfg(unix)]
    std::os::unix::fs::symlink(&sb.outside, &sb.repo).expect("symlink at old root path");

    // Reads and writes through the existing handle must hit the original
    // directory (now at `moved`), never the symlink target.
    let file = repo.read(Path::new("keep.txt")).expect("read via handle");
    assert_eq!(file.bytes, b"keep", "handle must read the original directory");

    repo.write(Path::new("after.txt"), b"after", WriteOptions::default())
        .expect("write via handle");

    assert_eq!(
        fs::read(moved.join("after.txt")).unwrap(),
        b"after",
        "write must land in the original (moved) directory"
    );
    assert_eq!(sb.sentinel(), b"outside", "outside sentinel untouched");
    #[cfg(unix)]
    assert!(
        !sb.outside.join("after.txt").exists() && !sb.outside.join("keep.txt").exists(),
        "nothing may be written through the old-path symlink"
    );
}

