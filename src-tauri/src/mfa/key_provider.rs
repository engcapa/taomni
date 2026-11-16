//! Crypto receives typed key operations, never a Vault path or AppState.
use super::crypto::DataKey;
use crate::vault::{MfaKeyAction, Vault};
use taomni_plugin_services::CoreOperationPermit;
use zeroize::Zeroizing;

pub(super) use taomni_mfa_engine::keys::KeyProvider;

pub(super) struct CoreKeyProvider<'a> {
    pub vault: &'a Vault,
    pub permit: &'a CoreOperationPermit,
}

impl CoreKeyProvider<'_> {
    fn key(&self, action: MfaKeyAction) -> Result<Option<DataKey>, String> {
        self.vault
            .mfa_key_with_permit(self.permit, action)
            .map(|key| key.map(|key| Zeroizing::new(*key.as_bytes())))
    }
}

impl KeyProvider for CoreKeyProvider<'_> {
    fn load(&self) -> Result<Option<DataKey>, String> {
        self.key(MfaKeyAction::Load)
    }
    fn initialize_empty(&self) -> Result<DataKey, String> {
        self.key(MfaKeyAction::InitializeEmpty)?
            .ok_or_else(|| super::ERR_KEY_MISSING.into())
    }
    fn repair_after_reset(&self) -> Result<DataKey, String> {
        self.key(MfaKeyAction::RepairAfterReset)?
            .ok_or_else(|| super::ERR_KEY_MISSING.into())
    }
}
