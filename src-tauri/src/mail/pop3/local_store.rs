use super::limits::LOCAL_FOLDERS;
use crate::mail::MailAccountConfig;
use crate::mail::MailFolder;
use crate::mail::MailMessageCached;
use crate::mail::list_cached_folders;
use crate::mail::now_ts;
use crate::mail::parse_body_message;
use crate::mail::upsert_folder;
use crate::mail::upsert_message;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;
use std::collections::HashSet;

pub(in crate::mail) fn is_pop3(config: &MailAccountConfig) -> bool {
    config.incoming == super::super::MailIncomingProtocol::Pop3
}

// ---------------------------------------------------------------------------
// Local store
// ---------------------------------------------------------------------------

pub(in crate::mail) fn migrate_local_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_local_raw (
            account_id TEXT NOT NULL,
            folder TEXT NOT NULL,
            uid INTEGER NOT NULL,
            raw BLOB NOT NULL,
            PRIMARY KEY (account_id, folder, uid)
         );
         CREATE TABLE IF NOT EXISTS mail_pop3_uidl (
            account_id TEXT NOT NULL,
            uidl TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, uidl)
         );",
    )
}

/// True once the account keeps mail only locally (guards cache clearing).
pub(in crate::mail) fn has_local_store(conn: &Connection, account_id: &str) -> SqlResult<bool> {
    migrate_local_tables(conn)?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_pop3_uidl WHERE account_id = ?1)
             OR EXISTS(SELECT 1 FROM mail_local_raw WHERE account_id = ?1)",
        params![account_id],
        |row| row.get::<_, bool>(0),
    )
}

pub(super) fn local_folder(account_id: &str, name: &str, attribute: &str) -> MailFolder {
    let mut flags = vec![
        "\\HasNoChildren".to_string(),
        super::super::folders::SUBSCRIBED_ATTRIBUTE.to_string(),
    ];
    if !attribute.is_empty() {
        flags.push(attribute.to_string());
    }
    MailFolder {
        account_id: account_id.to_string(),
        name: name.to_string(),
        display_name: name.to_string(),
        delimiter: Some("/".into()),
        flags,
        uid_validity: Some(1),
        updated_at: now_ts(),
        ..MailFolder::default()
    }
}

pub(in crate::mail) fn ensure_local_folders(conn: &Connection, account_id: &str) -> SqlResult<()> {
    migrate_local_tables(conn)?;
    let existing: HashSet<String> = list_cached_folders(conn, account_id)?
        .into_iter()
        .map(|folder| folder.name)
        .collect();
    for (name, attribute) in LOCAL_FOLDERS {
        if !existing.contains(name) {
            upsert_folder(conn, &local_folder(account_id, name, attribute))?;
        }
    }
    Ok(())
}

pub(in crate::mail) fn create_local_folder(
    conn: &Connection,
    account_id: &str,
    name: &str,
) -> SqlResult<()> {
    ensure_local_folders(conn, account_id)?;
    upsert_folder(conn, &local_folder(account_id, name, ""))?;
    refresh_counts(conn, account_id, name)
}

/// Recompute a local folder's totals and mark it fully synced.
pub(in crate::mail) fn refresh_counts(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<()> {
    conn.execute(
        "UPDATE mail_folders SET
            total = (SELECT COUNT(*) FROM mail_messages WHERE account_id = ?1 AND folder = ?2),
            unread = (SELECT COUNT(*) FROM mail_messages WHERE account_id = ?1 AND folder = ?2
                      AND flags_json NOT LIKE '%\\\\Seen%'),
            uid_next = (SELECT COALESCE(MAX(uid), 0) + 1 FROM mail_messages
                        WHERE account_id = ?1 AND folder = ?2),
            sync_low_uid = (SELECT MIN(uid) FROM mail_messages WHERE account_id = ?1 AND folder = ?2),
            sync_high_uid = (SELECT MAX(uid) FROM mail_messages WHERE account_id = ?1 AND folder = ?2),
            sync_complete = 1,
            last_error = NULL,
            updated_at = ?3
         WHERE account_id = ?1 AND name = ?2",
        params![account_id, folder, now_ts()],
    )?;
    Ok(())
}

pub(super) fn next_uid(conn: &Connection, account_id: &str, folder: &str) -> SqlResult<u32> {
    conn.query_row(
        "SELECT MAX(COALESCE((SELECT MAX(uid) FROM mail_messages WHERE account_id = ?1 AND folder = ?2), 0),
                    COALESCE((SELECT MAX(uid) FROM mail_local_raw WHERE account_id = ?1 AND folder = ?2), 0),
                    COALESCE((SELECT MAX(uid) FROM mail_full_messages WHERE account_id=?1 AND folder=?2 AND uid_validity=1),0),
                    COALESCE((SELECT MAX(uid) FROM mail_archive_skipped WHERE account_id=?1 AND folder=?2 AND uid_validity=1),0)) + 1",
        params![account_id, folder],
        |row| row.get::<_, i64>(0),
    )
    .map(|uid| uid as u32)
}

