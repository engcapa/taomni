use super::model::SaveSdkInstallationRequest;
use super::model::SaveWorkspaceSdkBindingRequest;
use super::model::SdkInstallation;
use super::model::SdkKind;
use super::model::SdkProbe;
use super::model::SdkRegistry;
use super::model::SdkRole;
use super::model::SetSdkDefaultRequest;
use super::model::WorkspaceSdkBinding;
use crate::sdk::detect;
use crate::sdk::probe;
use crate::sdk::resolve;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn sdk_get_registry(state: State<'_, AppState>) -> Result<SdkRegistry, String> {
    Ok(state.workspace.sdk.snapshot().await)
}

#[tauri::command]
pub async fn sdk_probe_installation(kind: SdkKind, location: String) -> Result<SdkProbe, String> {
    Ok(probe::probe_sdk(kind, &location).await)
}

#[tauri::command]
pub async fn sdk_discover_installations(
    kinds: Option<Vec<SdkKind>>,
) -> Result<Vec<SdkProbe>, String> {
    let kinds = kinds.unwrap_or_else(|| {
        vec![
            SdkKind::Java,
            SdkKind::Kotlin,
            SdkKind::Scala,
            SdkKind::Python,
        ]
    });
    Ok(probe::discover_sdks(&kinds).await)
}

#[tauri::command]
pub async fn sdk_save_installation(
    request: SaveSdkInstallationRequest,
    state: State<'_, AppState>,
) -> Result<SdkInstallation, String> {
    state.workspace.sdk.save_installation(request).await
}

#[tauri::command]
pub async fn sdk_remove_installation(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.workspace.sdk.remove_installation(&id).await
}

#[tauri::command]
pub async fn sdk_refresh_installations(
    id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SdkInstallation>, String> {
    state
        .workspace
        .sdk
        .refresh_installations(id.as_deref())
        .await
}

#[tauri::command]
pub async fn sdk_set_default(
    request: SetSdkDefaultRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.workspace.sdk.set_default(request).await
}

#[tauri::command]
pub async fn sdk_save_workspace_binding(
    request: SaveWorkspaceSdkBindingRequest,
    state: State<'_, AppState>,
) -> Result<WorkspaceSdkBinding, String> {
    state.workspace.sdk.save_binding(request).await
}

#[tauri::command]
pub async fn sdk_remove_workspace_binding(
    scope_path: String,
    kind: SdkKind,
    role: SdkRole,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .workspace
        .sdk
        .remove_binding(&scope_path, kind, role)
        .await
}

#[tauri::command]
pub async fn sdk_analyze_workspace(
    workspace_root: String,
) -> Result<detect::WorkspaceSdkAnalysis, String> {
    tokio::task::spawn_blocking(move || detect::analyze_workspace(&workspace_root))
        .await
        .map_err(|error| format!("SDK workspace analysis task failed: {error}"))?
}

#[tauri::command]
pub async fn sdk_resolve_workspace(
    workspace_root: String,
    state: State<'_, AppState>,
) -> Result<resolve::WorkspaceSdkResolution, String> {
    state.workspace.sdk.resolve_workspace(&workspace_root).await
}
