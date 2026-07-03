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
    Rlogin,
    RDP,
    VNC,
    FTP,
    SFTP,
    Serial,
    LocalShell,
    File,
    Browser,
    Mosh,
    MySQL,
    PostgreSQL,
    PanWeiDB,
    SQLServer,
    StarRocks,
    ClickHouse,
    Presto,
    Redis,
    HBaseShell,
    Proxy,
    /// Generic IMAP + SMTP email account. Endpoint, cache, and AI policy
    /// options live in `options_json`; credentials are stored as vault refs.
    Mail,
    /// S3 and any S3-compatible object storage (AWS S3, Alibaba OSS via its
    /// S3-compatible endpoint, MinIO, Cloudflare R2, Backblaze B2, Wasabi,
    /// Tencent COS, Ceph, ...). The concrete provider + endpoint + addressing
    /// style live in `options_json` (`provider`, `endpoint`, `region`,
    /// `pathStyle`, `authType`, credential `vault:` refs, `defaultBucket`).
    S3,
    /// Azure Blob storage (official azure_storage_blob SDK). `options_json`
    /// carries `accountName`, `endpointSuffix`, `authType` and the credential
    /// `vault:` refs (account key / connection string / SAS / Entra ID).
    AzureBlob,
}

impl SessionType {
    pub fn as_str(&self) -> &str {
        match self {
            Self::SSH => "SSH",
            Self::Telnet => "Telnet",
            Self::Rlogin => "Rlogin",
            Self::RDP => "RDP",
            Self::VNC => "VNC",
            Self::FTP => "FTP",
            Self::SFTP => "SFTP",
            Self::Serial => "Serial",
            Self::LocalShell => "LocalShell",
            Self::File => "File",
            Self::Browser => "Browser",
            Self::Mosh => "Mosh",
            Self::MySQL => "MySQL",
            Self::PostgreSQL => "PostgreSQL",
            Self::PanWeiDB => "PanWeiDB",
            Self::SQLServer => "SQLServer",
            Self::StarRocks => "StarRocks",
            Self::ClickHouse => "ClickHouse",
            Self::Presto => "Presto",
            Self::Redis => "Redis",
            Self::HBaseShell => "HBaseShell",
            Self::Proxy => "Proxy",
            Self::Mail => "Mail",
            Self::S3 => "S3",
            Self::AzureBlob => "AzureBlob",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "SSH" => Self::SSH,
            "Telnet" => Self::Telnet,
            "Rlogin" => Self::Rlogin,
            "RDP" => Self::RDP,
            "VNC" => Self::VNC,
            "FTP" => Self::FTP,
            "SFTP" => Self::SFTP,
            "Serial" => Self::Serial,
            "LocalShell" => Self::LocalShell,
            "File" => Self::File,
            "Browser" => Self::Browser,
            "Mosh" => Self::Mosh,
            "MySQL" => Self::MySQL,
            "PostgreSQL" => Self::PostgreSQL,
            "PanWeiDB" | "PanWei" | "openGauss" | "OpenGauss" => Self::PanWeiDB,
            "SQLServer" | "SQL Server" | "MSSQL" => Self::SQLServer,
            "StarRocks" | "StarRocksDB" => Self::StarRocks,
            "ClickHouse" => Self::ClickHouse,
            "Presto" => Self::Presto,
            "Redis" => Self::Redis,
            "HBaseShell" => Self::HBaseShell,
            "Proxy" => Self::Proxy,
            "Mail" => Self::Mail,
            "S3" => Self::S3,
            "AzureBlob" => Self::AzureBlob,
            _ => Self::SSH,
        }
    }

    pub fn default_port(&self) -> u16 {
        match self {
            Self::SSH | Self::SFTP => 22,
            Self::Telnet => 23,
            Self::Rlogin => 513,
            Self::RDP => 3389,
            Self::VNC => 5900,
            Self::FTP => 21,
            Self::Mosh => 60001,
            Self::MySQL => 3306,
            Self::PostgreSQL => 5432,
            Self::PanWeiDB => 5432,
            Self::SQLServer => 1433,
            Self::StarRocks => 9030,
            Self::ClickHouse => 9000,
            Self::Presto => 8080,
            Self::Redis => 6379,
            Self::HBaseShell => 8080,
            Self::Proxy => 3128,
            Self::Mail => 993,
            // Object storage speaks HTTPS; the real endpoint lives in options_json.
            Self::S3 | Self::AzureBlob => 443,
            Self::Serial | Self::LocalShell | Self::File | Self::Browser => 0,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_type_proxy_round_trips() {
        assert_eq!(SessionType::Proxy.as_str(), "Proxy");
        assert_eq!(SessionType::from_str("Proxy"), SessionType::Proxy);
    }

    #[test]
    fn planned_client_session_types_round_trip() {
        for (raw, expected_port) in [
            ("Rlogin", 513),
            ("Mosh", 60001),
            ("Browser", 0),
            ("Mail", 993),
            ("PanWeiDB", 5432),
        ] {
            let ty = SessionType::from_str(raw);
            assert_eq!(ty.as_str(), raw);
            assert_eq!(ty.default_port(), expected_port);
        }
    }

    #[test]
    fn session_config_deserializes_panweidb_type() {
        let json = r#"{
            "id": "pw",
            "name": "PanWei 192.168.152.250",
            "session_type": "PanWeiDB",
            "group_path": null,
            "host": "192.168.152.250",
            "port": 17700,
            "username": "panwei_omm",
            "auth_method": "Password",
            "options_json": "{\"dbDatabase\":\"panweidb\"}",
            "created_at": 0,
            "updated_at": 0,
            "last_connected_at": null,
            "sort_order": 0
        }"#;
        let config: SessionConfig =
            serde_json::from_str(json).expect("PanWeiDB session_type must deserialize");
        assert_eq!(config.session_type, SessionType::PanWeiDB);
        assert_eq!(config.session_type.as_str(), "PanWeiDB");
    }

    #[test]
    fn session_config_deserializes_proxy_type() {
        // Mirrors the payload the frontend sends to the `save_session`
        // Tauri command. Before `Proxy` was a SessionType variant, serde
        // rejected this at the IPC boundary and the session was never saved.
        let json = r#"{
            "id": "abc",
            "name": "SOCKS5 1.2.3.4:1080",
            "session_type": "Proxy",
            "group_path": null,
            "host": "1.2.3.4",
            "port": 1080,
            "username": null,
            "auth_method": "None",
            "options_json": "{\"proxyKind\":\"socks5\"}",
            "created_at": 0,
            "updated_at": 0,
            "last_connected_at": null,
            "sort_order": 0
        }"#;
        let config: SessionConfig =
            serde_json::from_str(json).expect("Proxy session_type must deserialize");
        assert_eq!(config.session_type, SessionType::Proxy);
    }
}
