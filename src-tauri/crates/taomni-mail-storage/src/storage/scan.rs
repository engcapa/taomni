//! Persisted pause, pending originals and guarded publication for an archive scan.

use rusqlite::{Connection, params};

use super::{FullMessage, PreparedMessage, publication::publish_checked, query::ArchiveKey};

pub const PAUSED: &str = "Full-message storage paused";

pub fn is_paused(db: &Connection, account: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT COALESCE((SELECT paused FROM mail_archive_preferences WHERE account_id=?1),0)",
        [account],
        |row| row.get(0),
    )
}

pub fn pause(db: &Connection, account: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO mail_archive_preferences(account_id,paused) VALUES(?1,1)
         ON CONFLICT(account_id) DO UPDATE SET paused=1",
        [account],
    )?;
    Ok(())
}

/// Return the pause state. Only an explicit resume clears an existing pause.
pub fn begin(db: &Connection, account: &str, resume: bool) -> rusqlite::Result<bool> {
    db.query_row(
        "INSERT INTO mail_archive_preferences(account_id,paused) VALUES(?1,0)
         ON CONFLICT(account_id) DO UPDATE SET paused=CASE WHEN ?2 THEN 0 ELSE paused END
         RETURNING paused",
        params![account, resume],
        |row| row.get(0),
    )
}

pub fn pending_local(db: &Connection, account: &str) -> rusqlite::Result<Vec<ArchiveKey>> {
    db.prepare(
        "SELECT r.folder,r.uid FROM mail_local_raw r WHERE r.account_id=?1
         AND NOT EXISTS(SELECT 1 FROM mail_full_messages a
             WHERE a.account_id=r.account_id AND a.folder=r.folder AND a.uid=r.uid
                 AND a.uid_validity=1)
         AND NOT EXISTS(SELECT 1 FROM mail_archive_skipped s
             WHERE s.account_id=r.account_id AND s.folder=r.folder AND s.uid=r.uid
                 AND s.uid_validity=1)",
    )?
    .query_map([account], |row| {
        Ok(ArchiveKey {
            folder: row.get(0)?,
            uid: row.get(1)?,
            uid_validity: 1,
        })
    })?
    .collect()
}

pub fn pending_imap(
    db: &Connection,
    account: &str,
    folder: &str,
) -> rusqlite::Result<(u32, Vec<u32>)> {
    let uid_validity = db.query_row(
        "SELECT COALESCE(uid_validity,0) FROM mail_folders WHERE account_id=?1 AND name=?2",
        params![account, folder],
        |row| row.get(0),
    )?;
    let uids = db
        .prepare(
            "SELECT m.uid FROM mail_messages m WHERE m.account_id=?1 AND m.folder=?2
             AND NOT EXISTS(SELECT 1 FROM mail_full_messages a
                 WHERE a.account_id=m.account_id AND a.folder=m.folder AND a.uid=m.uid
                     AND a.uid_validity=?3)
             AND NOT EXISTS(SELECT 1 FROM mail_archive_skipped s
                 WHERE s.account_id=m.account_id AND s.folder=m.folder AND s.uid=m.uid
                     AND s.uid_validity=?3)
             ORDER BY m.uid DESC",
        )?
        .query_map(params![account, folder, uid_validity], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok((uid_validity, uids))
}

pub fn skip(db: &Connection, account: &str, target: &ArchiveKey) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO mail_archive_skipped(account_id,folder,uid_validity,uid)
         VALUES(?1,?2,?3,?4)",
        params![account, target.folder, target.uid_validity, target.uid],
    )?;
    Ok(())
}

pub fn publish_original(
    db: &Connection,
    account: &str,
    target: &ArchiveKey,
    prepared: PreparedMessage,
    check_running: impl FnOnce() -> Result<(), String>,
) -> Result<FullMessage, String> {
    publish_checked(db, account, target, prepared, |tx| {
        if is_paused(tx, account).map_err(|error| error.to_string())? {
            return Err(PAUSED.into());
        }
        let skipped = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mail_archive_skipped
                 WHERE account_id=?1 AND folder=?2 AND uid_validity=?3 AND uid=?4)",
                params![account, target.folder, target.uid_validity, target.uid],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if skipped {
            return Err("This local original was cleaned up in another instance; scan again to continue with other messages".into());
        }
        check_running()
    })
}

#[cfg(all(test, feature = "mime-parse"))]
mod tests;
