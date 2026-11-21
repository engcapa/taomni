//! Messages exchanged by the core Servers pane and the signed VNC Server host.

use serde::{Deserialize, Serialize};

pub const SLUG: &str = "vnc-server";
pub const START: &str = "vnc-server/start";
pub const STATUS: &str = "vnc-server/status";
pub const STOP: &str = "vnc-server/stop";
pub const COMMANDS: [&str; 3] = [START, STATUS, STOP];

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub port: u16,
    pub bind_address: String,
    pub view_only: bool,
    pub shared_desktop: bool,
    pub password: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub id: String,
    pub pid: Option<u32>,
}

#[derive(Default, Deserialize, Serialize)]
pub struct Status {
    pub running: bool,
    pub logs: Vec<String>,
}
