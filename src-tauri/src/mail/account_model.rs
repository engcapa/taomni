use super::connection_model::MailAuthMode;
use super::connection_model::MailIncomingProtocol;
use super::connection_model::MailProvider;
use super::connection_model::MailServerConfig;
use super::connection_model::MailSmtpConfig;
use super::limits::DEFAULT_MESSAGE_LIMIT;
use super::oauth_model::MailOAuthSettings;
use crate::mail::caldav;
use crate::mail::contacts;
use crate::terminal::network::NetworkSettings;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;

pub use taomni_mail_engine::cache::MailCacheSettings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAiSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub skip_body_confirm: bool,
}

impl Default for MailAiSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            skip_body_confirm: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSyncSettings {
    #[serde(default = "default_true")]
    pub on_open: bool,
    #[serde(default = "default_sync_interval_minutes")]
    pub interval_minutes: u32,
    #[serde(default = "default_max_fetch_per_sync")]
    pub max_fetch_per_sync: u32,
    /// Hide and skip folders the server does not list as subscribed (LSUB).
    #[serde(default)]
    pub subscribed_only: bool,
}

impl Default for MailSyncSettings {
    fn default() -> Self {
        Self {
            on_open: true,
            interval_minutes: default_sync_interval_minutes(),
            max_fetch_per_sync: default_max_fetch_per_sync(),
            subscribed_only: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAccountConfig {
    pub session_id: String,
    pub email_address: String,
    #[serde(default)]
    pub provider: MailProvider,
    #[serde(default)]
    pub auth_mode: MailAuthMode,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    pub imap: MailServerConfig,
    pub smtp: MailSmtpConfig,
    #[serde(default)]
    pub oauth: MailOAuthSettings,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
    #[serde(default)]
    pub sync: MailSyncSettings,
    #[serde(default)]
    pub cache: MailCacheSettings,
    #[serde(default)]
    pub ai: MailAiSettings,
    /// Store a copy of sent mail in the Sent folder (IMAP APPEND). `None` =
    /// automatic: off for Gmail/Outlook (the server files it), on otherwise.
    #[serde(default)]
    pub save_sent_copy: Option<bool>,
    /// IMAP (default) or POP3 with local folders.
    #[serde(default)]
    pub incoming: MailIncomingProtocol,
    /// POP3: delete downloaded mail from the server after N days
    /// (`None` = keep on the server, `0` = delete right after download).
    #[serde(default)]
    pub pop3_leave_days: Option<u32>,
    /// Manual special folders (`sent`, `drafts`, `trash`, `junk`, `archive`
    /// -> server folder name); beats SPECIAL-USE and name matching.
    #[serde(default)]
    pub special_folders: HashMap<String, String>,
    /// CardDAV address book (TASK-19); `None` = local address book only.
    #[serde(default)]
    pub carddav: Option<contacts::MailCardDavSettings>,
    /// CalDAV calendar for the agenda (TASK-20 phase 2); `None` = off.
    #[serde(default)]
    pub caldav: Option<caldav::MailCalDavSettings>,
}

pub(super) fn default_true() -> bool {
    true
}

pub(super) fn default_sync_interval_minutes() -> u32 {
    5
}

pub(super) fn default_max_fetch_per_sync() -> u32 {
    DEFAULT_MESSAGE_LIMIT as u32
}
