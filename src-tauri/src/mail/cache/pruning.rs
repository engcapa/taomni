use crate::mail::account_model::MailCacheSettings;
use crate::mail::cache;
use crate::mail::pop3;
use crate::mail::sync;
use crate::mail::utilities::now_ts;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;

pub(in crate::mail) fn prune_mail_cache(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    cache: &MailCacheSettings,
) -> SqlResult<usize> {
    // POP3 mail exists only locally: never prune it (TASK-21).
    if pop3::has_local_store(conn, account_id)? {
        return Ok(0);
    }
    // Header pruning only ever cuts the low (oldest-UID) end so the cached span
    // stays contiguous; `sync::apply_prune_cut` moves the watermark with it.
    // Retention uses the server arrival time (INTERNALDATE), not the sender's
    // `Date:` header, so a freshly delivered but back-dated message survives.
    let mut cut: Option<u32> = None;
    let retain_headers: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_archive_preferences WHERE account_id=?1)",
        [account_id],
        |r| r.get(0),
    )?;
    if !retain_headers && cache.header_limit_per_folder > 0 {
        let first_dropped: Option<u32> = conn
            .query_row(
                "SELECT uid FROM mail_messages
                 WHERE account_id = ?1 AND folder = ?2
                 ORDER BY uid DESC
                 LIMIT 1 OFFSET ?3",
                params![account_id, folder, cache.header_limit_per_folder],
                |row| row.get(0),
            )
            .optional()?;
        cut = first_dropped.map(|uid| uid.saturating_add(1));
    }
    if !retain_headers && cache.header_retention_days > 0 {
        let cutoff = now_ts() - (cache.header_retention_days as i64 * 86_400);
        let (oldest_recent, max_uid): (Option<u32>, Option<u32>) = conn.query_row(
            "SELECT
                MIN(CASE WHEN COALESCE(internal_ts, date_ts) IS NULL
                          OR COALESCE(internal_ts, date_ts) >= ?3 THEN uid END),
                MAX(uid)
             FROM mail_messages WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder, cutoff],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let retention_cut = match (oldest_recent, max_uid) {
            (Some(uid), _) => Some(uid),
            (None, Some(max_uid)) => Some(max_uid.saturating_add(1)),
            (None, None) => None,
        };
        cut = match (cut, retention_cut) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
    let pruned = if let Some(cut) = cut {
        sync::apply_prune_cut(conn, account_id, folder, cut)?
    } else {
        0
    };
    if cache.body_recent_limit == 0 {
        conn.execute(
            "UPDATE mail_messages
             SET body_text = NULL, body_html = NULL, body_cached_at = NULL
             WHERE account_id = ?1 AND folder = ?2
               AND (body_cached_at IS NOT NULL OR body_text IS NOT NULL OR body_html IS NOT NULL)",
            params![account_id, folder],
        )?;
    } else {
        conn.execute(
            "UPDATE mail_messages
             SET body_text = NULL, body_html = NULL, body_cached_at = NULL
             WHERE account_id = ?1 AND folder = ?2
               AND (body_cached_at IS NOT NULL OR body_text IS NOT NULL OR body_html IS NOT NULL)
               AND rowid NOT IN (
                 SELECT rowid FROM mail_messages
                 WHERE account_id = ?1 AND folder = ?2 AND body_cached_at IS NOT NULL
                 ORDER BY COALESCE(date_ts, 0) DESC, uid DESC
                 LIMIT ?3
               )",
            params![account_id, folder, cache.body_recent_limit],
        )?;
    }
    Ok(pruned)
}

pub(in crate::mail) fn remove_cached_messages(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
) -> SqlResult<()> {
    let mut delete = conn.prepare_cached(
        "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    for uid in uids {
        delete.execute(params![account_id, folder, *uid as i64])?;
    }
    Ok(())
}

pub(in crate::mail) fn purge_cached_folder(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<()> {
    // Remove the folder and its messages, plus any nested subfolders addressed
    // with the common IMAP hierarchy delimiters.
    conn.execute(
        "DELETE FROM mail_messages
         WHERE account_id = ?1 AND (folder = ?2 OR folder LIKE ?3 OR folder LIKE ?4)",
        params![
            account_id,
            folder,
            format!("{folder}/%"),
            format!("{folder}.%")
        ],
    )?;
    conn.execute(
        "DELETE FROM mail_folders
         WHERE account_id = ?1 AND (name = ?2 OR name LIKE ?3 OR name LIKE ?4)",
        params![
            account_id,
            folder,
            format!("{folder}/%"),
            format!("{folder}.%")
        ],
    )?;
    Ok(())
}
