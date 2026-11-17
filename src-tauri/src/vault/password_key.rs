//! Verify existing metadata without opening a store or changing unlock state.
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::{ERR_VAULT_BAD_PASSWORD, crypto, db};

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct StoredKdfParams {
    pub(super) m_cost: u32,
    pub(super) t_cost: u32,
    pub(super) p_cost: u32,
}

/// The caller preserves its existing password normalization/empty semantics.
pub(super) fn verify(
    meta: &db::MetaRow,
    password: &str,
) -> Result<Zeroizing<[u8; crypto::KEY_LEN]>, String> {
    if meta.kdf != "argon2id" {
        return Err(format!("unsupported kdf: {}", meta.kdf));
    }
    let params: StoredKdfParams =
        serde_json::from_str(&meta.kdf_params).map_err(|error| error.to_string())?;
    let root = crypto::derive_root_key(
        password,
        &meta.kdf_salt,
        params.m_cost,
        params.t_cost,
        params.p_cost,
    )
    .map_err(|error| error.to_string())?;
    let nonce: [u8; crypto::NONCE_LEN] = meta
        .verifier_nonce
        .as_slice()
        .try_into()
        .map_err(|_| "verifier nonce shape")?;
    let plaintext = crypto::aead_decrypt(&root, &nonce, &meta.verifier_ciphertext)
        .map_err(|_| ERR_VAULT_BAD_PASSWORD)?;
    if plaintext.as_slice() != crypto::VERIFIER_PLAINTEXT {
        return Err(ERR_VAULT_BAD_PASSWORD.into());
    }
    Ok(root)
}

#[cfg(test)]
#[path = "password_key_tests.rs"]
mod tests;
