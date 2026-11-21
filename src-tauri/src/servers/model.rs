use serde::Deserialize;
use serde::Serialize;

/* ---------------------------- shared DTOs --------------------------- */

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerType {
    Ssh,
    Ftp,
    Tftp,
    Http,
    Telnet,
    Vnc,
    Nfs,
    Cron,
    Iperf,
    Rdp,
}

impl ServerType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ServerType::Ssh => "ssh",
            ServerType::Ftp => "ftp",
            ServerType::Tftp => "tftp",
            ServerType::Http => "http",
            ServerType::Telnet => "telnet",
            ServerType::Vnc => "vnc",
            ServerType::Nfs => "nfs",
            ServerType::Cron => "cron",
            ServerType::Iperf => "iperf",
            ServerType::Rdp => "rdp",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "ssh" => Some(ServerType::Ssh),
            "ftp" => Some(ServerType::Ftp),
            "tftp" => Some(ServerType::Tftp),
            "http" => Some(ServerType::Http),
            "telnet" => Some(ServerType::Telnet),
            "vnc" => Some(ServerType::Vnc),
            "nfs" => Some(ServerType::Nfs),
            "cron" => Some(ServerType::Cron),
            "iperf" => Some(ServerType::Iperf),
            "rdp" => Some(ServerType::Rdp),
            _ => None,
        }
    }

    pub fn all() -> [ServerType; 10] {
        [
            ServerType::Ssh,
            ServerType::Ftp,
            ServerType::Tftp,
            ServerType::Http,
            ServerType::Telnet,
            ServerType::Vnc,
            ServerType::Nfs,
            ServerType::Cron,
            ServerType::Iperf,
            ServerType::Rdp,
        ]
    }
}

pub use taomni_server_process::ServerConfig;

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ServerRunState {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub server_type: ServerType,
    pub status: ServerRunState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ServerStatus {
    pub(super) fn stopped(server_type: ServerType) -> Self {
        Self {
            server_type,
            status: ServerRunState::Stopped,
            pid: None,
            started_at: None,
            error: None,
        }
    }
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
