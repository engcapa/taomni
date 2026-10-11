use super::{control, jobs, model::ProviderKind};
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
) -> Result<Vec<DestinationResult>, String> {
    let config = control::load(&app)?;
    if config.selected_target_ids.is_empty() {
        return Err("Select at least one backup destination".into());
    }
    if !["core", "full"].contains(&scope.as_str()) {
        return Err("Invalid backup scope".into());
    }
    for id in config
        .selected_target_ids
        .iter()
        .filter(|id| id.as_str() != "local")
    {
        let t = config
            .targets
            .iter()
            .find(|t| &t.id == id)
            .ok_or("Selected backup target is missing")?;
        if t.kind != ProviderKind::Feishu {
            return Err("PROVIDER_NOT_IMPLEMENTED".into());
        }
        if !t.enabled || t.writes_paused {
            return Err(format!("Selected target {} is disabled or paused", t.name));
        }
    }
    let mut results = vec![];
    for id in config.selected_target_ids {
        if id == "local" {
            let outcome = super::backup_create(app.clone(), scope.clone(), None, None, None).await;
            results.push(match outcome {
                Ok(r) => DestinationResult {
                    target_id: id,
                    job_id: None,
                    local_path: Some(r.file_path),
                    error: None,
                },
                Err(e) => DestinationResult {
                    target_id: id,
                    job_id: None,
                    local_path: None,
                    error: Some(e),
                },
            });
        } else {
            let outcome = jobs::start(&app, &id, None, None);
            results.push(match outcome {
                Ok(job) => DestinationResult {
                    target_id: id,
                    job_id: Some(job),
                    local_path: None,
                    error: None,
                },
                Err(e) => DestinationResult {
                    target_id: id,
                    job_id: None,
                    local_path: None,
                    error: Some(e),
                },
            });
        }
    }
    Ok(results)
}
