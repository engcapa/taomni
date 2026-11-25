//! Official MFA process. Only the SDK owns transport/profile leases; this host
//! owns its encrypted store and never opens a core database or caches a key.
//! Product entry switching follows the signed-package and M0 gate evidence.
mod commands;
mod key_provider;
mod paths;
mod screen_scan;
mod snapshot;
mod store;

use std::{collections::BTreeSet, io, sync::Arc, time::Duration};
use taomni_plugin_api::{ErrorCode, RpcError, services::*};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, SnapshotProvider};

pub const PLUGIN_ID: &str = "taomni-plugin-mfa";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Internal retry signal. The core must drop its shared permit before admitting
/// a separate InitializeEmptyStore operation; the host cannot upgrade it.
pub use taomni_mfa_engine::INITIALIZATION_REQUIRED;

pub fn host_config() -> HostConfig {
    let mut services = ServiceCapabilities::default();
    services.0.insert(FIXED_KEY_SERVICE.into(), SERVICE_VERSION);
    HostConfig {
        plugin_id: PLUGIN_ID.into(),
        plugin_version: PLUGIN_VERSION.into(),
        commands: [
            "mfa_list",
            "mfa_codes",
            "mfa_inspect",
            "mfa_add",
            "mfa_update",
            "mfa_delete",
            "mfa_reorder",
            "mfa_hotp_next",
            "mfa_mark_used",
            "mfa_set_prefs",
            "mfa_export_uri",
            "mfa_reset_store",
            "mfa_initialize_empty",
            screen_scan::METHOD,
            SNAPSHOT_PREPARE_METHOD,
            SNAPSHOT_METHOD,
            SNAPSHOT_RELEASE_METHOD,
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        permissions: BTreeSet::from([FIXED_KEY_SERVICE.into(), CAPTURE_SCREEN_PERMISSION.into()]),
        required_services: services,
        optional_services: ServiceCapabilities(
            [(CAPTURE_STILL_SERVICE.into(), SERVICE_VERSION)].into(),
        ),
        operation_timeout: Duration::from_secs(10),
        snapshot_timeout: Duration::from_secs(300),
    }
}

pub fn serve_stdio() -> io::Result<()> {
    taomni_plugin_sdk::serve_stdio_with(host_config(), |storage| {
        let storage = storage.ok_or_else(|| io::Error::other("MFA profile ownership required"))?;
        let store =
            store::Store::open(storage).map_err(|_| io::Error::other("MFA store unavailable"))?;
        Ok(Arc::new(Handler {
            store: Arc::new(store),
        }))
    })
}

struct Handler {
    store: Arc<store::Store>,
}

impl PluginHandler for Handler {
    fn snapshot_provider(&self) -> Option<Arc<dyn SnapshotProvider>> {
        Some(self.store.clone())
    }

    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, RpcError> {
        operation.check_current()?;
        if operation.context().is_none() {
            return Err(CoreServiceError::StalePluginContext.into_rpc_error());
        }
        if method == screen_scan::METHOD {
            return screen_scan::capture_texts(operation, params);
        }
        commands::invoke(&self.store, operation, commands::parse(method, params)?)
    }
}

pub(crate) fn business_error(message: impl Into<String>) -> RpcError {
    let message = message.into();
    // The engine's platform-neutral KeyProvider carries failures as strings.
    // Restore only exact, typed service kinds at this transport boundary so a
    // denied key request, cancellation or timeout retains its stable RPC code.
    for service in [
        CoreServiceError::PermissionDenied,
        CoreServiceError::DuplicateRequest,
        CoreServiceError::VaultLocked,
        CoreServiceError::VaultBadPassword,
        CoreServiceError::VaultPasswordRequired,
        CoreServiceError::MfaKeyMissing,
        CoreServiceError::MfaKeyMismatch,
        CoreServiceError::StalePluginContext,
        CoreServiceError::PluginProfileInUse,
        CoreServiceError::CoreServiceBusy,
        CoreServiceError::Cancelled,
        CoreServiceError::TimedOut,
    ] {
        if message == service.kind() {
            return service.into_rpc_error();
        }
    }
    let code = if message.starts_with(taomni_mfa_engine::ERR_INVALID_INPUT) {
        ErrorCode::InvalidParams
    } else {
        ErrorCode::InvalidState
    };
    RpcError::new(code, message)
}

#[cfg(test)]
mod tests;
