//! File access relative to an open directory capability, never a checked path
//! reopened through ambient filesystem authority. Descendant symlinks are not
//! followed; replacement writes operate on a held parent directory handle.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Component, Path};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, OpenOptions};
use sha2::{Digest, Sha256};

pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum RepoFsError {
    #[error("invalid repository-relative path")]
    InvalidPath,
    #[error("filesystem access denied")]
    Denied,
    #[error("file not found")]
    NotFound,
    #[error("path is not a regular file")]
    NotFile,
    #[error("file exceeds the size limit")]
    TooLarge,
    #[error("file content changed")]
    Conflict,
    #[error("filesystem I/O failed")]
    Io(#[source] io::Error),
}

impl RepoFsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidPath => "invalid-path",
            Self::Denied => "denied",
            Self::NotFound => "not-found",
            Self::NotFile => "not-file",
            Self::TooLarge => "too-large",
            Self::Conflict => "conflict",
            Self::Io(_) => "io",
        }
    }
}

impl From<io::Error> for RepoFsError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::NotFound,
            io::ErrorKind::PermissionDenied => Self::Denied,
            io::ErrorKind::InvalidInput => Self::InvalidPath,
            _ => {
                #[cfg(unix)]
                if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
                    return Self::Denied;
                }
                Self::Io(error)
            }
        }
    }
}

#[derive(Debug)]
pub struct RepoFile {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

#[derive(Debug, serde::Serialize)]
pub struct RepoFileInfo {
    pub sha256: String,
    pub size: u64,
}

#[derive(Default, Debug)]
pub struct WriteOptions {
    pub create_parents: bool,
    /// An optimistic pre-write check, not a lock against unrelated writers.
    pub expected_sha256: Option<String>,
}

#[derive(Debug)]
pub struct RepoFs {
    root: Dir,
}

impl RepoFs {
    /// Grant access to this root once. The root is trusted configuration; all
    /// subsequent paths are resolved relative to its held handle.
    pub fn open(root: &Path) -> Result<Self, RepoFsError> {
        Ok(Self {
            root: Dir::open_ambient_dir(root, cap_std::ambient_authority())?,
        })
    }

    fn parent(&self, path: &Path, create: bool) -> Result<(Dir, OsString), RepoFsError> {
        let components = path_components(path)?;
        let (leaf, parents) = components.split_last().ok_or(RepoFsError::InvalidPath)?;
        let mut directory = self.root.try_clone()?;
        for component in parents {
            directory = match directory.open_dir_nofollow(component) {
                Ok(child) => child,
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    match directory.create_dir(component) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(error.into()),
                    }
                    // The new entry may have been replaced; reopen no-follow.
                    directory.open_dir_nofollow(component)?
                }
                Err(error) => return Err(error.into()),
            };
        }
        Ok((directory, leaf.clone()))
    }

    /// Obtain a confined descriptor. Prefix readers must enforce their own limit;
    /// full-file reads should use `read`, which checks size and growth.
    pub fn open_read_file(&self, path: &Path) -> Result<std::fs::File, RepoFsError> {
        let (parent, leaf) = self.parent(path, false)?;
        Ok(open_regular(&parent, &leaf, false)?.into_std())
    }

    pub fn read(&self, path: &Path) -> Result<RepoFile, RepoFsError> {
        let file = self.open_read_file(path)?;
        if file.metadata()?.len() > MAX_FILE_BYTES {
            return Err(RepoFsError::TooLarge);
        }
        let bytes = read_bounded(file)?;
        Ok(RepoFile {
            sha256: hash(&bytes),
            bytes,
        })
    }

    pub fn write(
        &self,
        path: &Path,
        bytes: &[u8],
        options: WriteOptions,
    ) -> Result<RepoFileInfo, RepoFsError> {
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(RepoFsError::TooLarge);
        }
        let (parent, leaf) = self
            .parent(
                path,
                options.create_parents && options.expected_sha256.is_none(),
            )
            .map_err(|error| match error {
                RepoFsError::NotFound if options.expected_sha256.is_some() => RepoFsError::Conflict,
                other => other,
            })?;
        let original = match open_regular(&parent, &leaf, true) {
            Ok(file) => Some(file),
            Err(RepoFsError::NotFound) => None,
            Err(error) => return Err(error),
        };
        let permissions = original
            .as_ref()
            .map(|file| file.metadata().map(|metadata| metadata.permissions()))
            .transpose()?;
        if permissions
            .as_ref()
            .is_some_and(|permission| permission.readonly())
        {
            return Err(RepoFsError::Denied);
        }
        if let Some(expected) = options.expected_sha256.as_ref() {
            let current = original.as_ref().ok_or(RepoFsError::Conflict)?;
            if hash(&read_bounded(current)?) != *expected {
                return Err(RepoFsError::Conflict);
            }
        }
        drop(original);

        let (temporary, mut file) = create_temporary(&parent)?;
        let result = (|| {
            file.write_all(bytes)?;
            if let Some(permissions) = permissions {
                file.set_permissions(permissions)?;
            }
            file.sync_all()?;
            drop(file);
            // Rename replaces a leaf entry, not its symlink/hardlink target.
            // Both names are relative to the same pinned parent capability.
            parent.rename(&temporary, &parent, &leaf)?;
            Ok(RepoFileInfo {
                sha256: hash(bytes),
                size: bytes.len() as u64,
            })
        })();
        if result.is_err() {
            // Cleanup also uses the capability; never follow a substituted link.
            let _ = parent.remove_file(&temporary);
        }
        result
    }
}

