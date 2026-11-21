//! Keep Local servers' settings and credentials with their respective owners.

use std::collections::HashMap;

use serde_json::Value;
use taomni_server_process::{ServerConfig, local};
use zeroize::Zeroizing;

use super::{db, process};
use crate::{plugin::LifecycleState, state::AppState};

pub(super) const INSTALL: &str = "Install the Local servers module from Settings → Module Store.";
pub(super) const ENABLE: &str = "Enable the Local servers module in Settings → Module Store.";

fn settings(state: &AppState) -> Result<Option<local::StoredSettings>, String> {
    local::SettingsFile::new(&state.core.paths.data)
        .load()
        .map_err(|error| format!("Local servers settings: {error}"))
}

pub(super) fn project(state: &AppState, configs: &mut HashMap<String, Value>) {
    match settings(state) {
        Ok(Some(record)) => {
            for kind in local::Kind::ALL {
                configs.remove(kind.as_str());
            }
            for (kind, config) in record.settings {
                match serde_json::to_value(config) {
                    Ok(value) => {
                        configs.insert(kind.as_str().into(), value);
                    }
                    Err(error) => tracing::warn!("load {} settings: {error}", kind.as_str()),
                }
            }
        }
        Ok(None) => {
            if state.plugins.get(local::SLUG).is_some_and(|record| {
                record.state == LifecycleState::Uninstalled
                    || record.manifest.commands.contains(local::SAVE_SETTINGS)
            }) {
                for kind in local::Kind::ALL {
                    configs.remove(kind.as_str());
                }
            } else if !cfg!(feature = "legacy-local-servers") {
                for kind in local::Kind::ALL
                    .into_iter()
                    .filter(|kind| kind.uses_password())
                {
                    if let Some(object) = configs
                        .get_mut(kind.as_str())
                        .and_then(Value::as_object_mut)
                    {
                        if object
                            .remove("password")
                            .and_then(|value| plaintext(&value).map(str::len))
                            .is_some()
                        {
                            object.insert("credentialMigrationRequired".into(), true.into());
                        }
                    }
                }
            }
        }
        Err(error) => {
            for kind in local::Kind::ALL {
                configs.remove(kind.as_str());
            }
            tracing::warn!("load Local servers settings: {error}");
        }
    }
}

pub(super) async fn save_if_managed(
    state: &AppState,
    kind: local::Kind,
    submitted: &Value,
) -> Result<Option<Value>, String> {
    let _write = state.legacy.servers.local_settings.lock().await;
    let previous = settings(state)?;
    let Some(record) = state.plugins.get(local::SLUG) else {
        return if cfg!(feature = "legacy-local-servers") && previous.is_none() {
            Ok(None)
        } else {
            Err(INSTALL.into())
        };
    };
    if record.state != LifecycleState::Enabled {
        return Err(ENABLE.into());
    }
    if !record.manifest.commands.contains(local::SAVE_SETTINGS) {
        return if previous.is_none() {
            Ok(None)
        } else {
            Err("Update the Local servers module to save its settings.".into())
        };
    }

    let mut config: ServerConfig = serde_json::from_value(submitted.clone())
        .map_err(|error| format!("Invalid {} configuration: {error}", kind.as_str()))?;
    let password = config.extra.remove("password");
    let remove = config
        .extra
        .remove("removePassword")
        .and_then(|value| value.as_bool())
        == Some(true);
    config.extra.remove("credentialMigrationRequired");
    config.extra.remove("passwordRef");
    if kind.uses_password() && !remove {
        let previous = previous
            .as_ref()
            .and_then(|record| record.settings.get(&kind));
        let old_reference = previous.and_then(local::password_ref);
        let password = match password.as_ref().and_then(plaintext) {
            Some(password) => Some(Zeroizing::new(password.to_owned())),
            None if previous.is_some_and(local::needs_legacy_password) => {
                Some(legacy_password(state, kind)?)
            }
            None => None,
        };
        let reference = match password {
            Some(password) => Some(store_password(state, kind, &password, old_reference)?),
            None => old_reference.map(str::to_owned),
        };
        if let Some(reference) = reference {
            config.extra.insert("passwordRef".into(), reference.into());
        }
    }
    let request = serde_json::to_value(local::StartRequest { kind, config })
        .map_err(|error| error.to_string())?;
    process::invoke::<()>(
        &state.plugins,
        local::SLUG,
        local::SAVE_SETTINGS,
        request.clone(),
    )
    .await?;
    Ok(Some(request["config"].clone()))
}

pub(super) fn resolve_password(
    state: &AppState,
    kind: local::Kind,
    config: &mut ServerConfig,
) -> Result<(), String> {
    if local::needs_legacy_password(config) {
        return Err("Unlock the Vault and save the migrated Local servers settings before starting this service.".into());
    }
    if kind.uses_password()
        && let Some(reference) = local::password_ref(config)
    {
        let password = state
            .core
            .vault
            .resolve_for_kind(reference, credential_kind(kind))?
            .ok_or("Invalid Local servers credential reference")?;
        config
            .extra
            .insert("password".into(), password.to_string().into());
    }
    Ok(())
}

fn legacy_password(state: &AppState, kind: local::Kind) -> Result<Zeroizing<String>, String> {
    let db = state.core.db.lock().map_err(|error| error.to_string())?;
    let row = db::load_server_config(&db, kind.as_str()).map_err(|error| error.to_string())?;
    row.as_ref()
        .and_then(|row| row.get("password"))
        .and_then(plaintext)
        .map(|password| Zeroizing::new(password.to_owned()))
        .ok_or_else(|| format!("Enter the {} password to finish migration.", kind.as_str()))
}

fn plaintext(value: &Value) -> Option<&str> {
    value.as_str().filter(|password| !password.is_empty())
}

fn credential_kind(kind: local::Kind) -> &'static str {
    match kind {
        local::Kind::Ssh => "local-ssh-server-password",
        local::Kind::Ftp => "local-ftp-server-password",
        _ => unreachable!("only SSH and FTP accept Local servers passwords"),
    }
}

fn store_password(
    state: &AppState,
    kind: local::Kind,
    password: &str,
    previous: Option<&str>,
) -> Result<String, String> {
    let vault = &state.core.vault;
    let credential = credential_kind(kind);
    if let Some(reference) = previous
        && vault
            .resolve_for_kind(reference, credential)
            .is_ok_and(|old| old.as_deref().is_some_and(|old| old == password))
    {
        return Ok(reference.to_owned());
    }
    let label = format!(
        "Local {} server password",
        kind.as_str().to_ascii_uppercase()
    );
    vault
        .put(credential, &label, password)
        .map(|entry| entry.reference)
}
