//! RDP session options and requests shared by the core and the remote client.

mod options;
pub mod transport;

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;
use zeroize::Zeroizing;

pub use options::{DriveRedirectOpt, GatewayOpt, PerformanceFlags, RdpOptions};

pub const SLUG: &str = "rdp-client";
pub const START: &str = "rdp/start";
pub const CLOSE: &str = "rdp/close";
pub const TEST: &str = "rdp/test";
pub const START_GATEWAY: &str = "rdp/start-gateway";
pub const TEST_GATEWAY: &str = "rdp/test-gateway";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<Zeroizing<String>>,
    pub options: RdpOptions,
    pub route: Endpoint,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayConnection {
    pub connection: Connection,
    pub outbound: Endpoint,
}

pub fn normalize_fingerprint(value: &str) -> Result<String, String> {
    let normalized: String = value
        .chars()
        .filter(|ch| !matches!(ch, ':' | '-' | ' ' | '\t' | '\r' | '\n'))
        .flat_map(char::to_lowercase)
        .collect();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(
            "RDP certificate fingerprint must contain exactly 64 SHA-256 hex digits".to_string(),
        );
    }
    Ok(normalized)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionId {
    pub session_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Started {
    pub session_id: String,
    pub ws_port: u16,
    pub ws_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionTestResult {
    pub width: u16,
    pub height: u16,
    pub protocol: String,
    pub server_name: String,
}
