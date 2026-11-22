//! Filesystem state machine for module installation.
//!
//! A module is never overwritten in place.  Each version lives below
//! `<slug>/versions/<version>` and `active.json` is replaced as one small
//! atomic metadata write.  Hosts are started from the directory named by the
//! pointer, so an upgrade or rollback cannot modify files used by a running
//! process.  User data is outside the version directories and is retained by
//! default when a module is uninstalled.

use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ActivePointer {
    #[serde(rename = "activeVersion")]
    pub active_version: Option<String>,
    #[serde(rename = "previousVersion")]
    pub previous_version: Option<String>,
    #[serde(
        default,
        rename = "rollbackUntil",
        skip_serializing_if = "Option::is_none"
    )]
    pub rollback_until: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) uninstalled: Option<UninstalledModule>,
}

/// Display metadata for removed code. It carries no executable paths or grants.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct UninstalledModule {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) kind: super::PluginKind,
    pub(crate) status: super::PluginStatus,
}

const ROLLBACK_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl ActivePointer {
    pub(crate) fn was_uninstalled(&self) -> bool {
        self.active_version.is_none()
            && (self.previous_version.is_some() || self.uninstalled.is_some())
    }

    pub(super) fn rollback_version(&self, slug: &str) -> Result<&str, InstallError> {
        let previous = self
            .previous_version
            .as_deref()
            .filter(|_| self.active_version.is_some())
            .ok_or_else(|| InstallError::NoRollback(slug.into()))?;
        if !Self::rollback_time_is_open(self.rollback_until) {
            return Err(InstallError::RollbackExpired(slug.into()));
        }
        Ok(previous)
    }

    pub(super) fn rollback_time_is_open(deadline: Option<u64>) -> bool {
        deadline.is_some_and(|deadline| deadline > unix_seconds(SystemTime::now()))
    }
}

