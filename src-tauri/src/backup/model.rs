//! Provider-neutral control and transfer contracts. Secrets never belong in these DTOs.
use crate::proxy::AppProxyConfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Local,
    Feishu,
    S3,
    GoogleDrive,
    Onedrive,
    Sftp,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub current_download: bool,
    pub native_version_upload: bool,
    pub list_versions: bool,
    pub download_version: bool,
    pub resume_upload: bool,
    pub resume_download: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpec {
    pub kind: String,
    pub schema_version: u32,
    pub scope: String,
    pub custom_options: Option<super::engine::BackupCustomOptions>,
}
impl Default for SourceSpec {
    fn default() -> Self {
        Self {
            kind: "taomni".into(),
            schema_version: 1,
            scope: "core".into(),
            custom_options: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    pub mode: String,
    pub custom: AppProxyConfig,
}
impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            mode: "app".into(),
            custom: AppProxyConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTarget {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub enabled: bool,
    #[serde(default)]
    pub connection_id: Option<String>,
    /// Read-only migration input from the unpublished callback-based draft.
    #[serde(default, skip_serializing)]
    pub app_id: String,
    pub root_token: String,
    #[serde(default)]
    pub proxy: NetworkConfig,
    #[serde(default)]
    pub source: SourceSpec,
    /// Missing in older configurations means the explicitly configured range.
    #[serde(default = "default_range_mode")]
    pub range_mode: String,
    /// A web-history workflow pauses writes until the user explicitly resumes.
    #[serde(default)]
    pub writes_paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuConnection {
    pub id: String,
    pub app_id: String,
    pub label: String,
    pub origin: String,
    pub account_id: String,
    pub account_name: String,
    pub tenant_key: String,
    pub auth_protocol_version: u32,
    pub scope_manifest_version: u32,
    #[serde(default)]
    pub registration_pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationSession {
    pub id: String,
    pub target_id: String,
    pub revision: u64,
    #[serde(default)]
    pub created_at: i64,
    pub phase: String,
    pub verification_url: Option<String>,
    pub user_code: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub cleanup_complete: Option<bool>,
    #[serde(default)]
    pub cancel_requested: bool,
    #[serde(default)]
    pub dismissed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlConfig {
    pub format_version: u32,
    #[serde(default)]
    pub settings_revision: u64,
    pub device: DeviceIdentity,
    pub targets: Vec<BackupTarget>,
    #[serde(default)]
    pub connections: Vec<FeishuConnection>,
    #[serde(default = "default_destinations")]
    pub selected_target_ids: Vec<String>,
}
fn default_destinations() -> Vec<String> {
    vec!["local".into()]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub snapshot_id: String,
    pub device_id: String,
    pub device_name: String,
    pub source_kind: String,
    pub source_schema_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackup {
    pub target_id: String,
    pub device_id: String,
    pub device_name: String,
    pub source_kind: String,
    pub file_token: String,
    pub name: String,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: String,
    pub snapshot_id: String,
    pub size: u64,
    pub sha256: String,
    pub source_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub file_token: String,
    pub version: Option<String>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupJob {
    pub id: String,
    pub revision: u64,
    pub target_id: String,
    pub operation: String,
    pub phase: String,
    pub bytes: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub artifact: Option<Artifact>,
    pub remote: Option<RemoteBackup>,
    pub receipt: Option<Receipt>,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub next_retry_at: Option<i64>,
    #[serde(default)]
    pub failure_kind: Option<super::failure::FailureKind>,
    /// The concrete source is frozen at enqueue, never added to the archive.
    #[serde(default)]
    pub execution_source: Option<SourceSpec>,
    #[serde(default)]
    pub cancel_requested: bool,
    #[serde(default)]
    pub local_path: Option<String>,
}

fn default_range_mode() -> String {
    "custom".into()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn validate_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "Invalid backup identifier".into())
}
pub fn validate_token(token: &str) -> Result<(), String> {
    if token.is_empty()
        || token.len() > 256
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("Invalid Feishu file/folder token".into());
    }
    Ok(())
}
