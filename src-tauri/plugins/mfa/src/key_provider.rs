//! One admitted operation, fixed owner ID, typed secret replies. A temporary
//! zeroizing copy lives only on this synchronous business worker's stack.
use taomni_mfa_engine::{crypto::DataKey, keys::KeyProvider};
use taomni_plugin_api::services::{
    CoreServiceError, FixedKeyAction, FixedKeyId, FixedKeyRequest, MFA_DATA_KEY_ID, ResetGrantId,
};
use taomni_plugin_sdk::Operation;
use zeroize::Zeroizing;

pub(super) struct SdkKeyProvider<'a> {
    operation: &'a Operation,
    reset: Option<ResetGrantId>,
}

impl<'a> SdkKeyProvider<'a> {
    pub fn new(operation: &'a Operation) -> Self {
        Self {
            operation,
            reset: None,
        }
    }

    pub fn for_reset(operation: &'a Operation, reset: ResetGrantId) -> Self {
        Self {
            operation,
            reset: Some(reset),
        }
    }

    fn request(&self, action: FixedKeyAction) -> Result<Option<DataKey>, String> {
        let key = self
            .operation
            .fixed_key(FixedKeyRequest {
                key_id: FixedKeyId::parse(MFA_DATA_KEY_ID).expect("compiled fixed key ID"),
                action,
            })
            .map_err(|error| error.message)?;
        key.map(|key| {
            key.with_key(|bytes| Zeroizing::new(*bytes))
                .map_err(|error| error.message)
        })
        .transpose()
    }
}

impl KeyProvider for SdkKeyProvider<'_> {
    fn load(&self) -> Result<Option<DataKey>, String> {
        self.request(FixedKeyAction::Load)
    }
    fn initialize_empty(&self) -> Result<DataKey, String> {
        self.request(FixedKeyAction::CreateIfAbsent)?
            .ok_or_else(|| taomni_mfa_engine::ERR_KEY_MISSING.into())
    }
    fn repair_after_reset(&self) -> Result<DataKey, String> {
        let grant = self
            .reset
            .clone()
            .ok_or_else(|| CoreServiceError::PermissionDenied.kind().to_owned())?;
        self.request(FixedKeyAction::RepairEmptyAfterReset { grant })?
            .ok_or_else(|| taomni_mfa_engine::ERR_KEY_MISSING.into())
    }
}
