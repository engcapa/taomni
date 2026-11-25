//! Account metadata and command DTOs. Stored secrets never appear in response DTOs.
use crate::{OtpAlgorithm, OtpKind};
use serde::{Deserialize, Serialize};

/// Account metadata sent to the renderer. Never carries the secret.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MfaAccount {
    pub id: String,
    pub issuer: String,
    pub account_name: String,
    pub group: String,
    pub note: String,
    pub kind: OtpKind,
    pub algorithm: OtpAlgorithm,
    pub digits: u32,
    pub period: u32,
    pub counter: u64,
    pub pinned: bool,
    pub sort_order: i64,
    pub use_count: i64,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Structured account the renderer parsed from a form, otpauth link or QR code.
/// Enumerations stay strings so bad values become field errors, not IPC errors.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaAccountInput {
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub account_name: String,
    pub secret: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default = "default_algorithm")]
    pub algorithm: String,
    #[serde(default = "default_digits")]
    pub digits: u32,
    #[serde(default = "default_period")]
    pub period: u32,
    #[serde(default)]
    pub counter: u64,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub note: String,
}

fn default_kind() -> String {
    "totp".into()
}
fn default_algorithm() -> String {
    "SHA1".into()
}
fn default_digits() -> u32 {
    6
}
pub fn default_period() -> u32 {
    30
}

/// Full replacement of the user-editable metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaAccountPatch {
    pub issuer: String,
    pub account_name: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MfaPrefs {
    pub sort_mode: String,
    #[serde(default)]
    pub group_filter: String,
}

impl Default for MfaPrefs {
    fn default() -> Self {
        Self {
            sort_mode: "custom".into(),
            group_filter: String::new(),
        }
    }
}

/// One generated code. TOTP rows carry their validity window; HOTP rows do not.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MfaCode {
    pub id: String,
    pub code: String,
    pub next_code: Option<String>,
    pub period: u32,
    pub counter: u64,
    pub valid_from_ms: Option<i64>,
    pub valid_until_ms: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaSnapshot {
    pub accounts: Vec<MfaAccount>,
    pub prefs: MfaPrefs,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaInspectItem {
    pub ok: bool,
    pub error: Option<String>,
    pub duplicate_of: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaAddResult {
    pub added: Vec<MfaAccount>,
    /// Input indexes skipped because an identical account already exists.
    pub duplicates: Vec<usize>,
}
