use super::account_model::MailAccountConfig;
use crate::terminal::network::NetworkSettings;
use lettre::transport::smtp::client::Tls;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailConnectionSecurity {
    #[serde(rename = "tls", alias = "TLS", alias = "Tls")]
    Tls,
    #[serde(rename = "starttls", alias = "STARTTLS", alias = "StartTls")]
    Starttls,
    #[serde(rename = "none", alias = "None", alias = "NONE")]
    None,
}

impl Default for MailConnectionSecurity {
    fn default() -> Self {
        Self::Tls
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailProvider {
    #[serde(rename = "custom", alias = "Custom")]
    Custom,
    #[serde(rename = "gmail", alias = "Gmail")]
    Gmail,
    #[serde(rename = "outlook", alias = "Outlook", alias = "outlook.com")]
    Outlook,
}

/// Incoming protocol of an account (TASK-21).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailIncomingProtocol {
    #[default]
    Imap,
    Pop3,
}

impl Default for MailProvider {
    fn default() -> Self {
        Self::Custom
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailAuthMode {
    #[serde(rename = "password", alias = "Password")]
    Password,
    #[serde(rename = "oauth2", alias = "OAuth2", alias = "oauth")]
    OAuth2,
}

impl Default for MailAuthMode {
    fn default() -> Self {
        Self::Password
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailServerConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub security: MailConnectionSecurity,
    /// Base64 DER of a certificate the user trusted for this server (AC-44).
    #[serde(default)]
    pub trusted_cert: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSmtpConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub security: MailConnectionSecurity,
    #[serde(default = "default_true")]
    pub use_imap_auth: bool,
    /// Base64 DER of a certificate the user trusted for this server (AC-44).
    #[serde(default)]
    pub trusted_cert: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedMailAccount {
    pub(super) config: MailAccountConfig,
    pub(super) auth_mode: MailAuthMode,
    pub(super) network_settings: Option<NetworkSettings>,
    pub(super) imap_username: String,
    pub(super) imap_password: String,
    pub(super) smtp_username: String,
    pub(super) smtp_password: String,
}
use super::account_model::default_true;
