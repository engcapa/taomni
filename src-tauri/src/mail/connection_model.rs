use super::account_model::MailAccountConfig;
use crate::terminal::network::NetworkSettings;
use serde::Deserialize;
use serde::Serialize;
pub use taomni_mail_api::{
    MailAuthMode, MailConnectionSecurity, MailIncomingProtocol, MailProvider,
};

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
