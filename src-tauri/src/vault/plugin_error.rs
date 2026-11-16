use std::fmt;

use taomni_plugin_api::{ErrorCode, RpcError, services::CoreServiceError};

/// Typed adapter errors preserve protocol codes. No Vault plaintext, SQL
/// values, requested key identity, or crypto diagnostic is included.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginKeyError {
    Service(CoreServiceError),
    VaultLocked,
    KeyMismatch,
    Unavailable,
}

impl PluginKeyError {
    pub fn into_rpc_error(self) -> RpcError {
        match self {
            Self::Service(error) => error.into_rpc_error(),
            Self::VaultLocked => CoreServiceError::VaultLocked.into_rpc_error(),
            Self::KeyMismatch => CoreServiceError::MfaKeyMismatch.into_rpc_error(),
            Self::Unavailable => {
                RpcError::new(ErrorCode::InternalError, "VAULT_SERVICE_UNAVAILABLE")
            }
        }
    }
}

impl fmt::Display for PluginKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Service(error) => error.kind(),
            Self::VaultLocked => "VAULT_LOCKED",
            Self::KeyMismatch => "MFA_KEY_MISMATCH",
            Self::Unavailable => "VAULT_SERVICE_UNAVAILABLE",
        })
    }
}

impl std::error::Error for PluginKeyError {}

impl From<CoreServiceError> for PluginKeyError {
    fn from(value: CoreServiceError) -> Self {
        Self::Service(value)
    }
}
