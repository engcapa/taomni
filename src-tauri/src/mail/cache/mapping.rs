use crate::mail::message_model::MailAddress;
use crate::mail::message_model::MailMessageBody;
use crate::mail::message_model::MailMessageCached;
use crate::mail::message_model::MailMessageHeader;
use rusqlite::Result as SqlResult;

pub(in crate::mail) fn row_to_header(row: &rusqlite::Row<'_>) -> SqlResult<MailMessageHeader> {
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

pub(in crate::mail) fn cached_to_body(message: MailMessageCached, source: &str) -> MailMessageBody {
    MailMessageBody {
        account_id: message.header.account_id,
        folder: message.header.folder,
        uid: message.header.uid,
        message_id: message.header.message_id,
        subject: message.header.subject,
        text: message.body_text,
        html: message.body_html,
        snippet: message.header.snippet,
        attachments: message.header.attachments,
        raw_size: message.header.raw_size,
        cached_at: message.body_cached_at,
        source: source.into(),
    }
}
