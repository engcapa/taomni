//! Wire contract for the Local servers module.

use serde::{Deserialize, Serialize};
use std::{fs::File, io, path::Path};

use crate::ServerConfig;

pub const SLUG: &str = "servers";
pub const START: &str = "servers/start";
pub const STATUS: &str = "servers/status";
pub const STOP: &str = "servers/stop";
pub const SAVE_SETTINGS: &str = "servers/save-settings";
pub const COMMANDS: [&str; 4] = [START, STATUS, STOP, SAVE_SETTINGS];
pub const HOST_KEY: &str = "host_ed25519";
pub const HOST_KEY_PATH: &str = "plugins/servers/data/host_ed25519";

pub struct SshIdentity(crate::settings_file::SettingsFile);

impl SshIdentity {
    pub fn new(profile: &Path) -> Self {
        Self(crate::settings_file::SettingsFile::new(
            profile,
            HOST_KEY_PATH,
        ))
    }

    pub fn directory(&self) -> io::Result<&Path> {
        self.0.prepare_parent()
    }

    pub fn open(&self) -> io::Result<Option<File>> {
        self.0.open()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Ssh,
    Ftp,
    Tftp,
    Http,
    Telnet,
    Nfs,
    Cron,
    Iperf,
}

impl Kind {
    pub const ALL: [Self; 8] = [
        Self::Ssh,
        Self::Ftp,
        Self::Tftp,
        Self::Http,
        Self::Telnet,
        Self::Nfs,
        Self::Cron,
        Self::Iperf,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::Ftp => "ftp",
            Self::Tftp => "tftp",
            Self::Http => "http",
            Self::Telnet => "telnet",
            Self::Nfs => "nfs",
            Self::Cron => "cron",
            Self::Iperf => "iperf",
        }
    }

    pub const fn uses_password(self) -> bool {
        matches!(self, Self::Ssh | Self::Ftp)
    }
}

mod settings;
pub use settings::{
    CONFIG_FILENAME, CONFIG_PATH, SettingsFile, StoredSettings, needs_legacy_password, password_ref,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    pub kind: Kind,
    pub config: ServerConfig,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub kind: Kind,
    pub id: String,
    pub pid: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartResponse {
    pub outcome: Result<Session, String>,
    pub logs: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Status {
    pub running: bool,
    pub logs: Vec<String>,
}
