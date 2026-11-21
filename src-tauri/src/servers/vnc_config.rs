//! Adapt the original Servers form to the signed VNC Server settings owner.

use std::collections::HashMap;

use serde_json::Value;
use taomni_server_process::vnc as contract;

use super::{db, vnc};
use crate::{plugin::LifecycleState, state::AppState};

const SERVER_TYPE: &str = "vnc";
const PASSWORD_KIND: &str = "vnc-server-password";

fn settings(state: &AppState) -> Result<Option<contract::Settings>, String> {
    contract::SettingsFile::new(&state.core.paths.data)
        .load()
        .map(|record| record.map(|record| record.settings))
        .map_err(|error| format!("VNC Server settings: {error}"))
}

pub(super) fn project(
    state: &AppState,
    configs: &mut HashMap<String, Value>,
) -> Result<(), String> {
    if let Some(settings) = settings(state)? {
        configs.insert(
            SERVER_TYPE.to_owned(),
            serde_json::to_value(settings).map_err(|error| error.to_string())?,
        );
    } else if state.plugins.get(contract::SLUG).is_some_and(|record| {
        record.state == LifecycleState::Uninstalled
            || record.manifest.commands.contains(contract::SAVE_SETTINGS)
    }) {
        // A user who chose permanent deletion must get fresh settings on
        // reinstall. The rollback row must never take over again.
        configs.remove(SERVER_TYPE);
    }
    Ok(())
}

pub(super) async fn save_if_managed(
    state: &AppState,
    value: &Value,
) -> Result<Option<Value>, String> {
    let _write = state.legacy.servers.vnc_settings.lock().await;
    let previous = settings(state)?;
    let record = state.plugins.get(contract::SLUG);
    let supports_settings = record
        .as_ref()
        .is_some_and(|record| record.manifest.commands.contains(contract::SAVE_SETTINGS));
    if !supports_settings
        && previous.is_none()
        && !record
            .as_ref()
            .is_some_and(|record| record.state == LifecycleState::Uninstalled)
    {
        return Ok(None);
    }
    if !record.is_some_and(|record| record.state == LifecycleState::Enabled) {
        return Err(
            "Enable the VNC Server module in Settings → Module Store to edit its settings.".into(),
        );
    }
    if !supports_settings {
        return Err("Update the VNC Server module to edit its stored settings.".into());
    }
    let mut next: contract::Settings = serde_json::from_value(value.clone())
        .map_err(|error| format!("Invalid VNC Server configuration: {error}"))?;
    let previous = previous.unwrap_or_default();
    next.password_ref = if value.get("removePassword").and_then(Value::as_bool) == Some(true) {
        None
    } else if let Some(password) = submitted_password(value) {
        Some(store_password(state, password)?)
    } else if previous.credential_migration_required {
        let legacy = {
            let db = state.core.db.lock().map_err(|error| error.to_string())?;
            db::load_server_config(&db, SERVER_TYPE).map_err(|error| error.to_string())?
        };
        let password = legacy
            .as_ref()
            .and_then(submitted_password)
            .ok_or("Enter the VNC Server password to finish migration.")?;
        Some(store_password(state, password)?)
    } else {
        previous.password_ref
    };
    next.credential_migration_required = false;
    let value = serde_json::to_value(next).map_err(|error| error.to_string())?;
    vnc::call::<()>(&state.plugins, contract::SAVE_SETTINGS, value.clone()).await?;
    Ok(Some(value))
}

pub(super) fn resolve_password(state: &AppState) -> Result<String, String> {
    let Some(settings) = settings(state)? else {
        return Ok(String::new());
    };
    if settings.credential_migration_required {
        return Err(
            "Open Local servers and unlock the Vault to finish migrating the VNC password.".into(),
        );
    }
    let Some(reference) = settings.password_ref else {
        return Ok(String::new());
    };
    state
        .core
        .vault
        .resolve_for_kind(&reference, PASSWORD_KIND)?
        .map(|value| value.to_string())
        .ok_or_else(|| "Invalid VNC Server password reference".into())
}

fn submitted_password(value: &Value) -> Option<&str> {
    value
        .get("password")
        .and_then(Value::as_str)
        .filter(|password| !password.is_empty())
}

fn store_password(state: &AppState, password: &str) -> Result<String, String> {
    state
        .core
        .vault
        .put(PASSWORD_KIND, "VNC Server password", password)
        .map(|result| result.reference)
}