#[derive(Debug, Error)]
pub enum InstallError {
    #[error(transparent)]
    Trust(#[from] super::verify::TrustError),
    #[error("invalid module slug: {0}")]
    InvalidSlug(String),
    #[error("invalid module version: {0}")]
    InvalidVersion(String),
    #[error("module {slug} version {version} is not staged")]
    NotStaged { slug: String, version: String },
    #[error("module {0} has no previous version to roll back to")]
    NoRollback(String),
    #[error("the seven-day rollback window for {0} has expired")]
    RollbackExpired(String),
    #[error("module filesystem operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("module active pointer is invalid: {0}")]
    InvalidPointer(String),
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

    /// Serialize pointer changes across desktop processes sharing the profile.
    pub(super) fn lock_mutations(&self) -> Result<fs::File, InstallError> {
        fs::create_dir_all(&self.root)?;
        let path = self.root.join(".registry-mutations.lock");
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.is_file() || super::data_contract::is_link(&metadata) => {
                return Err(InstallError::InvalidPointer(
                    "invalid registry mutation lock".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        lock.lock()?;
        Ok(lock)
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
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(InstallError::InvalidPointer(
                "active.json must not be a symlink".into(),
            ));
        }
        let mut pointer: ActivePointer = serde_json::from_slice(&fs::read(path)?)?;
        for version in [
            pointer.active_version.as_deref(),
            pointer.previous_version.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            validate_version(version).map_err(|error| {
                InstallError::InvalidPointer(format!("invalid version {version}: {error}"))
            })?;
        }
        // Existing pointers predate rollbackUntil. Use their activation file's
        // timestamp and persist that deadline if a subsequent operation writes it.
        if pointer.rollback_until.is_none()
            && pointer.active_version.is_some()
            && pointer.previous_version.is_some()
        {
            pointer.rollback_until =
                Some(unix_seconds(metadata.modified()?).saturating_add(ROLLBACK_WINDOW.as_secs()));
        }
        Ok(pointer)
    }

    /// The production staging entry accepts only the private capability made
    /// by real signature verification. Recheck the private source and copied
    /// tree before publishing the version, including an existing version on a
    /// retry. An arbitrary renderer directory cannot reach this operation.
    pub fn stage_verified(
        &self,
        package: &super::verify::VerifiedPackage,
    ) -> Result<PathBuf, InstallError> {
        let manifest = package.manifest();
        let destination = self.version_dir(&manifest.slug, &manifest.version)?;
        let versions = destination.parent().expect("version parent");
        for directory in [&self.root, &self.root.join(&manifest.slug), versions] {
            if let Ok(metadata) = fs::symlink_metadata(directory) {
                if metadata.file_type().is_symlink() {
                    return Err(InstallError::InvalidPointer(
                        "plugin directory must not be a symlink".into(),
                    ));
                }
            }
        }
        if fs::symlink_metadata(&destination).is_ok() {
            package.check_installed_contents(&destination)?;
            return Ok(destination);
        }
        fs::create_dir_all(versions)?;
        let staging = tempfile::Builder::new()
            .prefix(".verified-staging-")
            .tempdir_in(versions)?;
        package.check_contents(package.directory())?;
        copy_tree(package.directory(), staging.path())?;
        package.check_contents(staging.path())?;
        package.persist_proof(staging.path())?;
        package.check_installed_contents(staging.path())?;
        sync_tree(staging.path())?;
        // `TempDir` removes interrupted/failed staging automatically. Keeping
        // the directory only after rename avoids leaving an unverified tree.
        fs::rename(staging.path(), &destination)?;
        #[cfg(unix)]
        fs::File::open(versions)?.sync_all()?;
        Ok(destination)
    }

    /// Filesystem state-machine fixture. Production code must use
    /// `stage_verified`; unsigned directory staging is absent from that build.
    #[cfg(test)]
    pub(crate) fn stage(
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
            pointer.uninstalled = None;
            pointer.rollback_until = pointer
                .previous_version
                .as_ref()
                .map(|_| unix_seconds(SystemTime::now()).saturating_add(ROLLBACK_WINDOW.as_secs()));
            self.write_pointer(slug, &pointer)?;
        }
        Ok(pointer)
    }

    /// Switch the active pointer to the prior immutable directory. Calling
    /// this twice toggles between the two versions and remains idempotent.
    pub fn rollback(&self, slug: &str) -> Result<ActivePointer, InstallError> {
        let mut pointer = self.active_pointer(slug)?;
        let previous = pointer.rollback_version(slug)?;
        let previous_dir = self.version_dir(slug, previous)?;
        if !previous_dir.is_dir() {
            return Err(InstallError::NotStaged {
                slug: slug.to_owned(),
                version: previous.to_owned(),
            });
        }
        std::mem::swap(&mut pointer.active_version, &mut pointer.previous_version);
        self.write_pointer(slug, &pointer)?;
        Ok(pointer)
    }

    /// Restore the exact pre-transaction pointer after an activation or
    /// registry refresh failure. Active and rollback versions must already
    /// exist. An inactive pointer's previous version records history only.
    pub(crate) fn restore_pointer(
        &self,
        slug: &str,
        pointer: &ActivePointer,
    ) -> Result<(), InstallError> {
        validate_slug(slug)?;
        for version in [
            pointer.active_version.as_deref(),
            pointer.previous_version.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let path = self.version_dir(slug, version)?;
            if pointer.was_uninstalled() {
                continue;
            }
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(InstallError::NotStaged {
                    slug: slug.into(),
                    version: version.into(),
                });
            }
        }
        self.write_pointer(slug, pointer)
    }

    /// Commit the uninstall before removing any code. The previous version is
    /// history for reinstall/downgrade checks, even after its files are gone.
    pub(super) fn mark_uninstalled(
        &self,
        slug: &str,
        display: UninstalledModule,
    ) -> Result<(), InstallError> {
        validate_slug(slug)?;
        let mut pointer = self.active_pointer(slug)?;
        if pointer.active_version.is_some() {
            pointer.previous_version = pointer.active_version.take();
        }
        pointer.rollback_until = None;
        pointer.uninstalled = Some(display);
        self.write_pointer(slug, &pointer)
    }

    /// Remove installed versions and derived runtime files after uninstall.
    pub(super) fn remove_code_trees(&self, slug: &str) -> Result<(), InstallError> {
        validate_slug(slug)?;
        let owner = self.root.join(slug);
        for path in [&self.root, &owner] {
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_dir() && !super::data_contract::is_link(&metadata) => {
                    ()
                }
                Ok(_) => {
                    return Err(InstallError::InvalidPointer(
                        "invalid module code directory".into(),
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.into()),
            }
        }
        for name in ["versions", "runtime"] {
            let directory = owner.join(name);
            match fs::symlink_metadata(&directory) {
                Ok(metadata) if metadata.is_dir() && !super::data_contract::is_link(&metadata) => {
                    remove_code_directory(&directory)?;
                }
                Ok(_) => {
                    return Err(InstallError::InvalidPointer(format!(
                        "invalid module {name} directory"
                    )));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        #[cfg(unix)]
        fs::File::open(owner)?.sync_all()?;
        Ok(())
    }

    fn write_pointer(&self, slug: &str, pointer: &ActivePointer) -> Result<(), InstallError> {
        let directory = self.root.join(slug);
        fs::create_dir_all(&directory)?;
        let path = directory.join("active.json");
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        temporary.write_all(&serde_json::to_vec_pretty(pointer)?)?;
        temporary.as_file().sync_all()?;
        // tempfile uses replace-existing rename on Windows as well, without
        // an unlink gap where the last working active pointer disappears.
        temporary.persist(path).map_err(|error| error.error)?;
        #[cfg(unix)]
        fs::File::open(directory)?.sync_all()?;
        Ok(())
    }
}

fn remove_code_directory(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match fs::remove_dir_all(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            #[cfg(windows)]
            // A child process's image or driver can remain mapped briefly
            // after the module host has released its own process handle.
            Err(error)
                if matches!(error.raw_os_error(), Some(5 | 32 | 33))
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            result => return result,
        }
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

/// The active pointer may become durable immediately after publication.
/// Flush copied payload bytes and directory entries before making that
/// pointer possible, so it cannot reference an incomplete package on restart.
fn sync_tree(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "cannot flush linked/special package data",
        ));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            sync_tree(&entry?.path())?;
        }
        #[cfg(unix)]
        fs::File::open(path)?.sync_all()?;
    } else {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)?
            .sync_all()?;
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
    fn rollback_and_uninstall_remove_code_and_runtime_but_retain_history_and_data() {
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
        let runtime = root.path().join("rdp-client/runtime");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(runtime.join("derived-helper"), b"runtime").unwrap();
        installer
            .mark_uninstalled(
                "rdp-client",
                UninstalledModule {
                    name: "RDP Client".into(),
                    description: String::new(),
                    kind: super::super::PluginKind::RemoteClient,
                    status: super::super::PluginStatus::Stable,
                },
            )
            .unwrap();
        installer.remove_code_trees("rdp-client").unwrap();
        assert!(!root.path().join("rdp-client/versions").exists());
        assert!(!runtime.exists());
        assert!(root.path().join("rdp-client/data").exists());
        let removed = installer.active_pointer("rdp-client").unwrap();
        assert!(removed.was_uninstalled());
        assert_eq!(removed.previous_version.as_deref(), Some("1.0.0"));
        installer.restore_pointer("rdp-client", &removed).unwrap();
        assert_eq!(installer.active_pointer("rdp-client").unwrap(), removed);
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

    #[test]
    fn an_expired_rollback_window_leaves_both_pointers_unchanged() {
        let root = tempdir().unwrap();
        let installer = ModuleInstaller::new(root.path());
        let expired = ActivePointer {
            active_version: Some("2.0.0".into()),
            previous_version: Some("1.0.0".into()),
            rollback_until: Some(1),
            uninstalled: None,
        };
        installer.write_pointer("mfa", &expired).unwrap();
        assert!(matches!(
            installer.rollback("mfa"),
            Err(InstallError::RollbackExpired(_))
        ));
        assert_eq!(installer.active_pointer("mfa").unwrap(), expired);
    }

    #[test]
    fn rejects_tampered_active_pointer_paths() {
        let root = tempdir().unwrap();
        let plugin = root.path().join("mfa");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(
            plugin.join("active.json"),
            br#"{"activeVersion":"../outside","previousVersion":null}"#,
        )
        .unwrap();
        let installer = ModuleInstaller::new(root.path());
        assert!(matches!(
            installer.active_pointer("mfa"),
            Err(InstallError::InvalidPointer(_))
        ));
    }

    #[test]
    fn restores_prior_pointer_after_failed_transaction_and_rejects_missing_versions() {
        let root = tempdir().unwrap();
        let package = tempdir().unwrap();
        fs::write(package.path().join("module.json"), b"{}").unwrap();
        let installer = ModuleInstaller::new(root.path());
        installer.stage("mfa", "1.0.0", package.path()).unwrap();
        installer.stage("mfa", "1.1.0", package.path()).unwrap();
        let original = installer.activate("mfa", "1.0.0").unwrap();
        installer.activate("mfa", "1.1.0").unwrap();
        installer.restore_pointer("mfa", &original).unwrap();
        assert_eq!(installer.active_pointer("mfa").unwrap(), original);
        let invalid = ActivePointer {
            active_version: Some("../outside".into()),
            ..ActivePointer::default()
        };
        assert!(installer.restore_pointer("mfa", &invalid).is_err());
        let missing = ActivePointer {
            active_version: Some("9.0.0".into()),
            ..ActivePointer::default()
        };
        assert!(installer.restore_pointer("mfa", &missing).is_err());
        assert_eq!(installer.active_pointer("mfa").unwrap(), original);
        installer
            .restore_pointer("mfa", &ActivePointer::default())
            .unwrap();
        assert_eq!(
            installer.active_pointer("mfa").unwrap(),
            ActivePointer::default()
        );
    }
}
