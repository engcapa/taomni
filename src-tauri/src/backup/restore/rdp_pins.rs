//! Legacy core backups carried RDP pins inside the session database.
use std::path::{Path, PathBuf};

use super::super::manifest::{BackupManifest, file_sha256};
use super::paths::no_symlink_ancestors;
use crate::plugin::migration_rdp_pins::{export_for_restore, owns_profile_pins};
use taomni_rdp_client_api::SLUG;

pub(super) struct StagedPins {
    pub(super) database: PathBuf,
    _staging: tempfile::TempDir,
}

pub(super) fn stage(
    profile: &Path,
    pending: &Path,
    manifest: &BackupManifest,
) -> Result<Option<StagedPins>, String> {
    let Some(core) = manifest
        .files
        .iter()
        .find(|entry| entry.path == "databases/taomni.db")
    else {
        return Ok(None);
    };
    if manifest
        .plugin_datasets
        .iter()
        .any(|data| data.slug == SLUG)
        || !owns_profile_pins(profile)?
    {
        return Ok(None);
    }
    let source = pending.join(&core.path);
    no_symlink_ancestors(&source)?;
    if file_sha256(&source).map_err(|error| error.to_string())? != core.sha256
        || std::fs::metadata(&source)
            .map_err(|error| error.to_string())?
            .len()
            != core.size_bytes
    {
        return Err("Staged core backup changed".into());
    }
    let staging = tempfile::Builder::new()
        .prefix(".core-rdp-pins-")
        .tempdir_in(pending)
        .map_err(|error| error.to_string())?;
    Ok(
        export_for_restore(&source, staging.path())?.map(|database| StagedPins {
            database,
            _staging: staging,
        }),
    )
}
