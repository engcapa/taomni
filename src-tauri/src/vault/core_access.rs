//! Typed key access for the MFA facade before its business moves to a host.
//! A core permit cannot authorize reverse RPC or select another fixed key.
use super::{StoredKdfParams, Vault, crypto, db, plugin_access};
use taomni_plugin_api::services::SecretKey32;
use taomni_plugin_services::{CoreOperationPermit, MFA_FIXED_KEY_OWNER, OperationKind};

pub(crate) enum MfaKeyAction {
    Load,
    InitializeEmpty,
    RepairAfterReset,
}

impl Vault {
    pub(crate) fn mfa_key_with_permit(
        &self,
        permit: &CoreOperationPermit,
        action: MfaKeyAction,
    ) -> Result<Option<SecretKey32>, String> {
        use MfaKeyAction::*;
        match action {
            InitializeEmpty if permit.kind() != OperationKind::InitializeEmptyStore => {
                return Err("PERMISSION_DENIED".into());
            }
            RepairAfterReset if permit.kind() != OperationKind::ResetStore => {
                return Err("PERMISSION_DENIED".into());
            }
            _ => (),
        }
        if matches!(action, RepairAfterReset) {
            permit
                .consume_reset_grant()
                .map_err(|e| e.kind().to_string())?;
        }
        let result = {
            let mut inner = self.inner.lock().map_err(|_| "Vault is unavailable")?;
            permit.check_current().map_err(|e| e.kind().to_string())?;
            plugin_access::verify_current_root(&mut inner).map_err(|e| e.to_string())?;
            match plugin_access::load_data_key(&inner, MFA_FIXED_KEY_OWNER.id) {
                Ok(Some(key)) => Some(key),
                Ok(None) if matches!(action, Load) => None,
                Ok(None) => Some(
                    plugin_access::create_data_key(&inner, MFA_FIXED_KEY_OWNER, false)
                        .map_err(|e| e.to_string())?,
                ),
                Err(plugin_access::PluginKeyError::KeyMismatch)
                    if matches!(action, RepairAfterReset) =>
                {
                    Some(
                        plugin_access::create_data_key(&inner, MFA_FIXED_KEY_OWNER, true)
                            .map_err(|e| e.to_string())?,
                    )
                }
                Err(error) => return Err(error.to_string()),
            }
        };
        permit.check_current().map_err(|e| e.kind().to_string())?;
        Ok(result)
    }

    /// Export verifies the submitted password without mutating the root or
    /// reopening admission. Its existing operation lease excludes rekey.
    pub(crate) fn verify_export_password_with_permit(
        &self,
        password: &str,
        permit: &CoreOperationPermit,
    ) -> Result<(), String> {
        if permit.kind() != OperationKind::ExportSecret {
            return Err("PERMISSION_DENIED".into());
        }
        permit.check_current().map_err(|e| e.kind().to_string())?;
        let mut inner = self.inner.lock().map_err(|_| "Vault is unavailable")?;
        plugin_access::verify_current_root(&mut inner).map_err(|e| e.to_string())?;
        let password = password.trim();
        if password.is_empty() {
            return Err(super::ERR_VAULT_PASSWORD_REQUIRED.into());
        }
        let meta = db::get_meta(&inner.conn)
            .map_err(|e| e.to_string())?
            .ok_or(super::ERR_VAULT_EMPTY)?;
        if meta.kdf != "argon2id" {
            return Err(format!("unsupported kdf: {}", meta.kdf));
        }
        let params: StoredKdfParams =
            serde_json::from_str(&meta.kdf_params).map_err(|e| e.to_string())?;
        let root = crypto::derive_root_key(
            password,
            &meta.kdf_salt,
            params.m_cost,
            params.t_cost,
            params.p_cost,
        )
        .map_err(|e| e.to_string())?;
        let nonce: [u8; crypto::NONCE_LEN] = meta
            .verifier_nonce
            .as_slice()
            .try_into()
            .map_err(|_| "verifier nonce shape")?;
        let plaintext = crypto::aead_decrypt(&root, &nonce, &meta.verifier_ciphertext)
            .map_err(|_| super::ERR_VAULT_BAD_PASSWORD)?;
        if plaintext.as_slice() != crypto::VERIFIER_PLAINTEXT {
            return Err(super::ERR_VAULT_BAD_PASSWORD.into());
        }
        permit.check_current().map_err(|e| e.kind().to_string())
    }
}
