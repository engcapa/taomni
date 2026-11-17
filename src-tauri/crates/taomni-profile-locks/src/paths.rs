use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

use crate::LeaseError;

/// Canonicalization makes aliases of the same profile use the same OS locks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileRoot(PathBuf);

impl ProfileRoot {
    pub fn prepare(path: impl AsRef<Path>) -> Result<Self, LeaseError> {
        fs::create_dir_all(path.as_ref())?;
        let root = fs::canonicalize(path)?;
        if !root.is_dir() {
            return Err(LeaseError::UnsafeLockPath);
        }
        Ok(Self(root))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn open_profile(&self) -> Result<File, LeaseError> {
        open_lock(&self.0.join(".profile-use.lock"))
    }

    pub(crate) fn open_legacy_upgrade(&self) -> Result<File, LeaseError> {
        open_lock(&self.0.join(".mobile-mode.lock"))
    }

    pub(crate) fn open_plugin(&self, slug: &PluginSlug) -> Result<File, LeaseError> {
        let locks = ensure_directory(&self.0, ".profile-locks")?;
        let plugins = ensure_directory(&locks, "plugins")?;
        open_lock(&plugins.join(format!("{}.lock", slug.as_str())))
    }

    pub(crate) fn open_vault(&self) -> Result<File, LeaseError> {
        let locks = ensure_directory(&self.0, ".profile-locks")?;
        open_lock(&locks.join("vault-operations.lock"))
    }

    pub(crate) fn open_state(&self) -> Result<File, LeaseError> {
        let locks = ensure_directory(&self.0, ".profile-locks")?;
        open_lock(&locks.join("profile-state.lock"))
    }
}

/// A single path segment. This never accepts a plugin-supplied data path.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PluginSlug(String);

impl PluginSlug {
    pub fn parse(value: impl Into<String>) -> Result<Self, LeaseError> {
        let value = value.into();
        let device = value.to_ascii_uppercase();
        let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
            || (device.len() == 4
                && (device.starts_with("COM") || device.starts_with("LPT"))
                && device.as_bytes()[3].is_ascii_digit());
        if reserved
            || value.len() > 128
            || value.split('-').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            })
        {
            return Err(LeaseError::InvalidSlug);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn ensure_directory(parent: &Path, name: &str) -> Result<PathBuf, LeaseError> {
    let path = parent.join(name);
    match fs::create_dir(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err(LeaseError::UnsafeLockPath);
    }
    Ok(path)
}

fn open_lock(path: &Path) -> Result<File, LeaseError> {
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (!metadata.is_file() || is_reparse(&metadata))
    {
        return Err(LeaseError::UnsafeLockPath);
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(LeaseError::UnsafeLockPath);
    }
    Ok(file)
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
