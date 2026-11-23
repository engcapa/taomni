use crate::mail::MailMessageBody;
use crate::mail::archive_query;
use crate::mail::storage;
use crate::mail::{
    attachment_files::publish_mail_bytes, decode_mail_original, module_host, pop3_store,
    with_mail_db_async, with_mail_original,
};
use crate::state::AppState;
use serde::de::DeserializeOwned;
use std::path::Path;
use taomni_mail_api::archive_index::ArchiveIndexAction;
use taomni_mail_api::pop3_store::LocalArchiveAction;
use taomni_mail_engine::storage::scan;
use tauri::State;

use super::owned;

#[tauri::command]
pub async fn mail_archive_query(
    account_id: String,
    query: archive_query::ArchiveQuery,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<archive_query::ArchivePage, String> {
    let offset = offset.unwrap_or(0);
    let hosted = pop3_store::is_hosted(&state, &account_id).await?;
    if module_host::queries_archive_index(&state.plugins) {
        let cache = if hosted {
            None
        } else {
            Some(state.mail_db(&account_id)?)
        };
        return module_host::query_archive_index(
            state.plugins.clone(),
            account_id,
            cache,
            ArchiveIndexAction::Find { query, offset },
        )
        .await;
    }
    with_mail_db_async(&state, &account_id, move |db, account| {
        archive_query::query(db, account, &query, offset).map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_preview_cleanup(
    account_id: String,
    selection: archive_query::ArchiveSelection,
    state: State<'_, AppState>,
) -> Result<archive_query::CleanupPreview, String> {
    if pop3_store::is_hosted(&state, &account_id).await? {
        return owned::run(
            &state,
            &account_id,
            LocalArchiveAction::Preview { selection },
        )
        .await;
    }
    if module_host::cleans_archive_index(&state.plugins) {
        return cleanup_in_host(
            &state,
            &account_id,
            ArchiveIndexAction::Preview { selection },
        )
        .await;
    }
    with_mail_db_async(&state, &account_id, move |db, account| {
        archive_query::preview(db, account, &selection).map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_cleanup(
    account_id: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    // Stop publication before deleting the frozen preview; skip markers prevent
    // other instances from publishing these originals again.
    state.legacy.mail.mail_archive.pause_account(&account_id)?;
    if pop3_store::is_hosted(&state, &account_id).await? {
        return owned::run(&state, &account_id, LocalArchiveAction::Cleanup { token }).await;
    }
    if module_host::cleans_archive_index(&state.plugins) {
        return cleanup_in_host(&state, &account_id, ArchiveIndexAction::Cleanup { token }).await;
    }
    with_mail_db_async(&state, &account_id, move |db, account| {
        archive_query::remove_preview(db, account, &token).map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_list(
    account_id: String,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<storage::ArchiveEntry>, String> {
    let offset = offset.unwrap_or(0);
    let hosted = pop3_store::is_hosted(&state, &account_id).await?;
    if module_host::queries_archive_index(&state.plugins) {
        let cache = if hosted {
            None
        } else {
            Some(state.mail_db(&account_id)?)
        };
        return module_host::query_archive_index(
            state.plugins.clone(),
            account_id,
            cache,
            ArchiveIndexAction::List { offset },
        )
        .await;
    }
    with_mail_db_async(&state, &account_id, move |db, account| {
        storage::list(db, account, offset).map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_read(
    account_id: String,
    entry: storage::ArchiveEntry,
    state: State<'_, AppState>,
) -> Result<MailMessageBody, String> {
    if pop3_store::is_hosted(&state, &account_id).await? {
        return owned::run(&state, &account_id, LocalArchiveAction::Read { entry }).await;
    }
    if module_host::opens_archive_original(&state.plugins) {
        let cache = state.mail_db(&account_id)?;
        return module_host::read_archive_original(state.plugins.clone(), cache, account_id, entry)
            .await;
    }
    let folder = entry.folder.clone();
    let uid = entry.uid;
    let original = with_mail_original(&state, &account_id, move |db, account| {
        storage::open_entry(db, account, &entry)
    })
    .await?;
    module_host::decode_archive_original(state.plugins.clone(), original, account_id, folder, uid)
        .await
}

#[tauri::command]
pub async fn mail_archive_export(
    account_id: String,
    entry: storage::ArchiveEntry,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if pop3_store::is_hosted(&state, &account_id).await? {
        return module_host::pop3_store::export(
            state.plugins.clone(),
            account_id,
            entry,
            None,
            Path::new(&target_path),
        )
        .await;
    }
    if module_host::opens_archive_original(&state.plugins) {
        let cache = state.mail_db(&account_id)?;
        return module_host::export_archive_original(
            state.plugins.clone(),
            cache,
            account_id,
            entry,
            None,
            Path::new(&target_path),
        )
        .await;
    }
    let original = with_mail_original(&state, &account_id, move |db, account| {
        storage::open_entry(db, account, &entry)
    })
    .await?;
    decode_mail_original(move || original.export(Path::new(&target_path)).map(|_| ())).await
}

#[tauri::command]
pub async fn mail_archive_attachment(
    account_id: String,
    entry: storage::ArchiveEntry,
    attachment_index: usize,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if pop3_store::is_hosted(&state, &account_id).await? {
        return module_host::pop3_store::export(
            state.plugins.clone(),
            account_id,
            entry,
            Some(attachment_index),
            Path::new(&target_path),
        )
        .await;
    }
    if module_host::opens_archive_original(&state.plugins) {
        let cache = state.mail_db(&account_id)?;
        return module_host::export_archive_original(
            state.plugins.clone(),
            cache,
            account_id,
            entry,
            Some(attachment_index),
            Path::new(&target_path),
        )
        .await;
    }
    let original = with_mail_original(&state, &account_id, move |db, account| {
        storage::open_entry(db, account, &entry)
    })
    .await?;
    let contents =
        module_host::decode_archive_attachment(state.plugins.clone(), original, attachment_index)
            .await?;
    decode_mail_original(move || publish_mail_bytes(Path::new(&target_path), &contents)).await
}

#[tauri::command]
pub async fn mail_archive_remove(
    account_id: String,
    entries: Vec<storage::ArchiveEntry>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    state.legacy.mail.mail_archive.pause_account(&account_id)?;
    if pop3_store::is_hosted(&state, &account_id).await? {
        return owned::run(&state, &account_id, LocalArchiveAction::Remove { entries }).await;
    }
    if module_host::cleans_archive_index(&state.plugins) {
        return cleanup_in_host(&state, &account_id, ArchiveIndexAction::Remove { entries }).await;
    }
    with_mail_db_async(&state, &account_id, move |db, account| {
        scan::pause(db, account)?;
        storage::remove_entries(db, account, &entries).map_err(storage::as_sql_error)
    })
    .await
}

async fn cleanup_in_host<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: ArchiveIndexAction,
) -> Result<T, String> {
    module_host::cleanup_archive_index(
        state.plugins.clone(),
        account.to_owned(),
        state.mail_db(account)?,
        action,
    )
    .await
}
