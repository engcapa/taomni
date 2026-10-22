use super::flags::flags_include_seen;
use super::mapping::row_to_header;
use crate::mail::message_model::MailFolder;
use crate::mail::message_model::MailMessageBody;
use crate::mail::message_model::MailMessageHeader;
use crate::mail::mime::decode_imap_modified_utf7;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;

pub(in crate::mail) fn list_cached_folders(
    conn: &Connection,
    account_id: &str,
) -> SqlResult<Vec<MailFolder>> {
    let mut stmt = conn.prepare(
        "SELECT f.account_id, f.name, f.delimiter, f.flags_json, f.uid_validity, f.uid_next,
                f.total, f.unread, f.updated_at, f.sync_low_uid, f.sync_high_uid,
                f.sync_complete, f.last_error,
                (SELECT COUNT(*) FROM mail_messages m
                  WHERE m.account_id = f.account_id AND m.folder = f.name)
         FROM mail_folders f
         WHERE f.account_id = ?1
         ORDER BY CASE WHEN f.name = 'INBOX' THEN 0 ELSE 1 END, f.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let flags_json: String = row.get(3)?;
        let name: String = row.get(1)?;
        let complete: i64 = row.get(11)?;
        let cached_count: i64 = row.get(13)?;
        Ok(MailFolder {
            account_id: row.get(0)?,
            display_name: decode_imap_modified_utf7(&name),
            name,
            delimiter: row.get(2)?,
            flags: serde_json::from_str(&flags_json).unwrap_or_default(),
            uid_validity: row.get(4)?,
            uid_next: row.get(5)?,
            total: row.get(6)?,
            unread: row.get(7)?,
            updated_at: row.get(8)?,
            sync_low_uid: row.get(9)?,
            sync_high_uid: row.get(10)?,
            sync_complete: complete != 0,
            cached_count: Some(cached_count.max(0) as u32),
            last_error: row.get(12)?,
        })
    })?;
    rows.collect()
}

pub(in crate::mail) fn list_cached_messages(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    limit: u32,
    offset: u32,
) -> SqlResult<Vec<MailMessageHeader>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, in_reply_to, references_json,
                list_unsubscribe_json, receipt_to
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2
         ORDER BY COALESCE(date_ts, 0) DESC, uid DESC
         LIMIT ?3 OFFSET ?4",
    )?;
    let rows = stmt.query_map(params![account_id, folder, limit, offset], row_to_header)?;
    rows.collect()
}

/// One cached header.
pub(in crate::mail) fn cached_header(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> SqlResult<Option<MailMessageHeader>> {
    conn.query_row(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, in_reply_to, references_json,
                list_unsubscribe_json, receipt_to
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
        params![account_id, folder, uid],
        row_to_header,
    )
    .optional()
}

pub(in crate::mail) fn unread_cached_uids(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<Vec<u32>> {
    let mut stmt = conn.prepare(
        "SELECT uid, flags_json
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2",
    )?;
    let rows = stmt.query_map(params![account_id, folder], |row| {
        Ok((row.get::<_, i64>(0)? as u32, row.get::<_, String>(1)?))
    })?;
    let mut uids = Vec::new();
    for row in rows {
        let (uid, flags_json) = row?;
        let flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        if !flags_include_seen(&flags) {
            uids.push(uid);
        }
    }
    Ok(uids)
}

pub(in crate::mail) fn get_cached_body(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> SqlResult<Option<MailMessageBody>> {
    conn.query_row(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, in_reply_to, references_json,
                list_unsubscribe_json, receipt_to, body_text, body_html
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3
           AND body_cached_at IS NOT NULL
           AND (body_text IS NOT NULL OR body_html IS NOT NULL)",
        params![account_id, folder, uid],
        |row| {
            let mut header = row_to_header(row)?;
            let body_text: Option<String> = row.get(21)?;
            let body_html: Option<String> = row.get(22)?;
            header.body_cached = true;
            Ok(MailMessageBody {
                account_id: header.account_id,
                folder: header.folder,
                uid: header.uid,
                message_id: header.message_id,
                subject: header.subject,
                text: body_text,
                html: body_html,
                snippet: header.snippet,
                attachments: header.attachments,
                raw_size: header.raw_size,
                cached_at: row.get(16)?,
                source: "cache".into(),
            })
        },
    )
    .optional()
}
