//! Local settings DTOs, deliberately separate from the .taobak manifest.
use super::{commands::Configuration, policy::BackupPolicy};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revisions {
    pub policy: u64,
    pub control: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub policy: BackupPolicy,
    pub remote: Configuration,
    pub revisions: Revisions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRequest {
    pub domain: String,
    pub expected_revision: u64,
    pub patch: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ManualDestination {
    Selected {
        #[serde(rename = "localPassword")]
        local_password: Option<String>,
    },
    File {
        path: String,
        password: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualRequest {
    pub destination: ManualDestination,
    pub expected_policy_revision: u64,
    pub expected_control_revision: Option<u64>,
}
