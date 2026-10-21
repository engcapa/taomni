use serde::Deserialize;
use serde::Serialize;
use std::sync::atomic::AtomicU64;

pub(super) static REQ_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    pub running: bool,
    pub elevated: bool,
    pub endpoint: Option<String>,
    pub message: String,
    pub windivert: Option<serde_json::Value>,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct OrigMapping {
    pub dst_ip: String,
    pub dst_port: u16,
    pub pid: u32,
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct CaptureStartArgs {
    pub mode_apps: bool,
    pub app_paths: Vec<String>,
    pub bypass_cidrs: Vec<String>,
    pub bypass_pids: Vec<u32>,
    /// Executable paths to always bypass (restart-proof local-proxy exclusion).
    pub bypass_paths: Vec<String>,
    pub bypass_endpoints: Vec<(String, u16)>,
    pub relay_ip: String,
    pub relay_port: u16,
    /// Drop in-scope outbound UDP 443 so QUIC falls back to TCP (see design doc).
    pub block_quic: bool,
}
