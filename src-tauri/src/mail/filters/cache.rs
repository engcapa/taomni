use super::model::MailFilter;
use crate::mail::MailMessageHeader;
use crate::mail::now_ts;
use crate::mail::row_to_header;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;
use std::collections::HashSet;

pub(in crate::mail) fn migrate_filter_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_filters (
            account_id TEXT NOT NULL,
            id TEXT NOT NULL,
            position INTEGER NOT NULL,
            filter_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, id)
        );
        CREATE TABLE IF NOT EXISTS mail_filter_marks (
            account_id TEXT NOT NULL,
            folder TEXT NOT NULL,
            uid_validity INTEGER,
            high_uid INTEGER NOT NULL,
            PRIMARY KEY (account_id, folder)
        );",
    )
}

pub(in crate::mail) fn load_filters(
    conn: &Connection,
    account_id: &str,
) -> SqlResult<Vec<MailFilter>> {
    let mut stmt = conn.prepare(
        "SELECT filter_json FROM mail_filters WHERE account_id = ?1 ORDER BY position, id",
    )?;
    let rows = stmt.query_map(params![account_id], |row| row.get::<_, String>(0))?;
    let mut filters = Vec::new();
    for json in rows {
        if let Ok(filter) = serde_json::from_str::<MailFilter>(&json?) {
            filters.push(filter);
        }
    }
    Ok(filters)
}

pub(in crate::mail) fn store_filters(
    conn: &Connection,
    account_id: &str,
    filters: &[MailFilter],
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM mail_filters WHERE account_id = ?1",
        params![account_id],
    )?;
    for (position, filter) in filters.iter().enumerate() {
        tx.execute(
            "INSERT INTO mail_filters (account_id, id, position, filter_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                account_id,
                filter.id,
                position as i64,
                serde_json::to_string(filter).unwrap_or_default(),
                now_ts()
            ],
        )?;
    }
    tx.commit()
}

pub(super) fn folder_uid_validity(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<Option<u32>> {
    conn.query_row(
        "SELECT uid_validity FROM mail_folders WHERE account_id = ?1 AND name = ?2",
        params![account_id, folder],
        |row| row.get::<_, Option<i64>>(0),
    )
    .optional()
    .map(|value| value.flatten().map(|v| v as u32))
}

pub(super) fn max_cached_uid(conn: &Connection, account_id: &str, folder: &str) -> SqlResult<u32> {
    conn.query_row(
        "SELECT COALESCE(MAX(uid), 0) FROM mail_messages WHERE account_id = ?1 AND folder = ?2",
        params![account_id, folder],
        |row| row.get::<_, i64>(0),
    )
    .map(|uid| uid as u32)
}

/// Highest UID already offered to the incoming filters, or `None` when the
/// mark is missing or belongs to an older UIDVALIDITY.
pub(in crate::mail) fn filter_mark(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<Option<u32>> {
    let stored: Option<(Option<i64>, i64)> = conn
        .query_row(
            "SELECT uid_validity, high_uid FROM mail_filter_marks WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let current = folder_uid_validity(conn, account_id, folder)?;
    Ok(stored.and_then(|(validity, high)| {
        (validity.map(|v| v as u32) == current).then_some(high as u32)
    }))
}

pub(in crate::mail) fn set_filter_mark(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    high: u32,
) -> SqlResult<()> {
    let validity = folder_uid_validity(conn, account_id, folder)?;
    conn.execute(
        "INSERT INTO mail_filter_marks (account_id, folder, uid_validity, high_uid)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(account_id, folder) DO UPDATE SET
            uid_validity = excluded.uid_validity, high_uid = excluded.high_uid",
        params![account_id, folder, validity, high],
    )?;
    Ok(())
}

/// Mark everything cached as already filtered (called when filters are saved
/// so only mail that arrives afterwards is filtered).
pub(in crate::mail) fn ensure_filter_mark(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<()> {
    if filter_mark(conn, account_id, folder)?.is_none() {
        let high = max_cached_uid(conn, account_id, folder)?;
        set_filter_mark(conn, account_id, folder, high)?;
    }
    Ok(())
}

/// Cached headers (and text bodies) of the candidates, oldest first.
pub(super) fn load_candidates(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    selection: &CandidateSelection,
) -> SqlResult<Vec<(MailMessageHeader, Option<String>)>> {
    let (clause, bound) = match selection {
        CandidateSelection::Above(uid) => ("AND uid > ?3", *uid as i64),
        CandidateSelection::All | CandidateSelection::Uids(_) => ("AND ?3 = ?3", 0),
    };
    let sql = format!(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, in_reply_to, references_json,
                list_unsubscribe_json, receipt_to, body_text
         FROM mail_messages WHERE account_id = ?1 AND folder = ?2 {clause} ORDER BY uid"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![account_id, folder, bound], |row| {
        Ok((row_to_header(row)?, row.get::<_, Option<String>>(21)?))
    })?;
    let wanted: Option<HashSet<u32>> = match selection {
        CandidateSelection::Uids(uids) => Some(uids.iter().copied().collect()),
        _ => None,
    };
    let mut out = Vec::new();
    for row in rows {
        let (header, body) = row?;
        if wanted.as_ref().is_none_or(|set| set.contains(&header.uid)) {
            out.push((header, body));
        }
    }
    Ok(out)
}

pub(super) enum CandidateSelection {
    Above(u32),
    All,
    Uids(Vec<u32>),
}
