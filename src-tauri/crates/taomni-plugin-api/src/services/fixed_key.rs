use serde::{Deserialize, Serialize};

use super::{ExportGrantId, FixedKeyId, OperationContext, ResetGrantId, SecretKey32};

pub const FIXED_KEY_METHOD: &str = "core/vault.fixed-key";
pub const EXPORT_GRANT_METHOD: &str = "core/vault.export-grant.validate";
pub const MFA_DATA_KEY_ID: &str = "mfa.data-key-v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum FixedKeyAction {
    Load,
    CreateIfAbsent,
    RepairEmptyAfterReset { grant: ResetGrantId },
}

/// No slug, caller-chosen kind/label, password, or replacement key is accepted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedKeyRequest {
    pub key_id: FixedKeyId,
    pub action: FixedKeyAction,
}

/// Serialize directly into a sensitive frame, never through serde_json::Value.
#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum FixedKeyResult {
    Missing,
    Key {
        context: OperationContext,
        key: SecretKey32,
    },
}

impl std::fmt::Debug for FixedKeyResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => f.write_str("FixedKeyResult::Missing"),
            Self::Key { .. } => f.write_str("FixedKeyResult::Key([REDACTED])"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportGrantRequest {
    pub grant: ExportGrantId,
}
