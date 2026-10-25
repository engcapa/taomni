use super::control;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationResult {
    pub target_id: String,
    pub job_id: Option<String>,
    pub local_path: Option<String>,
    pub error: Option<String>,
}

/// Validate the entire selection first, then give each destination its own result.
#[tauri::command]
pub async fn backup_run_selected(
    app: tauri::AppHandle,
    scope: String,
    include_mail: Option<bool>,
) -> Result<Vec<DestinationResult>, String> {
    // Compatibility IPC: manual scope is now owned by saved global defaults.
    let _ = (scope, include_mail);
    let config = control::load(&app)?;
    let policy = super::policy::load_policy_result(&app)?;
    super::settings::backup_run_manual(
        app,
        super::settings_model::ManualRequest {
            destination: super::settings_model::ManualDestination::Selected {
                local_password: None,
            },
            expected_policy_revision: policy.settings_revision,
            expected_control_revision: Some(config.settings_revision),
        },
    )
    .await
}
