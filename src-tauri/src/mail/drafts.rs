use super::*;
use taomni_mail_api::contact_history::ContactHistoryAction;

#[cfg(test)]
pub(super) use taomni_mail_engine::drafts::{delete_mail_draft, list_mail_drafts, save_mail_draft};

#[tauri::command]
pub async fn mail_list_drafts(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailDraft>, String> {
    draft_store::list(&state, &account_id).await
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
    draft_store::save(&state, account_id, draft).await
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
    draft_store::delete(&state, account_id, draft_id).await
}

#[tauri::command]
pub async fn mail_index_cached_contacts(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    pop3_store::with_account_owner(
        &state,
        &account_id,
        taomni_mail_api::pop3_store::LocalMailboxAction::ReindexContacts,
        async {
            if module_host::manages_contact_history(&state.plugins) {
                return module_host::contact_history(
                    state.plugins.clone(),
                    state.mail_db(&account_id)?,
                    account_id.clone(),
                    ContactHistoryAction::Reindex,
                )
                .await;
            }
            with_mail_db_async(&state, &account_id, |db, account_id| {
                let tx = db.unchecked_transaction()?;
                let count = reindex_cached_contacts(&tx, account_id)?;
                tx.commit()?;
                Ok(count)
            })
            .await
        },
    )
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
    super::contacts::suggestions(&state, &account_id, query, limit).await
}
