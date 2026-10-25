//! Account snapshots pin immutable mail objects before releasing the account lock.
use super::{
    archive_writer::StagedFile,
    range::{BackupScopeFlags, resolve_scope_flags},
    snapshot_context::{SnapshotContext, hot_backup_conn},
};
use rusqlite::OptionalExtension;
use std::path::Path;

pub(super) fn snapshot_account(db: &rusqlite::Connection) -> Result<Option<String>, String> {
    for table in ["mail_messages", "mail_full_messages"] {
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            let account = db
                .query_row(
                    &format!("SELECT account_id FROM {table} LIMIT 1"),
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if account.is_some() {
                return Ok(account);
            }
        }
    }
    Ok(None)
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
    snapshot_mail_with_options(
        db,
        account,
        staging,
        resolve_scope_flags("full", None),
        &SnapshotContext::default(),
    )
}

pub(super) fn snapshot_mail_with_options(
    db: &rusqlite::Connection,
    account: Option<&str>,
    staging: &Path,
    flags: BackupScopeFlags,
    context: &SnapshotContext,
) -> Result<Vec<StagedFile>, String> {
    context.check()?;
    let source = Path::new(db.path().ok_or("Mail DB has no path")?);
    let filename = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("Invalid mail DB name")?;
    let target = staging.join("mail-cache").join(filename);
    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    hot_backup_conn(db, &target, context)?;
    if !flags.mail_originals {
        let snapshot = rusqlite::Connection::open(&target).map_err(|e| e.to_string())?;
        let has_table: bool = snapshot
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='mail_full_messages')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_table {
            context.sqlite(&snapshot, || {
                snapshot
                    .execute_batch("DELETE FROM mail_full_messages;")
                    .map_err(|e| e.to_string())
            })?;
        }
    }
    let mut files = vec![StagedFile {
        archive_path: format!("mail-cache/{filename}"),
        disk_path: target,
    }];
    if let Some(account) = account {
        let stem = crate::state::mail_db_file_stem(account);
        let prefix = format!("mail-cache/{stem}.mail");
        let has_originals: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='mail_full_messages')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if flags.mail_originals && has_originals {
            for (relative, disk_path) in context.sqlite(db, || {
                crate::mail::storage::snapshot_objects_with(
                    db,
                    account,
                    &staging.join(&prefix),
                    &|| context.check(),
                    &|source, target| context.copy(source, target),
                )
            })? {
                files.push(StagedFile {
                    archive_path: format!(
                        "{prefix}/{}",
                        relative.to_string_lossy().replace('\\', "/")
                    ),
                    disk_path,
                });
            }
        }
        let attachments = source.parent().unwrap().join("attachments").join(&stem);
        if flags.mail_attachments {
            snapshot_attachment_tree(
                &attachments,
                &format!("mail-cache/attachments/{stem}"),
                staging,
                &mut files,
                context,
            )?;
        }
    }
    Ok(files)
}

fn snapshot_attachment_tree(
    source: &Path,
    prefix: &str,
    staging: &Path,
    files: &mut Vec<StagedFile>,
    context: &SnapshotContext,
) -> Result<(), String> {
    context.check()?;
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
            snapshot_attachment_tree(&entry.path(), &path, staging, files, context)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "bin") {
            let target = staging.join(&path);
            std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            context.check()?;
            if std::fs::hard_link(entry.path(), &target).is_err() {
                context.copy(&entry.path(), &target)?;
            } else {
                context
                    .advance(entry.metadata().map_err(|e| e.to_string())?.len())
                    .map_err(|e| e.to_string())?;
            }
            files.push(StagedFile {
                archive_path: path,
                disk_path: target,
            });
        }
    }
    Ok(())
}
