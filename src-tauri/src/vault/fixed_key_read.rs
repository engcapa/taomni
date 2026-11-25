//! Shared read/decode path for operation-scoped and maintenance MFA checks.
//! Authorization and the stable connection belong to the enclosing owner.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::Connection;
use taomni_plugin_api::services::SecretKey32;
use zeroize::Zeroizing;

use super::{crypto, db, plugin_access::PluginKeyError};

pub(super) fn load(
    conn: &Connection,
    root: &[u8; crypto::KEY_LEN],
    id: &str,
) -> Result<Option<SecretKey32>, PluginKeyError> {
    let Some(entry) = db::get_entry(conn, id).map_err(|_| PluginKeyError::Unavailable)? else {
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

#[cfg(test)]
#[path = "fixed_key_read_tests.rs"]
mod tests;
