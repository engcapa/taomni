//! Commands and desktop events shared by the RDP Server host and core.

use serde::{Deserialize, Serialize};

mod settings;
pub use settings::{CONFIG_FILENAME, CONFIG_PATH, SettingsFile, StoredSettings};

pub const SLUG: &str = "rdp-server";
pub const SERVER_TYPE: &str = "rdp";
pub const START: &str = "rdp-server/start";
pub const STATUS: &str = "rdp-server/status";
pub const STOP: &str = "rdp-server/stop";
pub const APPROVE: &str = "rdp-server/approve";
pub const SAVE_SETTINGS: &str = "rdp-server/save-settings";
pub const COMMANDS: [&str; 5] = [START, STATUS, STOP, APPROVE, SAVE_SETTINGS];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub id: String,
    pub pid: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionApprovalRequest {
    pub request_id: String,
    pub peer: String,
    pub timeout_seconds: u64,
    pub expires_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpSessionEvent {
    pub state: String,
    pub peer: String,
    pub view_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopEvent {
    ConnectionRequest(ConnectionApprovalRequest),
    Session(RdpSessionEvent),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub request_id: String,
    pub approved: bool,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Status {
    pub running: bool,
    pub logs: Vec<String>,
    pub events: Vec<DesktopEvent>,
}
