use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::fs::File;

use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
};

use crate::{SnapshotControl, SnapshotError, SnapshotOptions, SnapshotPhase};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotOutcome {
    Missing,
    Created(SnapshotSummary),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotSummary {
    pub size_bytes: u64,
    pub total_pages: u32,
    /// Windows does not offer the same directory fsync as Unix. File bytes
    /// are synced before the atomic replacement on every platform.
    pub directory_synced: bool,
}

/// Never creates or migrates a missing source. The read-only connection sees
/// committed WAL pages; immutable=1 and plain main-file copies would lose them.
pub fn snapshot_existing(
    source: &Path,
    target: &Path,
    options: &SnapshotOptions,
    control: &SnapshotControl,
) -> Result<SnapshotOutcome, SnapshotError> {
    control.check()?;
    options.validate()?;
    match fs::symlink_metadata(source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SnapshotOutcome::Missing);
        }
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err(SnapshotError::UnsafePath);
        }
        Ok(_) => {}
    }
    let source = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    source.busy_timeout(std::time::Duration::ZERO)?;
    snapshot_connection(&source, target, options, control).map(SnapshotOutcome::Created)
}

/// Atomic publication is the final commit point. Cancellation before it leaves
/// any previous target untouched; cancellation after it cannot unpublish a
/// completed snapshot. The target must be a caller-authorized staging path.
pub fn snapshot_connection(
    source: &Connection,
    target: &Path,
    options: &SnapshotOptions,
    control: &SnapshotControl,
) -> Result<SnapshotSummary, SnapshotError> {
    options.validate()?;
    control.check()?;
    validate_target(source, target)?;
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let artifact = SnapshotArtifact::new(parent)?;
    control.report(SnapshotPhase::Starting, None);
    let pages = write_snapshot(source, artifact.file.path(), options, control)?;
    artifact.file.as_file().sync_all()?;
    let size_bytes = artifact.file.as_file().metadata()?.len();
    control.report(SnapshotPhase::Publishing, Some((0, pages)));
    control.check()?;
    // tempfile::persist replaces an existing destination atomically on the
    // same filesystem. All validation and cancellable work precede this.
    artifact.file.persist(target).map_err(|error| error.error)?;
    // A directory sync failure after publication is reported as durability
    // metadata, not a false failed/cancelled result after replacing the file.
    let directory_synced = sync_directory(parent);
    control.report(SnapshotPhase::Completed, Some((0, pages)));
    Ok(SnapshotSummary {
        size_bytes,
        total_pages: pages.max(0) as u32,
        directory_synced,
    })
}

fn write_snapshot(
    source: &Connection,
    path: &Path,
    options: &SnapshotOptions,
    control: &SnapshotControl,
) -> Result<i32, SnapshotError> {
    let mut destination = Connection::open(path)?;
    destination.busy_timeout(std::time::Duration::ZERO)?;
    let pages = {
        let backup = Backup::new(source, &mut destination)?;
        loop {
            control.check()?;
            let step = backup.step(options.pages_per_step as i32)?;
            let progress = backup.progress();
            match step {
                StepResult::Done => break progress.pagecount,
                StepResult::More => control.report(
                    SnapshotPhase::Copying,
                    Some((progress.remaining, progress.pagecount)),
                ),
                StepResult::Busy | StepResult::Locked => {
                    control.report(
                        SnapshotPhase::WaitingForDatabase,
                        Some((progress.remaining, progress.pagecount)),
                    );
                    control.wait(options.busy_retry_delay)?;
                }
                _ => return Err(SnapshotError::IntegrityCheckFailed),
            }
        }
    };
    control.check()?;
    control.report(SnapshotPhase::Verifying, Some((0, pages)));
    let cancellation = control.clone();
    destination.progress_handler(1_000, Some(move || cancellation.check().is_err()))?;
    let checked: rusqlite::Result<String> =
        destination.query_row("PRAGMA quick_check", [], |row| row.get(0));
    destination.progress_handler(0, None::<fn() -> bool>)?;
    control.check()?;
    if checked? != "ok" {
        return Err(SnapshotError::IntegrityCheckFailed);
    }
    // Only the temporary destination may be checkpointed/normalized. This
    // makes the published artifact standalone even when the source uses WAL.
    destination.pragma_update(None, "journal_mode", "DELETE")?;
    destination.close().map_err(|(_, error)| error)?;
    control.check()?;
    Ok(pages)
}

fn validate_target(source: &Connection, target: &Path) -> Result<(), SnapshotError> {
    // A published snapshot must be standalone. Never replace a database that
    // may still be open with an older generation's WAL or rollback journal.
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = target.as_os_str().to_owned();
        sidecar.push(suffix);
        if Path::new(&sidecar).try_exists()? {
            return Err(SnapshotError::UnsafePath);
        }
    }
    match fs::symlink_metadata(target) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err(SnapshotError::UnsafePath);
        }
        Ok(_) => {
            if let Some(path) = source.path().filter(|path| !path.is_empty())
                && fs::canonicalize(path)? == fs::canonicalize(target)?
            {
                return Err(SnapshotError::SourceIsDestination);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

struct SnapshotArtifact {
    file: tempfile::NamedTempFile,
    _sidecars: SidecarCleanup,
}

impl SnapshotArtifact {
    fn new(parent: &Path) -> Result<Self, SnapshotError> {
        let file = tempfile::Builder::new()
            .prefix(".taomni-snapshot-")
            .suffix(".part")
            .tempfile_in(parent)?;
        let sidecars = SidecarCleanup(file.path().to_owned());
        Ok(Self {
            file,
            _sidecars: sidecars,
        })
    }
}

struct SidecarCleanup(PathBuf);
impl Drop for SidecarCleanup {
    fn drop(&mut self) {
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut path = self.0.as_os_str().to_owned();
            path.push(suffix);
            let _ = fs::remove_file(PathBuf::from(path));
        }
    }
}

fn sync_directory(parent: &Path) -> bool {
    #[cfg(unix)]
    {
        File::open(parent).and_then(|file| file.sync_all()).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = parent;
        false
    }
}
