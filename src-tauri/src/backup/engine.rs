use super::coordination::BackupProcessLock;
use super::crypto::{encrypt_stream, is_encrypted_bytes};
use super::manifest::{BackupManifest, file_sha256};
use super::policy::{BackupPolicy, load_policy_result, resolve_backup_dir, save_policy};
use super::scheduler::{BackupCoordinator, BackupTrigger, is_backup_due};
use crate::state::AppState;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

pub use super::range::{BackupCustomOptions, BackupScopeFlags, resolve_scope_flags};

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
    if dest_path.exists() {
        let _ = std::fs::remove_file(dest_path);
    }
    let dest_str = dest_path.to_str().ok_or("invalid destination path")?;
    conn.execute("VACUUM INTO ?1", rusqlite::params![dest_str])
        .map_err(|e| format!("sqlite VACUUM INTO failed for {}: {e}", dest_path.display()))?;
    Ok(())
}

/// Helper struct for staging files before compressing into the backup archive.
#[derive(Debug, Clone)]
pub struct StagedFile {
    pub archive_path: String,
    pub disk_path: PathBuf,
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
    let coordinator = app.state::<BackupCoordinator>();
    let _operation = coordinator.operation.lock().map_err(|e| e.to_string())?;
    let _process_operation = BackupProcessLock::acquire(app)?;
    create_backup_locked(
        state,
        app,
        scope,
        custom_options,
        target_path,
        password,
        load_policy_result(app)?,
        true,
    )
}

pub fn create_scheduled_backup(
    app: &AppHandle,
    trigger: BackupTrigger,
) -> Result<Option<BackupResult>, String> {
    let coordinator = app.state::<BackupCoordinator>();
    let _operation = coordinator.operation.lock().map_err(|e| e.to_string())?;
    let _process_operation = BackupProcessLock::acquire(app)?;
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
    create_backup_locked(
        &state,
        app,
        &range.scope,
        range.custom_options,
        None,
        None,
        policy,
        true,
    )
    .map(Some)
}

