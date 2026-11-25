//! Typed key access for the MFA facade before its business moves to a host.
//! A core permit cannot authorize reverse RPC or select another fixed key.
use super::{Vault, db, password_key, plugin_access};
use taomni_plugin_api::services::SecretKey32;
use taomni_plugin_services::{
    CoreOperationPermit, MFA_FIXED_KEY_OWNER, OperationKind, OperationPermit,
};

pub(crate) enum MfaKeyAction {
    Load,
    InitializeEmpty,
    RepairAfterReset,
}

impl Vault {
    pub(crate) fn check_migration_password(&self, password: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|_| "Vault is unavailable")?;
        let meta = db::get_meta(&inner.conn)
            .map_err(|error| error.to_string())?
            .ok_or(super::ERR_VAULT_EMPTY)?;
        drop(password_key::verify(&meta, password)?);
        Ok(())
    }

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
        self.verify_export_password(password, permit.kind(), || permit.check_current())
    }

    pub(crate) fn verify_mfa_host_export_password(
        &self,
        password: &str,
        permit: &OperationPermit,
    ) -> Result<(), String> {
        self.verify_export_password(password, permit.kind(), || permit.check_current())
    }

    fn verify_export_password(
        &self,
        password: &str,
        kind: OperationKind,
        current: impl Fn() -> Result<(), taomni_plugin_api::services::CoreServiceError>,
    ) -> Result<(), String> {
        if kind != OperationKind::ExportSecret {
            return Err("PERMISSION_DENIED".into());
        }
        current().map_err(|e| e.kind().to_string())?;
        let mut inner = self.inner.lock().map_err(|_| "Vault is unavailable")?;
        plugin_access::verify_current_root(&mut inner).map_err(|e| e.to_string())?;
        let password = password.trim();
        if password.is_empty() {
            return Err(super::ERR_VAULT_PASSWORD_REQUIRED.into());
        }
        let meta = db::get_meta(&inner.conn)
            .map_err(|e| e.to_string())?
            .ok_or(super::ERR_VAULT_EMPTY)?;
        drop(password_key::verify(&meta, password)?);
        current().map_err(|e| e.kind().to_string())
    }
}
