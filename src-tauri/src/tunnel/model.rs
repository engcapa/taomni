use serde::Deserialize;
use serde::Serialize;

/* ---------------------------- data model ---------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
pub enum TunnelKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
pub enum TunnelAuthMethod {
    Password,
    PrivateKey,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSshCreds {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: TunnelAuthMethod,
    #[serde(default)]
    pub auth_data: Option<String>,
    #[serde(default)]
    pub save_auth: Option<bool>,
    /// Synthetic, output-only flag set by `list_tunnels` so the UI can show
    /// a masked indicator and enable the eye/reveal toggle without leaking
    /// the secret. Values: "vault" (auth_data is `vault:<id>`), "session"
    /// (plaintext lives only in the in-memory cache), "plaintext" (raw
    /// data on disk — only happens for PrivateKey paths), or "none".
    /// Stripped before persistence so this never round-trips to disk.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub auth_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub listen_host: String,
    pub listen_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
    #[serde(default)]
    pub ssh_session_id: Option<String>,
    pub ssh: TunnelSshCreds,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub autostart: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusInfo {
    pub id: String,
    pub status: TunnelStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_connections: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Stopped,
    Starting,
    Running,
    Error,
}
