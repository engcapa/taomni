use crate::models::{MailAddress, MailMessageHeader};
use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};

pub fn row_to_header(row: &rusqlite::Row<'_>) -> SqlResult<MailMessageHeader> {
    let to_json: String = row.get(7)?;
    let cc_json: String = row.get(8)?;
    let flags_json: String = row.get(10)?;
    let attachments_json: String = row.get(13)?;
    let from_name: Option<String> = row.get(5)?;
    let from_addr: Option<String> = row.get(6)?;
    let from = if from_name.is_some() || from_addr.is_some() {
        Some(MailAddress {
            name: from_name,
            address: from_addr,
        })
    } else {
        None
    };
    let body_cached_at: Option<i64> = row.get(16)?;
    Ok(MailMessageHeader {
        account_id: row.get(0)?,
        folder: row.get(1)?,
        uid: row.get::<_, i64>(2)? as u32,
        message_id: row.get(3)?,
        subject: row.get(4)?,
        from,
        to: serde_json::from_str(&to_json).unwrap_or_default(),
        cc: serde_json::from_str(&cc_json).unwrap_or_default(),
        date_ts: row.get(9)?,
        flags: serde_json::from_str(&flags_json).unwrap_or_default(),
        has_attachments: row.get::<_, i64>(11)? != 0,
        attachment_count: row.get::<_, i64>(12)? as usize,
        attachments: serde_json::from_str(&attachments_json).unwrap_or_default(),
        snippet: row.get(14)?,
        raw_size: row.get(15)?,
        body_cached: body_cached_at.is_some(),
        in_reply_to: row.get(17)?,
        references: row
            .get::<_, Option<String>>(18)?
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default(),
        list_unsubscribe: row
            .get::<_, Option<String>>(19)?
            .and_then(|json| serde_json::from_str(&json).ok()),
        receipt_to: row.get(20)?,
    })
}

/// One cached header.
pub fn cached_header(
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
