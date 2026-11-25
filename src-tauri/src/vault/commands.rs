//! IPC owns asynchronous router refresh; password transitions run off the UI
//! thread and share the registry's retryable admission/revocation coordinator.
use super::{
    ERR_VAULT_ENTRY_PROTECTED, Vault, VaultPutResult, VaultStatus, db, is_protected_entry,
};
use crate::{plugin::PluginRegistry, state::AppState};
use tauri::State;
use zeroize::Zeroizing;

async fn transition(
    state: &AppState,
    action: impl FnOnce(&PluginRegistry, &Vault) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let plugins = state.plugins.clone();
    let vault = state.core.vault.clone();
    tauri::async_runtime::spawn_blocking(move || action(&plugins, &vault))
        .await
        .map_err(|error| error.to_string())?
}

async fn rebuild_router(state: &AppState) -> Result<(), String> {
    let cfg = state.legacy.ai_ctx.read().await.config.clone();
    let llm = {
        let db = state
            .core
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::llm::router::build_router_from_ai_with_proxy_db(
            &cfg,
            Some(state.core.vault.as_ref()),
            Some(&db),
        )
    };
    state.legacy.ai_ctx.write().await.replace_router(llm);
    Ok(())
}

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    state.core.vault.status()
}

#[tauri::command]
pub async fn vault_init(master_password: String, state: State<'_, AppState>) -> Result<(), String> {
    let password = Zeroizing::new(master_password);
    transition(&state, move |plugins, vault| {
        plugins.initialize_vault(vault, &password)
    })
    .await?;
    rebuild_router(&state).await
}

#[tauri::command]
pub async fn vault_unlock(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let password = Zeroizing::new(master_password);
    transition(&state, move |plugins, vault| {
        plugins.unlock_vault(vault, &password)
    })
    .await?;
    rebuild_router(&state).await
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<(), String> {
    transition(&state, |plugins, vault| plugins.lock_vault(vault)).await?;
    crate::deepseek_app::cancel_all();
    rebuild_router(&state).await
}

#[tauri::command]
pub async fn vault_change_master(
    old_password: String,
    new_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let old = Zeroizing::new(old_password);
    let new = Zeroizing::new(new_password);
    transition(&state, move |plugins, vault| {
        plugins.change_vault_master(vault, &old, &new)
    })
    .await?;
    rebuild_router(&state).await
}

#[tauri::command]
pub async fn vault_put(
    kind: String,
    label: String,
    plaintext: String,
    state: State<'_, AppState>,
) -> Result<VaultPutResult, String> {
    state.core.vault.put(&kind, &label, &plaintext)
}

#[tauri::command]
pub async fn vault_update(
    id: String,
    plaintext: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.core.vault.update(&id, &plaintext)
}

#[tauri::command]
pub async fn vault_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if is_protected_entry(&id) {
        return Err(ERR_VAULT_ENTRY_PROTECTED.to_string());
    }
    state.core.vault.delete(&id)
}

#[tauri::command]
pub async fn vault_list(state: State<'_, AppState>) -> Result<Vec<db::EntrySummary>, String> {
    state.core.vault.list()
}
