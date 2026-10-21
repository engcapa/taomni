use super::index::account_root;
use super::index::object_path;
use super::model::ArchiveEntry;
use rusqlite::Connection;
use rusqlite::params;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

pub fn remove_entries(
    db: &Connection,
    account: &str,
    entries: &[ArchiveEntry],
) -> Result<usize, String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    for entry in entries {
        tx.execute("DELETE FROM mail_full_messages WHERE account_id=?1 AND folder=?2 AND uid_validity=?3 AND uid=?4",params![account,entry.folder,entry.uid_validity,entry.uid]).map_err(|e|e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO mail_archive_skipped(account_id,folder,uid_validity,uid) VALUES(?1,?2,?3,?4)",params![account,entry.folder,entry.uid_validity,entry.uid]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE mail_messages SET body_text=NULL,body_html=NULL,body_cached_at=NULL WHERE account_id=?1 AND folder=?2 AND uid=?3",params![account,entry.folder,entry.uid]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    collect_garbage(db, account)
}

/// Only an unreferenced object is removed. A backup's hard link remains valid.
pub fn collect_garbage(db: &Connection, account: &str) -> Result<usize, String> {
    let hashes: Vec<String> = db
        .prepare("SELECT sha256 FROM mail_archive_gc")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut removed = 0;
    for hash in hashes {
        let used: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mail_full_messages WHERE sha256=?1)",
                [&hash],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !used {
            let path = object_path(&account_root(db, account)?, &hash)?;
            match fs::remove_file(path) {
                Ok(()) => {
                    removed += 1;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Remove saved email: {e}")),
            }
        }
        db.execute("DELETE FROM mail_archive_gc WHERE sha256=?1", [hash])
            .map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

pub fn snapshot_objects(
    db: &Connection,
    account: &str,
    target_root: &Path,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let hashes: Vec<String> = db
        .prepare("SELECT DISTINCT sha256 FROM mail_full_messages WHERE account_id=?1")
        .map_err(|e| e.to_string())?
        .query_map([account], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let source_root = account_root(db, account)?;
    let mut files = Vec::new();
    for hash in hashes {
        let source = object_path(&source_root, &hash)?;
        let target = object_path(target_root, &hash)?;
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        if fs::hard_link(&source, &target).is_err() {
            fs::copy(&source, &target).map_err(|e| format!("Snapshot saved email: {e}"))?;
        }
        files.push((
            target.strip_prefix(target_root).unwrap().to_path_buf(),
            target,
        ));
    }
    Ok(files)
}

pub fn as_sql_error(error: String) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(std::io::Error::other(error).into())
}