pub fn create_cloud_snapshot(
    app: &AppHandle,
    source: &super::model::SourceSpec,
    path: String,
    password: String,
) -> Result<BackupResult, String> {
    let coordinator = app.state::<BackupCoordinator>();
    let _operation = coordinator.operation.lock().map_err(|e| e.to_string())?;
    let _process_operation = BackupProcessLock::acquire(app)?;
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
) -> Result<BackupResult, String> {
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

    let mail_paths = state
        .mail
        .mail_archive
        .changes
        .lock()
        .map_err(|e| e.to_string())?;

    // 1. taomni.db
    if flags.sessions {
        let snap_dest = temp_staging_dir.join("taomni.db");
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        hot_backup_conn(&conn, &snap_dest)?;
        drop(conn);
        portable_mail_paths(&rusqlite::Connection::open(&snap_dest).map_err(|e| e.to_string())?)?;
        staged_files.push(StagedFile {
            archive_path: "databases/taomni.db".into(),
            disk_path: snap_dest,
        });
    }

    // 2. notes.db
    if flags.notes {
        let snap_dest = temp_staging_dir.join("notes.db");
        let conn = state.notes_db.lock().map_err(|e| e.to_string())?;
        hot_backup_conn(&conn, &snap_dest)?;
        staged_files.push(StagedFile {
            archive_path: "databases/notes.db".into(),
            disk_path: snap_dest,
        });
    }

    // 3. vault.db
    if flags.vault {
        let snap_dest = temp_staging_dir.join("vault.db");
        state.vault.backup_to(&snap_dest)?;
        staged_files.push(StagedFile {
            archive_path: "databases/vault.db".into(),
            disk_path: snap_dest,
        });
    }

    // 3b. mfa.db (skipped when MFA was never used on this profile)
    if flags.mfa {
        let snap_dest = temp_staging_dir.join("mfa.db");
        if state.mfa.backup_to(&snap_dest)? {
            staged_files.push(StagedFile {
                archive_path: "databases/mfa.db".into(),
                disk_path: snap_dest,
            });
        }
    }

    // 4. lanchat.sqlite
    if flags.lanchat {
        let snap_dest = temp_staging_dir.join("lanchat.sqlite");
        state.lanchat.backup_to(&snap_dest)?;
        staged_files.push(StagedFile {
            archive_path: "databases/lanchat.sqlite".into(),
            disk_path: snap_dest,
        });
    }

    // 5. Config files
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
    if flags.mail {
        let sessions = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
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
            let db = handle.lock().map_err(|e| e.to_string())?;
            crate::mail::init_mail_tables(&db).map_err(|e| e.to_string())?;
            staged_files.extend(snapshot_mail(&db, Some(&session.id), &temp_staging_dir)?);
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
                let db = handle.lock()?;
                let account:Option<String>=db.query_row("SELECT account_id FROM mail_messages UNION SELECT account_id FROM mail_full_messages LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
                staged_files.extend(snapshot_mail(&db, account.as_deref(), &temp_staging_dir)?);
            }
        }
    }

    drop(mail_paths);

    // 7. Local history snapshots
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
    if scope == "core" || scope == "full" {
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
    let (manifest, file_size) = pack_staged_archive_with_provenance(
        &staged_files,
        &app_version,
        scope,
        password.as_deref(),
        &out_file_path,
        Some(provenance),
    )?;

    // If backup was written into the configured backup directory, perform retention rotation
    if out_file_path.starts_with(&resolved_target_dir) {
        if let Err(error) = rotate_backups(&resolved_target_dir, policy.max_retained_copies) {
            tracing::warn!(target: "backup", %error, "Backup retention cleanup failed");
        }
    }

    // Update policy last backup time
    let mut updated_policy = policy;
    updated_policy.last_backup_at = Some(manifest.created_at);
    if update_local_policy {
        save_policy(app, &updated_policy)?;
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

/// Package staged files into a zip archive with manifest and optional encryption.
pub fn pack_staged_archive(
    staged_files: &[StagedFile],
    app_version: &str,
    scope: &str,
    password: Option<&str>,
    out_file_path: &Path,
) -> Result<(BackupManifest, u64), String> {
    pack_staged_archive_with_provenance(
        staged_files,
        app_version,
        scope,
        password,
        out_file_path,
        None,
    )
}

fn pack_staged_archive_with_provenance(
    staged_files: &[StagedFile],
    app_version: &str,
    scope: &str,
    password: Option<&str>,
    out_file_path: &Path,
    provenance: Option<super::model::Provenance>,
) -> Result<(BackupManifest, u64), String> {
    let is_encrypted = password.as_ref().is_some_and(|p| !p.trim().is_empty());
    let mut manifest =
        BackupManifest::new(app_version.to_string(), scope.to_string(), is_encrypted);
    manifest.provenance = provenance;

    let parent = out_file_path.parent().ok_or("Invalid backup destination")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut zip_buffer = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    {
        let mut zip = ZipWriter::new(zip_buffer.as_file_mut());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        for staged in staged_files {
            let sha256 = file_sha256(&staged.disk_path)
                .map_err(|e| format!("calculate sha256 for {}: {e}", staged.disk_path.display()))?;
            let size = std::fs::metadata(&staged.disk_path)
                .map(|m| m.len())
                .unwrap_or(0);

            manifest.add_file(staged.archive_path.clone(), sha256, size);

            zip.start_file(
                &staged.archive_path,
                options
                    .large_file(size >= u32::MAX as u64)
                    .compression_method(if staged.archive_path.ends_with(".eml.gz") {
                        CompressionMethod::Stored
                    } else {
                        CompressionMethod::Deflated
                    }),
            )
            .map_err(|e| format!("start zip file {}: {e}", staged.archive_path))?;

            let mut f = File::open(&staged.disk_path)
                .map_err(|e| format!("open staged file {}: {e}", staged.disk_path.display()))?;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = f.read(&mut buf).map_err(|e| format!("read file: {e}"))?;
                if n == 0 {
                    break;
                }
                zip.write_all(&buf[..n])
                    .map_err(|e| format!("write to zip: {e}"))?;
            }
        }

        // Add manifest.json to the zip archive
        let manifest_bytes = manifest
            .to_json_bytes()
            .map_err(|e| format!("serialize manifest: {e}"))?;
        zip.start_file(super::manifest::MANIFEST_FILE_NAME, options)
            .map_err(|e| format!("start manifest in zip: {e}"))?;
        zip.write_all(&manifest_bytes)
            .map_err(|e| format!("write manifest to zip: {e}"))?;

        zip.finish().map_err(|e| format!("finish zip: {e}"))?;
    }

    zip_buffer
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|e| e.to_string())?;
    let mut output = if let Some(pw) = password.filter(|pw| !pw.trim().is_empty()) {
        let mut encrypted = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        encrypt_stream(zip_buffer.as_file_mut(), pw.trim(), encrypted.as_file_mut())?;
        encrypted
    } else {
        zip_buffer
    };
    output.as_file_mut().sync_all().map_err(|e| e.to_string())?;
    let file_size = output
        .as_file()
        .metadata()
        .map_err(|e| e.to_string())?
        .len();
    let _cache_reservation = super::cache::reserve(out_file_path, file_size)?;
    output
        .persist(out_file_path)
        .map_err(|e| format!("Publish backup: {}", e.error))?;

    Ok((manifest, file_size))
}

