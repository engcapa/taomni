//! Narrow, revision-checked settings mutations. No archive-format changes.
use super::{commands, control, credentials, jobs, model::*, policy, range, settings_model::*};
use serde_json::Value;
use tauri::Manager;

pub const CONFLICT: &str = "BACKUP_CONFIG_CONFLICT";

#[tauri::command]
pub async fn backup_settings_get(app: tauri::AppHandle) -> Result<SettingsSnapshot, String> {
    let policy = policy::load_policy_result(&app)?;
    let remote = commands::backup_remote_get_config(app).await?;
    let revisions = Revisions {
        policy: policy.settings_revision,
        control: remote.config.settings_revision,
    };
    Ok(SettingsSnapshot {
        policy,
        remote,
        revisions,
    })
}

fn merge_fields(value: &mut Value, patch: &Value, allowed: &[&str]) -> Result<(), String> {
    let fields = patch.as_object().ok_or("Invalid settings patch")?;
    for (key, field) in fields {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("Settings field is not editable: {key}"));
        }
        value[key] = field.clone();
    }
    Ok(())
}

pub(super) fn patch_policy(
    current: &policy::BackupPolicy,
    patch: &Value,
) -> Result<policy::BackupPolicy, String> {
    let mut value = serde_json::to_value(current).map_err(|e| e.to_string())?;
    merge_fields(
        &mut value,
        patch,
        &[
            "defaultScope",
            "includeMail",
            "defaultCustomOptions",
            "localRangeOverride",
            "localChannelEnabled",
            "autoBackupEnabled",
            "frequency",
            "customBackupDir",
            "maxRetainedCopies",
        ],
    )?;
    let mut next: policy::BackupPolicy =
        serde_json::from_value(value).map_err(|e| e.to_string())?;
    range::global(&next).validate()?;
    if let Some(range) = &next.local_range_override {
        range.validate()?;
    }
    if !["daily", "weekly", "on_exit"].contains(&next.frequency.as_str())
        || !(1..=10_000).contains(&next.max_retained_copies)
    {
        return Err("Invalid backup frequency or retained copies".into());
    }
    next.settings_revision = current.settings_revision.saturating_add(1);
    Ok(next)
}

fn validate_target(target: &BackupTarget) -> Result<(), String> {
    validate_id(&target.id)?;
    if target.kind != ProviderKind::Feishu {
        return Err("PROVIDER_NOT_IMPLEMENTED".into());
    }
    if target.name.trim().is_empty()
        || target.name.len() > 128
        || !["inherit", "custom"].contains(&target.range_mode.as_str())
        || !["app", "custom", "none"].contains(&target.proxy.mode.as_str())
        || target.source.kind != "taomni"
        || target.source.schema_version != 1
    {
        return Err("Invalid backup target settings".into());
    }
    if !target.root_token.is_empty() {
        validate_token(&target.root_token)?;
    }
    range::BackupRange {
        scope: target.source.scope.clone(),
        custom_options: target.source.custom_options.clone(),
    }
    .validate()
}

