use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    pub id: String,
    pub name: String,
    pub session_type: SessionType,
    pub group_path: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub auth_method: AuthMethod,
    /// Protocol-specific options serialized as JSON. The shape depends on
    /// `session_type`: SSH/Telnet carry terminal + network settings, WSL
    /// carries the launch argv, and `SessionType::RDP` carries the
    /// `RdpOptions` tree (`crate::rdp::RdpOptions`, camelCase) — domain,
    /// colorDepth, screenW/H, nla, performance flags, clipboard/audio/drive
    /// redirection, and an optional RD Gateway block.
    pub options_json: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_connected_at: Option<i64>,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionType {
    SSH,
    Telnet,
    RDP,
    VNC,
    FTP,
    SFTP,
    Serial,
    LocalShell,
    File,
}

impl SessionType {
    pub fn as_str(&self) -> &str {
        match self {
            Self::SSH => "SSH",
            Self::Telnet => "Telnet",
            Self::RDP => "RDP",
            Self::VNC => "VNC",
            Self::FTP => "FTP",
            Self::SFTP => "SFTP",
            Self::Serial => "Serial",
            Self::LocalShell => "LocalShell",
            Self::File => "File",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "SSH" => Self::SSH,
            "Telnet" => Self::Telnet,
            "RDP" => Self::RDP,
            "VNC" => Self::VNC,
            "FTP" => Self::FTP,
            "SFTP" => Self::SFTP,
            "Serial" => Self::Serial,
            "LocalShell" => Self::LocalShell,
            "File" => Self::File,
            _ => Self::SSH,
        }
    }

    pub fn default_port(&self) -> u16 {
        match self {
            Self::SSH | Self::SFTP => 22,
            Self::Telnet => 23,
            Self::RDP => 3389,
            Self::VNC => 5900,
            Self::FTP => 21,
            Self::Serial | Self::LocalShell | Self::File => 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuthMethod {
    Password,
    PrivateKey { key_path: String },
    Agent,
    None,
}

impl AuthMethod {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Password => "Password",
            Self::PrivateKey { .. } => "PrivateKey",
            Self::Agent => "Agent",
            Self::None => "None",
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "\"Password\"".to_string())
    }

    pub fn from_json(s: &str) -> Self {
        serde_json::from_str(s).unwrap_or(Self::Password)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
    pub icon: Option<String>,
}