/// A backup is portable: it must never restore an old machine's external paths.
pub(super) fn portable_mail_paths(db: &rusqlite::Connection) -> Result<(), String> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(());
    }
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(sessions)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(1))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    if !["id", "session_type", "options_json"]
        .iter()
        .all(|name| columns.iter().any(|col| col == name))
    {
        return Ok(());
    }
    let sessions: Vec<(String, String)> = db
        .prepare("SELECT id,options_json FROM sessions WHERE session_type='Mail'")
        .map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    for (id, options) in sessions {
        let mut options: serde_json::Value =
            serde_json::from_str(&options).map_err(|e| e.to_string())?;
        if let Some(obj) = options.as_object_mut() {
            obj.remove("mailStorageDirectory");
        }
        db.execute(
            "UPDATE sessions SET options_json=?1 WHERE id=?2",
            rusqlite::params![options.to_string(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn snapshot_mail(
    db: &rusqlite::Connection,
    account: Option<&str>,
    staging: &Path,
) -> Result<Vec<StagedFile>, String> {
    let source = Path::new(db.path().ok_or("Mail DB has no path")?);
    let filename = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("Invalid mail DB name")?;
    let target = staging.join("mail-cache").join(filename);
    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    hot_backup_conn(db, &target)?;
    let mut files = vec![StagedFile {
        archive_path: format!("mail-cache/{filename}"),
        disk_path: target,
    }];
    if let Some(account) = account {
        let stem = crate::state::mail_db_file_stem(account);
        let prefix = format!("mail-cache/{stem}.mail");
        for (relative, disk_path) in
            crate::mail::storage::snapshot_objects(db, account, &staging.join(&prefix))?
        {
            files.push(StagedFile {
                archive_path: format!("{prefix}/{}", relative.to_string_lossy().replace('\\', "/")),
                disk_path,
            });
        }
        let attachments = source.parent().unwrap().join("attachments").join(&stem);
        snapshot_attachment_tree(
            &attachments,
            &format!("mail-cache/attachments/{stem}"),
            staging,
            &mut files,
        )?;
    }
    Ok(files)
}

fn snapshot_attachment_tree(
    source: &Path,
    prefix: &str,
    staging: &Path,
    files: &mut Vec<StagedFile>,
) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("Cannot back up symbolic links in mail storage".into());
        }
        let path = format!("{prefix}/{}", entry.file_name().to_string_lossy());
        if kind.is_dir() {
            snapshot_attachment_tree(&entry.path(), &path, staging, files)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "bin") {
            let target = staging.join(&path);
            std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            if std::fs::hard_link(entry.path(), &target).is_err() {
                std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
            }
            files.push(StagedFile {
                archive_path: path,
                disk_path: target,
            });
        }
    }
    Ok(())
}
