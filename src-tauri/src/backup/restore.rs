//! Restore staging; verification, paths and restart transaction have separate owners.
mod archive;
mod journal;
mod paths;
mod rdp_pins;

use super::manifest::BackupManifest;
use archive::{verified_archive, verified_archive_with_context};
pub(crate) use journal::JOURNAL_FILE;
pub use journal::apply_pending_restore;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use tauri::AppHandle;

pub const RESTORE_INTENT_FILE: &str = "restore_intent.json";
pub const PENDING_RESTORE_DIR: &str = ".pending_restore";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRestoreResult {
    pub manifest: BackupManifest,
    pub restart_required: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RestoreIntent {
    staged_at: i64,
    manifest: BackupManifest,
}

pub(crate) fn inspect_archive_with_context(
    path: &Path,
    password: Option<&str>,
    context: &super::snapshot_context::SnapshotContext,
) -> Result<BackupManifest, String> {
    context.begin("verifying", None)?;
    verified_archive_with_context(path, password, context).map(|(manifest, _)| manifest)
}

pub fn inspect_archive(path: &Path, password: Option<&str>) -> Result<BackupManifest, String> {
    verified_archive(path, password).map(|(m, _)| m)
}
pub fn stage_restore(
    app: &AppHandle,
    path: &Path,
    password: Option<&str>,
) -> Result<StageRestoreResult, String> {
    stage_restore_to_dir(&crate::resolved_app_data_dir(app)?, path, password)
}

pub fn stage_restore_to_dir(
    app_data: &Path,
    path: &Path,
    password: Option<&str>,
) -> Result<StageRestoreResult, String> {
    let (manifest, mut archive) = verified_archive(path, password)?;
    super::plugins::check_restore_dependencies(app_data, &manifest)?;
    let plugin_entries = super::plugins::contracts::validate_manifest(&manifest)?;
    if app_data.join(RESTORE_INTENT_FILE).exists() || app_data.join(JOURNAL_FILE).exists() {
        return Err("A restore is already staged; restart before preparing another restore".into());
    }
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let temp = tempfile::Builder::new()
        .prefix(".restore-verify-")
        .tempdir_in(app_data)
        .map_err(|e| e.to_string())?;
    for entry in &manifest.files {
        let output = temp.path().join(&entry.path);
        std::fs::create_dir_all(output.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut out = File::create(&output).map_err(|e| e.to_string())?;
        std::io::copy(
            &mut archive.by_name(&entry.path).map_err(|e| e.to_string())?,
            &mut out,
        )
        .map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
        if super::plugins::contracts::is_sqlite(&plugin_entries, &entry.path) {
            let db = rusqlite::Connection::open_with_flags(
                &output,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|e| format!("Invalid SQLite backup: {e}"))?;
            let check: String = db
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if check != "ok" {
                return Err(format!("SQLite backup check failed: {check}"));
            }
        }
    }
    let temp_path = temp.keep();
    let pending = app_data.join(PENDING_RESTORE_DIR);
    if pending.exists() {
        std::fs::remove_dir_all(&pending).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp_path, &pending).map_err(|e| {
        let _ = std::fs::remove_dir_all(&temp_path);
        e.to_string()
    })?;
    let intent = RestoreIntent {
        staged_at: super::model::now_ms(),
        manifest: manifest.clone(),
    };
    super::control::write_json(&app_data.join(RESTORE_INTENT_FILE), &intent)?;
    Ok(StageRestoreResult {
        manifest,
        restart_required: true,
        message: "Backup verified and staged. Restart to restore.".into(),
    })
}
