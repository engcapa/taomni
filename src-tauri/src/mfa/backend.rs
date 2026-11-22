//! Select the legacy store or the signed host while preserving each profile's data owner.
use std::{
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
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

pub(crate) struct MfaBackend {
    legacy: Result<Option<MfaStore>, String>,
    selected_module: AtomicBool,
    legacy_dispatch: Mutex<()>,
}

impl MfaBackend {
    pub(crate) fn load(profile: &Path) -> Self {
        Self {
            legacy: super::ownership::uses_module_data(profile)
                .map(|owned| (!owned).then(|| MfaStore::new(profile.join("mfa.db")))),
            selected_module: AtomicBool::new(false),
            legacy_dispatch: Mutex::new(()),
        }
    }

    pub(crate) fn legacy_store(&self) -> Result<Option<&MfaStore>, String> {
        if self.selected_module.load(Ordering::Acquire) {
            return Ok(None);
        }
        self.legacy
            .as_ref()
            .map(Option::as_ref)
            .map_err(Clone::clone)
    }

    /// The dispatch lock also covers each legacy operation, so a concurrent
    /// legacy add cannot race the decision that the profile has no accounts.
    fn with_legacy<T>(
        &self,
        registry: &PluginRegistry,
        profile: &Path,
        operation: impl FnOnce(&MfaStore) -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        let _dispatch = self.legacy_dispatch.lock().map_err(|e| e.to_string())?;
        let Some(store) = self.legacy_store()? else {
            return Ok(None);
        };
        if let Some(record) = registry.get("mfa") {
            if !super::ownership::legacy_has_accounts(profile)? {
                if record.state == LifecycleState::Enabled && record.reason.is_none() {
                    self.selected_module.store(true, Ordering::Release);
                }
                return Ok(None);
            }
        }
        operation(store).map(Some)
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
    let mut args = Some(args);
    if let Some(result) =
        state
            .legacy
            .mfa
            .with_legacy(&state.plugins, &state.core.paths.data, |store| {
                access::with_key(
                    &state.plugins,
                    &state.core.vault,
                    store,
                    kind,
                    |conn, key| legacy(conn, key, args.take().expect("legacy operation runs once")),
                )
            })?
    {
        return Ok(result);
    }
    let args = args.expect("module operation retains its arguments");
    on_host(state, move |registry| {
        call(registry, method, kind, || wire(&args), deadline()).and_then(decode)
    })
    .await
}

pub(crate) async fn export(
    state: &AppState,
    id: String,
    password: zeroize::Zeroizing<String>,
) -> Result<String, String> {
    if let Some(result) =
        state
            .legacy
            .mfa
            .with_legacy(&state.plugins, &state.core.paths.data, |store| {
                access::export_with_password(
                    &state.plugins,
                    &state.core.vault,
                    store,
                    &id,
                    &password,
                )
            })?
    {
        return Ok(result);
    }
    on_host(state, move |registry| {
        registry
            .export_mfa_uri(&id, &password, deadline())
            .map_err(error)
            .and_then(decode)
    })
    .await
}

pub(crate) async fn reset(state: &AppState) -> Result<(), String> {
    if state
        .legacy
        .mfa
        .with_legacy(&state.plugins, &state.core.paths.data, |store| {
            access::reset_store(&state.plugins, &state.core.vault, store)
        })?
        .is_some()
    {
        return Ok(());
    }
    on_host(state, move |registry| {
        registry
            .reset_mfa_host(deadline())
            .map_err(error)
            .and_then(decode)
    })
    .await
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
