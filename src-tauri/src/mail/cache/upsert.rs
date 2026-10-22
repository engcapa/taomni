use crate::mail::message_model::MailFolder;
use crate::mail::message_model::MailMessageCached;
use crate::mail::utilities::now_ts;
use rusqlite::Connection;
use rusqlite::Result as SqlResult;
use rusqlite::params;

pub(in crate::mail) fn upsert_folder(conn: &Connection, folder: &MailFolder) -> SqlResult<()> {
    let flags_json = serde_json::to_string(&folder.flags).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO mail_folders
         (account_id, name, delimiter, flags_json, uid_validity, uid_next, total, unread, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(account_id, name) DO UPDATE SET
            delimiter = excluded.delimiter,
            flags_json = excluded.flags_json,
            uid_validity = COALESCE(excluded.uid_validity, mail_folders.uid_validity),
            uid_next = COALESCE(excluded.uid_next, mail_folders.uid_next),
            total = COALESCE(excluded.total, mail_folders.total),
            unread = COALESCE(excluded.unread, mail_folders.unread),
            updated_at = excluded.updated_at",
        params![
            folder.account_id,
            folder.name,
            folder.delimiter,
            flags_json,
            folder.uid_validity,
            folder.uid_next,
            folder.total,
            folder.unread,
            folder.updated_at,
        ],
    )?;
    Ok(())
}

pub(in crate::mail) fn upsert_message(
    conn: &Connection,
    message: &MailMessageCached,
) -> SqlResult<()> {
    upsert_message_at(conn, message, None)
}

pub(in crate::mail) fn upsert_message_at(
    conn: &Connection,
    message: &MailMessageCached,
    observed_at: Option<i64>,
) -> SqlResult<()> {
    let header = &message.header;
    let to_json = serde_json::to_string(&header.to).unwrap_or_else(|_| "[]".into());
    let cc_json = serde_json::to_string(&header.cc).unwrap_or_else(|_| "[]".into());
    let flags_json = serde_json::to_string(&header.flags).unwrap_or_else(|_| "[]".into());
    let attachments_json =
        serde_json::to_string(&header.attachments).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO mail_messages
         (account_id, folder, uid, message_id, subject, from_name, from_addr,
          to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
          attachments_json, snippet, body_text, body_html, body_cached_at, raw_size, updated_at,
          internal_ts, in_reply_to, references_json, list_unsubscribe_json, receipt_to)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?23, ?24, ?25, ?26)
         ON CONFLICT(account_id, folder, uid) DO UPDATE SET
            message_id = COALESCE(excluded.message_id, mail_messages.message_id),
            subject = CASE WHEN excluded.subject != '' THEN excluded.subject ELSE mail_messages.subject END,
            from_name = COALESCE(excluded.from_name, mail_messages.from_name),
            from_addr = COALESCE(excluded.from_addr, mail_messages.from_addr),
            to_json = CASE WHEN excluded.to_json != '[]' THEN excluded.to_json ELSE mail_messages.to_json END,
            cc_json = CASE WHEN excluded.cc_json != '[]' THEN excluded.cc_json ELSE mail_messages.cc_json END,
            date_ts = COALESCE(excluded.date_ts, mail_messages.date_ts),
            flags_json = CASE WHEN ?27 IS NOT NULL AND COALESCE(mail_messages.flags_local_at, 0) >= ?27 THEN mail_messages.flags_json
                              WHEN ?22 = 1 OR excluded.flags_json != '[]' THEN excluded.flags_json ELSE mail_messages.flags_json END,
            internal_ts = COALESCE(excluded.internal_ts, mail_messages.internal_ts),
            in_reply_to = COALESCE(excluded.in_reply_to, mail_messages.in_reply_to),
            references_json = CASE WHEN excluded.references_json != '[]'
                                   THEN excluded.references_json ELSE mail_messages.references_json END,
            list_unsubscribe_json = COALESCE(excluded.list_unsubscribe_json, mail_messages.list_unsubscribe_json),
            receipt_to = COALESCE(excluded.receipt_to, mail_messages.receipt_to),
            has_attachments = CASE
                WHEN excluded.attachments_json != '[]' OR excluded.has_attachments = 1
                THEN excluded.has_attachments
                ELSE mail_messages.has_attachments
            END,
            attachment_count = CASE
                WHEN excluded.attachments_json != '[]' OR excluded.attachment_count > 0
                THEN excluded.attachment_count
                ELSE mail_messages.attachment_count
            END,
            attachments_json = CASE WHEN excluded.attachments_json != '[]' THEN excluded.attachments_json ELSE mail_messages.attachments_json END,
            snippet = COALESCE(excluded.snippet, mail_messages.snippet),
            body_text = COALESCE(excluded.body_text, mail_messages.body_text),
            body_html = COALESCE(excluded.body_html, mail_messages.body_html),
            body_cached_at = COALESCE(excluded.body_cached_at, mail_messages.body_cached_at),
            raw_size = COALESCE(excluded.raw_size, mail_messages.raw_size),
            updated_at = excluded.updated_at",
        params![
            header.account_id,
            header.folder,
            header.uid,
            header.message_id,
            header.subject,
            header.from.as_ref().and_then(|a| a.name.clone()),
            header.from.as_ref().and_then(|a| a.address.clone()),
            to_json,
            cc_json,
            header.date_ts,
            flags_json,
            header.has_attachments as i64,
            header.attachment_count as i64,
            attachments_json,
            header.snippet,
            message.body_text,
            message.body_html,
            message.body_cached_at,
            header.raw_size,
            now_ts(),
            message.internal_ts,
            message.flags_authoritative as i64,
            header.in_reply_to,
            serde_json::to_string(&header.references).unwrap_or_else(|_| "[]".into()),
            header
                .list_unsubscribe
                .as_ref()
                .and_then(|list| serde_json::to_string(list).ok()),
            header.receipt_to,
            observed_at,
        ],
    )?;
    Ok(())
}
