//! Admission/lease -> MFA connection -> Vault. No lease upgrade while holding
//! an MFA mutex, and no operation-owned key escapes the admitted scope.
use super::{
    crypto::{self, DataKey},
    key_provider::{CoreKeyProvider, KeyProvider},
    store::{self, MfaStore},
};
use crate::{plugin::PluginRegistry, vault::Vault};
use std::time::{Duration, Instant};
use taomni_plugin_services::{CoreOperationPermit, OperationKind};

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(10)
}

fn current(permit: &CoreOperationPermit) -> Result<(), String> {
    permit.check_current().map_err(|e| match e {
        taomni_plugin_api::services::CoreServiceError::StalePluginContext => {
            crate::vault::ERR_VAULT_LOCKED.into()
        }
        _ => e.kind().to_string(),
    })
}

pub(super) fn with_key<T>(
    registry: &PluginRegistry,
    vault: &Vault,
    mfa: &MfaStore,
    kind: OperationKind,
    f: impl FnOnce(&mut rusqlite::Connection, &DataKey) -> Result<T, String>,
) -> Result<T, String> {
    with_key_until(registry, vault, mfa, kind, deadline(), f)
}

pub(super) fn with_key_until<T>(
    registry: &PluginRegistry,
    vault: &Vault,
    mfa: &MfaStore,
    kind: OperationKind,
    until: Instant,
    f: impl FnOnce(&mut rusqlite::Connection, &DataKey) -> Result<T, String>,
) -> Result<T, String> {
    let permit = registry.admit_core_operation(kind, until)?;
    let keys = CoreKeyProvider {
        vault,
        permit: &permit,
    };
    let mut f = Some(f);
    let result = mfa.with_conn(|conn| {
        current(&permit)?;
        let Some(key) = crypto::prepare_key(conn, &keys)? else {
            return Ok(None);
        };
        f.take().expect("operation runs once")(conn, &key).map(Some)
    });
    current(&permit)?;
    drop(permit);
    if let Some(result) = result? {
        return Ok(result);
    }
    // The first probe established an empty store. It has released both its
    // connection mutex and shared lease before waiting for exclusive access.
    let permit = registry.admit_core_operation(OperationKind::InitializeEmptyStore, until)?;
    let keys = CoreKeyProvider {
        vault,
        permit: &permit,
    };
    let result = mfa.with_conn(|conn| {
        current(&permit)?;
        let key = crypto::ensure_key(conn, &keys)?;
        f.take().expect("uninitialized operation has not run")(conn, &key)
    });
    current(&permit)?;
    result
}

pub(crate) fn export_with_password(
    registry: &PluginRegistry,
    vault: &Vault,
    mfa: &MfaStore,
    id: &str,
    password: &str,
) -> Result<String, String> {
    let permit = registry.admit_core_operation(OperationKind::ExportSecret, deadline())?;
    vault.verify_export_password_with_permit(password, &permit)?;
    let keys = CoreKeyProvider {
        vault,
        permit: &permit,
    };
    let result = mfa.with_conn(|conn| {
        current(&permit)?;
        let key = crypto::prepare_key(conn, &keys)?.ok_or(super::ERR_NOT_FOUND)?;
        taomni_mfa_engine::operations::export_uri(conn, &key, id)
    });
    current(&permit)?;
    result
}

pub(super) fn reset_store(
    registry: &PluginRegistry,
    vault: &Vault,
    mfa: &MfaStore,
) -> Result<(), String> {
    reset_store_until(registry, vault, mfa, deadline())
}

pub(super) fn reset_store_until(
    registry: &PluginRegistry,
    vault: &Vault,
    mfa: &MfaStore,
    until: Instant,
) -> Result<(), String> {
    registry.with_core_reset(vault, until, |permit| {
        let keys = CoreKeyProvider { vault, permit };
        mfa.with_conn(|conn| {
            current(permit)?;
            // A locked/unavailable Vault fails before a destructive write. An
            // explicit reset may replace a malformed fixed key, ordinary use may not.
            match keys.load() {
                Ok(_) => (),
                Err(error) if error == super::ERR_KEY_MISMATCH => (),
                Err(error) => return Err(error),
            }
            store::reset(conn)?;
            crypto::rebind_after_reset(conn, &keys).map(|_| ())
        })
    })
}
