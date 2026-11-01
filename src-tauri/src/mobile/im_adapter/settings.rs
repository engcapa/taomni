use super::{Config, Status};
use crate::{mobile::Core, state::AppState};
use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

#[derive(Serialize)]
pub struct View {
    config: Config,
    status: Status,
    secret_configured: bool,
}
fn view(config: Config, state: &AppState) -> View {
    let secret_configured = !config.secret_ref.is_empty();
    View {
        config,
        status: state.mobile.im.snapshot(),
        secret_configured,
    }
}
#[tauri::command]
pub async fn mobile_feishu_get(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<View, String> {
    Ok(view(
        Config::load(&crate::resolved_app_data_dir(&app)?)?,
        &state,
    ))
}
#[tauri::command]
pub async fn mobile_feishu_save(
    mut config: Config,
    secret: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<View, String> {
    let _service = state.mobile.lifecycle.lock().await;
    let secret = secret.map(Zeroizing::new);
    if !state.mobile.im.idle().await {
        return Err("stop_feishu_before_saving".into());
    }
    let data = crate::resolved_app_data_dir(&app)?;
    let old = Config::load(&data)?;
    // The UI cannot assign references to unrelated vault entries.
    config.secret_ref = old.secret_ref.clone();
    config.validate()?;
    if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        if secret.len() > 1024 {
            return Err("invalid_app_secret".into());
        }
        state.vault.put_fixed(
            "mobile.feishu.app-secret",
            "api-key",
            "Taomni Feishu application",
            &secret,
        )?;
        config.secret_ref = "vault:mobile.feishu.app-secret".into();
    }
    config.save(&data)?;
    Ok(view(config, &state))
}
#[tauri::command]
pub async fn mobile_feishu_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Status, String> {
    let service = state.mobile.lifecycle.lock().await;
    if !service.as_ref().is_some_and(|r| !r.task.is_finished()) {
        return Err("start_mobile_service_first".into());
    }
    let config = Config::load(&crate::resolved_app_data_dir(&app)?)?;
    let secret = state
        .vault
        .resolve(&config.secret_ref)?
        .ok_or("configure_app_secret_in_vault")?;
    state
        .mobile
        .im
        .start(Core::Desktop(app), config, secret)
        .await?;
    drop(service);
    Ok(state.mobile.im.snapshot())
}
#[tauri::command]
pub async fn mobile_feishu_stop(state: State<'_, AppState>) -> Result<Status, String> {
    state.mobile.im.stop().await;
    Ok(state.mobile.im.snapshot())
}
