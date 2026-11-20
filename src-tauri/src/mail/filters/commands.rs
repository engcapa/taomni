use crate::mail::with_mail_db;
use crate::state::AppState;
use std::collections::HashSet;
use taomni_mail_engine::filters::{
    MailFilter, ensure_filter_mark, load_filters, parse_filter_file, prepare_filters,
    serialize_filter_file, store_filters,
};
use tauri::State;

#[tauri::command]
pub async fn mail_list_filters(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFilter>, String> {
    with_mail_db(&state, &account_id, |db| load_filters(db, &account_id))
}

/// Replace the account's filters (order = run order).
#[tauri::command]
pub async fn mail_save_filters(
    account_id: String,
    filters: Vec<MailFilter>,
    state: State<'_, AppState>,
) -> Result<Vec<MailFilter>, String> {
    let filters = prepare_filters(filters)?;
    with_mail_db(&state, &account_id, |db| {
        store_filters(db, &account_id, &filters)?;
        // Only mail arriving from now on is filtered on receipt.
        ensure_filter_mark(db, &account_id, "INBOX")?;
        load_filters(db, &account_id)
    })
}

#[tauri::command]
pub async fn mail_export_filters(
    account_id: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let filters = with_mail_db(&state, &account_id, |db| load_filters(db, &account_id))?;
    let count = filters.len();
    let json = serialize_filter_file(filters)?;
    std::fs::write(target_path.trim(), json)
        .map_err(|e| format!("failed to write filters: {e}"))?;
    Ok(count)
}

/// Append the filters of a file after the existing ones.
#[tauri::command]
pub async fn mail_import_filters(
    account_id: String,
    source_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFilter>, String> {
    let text = std::fs::read_to_string(source_path.trim())
        .map_err(|e| format!("failed to read filters: {e}"))?;
    let imported = parse_filter_file(&text)?;
    with_mail_db(&state, &account_id, |db| {
        let mut all = load_filters(db, &account_id)?;
        let known: HashSet<String> = all.iter().map(|f| f.id.clone()).collect();
        all.extend(imported.into_iter().map(|mut f| {
            if known.contains(&f.id) {
                f.id.clear();
            }
            f
        }));
        Ok(all)
    })
    .and_then(|all| prepare_filters(all))
    .and_then(|all| {
        with_mail_db(&state, &account_id, |db| {
            store_filters(db, &account_id, &all)?;
            ensure_filter_mark(db, &account_id, "INBOX")?;
            load_filters(db, &account_id)
        })
    })
}
