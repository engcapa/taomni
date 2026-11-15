//! Filesystem state machine for module installation.
//!
//! A module is never overwritten in place.  Each version lives below
//! `<slug>/versions/<version>` and `active.json` is replaced as one small
//! atomic metadata write.  Hosts are started from the directory named by the
//! pointer, so an upgrade or rollback cannot modify files used by a running
//! process.  User data is outside the version directories and is retained by
//! default when a module is uninstalled.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ActivePointer {
    #[serde(rename = "activeVersion")]
    pub active_version: Option<String>,
    #[serde(rename = "previousVersion")]
    pub previous_version: Option<String>,
}

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("invalid module slug: {0}")]
    InvalidSlug(String),
    #[error("invalid module version: {0}")]
    InvalidVersion(String),
    #[error("module {slug} version {version} is not staged")]
    NotStaged { slug: String, version: String },
    #[error("module {0} has no previous version to roll back to")]
    NoRollback(String),
    #[error("module filesystem operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("module state JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct ModuleInstaller {
    root: PathBuf,
}

impl ModuleInstaller {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn version_dir(&self, slug: &str, version: &str) -> Result<PathBuf, InstallError> {
        validate_slug(slug)?;
        validate_version(version)?;
        Ok(self.root.join(slug).join("versions").join(version))
    }

    pub fn active_pointer(&self, slug: &str) -> Result<ActivePointer, InstallError> {
        validate_slug(slug)?;
        let path = self.root.join(slug).join("active.json");
        if !path.exists() {
            return Ok(ActivePointer::default());
        }
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }

    /// Copy a verified package into a private staging directory, then rename
    /// it into the immutable version directory. Existing versions are never
    /// replaced, which makes a failed update safe to retry.
    pub fn stage(
        &self,
        slug: &str,
        version: &str,
        package_dir: &Path,
    ) -> Result<PathBuf, InstallError> {
        let destination = self.version_dir(slug, version)?;
        if !package_dir.is_dir() {
            return Err(InstallError::Io(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "package directory does not exist: {}",
                    package_dir.display()
                ),
            )));
        }
        if destination.exists() {
            return Ok(destination);
        }
        let versions = destination.parent().expect("version directory has parent");
        fs::create_dir_all(versions)?;
        let staging = versions.join(format!(".{version}.staging-{}", std::process::id()));
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        copy_tree(package_dir, &staging)?;
        // On the supported filesystems rename is atomic within a directory.
        // The destination does not exist because versions are immutable.
        fs::rename(&staging, &destination)?;
        Ok(destination)
    }

    /// Atomically activate an already staged version and retain one rollback
    /// pointer. The caller can start/re-handshake the host after this write.
    pub fn activate(&self, slug: &str, version: &str) -> Result<ActivePointer, InstallError> {
        let version_dir = self.version_dir(slug, version)?;
        if !version_dir.is_dir() {
            return Err(InstallError::NotStaged {
                slug: slug.to_owned(),
                version: version.to_owned(),
            });
        }
        let mut pointer = self.active_pointer(slug)?;
        if pointer.active_version.as_deref() != Some(version) {
            pointer.previous_version = pointer.active_version.take();
            pointer.active_version = Some(version.to_owned());
            self.write_pointer(slug, &pointer)?;
        }
        Ok(pointer)
    }

    /// Switch the active pointer to the prior immutable directory. Calling
    /// this twice toggles between the two versions and remains idempotent.
    pub fn rollback(&self, slug: &str) -> Result<ActivePointer, InstallError> {
        let mut pointer = self.active_pointer(slug)?;
        let previous = pointer
            .previous_version
            .clone()
            .ok_or_else(|| InstallError::NoRollback(slug.to_owned()))?;
        let previous_dir = self.version_dir(slug, &previous)?;
        if !previous_dir.is_dir() {
            return Err(InstallError::NotStaged {
                slug: slug.to_owned(),
                version: previous,
            });
        }
        std::mem::swap(&mut pointer.active_version, &mut pointer.previous_version);
        self.write_pointer(slug, &pointer)?;
        Ok(pointer)
    }

    /// Deactivate a module while retaining its immutable versions and data.
    /// Data is removed only when `delete_data` is explicitly true.
    pub fn uninstall(&self, slug: &str, delete_data: bool) -> Result<ActivePointer, InstallError> {
        validate_slug(slug)?;
        let mut pointer = self.active_pointer(slug)?;
        if pointer.active_version.is_some() {
            pointer.previous_version = pointer.active_version.take();
        }
        self.write_pointer(slug, &pointer)?;
        if delete_data {
            let data = self.root.join(slug).join("data");
            if data.exists() {
                fs::remove_dir_all(data)?;
            }
        }
        Ok(pointer)
    }

    fn write_pointer(&self, slug: &str, pointer: &ActivePointer) -> Result<(), InstallError> {
        let directory = self.root.join(slug);
        fs::create_dir_all(&directory)?;
        let path = directory.join("active.json");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let temporary = directory.join(format!(".active.{nonce}.tmp"));
        fs::write(&temporary, serde_json::to_vec_pretty(pointer)?)?;
        // `active.json` is replaced only after the complete JSON is on disk.
        // Unix rename is atomic. On Windows rename of an existing file is not
        // permitted, so remove the old pointer immediately before rename;
        // version directories remain untouched and can still be recovered.
        if cfg!(windows) && path.exists() {
            fs::remove_file(&path)?;
        }
        fs::rename(temporary, path)?;
        Ok(())
    }
}

