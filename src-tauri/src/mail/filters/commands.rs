use super::store;
use crate::state::AppState;
use taomni_mail_engine::filters::{
    MailFilter, parse_filter_file, rules::FilterRulesAction, serialize_filter_file,
};
use tauri::State;

#[tauri::command]
pub async fn mail_list_filters(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFilter>, String> {
    store::run(&state, &account_id, FilterRulesAction::List).await
}

/// Replace the account's filters (order = run order).
#[tauri::command]
pub async fn mail_save_filters(
    account_id: String,
    filters: Vec<MailFilter>,
    state: State<'_, AppState>,
) -> Result<Vec<MailFilter>, String> {
    store::run(
        &state,
        &account_id,
        FilterRulesAction::Replace { rules: filters },
    )
    .await
}

#[tauri::command]
pub async fn mail_export_filters(
    account_id: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let filters = store::run(&state, &account_id, FilterRulesAction::List).await?;
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
    store::run(
        &state,
        &account_id,
        FilterRulesAction::Append { rules: imported },
    )
    .await
}