fn path_components(path: &Path) -> Result<Vec<OsString>, RepoFsError> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => {
                let text = name.to_string_lossy();
                if text.contains('\0') {
                    return Err(RepoFsError::InvalidPath);
                }
                if text
                    .trim_end_matches([' ', '.'])
                    .eq_ignore_ascii_case(".git")
                {
                    return Err(RepoFsError::Denied);
                }
                #[cfg(windows)]
                if text.contains(':') || text.ends_with([' ', '.']) {
                    return Err(RepoFsError::InvalidPath);
                }
                components.push(name.to_os_string());
                if components.len() > 256 {
                    return Err(RepoFsError::InvalidPath);
                }
            }
            _ => return Err(RepoFsError::InvalidPath),
        }
    }
    if components.is_empty() {
        return Err(RepoFsError::InvalidPath);
    }
    Ok(components)
}

fn file_options(write: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(write).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        // Do not hang if a regular file is replaced by a FIFO before open.
        options.custom_flags(libc::O_NONBLOCK);
    }
    options
}

fn open_regular(parent: &Dir, leaf: &OsString, write: bool) -> Result<File, RepoFsError> {
    let metadata = parent.symlink_metadata(leaf)?;
    if metadata.is_symlink() {
        return Err(RepoFsError::Denied);
    }
    if !metadata.is_file() {
        return Err(RepoFsError::NotFile);
    }
    let file = parent.open_with(leaf, &file_options(write))?;
    if !file.metadata()?.is_file() {
        return Err(RepoFsError::NotFile);
    }
    Ok(file)
}

fn read_bounded(reader: impl Read) -> Result<Vec<u8>, RepoFsError> {
    let mut bytes = Vec::new();
    reader.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(RepoFsError::TooLarge);
    }
    Ok(bytes)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn create_temporary(parent: &Dir) -> Result<(OsString, File), RepoFsError> {
    for _ in 0..16 {
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random)
            .map_err(|_| RepoFsError::Io(io::Error::other("random source failed")))?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let name = OsString::from(format!(".diffing-write-{suffix}.tmp"));
        let mut options = file_options(true);
        options.create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            // Keep partially written data private, even when the final file
            // preserves broader permissions. New files default to owner-only.
            options.mode(0o600);
        }
        match parent.open_with(&name, &options) {
            Ok(file) => return Ok((name, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(RepoFsError::Io(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate temporary file",
    )))
}
