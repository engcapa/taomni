use crate::mail::MailMessageBody;
use crate::mail::archive_query;
use crate::mail::storage;
use crate::mail::{
    attachment_files::publish_mail_bytes, decode_mail_original, module_host, with_mail_db_async,
    with_mail_original,
};
use crate::state::AppState;
use std::io::Read;
use std::path::Path;
use taomni_mail_engine::storage::scan;
use tauri::State;

#[tauri::command]
pub async fn mail_archive_query(
    account_id: String,
    query: archive_query::ArchiveQuery,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<archive_query::ArchivePage, String> {
    with_mail_db_async(&state, &account_id, move |db, account| {
        archive_query::query(db, account, &query, offset.unwrap_or(0))
            .map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_preview_cleanup(
    account_id: String,
    selection: archive_query::ArchiveSelection,
    state: State<'_, AppState>,
) -> Result<archive_query::CleanupPreview, String> {
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
    with_mail_db_async(&state, &account_id, move |db, account| {
        storage::list(db, account, offset.unwrap_or(0)).map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_read(
    account_id: String,
    entry: storage::ArchiveEntry,
    state: State<'_, AppState>,
) -> Result<MailMessageBody, String> {
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
    with_mail_db_async(&state, &account_id, move |db, account| {
        scan::pause(db, account)?;
        storage::remove_entries(db, account, &entries).map_err(storage::as_sql_error)
    })
    .await
}
