use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{ErrorCode, RpcError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContractError {
    InvalidIdentifier,
    InvalidEpoch,
    InvalidKeyId,
    InvalidRelativePath,
    InvalidDigest,
}

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidIdentifier => "invalid service identifier",
            Self::InvalidEpoch => "invalid vault epoch",
            Self::InvalidKeyId => "invalid fixed key identifier",
            Self::InvalidRelativePath => "invalid relative data path",
            Self::InvalidDigest => "invalid SHA-256 digest",
        })
    }
}

impl std::error::Error for ContractError {}

/// Stable reasons; errors intentionally carry no secret or requested key ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoreServiceError {
    PermissionDenied,
    DuplicateRequest,
    VaultLocked,
    VaultBadPassword,
    VaultPasswordRequired,
    MfaKeyMissing,
    MfaKeyMismatch,
    StalePluginContext,
    PluginProfileInUse,
    CoreServiceBusy,
    Cancelled,
    TimedOut,
}

impl CoreServiceError {
    pub fn kind(self) -> &'static str {
        match self {
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::DuplicateRequest => "DUPLICATE_REQUEST",
            Self::VaultLocked => "VAULT_LOCKED",
            Self::VaultBadPassword => "VAULT_BAD_PASSWORD",
            Self::VaultPasswordRequired => "VAULT_PASSWORD_REQUIRED",
            Self::MfaKeyMissing => "MFA_KEY_MISSING",
            Self::MfaKeyMismatch => "MFA_KEY_MISMATCH",
            Self::StalePluginContext => "STALE_PLUGIN_CONTEXT",
            Self::PluginProfileInUse => "PLUGIN_PROFILE_IN_USE",
            Self::CoreServiceBusy => "CORE_SERVICE_BUSY",
            Self::Cancelled => "REQUEST_CANCELLED",
            Self::TimedOut => "REQUEST_TIMEOUT",
        }
    }

    pub fn into_rpc_error(self) -> RpcError {
        let code = match self {
            Self::PermissionDenied => ErrorCode::PermissionDenied,
            Self::DuplicateRequest => ErrorCode::DuplicateRequest,
            Self::Cancelled => ErrorCode::RequestCancelled,
            Self::TimedOut => ErrorCode::RequestTimeout,
            _ => ErrorCode::InvalidState,
        };
        RpcError::new(code, self.kind())
    }
}