fn validate_slug(slug: &str) -> Result<(), InstallError> {
    if slug.is_empty()
        || slug.starts_with('-')
        || slug.ends_with('-')
        || slug.split('-').any(|part| {
            part.is_empty()
                || !part
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
    {
        return Err(InstallError::InvalidSlug(slug.to_owned()));
    }
    Ok(())
}

fn validate_version(version: &str) -> Result<(), InstallError> {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let numbers = core.split('.').collect::<Vec<_>>();
    if numbers.len() != 3
        || numbers
            .iter()
            .any(|part| part.is_empty() || part.parse::<u64>().is_err())
        || version.chars().any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
        })
    {
        return Err(InstallError::InvalidVersion(version.to_owned()));
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), InstallError> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(InstallError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "symlink is not allowed in module package: {}",
                    entry.path().display()
                ),
            )));
        }
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn stages_versions_and_switches_pointer_atomically() {
        let root = tempdir().unwrap();
        let package = tempdir().unwrap();
        fs::write(package.path().join("module.json"), b"{}").unwrap();
        let installer = ModuleInstaller::new(root.path());
        installer.stage("mfa", "1.0.0", package.path()).unwrap();
        installer.stage("mfa", "1.1.0", package.path()).unwrap();
        assert_eq!(
            installer
                .activate("mfa", "1.0.0")
                .unwrap()
                .active_version
                .as_deref(),
            Some("1.0.0")
        );
        let pointer = installer.activate("mfa", "1.1.0").unwrap();
        assert_eq!(pointer.active_version.as_deref(), Some("1.1.0"));
        assert_eq!(pointer.previous_version.as_deref(), Some("1.0.0"));
        assert!(!root.path().join("mfa/.active.tmp").exists());
    }

    #[test]
    fn rollback_and_uninstall_keep_versions_and_data_by_default() {
        let root = tempdir().unwrap();
        let package = tempdir().unwrap();
        fs::write(package.path().join("host"), b"host").unwrap();
        let installer = ModuleInstaller::new(root.path());
        installer
            .stage("rdp-client", "1.0.0", package.path())
            .unwrap();
        installer
            .stage("rdp-client", "2.0.0", package.path())
            .unwrap();
        installer.activate("rdp-client", "1.0.0").unwrap();
        installer.activate("rdp-client", "2.0.0").unwrap();
        let rolled = installer.rollback("rdp-client").unwrap();
        assert_eq!(rolled.active_version.as_deref(), Some("1.0.0"));
        fs::create_dir_all(root.path().join("rdp-client/data")).unwrap();
        installer.uninstall("rdp-client", false).unwrap();
        assert!(root.path().join("rdp-client/versions/1.0.0/host").exists());
        assert!(root.path().join("rdp-client/data").exists());
    }

    #[test]
    fn rejects_traversal_and_unstaged_versions() {
        let installer = ModuleInstaller::new(tempdir().unwrap().path());
        assert!(matches!(
            installer.version_dir("../mfa", "1.0.0"),
            Err(InstallError::InvalidSlug(_))
        ));
        assert!(matches!(
            installer.activate("mfa", "1.0.0"),
            Err(InstallError::NotStaged { .. })
        ));
    }
}
