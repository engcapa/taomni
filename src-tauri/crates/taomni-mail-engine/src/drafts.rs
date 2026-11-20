//! Cached drafts, templates and scheduled Outbox state.

use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};

use crate::now_ts;

/// Queue state of a draft waiting in the local Outbox (TASK-17).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailOutboxState {
    /// Earliest send time (epoch seconds); `None` = wait for "Send now".
    #[serde(default)]
    pub send_at: Option<i64>,
    #[serde(default)]
    pub queued_at: i64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub read_receipt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftAttachment {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub inline: bool,
    #[serde(default)]
    pub content_id: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftContext {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub uid: Option<u32>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
    /// Thread ancestry of the replied-to message, oldest first.
    #[serde(default)]
    pub references: Vec<String>,
    /// Sending identity chosen in the composer.
    #[serde(default)]
    pub identity_id: Option<String>,
    /// Present while the draft waits in the Outbox.
    #[serde(default)]
    pub outbox: Option<MailOutboxState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraft {
    pub id: String,
    pub account_id: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text_body: String,
    pub html_body: String,
    pub attachments: Vec<MailDraftAttachment>,
    #[serde(default)]
    pub reply_context: Option<MailDraftContext>,
    #[serde(default)]
    pub remote_draft_folder: Option<String>,
    #[serde(default)]
    pub remote_draft_uid: Option<u32>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftSaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub text_body: String,
    #[serde(default)]
    pub html_body: String,
    #[serde(default)]
    pub attachments: Vec<MailDraftAttachment>,
    #[serde(default)]
    pub reply_context: Option<MailDraftContext>,
    #[serde(default)]
    pub remote_draft_folder: Option<String>,
    #[serde(default)]
    pub remote_draft_uid: Option<u32>,
}

pub fn list_mail_drafts(conn: &Connection, account_id: &str) -> SqlResult<Vec<MailDraft>> {
    list_mail_drafts_page(conn, account_id, u32::MAX, 0)
}

pub fn list_mail_drafts_page(
    conn: &Connection,
    account_id: &str,
    limit: u32,
    offset: u32,
) -> SqlResult<Vec<MailDraft>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, id, to_json, cc_json, bcc_json, subject, text_body, html_body,
                attachments_json, reply_context_json, remote_draft_folder, remote_draft_uid,
                created_at, updated_at
         FROM mail_drafts
         WHERE account_id = ?1
         ORDER BY updated_at DESC, id ASC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![account_id, limit, offset], mail_draft_from_row)?;
    rows.collect()
}

pub fn save_mail_draft(
    conn: &Connection,
    account_id: &str,
    draft: MailDraftSaveRequest,
) -> SqlResult<MailDraft> {
    let id = draft
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_ts();
    let created_at = conn
        .query_row(
            "SELECT created_at FROM mail_drafts WHERE account_id = ?1 AND id = ?2",
            params![account_id, id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(now);
    let saved = MailDraft {
        id,
        account_id: account_id.to_string(),
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        text_body: draft.text_body,
        html_body: draft.html_body,
        attachments: draft.attachments,
        reply_context: draft.reply_context,
        remote_draft_folder: draft.remote_draft_folder,
        remote_draft_uid: draft.remote_draft_uid,
        created_at,
        updated_at: now,
    };
    let to_json = serde_json::to_string(&saved.to).unwrap_or_else(|_| "[]".into());
    let cc_json = serde_json::to_string(&saved.cc).unwrap_or_else(|_| "[]".into());
    let bcc_json = serde_json::to_string(&saved.bcc).unwrap_or_else(|_| "[]".into());
    let attachments_json =
        serde_json::to_string(&saved.attachments).unwrap_or_else(|_| "[]".into());
    let reply_context_json = saved
        .reply_context
        .as_ref()
        .and_then(|context| serde_json::to_string(context).ok());
    conn.execute(
        "INSERT INTO mail_drafts
         (account_id, id, to_json, cc_json, bcc_json, subject, text_body, html_body,
          attachments_json, reply_context_json, remote_draft_folder, remote_draft_uid,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(account_id, id) DO UPDATE SET
            to_json = excluded.to_json,
            cc_json = excluded.cc_json,
            bcc_json = excluded.bcc_json,
            subject = excluded.subject,
            text_body = excluded.text_body,
            html_body = excluded.html_body,
            attachments_json = excluded.attachments_json,
            reply_context_json = excluded.reply_context_json,
            remote_draft_folder = excluded.remote_draft_folder,
            remote_draft_uid = excluded.remote_draft_uid,
            updated_at = excluded.updated_at",
        params![
            saved.account_id,
            saved.id,
            to_json,
            cc_json,
            bcc_json,
            saved.subject,
            saved.text_body,
            saved.html_body,
            attachments_json,
            reply_context_json,
            saved.remote_draft_folder,
            saved.remote_draft_uid,
            saved.created_at,
            saved.updated_at,
        ],
    )?;
    Ok(saved)
}

pub fn delete_mail_draft(conn: &Connection, account_id: &str, draft_id: &str) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM mail_drafts WHERE account_id = ?1 AND id = ?2",
        params![account_id, draft_id],
    )?;
    Ok(())
}

fn mail_draft_from_row(row: &rusqlite::Row<'_>) -> SqlResult<MailDraft> {
    let to_json: String = row.get(2)?;
    let cc_json: String = row.get(3)?;
    let bcc_json: String = row.get(4)?;
    let attachments_json: String = row.get(8)?;
    let reply_context_json: Option<String> = row.get(9)?;
    let remote_draft_uid: Option<i64> = row.get(11)?;
    Ok(MailDraft {
        account_id: row.get(0)?,
        id: row.get(1)?,
        to: serde_json::from_str(&to_json).unwrap_or_default(),
        cc: serde_json::from_str(&cc_json).unwrap_or_default(),
        bcc: serde_json::from_str(&bcc_json).unwrap_or_default(),
        subject: row.get(5)?,
        text_body: row.get(6)?,
        html_body: row.get(7)?,
        attachments: serde_json::from_str(&attachments_json).unwrap_or_default(),
        reply_context: reply_context_json
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok()),
        remote_draft_folder: row.get(10)?,
        remote_draft_uid: remote_draft_uid.map(|value| value.max(0) as u32),
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}
