use super::coordination::BackupProcessLock;
use super::crypto::is_encrypted_bytes;

use super::policy::{BackupPolicy, load_policy_result, resolve_backup_dir, save_policy};
use super::scheduler::{BackupCoordinator, BackupTrigger, is_backup_due};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

pub use super::archive_writer::{StagedFile, pack_staged_archive};
pub(super) use super::mail_snapshot::{portable_mail_paths, snapshot_mail};
pub use super::range::{BackupCustomOptions, BackupScopeFlags, resolve_scope_flags};
use super::{mail_snapshot::snapshot_mail_with_options, snapshot_context::SnapshotContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub file_path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub created_at: i64,
    pub scope: String,
    pub encrypted: bool,
    pub files_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntryInfo {
    pub file_name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub modified_at: i64,
    pub is_encrypted: bool,
}

/// Perform a hot backup of an active SQLite database using `VACUUM INTO`.
///
/// `dest_path` must not exist prior to executing VACUUM INTO.
pub fn hot_backup_conn(conn: &rusqlite::Connection, dest_path: &Path) -> Result<(), String> {
    super::snapshot_context::hot_backup_conn(conn, dest_path, &SnapshotContext::default())
}

/// Create a backup according to scope, options, target path and optional password.
pub fn create_backup(
    state: &AppState,
    app: &AppHandle,
    scope: &str,
    custom_options: Option<BackupCustomOptions>,
    target_path: Option<String>,
    password: Option<String>,
) -> Result<BackupResult, String> {
    create_backup_with_context(
        state,
        app,
        scope,
        custom_options,
        target_path,
        password,
        &SnapshotContext::default(),
    )
}

pub(crate) fn create_backup_with_context(
    state: &AppState,
    app: &AppHandle,
    scope: &str,
    custom_options: Option<BackupCustomOptions>,
    target_path: Option<String>,
    password: Option<String>,
    context: &SnapshotContext,
) -> Result<BackupResult, String> {
    let coordinator = app.state::<BackupCoordinator>();
    let _operation = context.lock(&coordinator.operation)?;
    let _process_operation = BackupProcessLock::acquire_cancellable(app, &context.cancel)?;
    create_backup_locked(
        state,
        app,
        scope,
        custom_options,
        target_path,
        password,
        load_policy_result(app)?,
        true,
        context,
    )
}

pub fn create_scheduled_backup(
    app: &AppHandle,
    trigger: BackupTrigger,
) -> Result<Option<BackupResult>, String> {
    create_scheduled_backup_with_context(app, trigger, &SnapshotContext::default(), None)
}

pub(crate) fn create_scheduled_backup_with_context(
    app: &AppHandle,
    trigger: BackupTrigger,
    context: &SnapshotContext,
    frozen: Option<&super::model::SourceSpec>,
) -> Result<Option<BackupResult>, String> {
    let coordinator = app.state::<BackupCoordinator>();
    let _operation = context.lock(&coordinator.operation)?;
    let _process_operation = BackupProcessLock::acquire_cancellable(app, &context.cancel)?;
    let policy = super::policy::load_policy_result(app)?;
    // Recheck inside both locks: any instance may have just completed a backup.
    if !policy.local_channel_enabled
        || !is_backup_due(&policy, chrono::Utc::now().timestamp_millis(), trigger)
    {
        return Ok(None);
    }
    let state = app.state::<AppState>();
    let range = policy
        .local_range_override
        .clone()
        .unwrap_or_else(|| super::range::global(&policy));
    let range = frozen
        .map(|s| super::range::BackupRange {
            scope: s.scope.clone(),
            custom_options: s.custom_options.clone(),
        })
        .unwrap_or(range);
    create_backup_locked(
        &state,
        app,
        &range.scope,
        range.custom_options,
        None,
        None,
        policy,
        true,
        context,
    )
    .map(Some)
}

pub fn create_cloud_snapshot(
    app: &AppHandle,
    source: &super::model::SourceSpec,
    path: String,
    password: String,
) -> Result<BackupResult, String> {
    create_cloud_snapshot_with_context(app, source, path, password, &SnapshotContext::default())
}

pub(crate) fn create_cloud_snapshot_with_context(
    app: &AppHandle,
    source: &super::model::SourceSpec,
    path: String,
    password: String,
    context: &SnapshotContext,
) -> Result<BackupResult, String> {
    let coordinator = app.state::<BackupCoordinator>();
    let _operation = context.lock(&coordinator.operation)?;
    let _process_operation = BackupProcessLock::acquire_cancellable(app, &context.cancel)?;
    if crate::resolved_app_data_dir(app)?
        .join(super::restore::RESTORE_INTENT_FILE)
        .exists()
    {
        return Err("A restore is staged; restart before creating cloud backups".into());
    }
    create_backup_locked(
        &app.state::<AppState>(),
        app,
        &source.scope,
        source.custom_options.clone(),
        Some(path),
        Some(password),
        load_policy_result(app)?,
        false,
        context,
    )
}

fn create_backup_locked(
    state: &AppState,
    app: &AppHandle,
    scope: &str,
    custom_options: Option<BackupCustomOptions>,
    target_path: Option<String>,
    password: Option<String>,
    policy: BackupPolicy,
    update_local_policy: bool,
    context: &SnapshotContext,
) -> Result<BackupResult, String> {
    context.begin("snapshotting", None)?;
    let app_data = crate::resolved_app_data_dir(app)?;

    let resolved_target_dir = resolve_backup_dir(app, &policy);

    let now = chrono::Local::now();
    let timestamp_str = now.format("%Y%m%d_%H%M%S").to_string();
    let default_filename = format!(
        "taomni_backup_{timestamp_str}_{}.taobak",
        uuid::Uuid::new_v4().simple()
    );

    let out_file_path = match target_path {
        Some(custom) if !custom.trim().is_empty() => PathBuf::from(custom.trim()),
        _ => resolved_target_dir.join(&default_filename),
    };

    if let Some(parent) = out_file_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create backup destination directory: {e}"))?;
    }

    let temp_staging_dir =
        app_data.join(format!(".backup_staging_{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&temp_staging_dir)
        .map_err(|e| format!("create staging directory: {e}"))?;

    // Clean up temporary directory on return
    let _cleanup_guard = scopeguard::guard(temp_staging_dir.clone(), |dir| {
        let _ = std::fs::remove_dir_all(dir);
    });

    let mut staged_files: Vec<StagedFile> = Vec::new();

    // Determine what to include based on scope
    let flags = resolve_scope_flags(scope, custom_options);

    let mail_paths = if flags.mail {
        Some(context.lock(&state.mail.mail_archive.changes)?)
    } else {
        None
    };

    // 1. taomni.db
    context.check()?;
    if flags.sessions {
        let snap_dest = temp_staging_dir.join("taomni.db");
        let conn = context.lock(&state.db)?;
        super::snapshot_context::hot_backup_conn(&conn, &snap_dest, context)?;
        drop(conn);
        portable_mail_paths(&rusqlite::Connection::open(&snap_dest).map_err(|e| e.to_string())?)?;
        staged_files.push(StagedFile {
            archive_path: "databases/taomni.db".into(),
            disk_path: snap_dest,
        });
    }

    // 2. notes.db
    context.check()?;
    if flags.notes {
        let snap_dest = temp_staging_dir.join("notes.db");
        let conn = context.lock(&state.notes_db)?;
        super::snapshot_context::hot_backup_conn(&conn, &snap_dest, context)?;
        staged_files.push(StagedFile {
            archive_path: "databases/notes.db".into(),
            disk_path: snap_dest,
        });
    }

    // 3. vault.db
    context.check()?;
    if flags.vault {
        let snap_dest = temp_staging_dir.join("vault.db");
        state.vault.backup_to_with_context(&snap_dest, context)?;
        staged_files.push(StagedFile {
            archive_path: "databases/vault.db".into(),
            disk_path: snap_dest,
        });
    }

    // 3b. mfa.db (skipped when MFA was never used on this profile)
    context.check()?;
    if flags.mfa {
        let snap_dest = temp_staging_dir.join("mfa.db");
        if state.mfa.backup_to_with_context(&snap_dest, context)? {
            staged_files.push(StagedFile {
                archive_path: "databases/mfa.db".into(),
                disk_path: snap_dest,
            });
        }
    }

    // 4. lanchat.sqlite
    context.check()?;
    if flags.lanchat {
        let snap_dest = temp_staging_dir.join("lanchat.sqlite");
        state.lanchat.backup_to_with_context(&snap_dest, context)?;
        staged_files.push(StagedFile {
            archive_path: "databases/lanchat.sqlite".into(),
            disk_path: snap_dest,
        });
    }

    // 5. Config files
    context.check()?;
    if flags.configs {
        if let Some(cfg_base) = dirs::config_dir() {
            let taomni_cfg_dir = cfg_base.join("taomni");
            for cfg_name in &["ai.json", "proxy.json", "mirror.json", "sdk.json"] {
                let src = taomni_cfg_dir.join(cfg_name);
                if src.is_file() {
                    staged_files.push(StagedFile {
                        archive_path: format!("configs/{cfg_name}"),
                        disk_path: src,
                    });
                }
            }
        }
        let tunnels_path = app_data.join("tunnels.json");
        if tunnels_path.is_file() {
            staged_files.push(StagedFile {
                archive_path: "configs/tunnels.json".into(),
                disk_path: tunnels_path,
            });
        }
    }

    // 6. Consistent per-account snapshots, including custom locations and
    // immutable MIME objects pinned before releasing the account lock.
    context.check()?;
    if flags.mail {
        let sessions = {
            let db = context.lock(&state.db)?;
            crate::session::db::list_sessions(&db, None).map_err(|e| e.to_string())?
        };
        let mut covered = std::collections::HashSet::new();
        for session in sessions
            .into_iter()
            .filter(|s| s.session_type == crate::session::models::SessionType::Mail)
        {
            let stem = crate::state::mail_db_file_stem(&session.id);
            let directory = crate::mail::storage::configured_directory(
                &session.options_json,
                state.mail_cache_root(),
            )?;
            let configured_db = directory.join(format!("{stem}.db"));
            if !configured_db.is_file()
                && !crate::mail::coordination::redirect_path(&configured_db).is_file()
            {
                continue;
            }
            let handle = state.mail_db(&session.id)?;
            let db = handle.lock_for_snapshot(&context.cancel)?;
            staged_files.extend(snapshot_mail_with_options(
                &db,
                Some(&session.id),
                &temp_staging_dir,
                flags,
                context,
            )?);
            covered.insert(format!("{stem}.db"));
        }
        // Older/local sessions may no longer be in the session tree.
        if state.mail_cache_root().is_dir() {
            for entry in std::fs::read_dir(state.mail_cache_root()).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if !path.is_file()
                    || path.extension().is_none_or(|ext| ext != "db")
                    || covered.contains(&name)
                {
                    continue;
                }
                let handle = crate::mail::coordination::MailDatabase::new(path);
                let db = handle.lock_for_snapshot(&context.cancel)?;
                let account = super::mail_snapshot::snapshot_account(&db)?;
                staged_files.extend(snapshot_mail_with_options(
                    &db,
                    account.as_deref(),
                    &temp_staging_dir,
                    flags,
                    context,
                )?);
            }
        }
    }

    drop(mail_paths);

    // 7. Local history snapshots
    context.check()?;
    if flags.local_history {
        let history_db = app_data.join("local-history").join("history.db");
        if history_db.is_file() {
            staged_files.push(StagedFile {
                archive_path: "local-history/history.db".into(),
                disk_path: history_db,
            });
        }
    }

    // 8. Server certificates / keys (core and full scope)
    context.check()?;
    if flags.server_certificates {
        let ssh_key = app_data.join("ssh-server").join("host_ed25519");
        if ssh_key.is_file() {
            staged_files.push(StagedFile {
                archive_path: "servers/ssh_host_ed25519".into(),
                disk_path: ssh_key,
            });
        }
        let rdp_cert = app_data.join("rdp-server").join("cert.pem");
        if rdp_cert.is_file() {
            staged_files.push(StagedFile {
                archive_path: "servers/rdp_cert.pem".into(),
                disk_path: rdp_cert,
            });
        }
        let rdp_key = app_data.join("rdp-server").join("key.pem");
        if rdp_key.is_file() {
            staged_files.push(StagedFile {
                archive_path: "servers/rdp_key.pem".into(),
                disk_path: rdp_key,
            });
        }
    }

    let app_version = app.package_info().version.to_string();
    let device = super::control::load(app)?.device;
    let provenance = super::model::Provenance {
        snapshot_id: uuid::Uuid::new_v4().to_string(),
        device_id: device.id,
        device_name: device.name,
        source_kind: "taomni".into(),
        source_schema_version: 1,
    };
    let (manifest, file_size) = super::archive_writer::pack_staged_archive_with_provenance(
        &staged_files,
        &app_version,
        scope,
        password.as_deref(),
        &out_file_path,
        Some(provenance),
        context,
    )?;

    // If backup was written into the configured backup directory, perform retention rotation
    if out_file_path.starts_with(&resolved_target_dir) {
        if let Err(error) = rotate_backups(&resolved_target_dir, policy.max_retained_copies) {
            tracing::warn!(target: "backup", %error, "Backup retention cleanup failed");
        }
    }

    // Publication is the commit point. A late cancellation must not report a
    // cancelled task after the completed archive has replaced its destination.
    let mut updated_policy = policy;
    updated_policy.last_backup_at = Some(manifest.created_at);
    if update_local_policy {
        if let Err(error) = save_policy(app, &updated_policy) {
            tracing::error!(target: "backup", %error, "Archive completed but backup time could not be saved");
        }
    }

    let result = BackupResult {
        file_path: out_file_path.to_string_lossy().into_owned(),
        file_name: out_file_path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| default_filename.clone()),
        size_bytes: file_size,
        created_at: manifest.created_at,
        scope: scope.to_string(),
        encrypted: manifest.encrypted,
        files_count: manifest.files.len(),
    };

    if let Err(error) = app.emit("backup-completed", &result) {
        tracing::warn!(target: "backup", %error, "Failed to notify backup completion");
    }
    Ok(result)
}