fn patch_control(
    app: &tauri::AppHandle,
    config: &mut ControlConfig,
    patch: &Value,
) -> Result<(), String> {
    let op = patch["op"].as_str().ok_or("Missing settings operation")?;
    match op {
        "setDeviceName" => {
            let name = patch["name"].as_str().ok_or("Invalid device name")?.trim();
            if name.is_empty() || name.len() > 128 {
                return Err("Invalid device name".into());
            }
            config.device.name = name.into();
        }
        "setSelectedTargets" => {
            let ids: Vec<String> =
                serde_json::from_value(patch["ids"].clone()).map_err(|e| e.to_string())?;
            let mut unique = std::collections::HashSet::new();
            for id in &ids {
                if !unique.insert(id)
                    || (id != "local" && !config.targets.iter().any(|t| &t.id == id))
                {
                    return Err("Invalid selected backup destinations".into());
                }
            }
            config.selected_target_ids = ids;
        }
        "addTarget" => {
            let mut target: BackupTarget =
                serde_json::from_value(patch["target"].clone()).map_err(|e| e.to_string())?;
            target.enabled = false;
            target.connection_id = None;
            target.app_id.clear();
            target.writes_paused = false;
            target.range_mode = "inherit".into();
            validate_target(&target)?;
            if config.targets.iter().any(|t| t.id == target.id) {
                return Err("Duplicate backup target".into());
            }
            config.targets.push(target);
        }
        "updateTarget" | "removeTarget" => {
            let id = patch["targetId"]
                .as_str()
                .ok_or("Missing target identifier")?;
            let index = config
                .targets
                .iter()
                .position(|t| t.id == id)
                .ok_or("Backup target not found")?;
            let fields = &patch["fields"];
            let sensitive = op == "removeTarget"
                || ["proxy", "rootToken", "enabled"]
                    .iter()
                    .any(|key| fields.get(key).is_some());
            if sensitive {
                let running = app.state::<jobs::BackupJobs>();
                let active = running.running.lock().map_err(|e| e.to_string())?;
                let relevant_transfer = jobs::list(app)?
                    .iter()
                    .any(|j| j.target_id == id && active.contains_key(&j.id));
                let relevant_auth = super::feishu::auth::sessions(app)?
                    .iter()
                    .any(|s| s.target_id == id && active.contains_key(&format!("auth:{}", s.id)));
                if relevant_transfer || relevant_auth {
                    return Err("Finish or cancel active tasks for this destination first".into());
                }
            }
            if op == "removeTarget" {
                config.targets.remove(index);
                config.selected_target_ids.retain(|value| value != id);
            } else {
                let mut value =
                    serde_json::to_value(&config.targets[index]).map_err(|e| e.to_string())?;
                merge_fields(
                    &mut value,
                    fields,
                    &[
                        "name",
                        "enabled",
                        "rootToken",
                        "proxy",
                        "source",
                        "rangeMode",
                    ],
                )?;
                let target: BackupTarget =
                    serde_json::from_value(value).map_err(|e| e.to_string())?;
                validate_target(&target)?;
                if target.enabled
                    && credentials::get(&config.device.id, id)?
                        .archive_password
                        .trim()
                        .is_empty()
                {
                    return Err(
                        "Configure an independent backup password before enabling cloud backup"
                            .into(),
                    );
                }
                config.targets[index] = target;
            }
        }
        _ => return Err("Unknown backup settings operation".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn backup_settings_patch(
    app: tauri::AppHandle,
    request: PatchRequest,
) -> Result<SettingsSnapshot, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if request.domain == "policy" {
            let coordinator = worker_app.state::<super::scheduler::BackupCoordinator>();
            let _operation = coordinator.operation.lock().map_err(|e| e.to_string())?;
            let _process = super::coordination::BackupProcessLock::acquire(&worker_app)?;
            let current = policy::load_policy_result(&worker_app)?;
            if current.settings_revision != request.expected_revision {
                return Err(CONFLICT.into());
            }
            policy::save_policy(&worker_app, &patch_policy(&current, &request.patch)?)
        } else if request.domain == "control" {
            let _owner = jobs::claim(&worker_app)?;
            let jobs = worker_app.state::<jobs::BackupJobs>();
            let _gate = jobs.gate.lock().map_err(|e| e.to_string())?;
            control::update(&worker_app, |config| {
                if config.settings_revision != request.expected_revision {
                    return Err(CONFLICT.into());
                }
                patch_control(&worker_app, config, &request.patch)
            })
        } else {
            Err("Unknown backup settings domain".into())
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    backup_settings_get(app).await
}

#[tauri::command]
pub async fn backup_target_set_password(
    app: tauri::AppHandle,
    target_id: String,
    password: String,
) -> Result<SettingsSnapshot, String> {
    if password.trim().is_empty() {
        return Err("Backup password cannot be empty".into());
    }
    let _owner = jobs::claim(&app)?;
    {
        let service = app.state::<jobs::BackupJobs>();
        let _gate = service.gate.lock().map_err(|e| e.to_string())?;
        let running = service.running.lock().map_err(|e| e.to_string())?;
        if jobs::list(&app)?
            .iter()
            .any(|j| j.target_id == target_id && running.contains_key(&j.id))
        {
            return Err("Wait for this destination's transfer before changing its password".into());
        }
        let config = control::load(&app)?;
        if !config.targets.iter().any(|t| t.id == target_id) {
            return Err("Backup target not found".into());
        }
        let mut secrets = credentials::get(&config.device.id, &target_id)?;
        secrets.archive_password = password;
        credentials::put(&config.device.id, &target_id, &secrets)?;
    }
    backup_settings_get(app).await
}

#[tauri::command]
pub async fn backup_run_manual(
    app: tauri::AppHandle,
    request: ManualRequest,
) -> Result<Vec<super::batch::DestinationResult>, String> {
    use super::batch::DestinationResult;
    let policy = policy::load_policy_result(&app)?;
    if policy.settings_revision != request.expected_policy_revision {
        return Err(CONFLICT.into());
    }
    let range = range::global(&policy);
    range.validate()?;
    if let ManualDestination::File { path, password } = request.destination {
        let result =
            super::backup_create(app, range.scope, range.custom_options, Some(path), password)
                .await?;
        return Ok(vec![DestinationResult {
            target_id: "local".into(),
            job_id: None,
            local_path: Some(result.file_path),
            error: None,
        }]);
    }
    let ManualDestination::Selected { local_password } = request.destination else {
        unreachable!()
    };
    let config = control::load(&app)?;
    if request.expected_control_revision != Some(config.settings_revision) {
        return Err(CONFLICT.into());
    }
    if config.selected_target_ids.is_empty() {
        return Err("Select at least one backup destination".into());
    }
    for id in &config.selected_target_ids {
        if id == "local" {
            if !policy.local_channel_enabled {
                return Err("Local backup destination is disabled".into());
            }
        } else {
            let target = config
                .targets
                .iter()
                .find(|t| &t.id == id)
                .ok_or("Backup target not found")?;
            if !target.enabled || target.writes_paused {
                return Err("Backup target uploads are disabled or paused".into());
            }
            let connection = target
                .connection_id
                .as_deref()
                .ok_or("Connect Feishu before using this backup target")?;
            if !super::feishu::auth::connected(&credentials::get_connection(
                &config.device.id,
                connection,
            )?) {
                return Err("Connect Feishu before using this backup target".into());
            }
            if credentials::get(&config.device.id, id)?
                .archive_password
                .trim()
                .is_empty()
            {
                return Err(
                    "Configure an independent backup password before enabling cloud backup".into(),
                );
            }
        }
    }
    let mut results = Vec::new();
    for id in config.selected_target_ids {
        let outcome = if id == "local" {
            super::backup_create(
                app.clone(),
                range.scope.clone(),
                range.custom_options.clone(),
                None,
                local_password.clone(),
            )
            .await
            .map(|r| DestinationResult {
                target_id: id.clone(),
                job_id: None,
                local_path: Some(r.file_path),
                error: None,
            })
        } else {
            jobs::start_manual(&app, &id, range.source()).map(|job| DestinationResult {
                target_id: id.clone(),
                job_id: Some(job),
                local_path: None,
                error: None,
            })
        };
        results.push(outcome.unwrap_or_else(|error| DestinationResult {
            target_id: id,
            job_id: None,
            local_path: None,
            error: Some(error),
        }));
    }
    Ok(results)
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
