use crate::storage::FullMessageMode;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailCacheSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_header_retention_days")]
    pub header_retention_days: u32,
    #[serde(default = "default_header_limit_per_folder")]
    pub header_limit_per_folder: u32,
    #[serde(default = "default_body_recent_limit")]
    pub body_recent_limit: u32,
    #[serde(default = "default_body_max_bytes")]
    pub body_max_bytes: u32,
    #[serde(default)]
    pub attachment_cache: bool,
    #[serde(default)]
    pub save_directory: Option<String>,
    #[serde(default)]
    pub storage_directory: Option<String>,
    #[serde(default)]
    pub full_message_mode: FullMessageMode,
    #[serde(default)]
    pub full_message_folders: Vec<String>,
}

impl Default for MailCacheSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            header_retention_days: default_header_retention_days(),
            header_limit_per_folder: default_header_limit_per_folder(),
            body_recent_limit: default_body_recent_limit(),
            body_max_bytes: default_body_max_bytes(),
            attachment_cache: false,
            save_directory: None,
            storage_directory: None,
            full_message_mode: FullMessageMode::All,
            full_message_folders: Vec::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

/// 0 = keep every header (full local header index).
fn default_header_retention_days() -> u32 {
    0
}

/// 0 = no per-folder header cap.
fn default_header_limit_per_folder() -> u32 {
    0
}

fn default_body_recent_limit() -> u32 {
    200
}

fn default_body_max_bytes() -> u32 {
    256 * 1024
}