/// Store a raw message in a local folder; returns the cached row.
pub(in crate::mail) fn insert_local(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    raw: &[u8],
    flags: &[&str],
) -> SqlResult<MailMessageCached> {
    let uid = next_uid(conn, account_id, folder)?;
    let mut message = parse_body_message(
        account_id,
        folder,
        uid,
        Some(raw.len() as u32),
        raw,
        8 * 1024 * 1024,
    );
    message.header.uid = uid;
    message.header.folder = folder.to_string();
    message.header.flags = flags.iter().map(|f| f.to_string()).collect();
    message.header.body_cached = true;
    message.flags_authoritative = true;
    message.body_cached_at = Some(now_ts());
    message.internal_ts = Some(now_ts());
    if message.header.date_ts.is_none() {
        message.header.date_ts = Some(now_ts());
    }
    upsert_message(conn, &message)?;
    conn.execute(
        "INSERT OR REPLACE INTO mail_local_raw (account_id, folder, uid, raw) VALUES (?1, ?2, ?3, ?4)",
        params![account_id, folder, uid, raw],
    )?;
    Ok(message)
}

pub(in crate::mail) fn local_raw(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> SqlResult<Option<Vec<u8>>> {
    migrate_local_tables(conn)?;
    conn.query_row(
        "SELECT raw FROM mail_local_raw WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
        params![account_id, folder, uid],
        |row| row.get(0),
    )
    .optional()
}

/// Move (or copy) local messages; returns the count.
pub(in crate::mail) fn move_local(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    target: &str,
    copy: bool,
) -> SqlResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut moved = 0;
    for uid in uids {
        let Some(raw) = local_raw(&tx, account_id, folder, *uid)? else {
            continue;
        };
        let flags_json: String = tx
            .query_row(
                "SELECT flags_json FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                params![account_id, folder, uid],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_else(|| "[]".into());
        let flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        let refs: Vec<&str> = flags.iter().map(String::as_str).collect();
        insert_local(&tx, account_id, target, &raw, &refs)?;
        if !copy {
            delete_rows(&tx, account_id, folder, *uid)?;
        }
        moved += 1;
    }
    refresh_counts(&tx, account_id, target)?;
    refresh_counts(&tx, account_id, folder)?;
    tx.commit()?;
    Ok(moved)
}

pub(super) fn delete_rows(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
        params![account_id, folder, uid],
    )?;
    conn.execute(
        "DELETE FROM mail_local_raw WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
        params![account_id, folder, uid],
    )?;
    Ok(())
}

/// Permanently delete local messages (`uids` None = the whole folder).
pub(in crate::mail) fn delete_local(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: Option<&[u32]>,
) -> SqlResult<usize> {
    migrate_local_tables(conn)?;
    let targets: Vec<u32> = match uids {
        Some(uids) => uids.to_vec(),
        None => {
            let mut stmt = conn
                .prepare("SELECT uid FROM mail_messages WHERE account_id = ?1 AND folder = ?2")?;
            let rows = stmt.query_map(params![account_id, folder], |row| row.get::<_, i64>(0))?;
            rows.filter_map(Result::ok).map(|uid| uid as u32).collect()
        }
    };
    for uid in &targets {
        // Retain the original before permanent local deletion, even when the
        // background archive has not reached this newly received message yet.
        if conn.path().is_some_and(|p| !p.is_empty()) {
            let skipped:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM mail_archive_skipped WHERE account_id=?1 AND folder=?2 AND uid=?3 AND uid_validity=1)",params![account_id,folder,uid],|r|r.get(0))?;
            if !skipped
                && super::super::storage::lookup(conn, account_id, folder, *uid)
                    .map_err(super::super::storage::as_sql_error)?
                    .is_none()
            {
                if let Some(raw) = local_raw(conn, account_id, folder, *uid)? {
                    super::super::storage::store(conn, account_id, folder, *uid, 1, raw.as_slice())
                        .map_err(super::super::storage::as_sql_error)?;
                }
            }
        }
        delete_rows(conn, account_id, folder, *uid)?;
    }
    refresh_counts(conn, account_id, folder)?;
    Ok(targets.len())
}

pub(in crate::mail) fn rename_local_folder(
    conn: &Connection,
    account_id: &str,
    from: &str,
    to: &str,
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE mail_folders SET name = ?3 WHERE account_id = ?1 AND name = ?2",
        params![account_id, from, to],
    )?;
    tx.execute(
        "UPDATE mail_messages SET folder = ?3 WHERE account_id = ?1 AND folder = ?2",
        params![account_id, from, to],
    )?;
    tx.execute(
        "UPDATE mail_local_raw SET folder = ?3 WHERE account_id = ?1 AND folder = ?2",
        params![account_id, from, to],
    )?;
    tx.commit()
}

pub(in crate::mail) fn delete_local_folder(
    conn: &Connection,
    account_id: &str,
    name: &str,
) -> SqlResult<()> {
    delete_local(conn, account_id, name, None)?;
    conn.execute(
        "DELETE FROM mail_folders WHERE account_id = ?1 AND name = ?2",
        params![account_id, name],
    )?;
    Ok(())
}
