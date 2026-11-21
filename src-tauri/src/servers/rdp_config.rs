//! Access the signed RDP settings through the existing Local servers form.

use std::collections::HashMap;

use serde_json::Value;
use taomni_server_process::{ServerConfig, rdp};

use super::{
    credentials::{RDP_PASSWORD_KIND, RDP_PASSWORD_LABEL, rdp_plaintext_password},
    db, process,
};
use crate::{plugin::LifecycleState, state::AppState};

const INSTALL: &str = "Install the RDP Server module from Settings → Module Store.";
const ENABLE: &str = "Enable the RDP Server module in Settings → Module Store.";

fn settings(state: &AppState) -> Result<Option<rdp::StoredSettings>, String> {
    rdp::SettingsFile::new(&state.core.paths.data)
        .load()
        .map_err(|error| format!("RDP Server settings: {error}"))
}

pub(super) fn project(
    state: &AppState,
    configs: &mut HashMap<String, Value>,
) -> Result<bool, String> {
    if let Some(record) = settings(state)? {
        configs.insert(
            rdp::SERVER_TYPE.to_owned(),
            serde_json::to_value(record.settings).map_err(|error| error.to_string())?,
        );
        return Ok(true);
    }
    if state.plugins.get(rdp::SLUG).is_some_and(|record| {
        record.state == LifecycleState::Uninstalled
            || record.manifest.commands.contains(rdp::SAVE_SETTINGS)
    }) {
        configs.remove(rdp::SERVER_TYPE);
        return Ok(true);
    }
    Ok(false)
}

pub(super) async fn save_if_managed(
    state: &AppState,
    submitted: &Value,
) -> Result<Option<Value>, String> {
    let _write = state.legacy.servers.rdp_settings.lock().await;
    let previous = settings(state)?;
    let record = state.plugins.get(rdp::SLUG);
    let Some(record) = record else {
        return if cfg!(feature = "legacy-rdp-server") && previous.is_none() {
            Ok(None)
        } else {
            Err(INSTALL.into())
        };
    };
    if record.state != LifecycleState::Enabled {
        return Err(ENABLE.into());
    }
    if !record.manifest.commands.contains(rdp::SAVE_SETTINGS) {
        return if previous.is_none() {
            Ok(None)
        } else {
            Err("Update the RDP Server module to edit its stored settings.".into())
        };
    }

    let mut next: ServerConfig = serde_json::from_value(submitted.clone())
        .map_err(|error| format!("Invalid RDP Server configuration: {error}"))?;
    next.extra.remove("password");
    next.extra.remove("passwordRef");
    next.extra.remove("credentialMigrationRequired");

    let password = match rdp_plaintext_password(submitted) {
        Some(password) => Some(zeroize::Zeroizing::new(password.to_owned())),
        None if previous
            .as_ref()
            .is_some_and(rdp::StoredSettings::needs_legacy_password) =>
        {
            Some(legacy_password(state)?)
        }
        None => None,
    };
    // The legacy rollback row may still refer to the original Vault entry.
    // A new password gets its own reference until the host publishes the edit.
    let reference = if let Some(password) = password {
        state
            .core
            .vault
            .put(RDP_PASSWORD_KIND, RDP_PASSWORD_LABEL, &password)?
            .reference
    } else {
        previous
            .as_ref()
            .and_then(rdp::StoredSettings::password_ref)
            .ok_or("RDP Server requires a password in the credential Vault.")?
            .to_owned()
    };
    next.extra.insert("passwordRef".into(), reference.into());
    let value = serde_json::to_value(next).map_err(|error| error.to_string())?;
    process::invoke::<()>(&state.plugins, rdp::SLUG, rdp::SAVE_SETTINGS, value.clone()).await?;
    Ok(Some(value))
}

fn legacy_password(state: &AppState) -> Result<zeroize::Zeroizing<String>, String> {
    let db = state.core.db.lock().map_err(|error| error.to_string())?;
    let row = db::load_server_config(&db, rdp::SERVER_TYPE).map_err(|error| error.to_string())?;
    row.as_ref()
        .and_then(rdp_plaintext_password)
        .map(|password| zeroize::Zeroizing::new(password.to_owned()))
        .ok_or_else(|| "Enter the RDP Server password to finish migration.".into())
}
