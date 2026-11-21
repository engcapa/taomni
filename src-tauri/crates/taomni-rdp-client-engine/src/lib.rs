//! RD Gateway and the certificate-verifying TLS used by the RDP client.

use serde::{Deserialize, Serialize};

pub mod gateway;
pub mod tls;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayOpt {
    pub host: String,
    #[serde(default = "default_gateway_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default = "default_gateway_auth")]
    pub auth: String, // "basic" | "ntlm"
    #[serde(default = "default_true")]
    pub use_session_creds: bool,
    /// Optional SHA-256 pin for the HTTPS certificate presented by RD Gateway.
    #[serde(default)]
    pub certificate_fingerprint: Option<String>,
}

fn default_gateway_port() -> u16 {
    443
}
fn default_gateway_auth() -> String {
    "ntlm".into()
}

fn default_true() -> bool {
    true
}
