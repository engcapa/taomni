use super::coordination::BackupProcessLock;
use super::crypto::{encrypt_payload, is_encrypted_bytes};
use super::manifest::{BackupManifest, file_sha256};
use super::policy::{BackupPolicy, load_policy, resolve_backup_dir, save_policy};
use super::scheduler::{BackupCoordinator, BackupTrigger, is_backup_due};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCustomOptions {
    #[serde(default)]
    pub include_sessions: bool,
    #[serde(default)]
    pub include_notes: bool,
    #[serde(default)]
    pub include_vault: bool,
    #[serde(default)]
    pub include_lanchat: bool,
    #[serde(default)]
    pub include_configs: bool,
    #[serde(default)]
    pub include_mail: bool,
    #[serde(default)]
    pub include_local_history: bool,
    #[serde(default)]
    pub include_mfa: bool,
}

/// What a backup scope stages. MFA secrets are sealed with a data key held in
/// the vault, so including `mfa.db` always includes `vault.db` as well.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupScopeFlags {
    pub sessions: bool,
    pub notes: bool,
    pub vault: bool,
    pub lanchat: bool,
    pub configs: bool,
    pub mail: bool,
    pub local_history: bool,
    pub mfa: bool,
}

pub fn resolve_scope_flags(scope: &str, custom: Option<BackupCustomOptions>) -> BackupScopeFlags {
    let core = BackupScopeFlags {
        sessions: true,
        notes: true,
        vault: true,
        lanchat: false,
        configs: true,
        mail: false,
        local_history: false,
        mfa: true,
    };
    let mut flags = match scope {
        "full" => BackupScopeFlags {
            lanchat: true,
            mail: true,
            ..core
        },
        "custom" => match custom {
            Some(opts) => BackupScopeFlags {
                sessions: opts.include_sessions,
                notes: opts.include_notes,
                vault: opts.include_vault,
                lanchat: opts.include_lanchat,
                configs: opts.include_configs,
                mail: opts.include_mail,
                local_history: opts.include_local_history,
                mfa: opts.include_mfa,
            },
            None => core,
        },
        _ => core,
    };
    if flags.mfa {
        flags.vault = true;
    }
    flags
}

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
        load_policy(app),
    )
}

pub fn create_scheduled_backup(
    app: &AppHandle,
    trigger: BackupTrigger,
) -> Result<Option<BackupResult>, String> {
    let coordinator = app.state::<BackupCoordinator>();
    let _operation = coordinator.operation.lock().map_err(|e| e.to_string())?;
    let _process_operation = BackupProcessLock::acquire(app)?;
    let policy = load_policy(app);
    // Recheck inside both locks: any instance may have just completed a backup.
    if !is_backup_due(&policy, chrono::Utc::now().timestamp_millis(), trigger) {
        return Ok(None);
    }
    let state = app.state::<AppState>();
    let scope = policy.default_scope.clone();
    create_backup_locked(&state, app, &scope, None, None, None, policy).map(Some)
}

fn create_backup_locked(
    state: &AppState,
    app: &AppHandle,
    scope: &str,
    custom_options: Option<BackupCustomOptions>,
    target_path: Option<String>,
    password: Option<String>,
    policy: BackupPolicy,
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

    // 1. taomni.db
    if flags.sessions {
        let snap_dest = temp_staging_dir.join("taomni.db");
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        hot_backup_conn(&conn, &snap_dest)?;
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

    // 6. Mail cache databases
    if flags.mail {
        let mail_dir = app_data.join("mail-cache");
        if mail_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&mail_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() && path.extension().is_some_and(|ext| ext == "db") {
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            staged_files.push(StagedFile {
                                archive_path: format!("mail-cache/{name}"),
                                disk_path: path,
                            });
                        }
                    }
                }
            }
        }
    }

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
    let (manifest, file_size) = pack_staged_archive(
        &staged_files,
        &app_version,
        scope,
        password.as_deref(),
        &out_file_path,
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
    save_policy(app, &updated_policy)?;

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
    let is_encrypted = password.as_ref().is_some_and(|p| !p.trim().is_empty());
    let mut manifest =
        BackupManifest::new(app_version.to_string(), scope.to_string(), is_encrypted);

    // Build in-memory Zip archive
    let mut zip_buffer = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut zip_buffer);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        for staged in staged_files {
            let sha256 = file_sha256(&staged.disk_path)
                .map_err(|e| format!("calculate sha256 for {}: {e}", staged.disk_path.display()))?;
            let size = std::fs::metadata(&staged.disk_path)
                .map(|m| m.len())
                .unwrap_or(0);

            manifest.add_file(staged.archive_path.clone(), sha256, size);

            zip.start_file(&staged.archive_path, options)
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

    let raw_zip_bytes = zip_buffer.into_inner();
    let final_bytes = if let Some(pw) = password {
        if !pw.trim().is_empty() {
            encrypt_payload(&raw_zip_bytes, pw.trim())?
        } else {
            raw_zip_bytes
        }
    } else {
        raw_zip_bytes
    };

    if let Some(parent) = out_file_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Other instances can read history while this archive is being written.
    // Publish the complete file with a rename in its destination directory.
    let pending_path = out_file_path.with_file_name(format!(
        ".backup_output_{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let _cleanup = scopeguard::guard(pending_path.clone(), |path| {
        let _ = std::fs::remove_file(path);
    });
    std::fs::write(&pending_path, &final_bytes)
        .map_err(|e| format!("write backup output file {}: {e}", out_file_path.display()))?;
    std::fs::rename(&pending_path, out_file_path).map_err(|e| {
        format!(
            "publish backup output file {}: {e}",
            out_file_path.display()
        )
    })?;

    let file_size = final_bytes.len() as u64;
    Ok((manifest, file_size))
}
