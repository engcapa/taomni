//! Offline, load-only MFA validation under the exporter's maintenance scope.
//! No key/root is returned; no live Vault is unlocked or initialized.
use taomni_mfa_api::{
    ERR_KEY_MISSING,
    legacy::{ExistingKeyCheck, verify_existing_key},
};
use taomni_plugin_api::services::MFA_DATA_KEY_ID;
use zeroize::Zeroizing;

use super::{db, fixed_key_read, password_key};
use crate::plugin::migration::export::MfaKeySources;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MfaMigrationKeyCheck {
    Database(ExistingKeyCheck),
    VaultKeyOnly,
}

pub(crate) fn verify(
    sources: MfaKeySources<'_>,
    password: &str,
) -> Result<MfaMigrationKeyCheck, String> {
    sources.check()?;
    if !sources.is_exclusive() {
        return Err("PERMISSION_DENIED".into());
    }
    for connection in [sources.vault(), sources.database()].into_iter().flatten() {
        if !connection
            .is_readonly("main")
            .map_err(|_| "VAULT_SERVICE_UNAVAILABLE")?
        {
            return Err("PERMISSION_DENIED".into());
        }
    }
    let key = if let Some(vault) = sources.vault() {
        // Absence is not authorization to initialize a key. It is also not a
        // reason to ask for a password when there is no secret to load.
        if db::get_entry(vault, MFA_DATA_KEY_ID)
            .map_err(|_| "VAULT_SERVICE_UNAVAILABLE")?
            .is_none()
        {
            None
        } else {
            if password.is_empty() {
                return Err(super::ERR_VAULT_PASSWORD_REQUIRED.into());
            }
            let meta = db::get_meta(vault)
                .map_err(|_| "VAULT_SERVICE_UNAVAILABLE")?
                .ok_or(super::ERR_VAULT_EMPTY)?;
            sources.check()?;
            let root = password_key::verify(&meta, password)?;
            sources.check()?;
            // This is the identical decoder used by authenticated fixed-key
            // RPC and the core MFA facade. The owner is constant, load-only.
            let key = fixed_key_read::load(vault, &root, MFA_DATA_KEY_ID)
                .map_err(|error| error.to_string())?;
            drop(root);
            sources.check()?;
            key
        }
    } else {
        None
    };
    let key = key.map(|key| Zeroizing::new(*key.as_bytes()));
    let result = match sources.database() {
        Some(database) => {
            MfaMigrationKeyCheck::Database(verify_existing_key(database, key.as_ref(), &|| {
                sources.check()
            })?)
        }
        None if key.is_some() => MfaMigrationKeyCheck::VaultKeyOnly,
        None => return Err(ERR_KEY_MISSING.into()),
    };
    sources.check()?;
    Ok(result)
}
