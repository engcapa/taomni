use super::*;

#[tauri::command]
pub async fn mail_list_drafts(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailDraft>, String> {
    with_mail_db_async(&state, &account_id, |db, account_id| {
        list_mail_drafts(db, account_id)
    })
    .await
}

#[tauri::command]
pub async fn mail_save_draft(
    account_id: String,
    draft: MailDraftSaveRequest,
    state: State<'_, AppState>,
) -> Result<MailDraft, String> {
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return Err("mail account id is required".into());
    }
    with_mail_db_async(&state, account_id, move |db, account_id| {
        save_mail_draft(db, account_id, draft)
    })
    .await
}

#[tauri::command]
pub async fn mail_delete_draft(
    account_id: String,
    draft_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let account_id = account_id.trim();
    let draft_id = draft_id.trim().to_string();
    if account_id.is_empty() {
        return Err("mail account id is required".into());
    }
    if draft_id.is_empty() {
        return Err("mail draft id is required".into());
    }
    with_mail_db_async(&state, account_id, move |db, account_id| {
        delete_mail_draft(db, account_id, &draft_id)
    })
    .await
}

#[tauri::command]
pub async fn mail_index_cached_contacts(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    with_mail_db_async(&state, &account_id, move |db, account_id| {
        // Rebuilding once when opening a composer must be one transaction,
        // not a durable SQLite commit for every address in the entire mailbox.
        let tx = db.unchecked_transaction()?;
        let count = reindex_cached_contacts(&tx, account_id)?;
        tx.commit()?;
        Ok(count)
    })
    .await
}

#[tauri::command]
pub async fn mail_search_contacts(
    account_id: String,
    query: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<MailContactSuggestion>, String> {
    let limit = limit.unwrap_or(8).clamp(1, 20);
    with_mail_db_async(&state, &account_id, move |db, account_id| {
        // Address book entries (TASK-19) first, then collected contacts.
        let book = contacts::address_book_suggestions(db, &account_id, &query, limit)?;
        let collected = search_contacts(db, &account_id, &query, limit)?;
        Ok(contacts::merge_suggestions(book, collected, limit))
    })
    .await
}

pub(super) fn list_mail_drafts(conn: &Connection, account_id: &str) -> SqlResult<Vec<MailDraft>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, id, to_json, cc_json, bcc_json, subject, text_body, html_body,
                attachments_json, reply_context_json, remote_draft_folder, remote_draft_uid,
                created_at, updated_at
         FROM mail_drafts
         WHERE account_id = ?1
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![account_id], mail_draft_from_row)?;
    rows.collect()
}

pub(super) fn save_mail_draft(
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

pub(super) fn delete_mail_draft(
    conn: &Connection,
    account_id: &str,
    draft_id: &str,
) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM mail_drafts WHERE account_id = ?1 AND id = ?2",
        params![account_id, draft_id],
    )?;
    Ok(())
}

pub(super) fn mail_draft_from_row(row: &rusqlite::Row<'_>) -> SqlResult<MailDraft> {
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
