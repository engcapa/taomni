//! RDP session options and requests shared by the core and the remote client.

mod options;

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;
use zeroize::Zeroizing;

pub use options::{DriveRedirectOpt, GatewayOpt, PerformanceFlags, RdpOptions};

pub const SLUG: &str = "rdp-client";
pub const START: &str = "rdp/start";
pub const CLOSE: &str = "rdp/close";
pub const TEST: &str = "rdp/test";

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
