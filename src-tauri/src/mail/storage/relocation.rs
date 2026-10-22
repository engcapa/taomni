use super::reading::open;
#[cfg(test)]
use super::reading::read;
use rusqlite::Connection;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

pub fn configured_directory(options: &str, default: &Path) -> Result<PathBuf, String> {
    let options: serde_json::Value = serde_json::from_str(options).map_err(|e| e.to_string())?;
    let directory = options
        .get("mailStorageDirectory")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if directory.is_empty() {
        return Ok(default.to_path_buf());
    }
    let path = PathBuf::from(directory);
    if !path.is_absolute() {
        return Err("Mail storage directory must be an absolute path".into());
    }
    Ok(path)
}

pub(super) fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("Mail storage migration cannot follow symbolic links".into());
        }
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else if kind.is_file() {
            if fs::hard_link(entry.path(), &destination).is_err() {
                fs::copy(entry.path(), destination).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// The shared handle stays the same: requests waiting on it use the new
/// connection after relocation, rather than writing to a detached old DB.
pub fn save_mail_session(
    state: &crate::state::AppState,
    config: &crate::session::models::SessionConfig,
) -> Result<(), String> {
    let target_root = configured_directory(&config.options_json, state.mail_cache_root())?;
    let _changes = state
        .mail
        .mail_archive
        .changes
        .lock()
        .map_err(|e| e.to_string())?;
    state.mail.mail_archive.stop_account(&config.id)?;
    let handle = state.mail_db(&config.id)?;
    let mut db = handle.lock().map_err(|e| e.to_string())?;
    let _worker = super::super::coordination::ProcessLock::try_at(
        Path::new(db.path().ok_or("Mail storage has no disk path")?), "archive",
    )?.ok_or("Another Taomni instance is storing this mailbox. Pause full storage and retry saving its settings")?;
    relocate(&mut db, &config.id, &target_root, || {
        let main_db = state.db.lock().map_err(|e| e.to_string())?;
        crate::session::db::save_session(&main_db, config).map_err(|e| e.to_string())
    })
}

pub(in crate::mail) fn relocate(
    db: &mut Connection,
    account: &str,
    target_root: &Path,
    persist_settings: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    super::super::init_mail_tables(db).map_err(|e| e.to_string())?;
    let source = PathBuf::from(db.path().ok_or("Mail storage has no disk path")?);
    fs::create_dir_all(&target_root).map_err(|e| format!("Create mail storage directory: {e}"))?;
    let target_root = target_root.canonicalize().map_err(|e| e.to_string())?;
    let source_root = source
        .parent()
        .unwrap()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if source_root == target_root {
        return persist_settings();
    }
    let stem = crate::state::mail_db_file_stem(account);
    let target_db = target_root.join(format!("{stem}.db"));
    let _target_lock = super::super::coordination::ProcessLock::access(&target_db)?;
    let _target_worker = super::super::coordination::ProcessLock::try_at(&target_db, "archive")?
        .ok_or("Another Taomni instance is using the destination mailbox")?;
    let target_objects = target_root.join(format!("{stem}.mail"));
    let target_attachments = target_root.join("attachments").join(&stem);
    if target_db.exists() || target_objects.exists() || target_attachments.exists() {
        return Err("The selected directory already contains this mailbox. Choose an empty location; existing mail will not be overwritten".into());
    }
    if target_root.starts_with(source_root.join(format!("{stem}.mail")))
        || target_root.starts_with(source_root.join("attachments").join(&stem))
    {
        return Err("Choose a storage directory outside this account's existing mail files".into());
    }
    let staging = tempfile::Builder::new()
        .prefix(".mail-move-")
        .tempdir_in(&target_root)
        .map_err(|e| e.to_string())?;
    let staged_db = staging.path().join("mail.db");
    db.execute("VACUUM INTO ?1", [staged_db.to_string_lossy().as_ref()])
        .map_err(|e| format!("Snapshot mail storage: {e}"))?;
    let source_objects = source_root.join(format!("{stem}.mail"));
    let source_attachments = source_root.join("attachments").join(&stem);
    copy_tree(&source_objects, &staging.path().join("objects"))?;
    copy_tree(&source_attachments, &staging.path().join("attachments"))?;
    // Only paths created by this migration are rolled back on failure.
    let mut created = Vec::new();
    let target_redirect = super::super::coordination::redirect_path(&target_db);
    let previous_redirect = if target_redirect.exists() {
        Some(fs::read(&target_redirect).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let publication = (|| -> Result<Connection, String> {
        for (from, to) in [
            (staging.path().join("objects"), target_objects.clone()),
            (
                staging.path().join("attachments"),
                target_attachments.clone(),
            ),
        ] {
            if from.exists() {
                fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::rename(from, &to).map_err(|e| e.to_string())?;
                created.push(to);
            }
        }
        fs::rename(&staged_db, &target_db).map_err(|e| e.to_string())?;
        created.push(target_db.clone());
        let replacement = Connection::open(&target_db).map_err(|e| e.to_string())?;
        let integrity: String = replacement
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if integrity != "ok" {
            return Err("Migrated mail database failed integrity verification".into());
        }
        // Both directories are locked. Publish a durable redirect before
        // changing settings so cached connections in other processes follow it.
        // Moving back to a previously used directory must not form a cycle.
        if previous_redirect.is_some() {
            fs::remove_file(&target_redirect).map_err(|e| e.to_string())?;
        }
        super::super::coordination::write_redirect(&source, &target_db)?;
        if let Err(error) = persist_settings() {
            let _ = fs::remove_file(super::super::coordination::redirect_path(&source));
            return Err(error);
        }
        Ok(replacement)
    })();
    match publication {
        Err(error) => {
            if let Some(bytes) = previous_redirect {
                let _ = fs::write(target_redirect, bytes);
            }
            for path in created.into_iter().rev() {
                if path.is_dir() {
                    let _ = fs::remove_dir_all(path);
                } else {
                    let _ = fs::remove_file(path);
                }
            }
            return Err(error);
        }
        Ok(replacement) => {
            *db = replacement;
        }
    }
    // The old SQLite connection has been closed before removing its files.
    for path in [
        source.clone(),
        PathBuf::from(format!("{}-wal", source.display())),
        PathBuf::from(format!("{}-shm", source.display())),
    ] {
        if path.exists() {
            if let Err(error) = fs::remove_file(&path) {
                tracing::warn!(%error,"Mail moved; old database cleanup pending at {}",path.display());
            }
        }
    }
    for path in [source_objects, source_attachments] {
        if path.exists() {
            if let Err(error) = fs::remove_dir_all(&path) {
                tracing::warn!(%error,"Mail moved; old files cleanup pending at {}",path.display());
            }
        }
    }
    Ok(())
}
