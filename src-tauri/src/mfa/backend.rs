//! MFA selects its data owner once while startup holds its profile lease.
use std::{
    path::Path,
    time::{Duration, Instant},
};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use taomni_mfa_engine::INITIALIZATION_REQUIRED;
use taomni_plugin_api::services::CAPTURE_SCREEN_PERMISSION;
use taomni_plugin_services::OperationKind;

use crate::{
    plugin::{LifecycleState, PluginError, PluginRegistry},
    state::AppState,
};

use super::{access, crypto::DataKey, store::MfaStore};

pub(crate) enum MfaBackend {
    Legacy(MfaStore),
    Module,
    Unavailable(String),
}

impl MfaBackend {
    pub(crate) fn load(profile: &Path) -> Self {
        match super::ownership::uses_module_data(profile) {
            Ok(false) => Self::Legacy(MfaStore::new(profile.join("mfa.db"))),
            Ok(true) => Self::Module,
            Err(error) => Self::Unavailable(error),
        }
    }

    pub(crate) fn legacy_store(&self) -> Result<Option<&MfaStore>, String> {
        match self {
            Self::Legacy(store) => Ok(Some(store)),
            Self::Module => Ok(None),
            Self::Unavailable(error) => Err(error.clone()),
        }
    }
}

pub(crate) async fn run<T: DeserializeOwned + Send + 'static, A: Send + 'static>(
    state: &AppState,
    method: &'static str,
    kind: OperationKind,
    args: A,
    wire: impl Fn(&A) -> Value + Send + 'static,
    legacy: impl FnOnce(&mut rusqlite::Connection, &DataKey, A) -> Result<T, String>,
) -> Result<T, String> {
    match state.legacy.mfa.legacy_store()? {
        Some(store) => access::with_key(
            &state.plugins,
            &state.core.vault,
            store,
            kind,
            |conn, key| legacy(conn, key, args),
        ),
        None => {
            on_host(state, move |registry| {
                call(registry, method, kind, || wire(&args), deadline()).and_then(decode)
            })
            .await
        }
    }
}

pub(crate) async fn export(
    state: &AppState,
    id: String,
    password: zeroize::Zeroizing<String>,
) -> Result<String, String> {
    match state.legacy.mfa.legacy_store()? {
        Some(store) => {
            access::export_with_password(&state.plugins, &state.core.vault, store, &id, &password)
        }
        None => {
            on_host(state, move |registry| {
                registry
                    .export_mfa_uri(&id, &password, deadline())
                    .map_err(error)
                    .and_then(decode)
            })
            .await
        }
    }
}

pub(crate) async fn reset(state: &AppState) -> Result<(), String> {
    match state.legacy.mfa.legacy_store()? {
        Some(store) => access::reset_store(&state.plugins, &state.core.vault, store),
        None => {
            on_host(state, move |registry| {
                registry
                    .reset_mfa_host(deadline())
                    .map_err(error)
                    .and_then(decode)
            })
            .await
        }
    }
}

pub(super) async fn scan_in_host(
    state: &AppState,
    window: tauri::WebviewWindow,
) -> Result<Option<Vec<String>>, String> {
    const METHOD: &str = "mfa_scan_screen_codes";
    let registry = &state.plugins;
    if !registry.get("mfa").is_some_and(|record| {
        record.state == LifecycleState::Enabled
            && record.reason.is_none()
            && record.manifest.commands.contains(METHOD)
            && record
                .manifest
                .permissions
                .contains(CAPTURE_SCREEN_PERMISSION)
    }) {
        return Ok(None);
    }
    on_host(state, move |registry| {
        registry
            .invoke_scoped_capture(
                window,
                "mfa",
                METHOD,
                json!({}),
                &uuid::Uuid::new_v4().to_string(),
                deadline(),
            )
            .map_err(|failure| match error(failure).as_str() {
                "SCREEN_PERMISSION_REQUIRED" => super::ERR_SCREEN_PERMISSION.into(),
                "SCREEN_CAPTURE_NO_DISPLAY" => super::ERR_NO_DISPLAY.into(),
                "SCREEN_CAPTURE_FAILED" => super::ERR_CAPTURE_FAILED.into(),
                message => message.to_owned(),
            })
            .and_then(decode)
            .map(Some)
    })
    .await
}

async fn on_host<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&PluginRegistry) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let registry = state.plugins.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&registry))
        .await
        .map_err(|error| error.to_string())?
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(10)
}

fn call(
    registry: &PluginRegistry,
    method: &str,
    kind: OperationKind,
    params: impl Fn() -> Value,
    deadline: Instant,
) -> Result<Value, String> {
    let invoke = |method, kind, params| {
        registry
            .invoke_scoped(
                "mfa",
                method,
                params,
                &uuid::Uuid::new_v4().to_string(),
                kind,
                deadline,
            )
            .map_err(error)
    };
    let first = invoke(method, kind, params());
    if first
        .as_ref()
        .is_err_and(|error| error == INITIALIZATION_REQUIRED)
    {
        // The first call returned without committing. Its shared permit has
        // been released before we admit the separate initialization.
        invoke(
            "mfa_initialize_empty",
            OperationKind::InitializeEmptyStore,
            json!({}),
        )?;
        return invoke(method, kind, params());
    }
    first
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|_| "MFA_RESULT_DECODING_FAILED".into())
}

fn error(error: PluginError) -> String {
    match error {
        PluginError::Rpc { message, .. } | PluginError::HostRequest(message)
            if message == "STALE_PLUGIN_CONTEXT" =>
        {
            crate::vault::ERR_VAULT_LOCKED.into()
        }
        PluginError::Rpc { message, .. } | PluginError::HostRequest(message) => message,
        other => other.to_string(),
    }
}
