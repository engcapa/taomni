//! Production Vault adapter for authenticated, operation-scoped fixed keys.
//! The dispatcher owns the ReverseRequestPermit; neither a renderer nor a
//! plugin chooses an owner, label, kind, replacement key, or Vault database.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use taomni_plugin_api::{
    RequestId,
    services::{FixedKeyAction, FixedKeyRequest, FixedKeyResult, SecretKey32},
};
use taomni_plugin_services::{FixedKeyOwner, ReverseRequestPermit, SensitiveServiceFrame};
use zeroize::Zeroizing;

use super::{Vault, VaultInner, crypto, db};

#[path = "plugin_error.rs"]
mod error;
pub use error::PluginKeyError;

impl taomni_plugin_services::CoreServiceBackend for Vault {
    fn fixed_key(
        &self,
        id: RequestId,
        request: FixedKeyRequest,
        permit: ReverseRequestPermit,
    ) -> Result<SensitiveServiceFrame, taomni_plugin_api::RpcError> {
        self.plugin_fixed_key_frame(id, request, permit)
            .map_err(PluginKeyError::into_rpc_error)
    }
}

impl Vault {
    /// The returned frame retains the operation and its cross-process lease
    /// through the bounded transport write. Never turn it into generic Value.
    pub fn plugin_fixed_key_frame(
        &self,
        id: RequestId,
        request: FixedKeyRequest,
        permit: ReverseRequestPermit,
    ) -> Result<SensitiveServiceFrame, PluginKeyError> {
        let owner = permit.authorize_fixed_key(&request)?;
        let result = {
            // Lock order is outer admission/lease -> host MFA DB -> Vault.
            // No host or registry mutex is acquired by this service worker.
            let mut inner = self.inner.lock().map_err(|_| PluginKeyError::Unavailable)?;
            permit.check_current()?;
            verify_current_root(&mut inner)?;
            let key = match load_data_key(&inner, owner.id) {
                Ok(Some(key)) => Some(key),
                Ok(None) => match request.action {
                    FixedKeyAction::Load => None,
                    _ => Some(create_data_key(&inner, owner, false)?),
                },
                Err(PluginKeyError::KeyMismatch) => match request.action {
                    FixedKeyAction::RepairEmptyAfterReset { .. } => {
                        Some(create_data_key(&inner, owner, true)?)
                    }
                    _ => return Err(PluginKeyError::KeyMismatch),
                },
                Err(error) => return Err(error),
            };
            match key {
                Some(key) => FixedKeyResult::Key {
                    context: permit.operation().context().clone(),
                    key,
                },
                None => FixedKeyResult::Missing,
            }
        };
        permit.check_current()?;
        SensitiveServiceFrame::encode(id, result, permit).map_err(PluginKeyError::from)
    }
}

/// A second core may have changed the master password. Verify cached root
/// material against current SQLite metadata while holding Vault's mutex and
/// the already-admitted shared/exclusive cross-process VaultOperationLease.
/// A stale root is cleared, never used to mint a new encrypted fixed key.
fn verify_current_root(inner: &mut VaultInner) -> Result<(), PluginKeyError> {
    let key = inner.root_key.as_ref().ok_or(PluginKeyError::VaultLocked)?;
    let meta = db::get_meta(&inner.conn).map_err(|_| PluginKeyError::Unavailable)?;
    let current = meta
        .and_then(|meta| {
            let nonce: [u8; crypto::NONCE_LEN] = meta.verifier_nonce.as_slice().try_into().ok()?;
            crypto::aead_decrypt(key, &nonce, &meta.verifier_ciphertext).ok()
        })
        .is_some_and(|plaintext| plaintext.as_slice() == crypto::VERIFIER_PLAINTEXT);
    if !current {
        inner.root_key = None;
        return Err(PluginKeyError::VaultLocked);
    }
    Ok(())
}

fn load_data_key(inner: &VaultInner, id: &str) -> Result<Option<SecretKey32>, PluginKeyError> {
    let root = inner.root_key.as_ref().ok_or(PluginKeyError::VaultLocked)?;
    let Some(entry) = db::get_entry(&inner.conn, id).map_err(|_| PluginKeyError::Unavailable)?
    else {
        return Ok(None);
    };
    let nonce: [u8; crypto::NONCE_LEN] = entry
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| PluginKeyError::KeyMismatch)?;
    let plaintext = crypto::aead_decrypt(root, &nonce, &entry.ciphertext)
        .map_err(|_| PluginKeyError::KeyMismatch)?;
    let encoded =
        std::str::from_utf8(plaintext.as_slice()).map_err(|_| PluginKeyError::KeyMismatch)?;
    let mut bytes = Zeroizing::new([0u8; 32]);
    let count = STANDARD
        .decode_slice(encoded.trim(), bytes.as_mut_slice())
        .map_err(|_| PluginKeyError::KeyMismatch)?;
    if count != 32 {
        return Err(PluginKeyError::KeyMismatch);
    }
    Ok(Some(SecretKey32::new(std::mem::take(&mut *bytes))))
}

fn create_data_key(
    inner: &VaultInner,
    owner: FixedKeyOwner,
    repair: bool,
) -> Result<SecretKey32, PluginKeyError> {
    let root = inner.root_key.as_ref().ok_or(PluginKeyError::VaultLocked)?;
    let mut bytes = Zeroizing::new([0u8; 32]);
    rand::fill(bytes.as_mut_slice());
    let encoded = Zeroizing::new(STANDARD.encode(bytes.as_slice()));
    let nonce = crypto::random_nonce();
    let ciphertext = crypto::aead_encrypt(root, &nonce, encoded.as_bytes())
        .map_err(|_| PluginKeyError::Unavailable)?;
    if repair {
        // Only the consumed ResetStore grant reaches this branch. Normal
        // initialization uses insert and can never replace an existing key.
        db::upsert_entry(
            &inner.conn,
            owner.id,
            owner.label,
            owner.kind,
            &ciphertext,
            &nonce,
            Vault::now(),
        )
    } else {
        db::insert_entry(
            &inner.conn,
            owner.id,
            owner.label,
            owner.kind,
            &ciphertext,
            &nonce,
            Vault::now(),
        )
    }
    .map_err(|_| PluginKeyError::Unavailable)?;
    Ok(SecretKey32::new(std::mem::take(&mut *bytes)))
}

#[cfg(test)]
#[path = "plugin_host_tests.rs"]
mod host_tests;
#[cfg(test)]
#[path = "plugin_access_tests.rs"]
mod tests;