/// List all backup files in the specified directory.
pub fn list_backups(backup_dir: &Path) -> Result<Vec<BackupEntryInfo>, String> {
    if !backup_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut list = Vec::new();
    let entries = std::fs::read_dir(backup_dir).map_err(|e| format!("read backup dir: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let is_taobak = path
                .extension()
                .is_some_and(|ext| ext == "taobak" || ext == "zip");
            if is_taobak {
                let meta = entry.metadata().ok();
                let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified_at = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);

                let mut is_encrypted = false;
                if let Ok(mut f) = File::open(&path) {
                    let mut header = [0u8; 13];
                    if f.read_exact(&mut header).is_ok() {
                        is_encrypted = is_encrypted_bytes(&header);
                    }
                }

                list.push(BackupEntryInfo {
                    file_name: entry.file_name().to_string_lossy().into_owned(),
                    file_path: path.to_string_lossy().into_owned(),
                    size_bytes,
                    modified_at,
                    is_encrypted,
                });
            }
        }
    }

    list.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(list)
}

/// Retain only the newest `max_copies` backup archives in the given directory.
pub fn rotate_backups(backup_dir: &Path, max_copies: u32) -> Result<(), String> {
    if max_copies == 0 {
        return Ok(());
    }
    let backups = list_backups(backup_dir)?;
    if backups.len() > max_copies as usize {
        for old in &backups[max_copies as usize..] {
            let path = PathBuf::from(&old.file_path);
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// Delete a specific backup file by filename inside the target backup directory.
pub fn delete_backup_item(backup_dir: &Path, file_name: &str) -> Result<(), String> {
    let clean_name = Path::new(file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;

    let target = backup_dir.join(clean_name);
    if target.is_file() {
        std::fs::remove_file(&target)
            .map_err(|e| format!("delete backup file {}: {e}", target.display()))?;
        Ok(())
    } else {
        Err(format!("Backup file not found: {}", clean_name))
    }
}
