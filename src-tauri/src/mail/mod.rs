//! Generic IMAP/SMTP mail backend.
//!
//! IMAP operations reuse a per-account live session (and its session-level
//! proxy forwarder) for a short idle TTL. SMTP remains short-lived. Network
//! routing uses only the mail session's `networkSettings` — never the app
//! global proxy.
//!
//! Session proxy forwarding uses an explicit `tokio::runtime::Handle` with
//! `Handle::block_on` from `spawn_blocking` workers (no long-lived
//! `handle.enter()`). OAuth token HTTP uses `reqwest::blocking` and is isolated
//! onto a plain OS thread when a Tokio runtime is already current, to avoid
//! nested-runtime drop panics in debug builds.

mod imap_pool;
pub use imap_pool::*;
mod smtp;
pub use smtp::*;
mod imap_transport;
use imap_transport::*;
mod cache_access;
pub use cache_access::*;
mod message_commands;
pub use message_commands::*;
mod oauth;
pub use oauth::*;
mod sync_commands;
pub use sync_commands::*;
mod drafts;
pub use drafts::*;
mod mutation_commands;
pub use mutation_commands::*;
mod account_config;
use account_config::*;
mod imap_messages;
use imap_messages::*;
mod attachment_files;
use attachment_files::*;
mod mime;
use mime::*;
mod cache;
use cache::*;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
};
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::Tls;
use lettre::{Message, SmtpTransport, Transport};
use mail_parser::{Address as ParsedAddress, MessageParser, MimeHeaders, PartType};
use native_tls::TlsConnector;
use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;
use tokio::task::JoinHandle;

use crate::state::AppState;
use crate::terminal::network::NetworkSettings;

pub mod archive;
mod archive_metadata;
pub(crate) mod archive_query;
pub mod autoconfig;
pub mod caldav;
pub mod calendar;
pub mod certs;
pub mod contacts;
pub(crate) mod coordination;
#[cfg(test)]
mod fake_imap;
pub mod filters;
pub mod folders;
pub mod idle;
pub mod lists;
mod local_cmds;
pub mod mbox;
mod mutations;
pub mod outgoing;
mod parts;
mod pop3;
mod read_actions;
pub mod receipts;
#[cfg(test)]
mod responsiveness_tests;
pub mod search;
pub(crate) mod storage;
mod sync;
mod vcard;
mod webdav;

use sync::{FolderStepOutcome, FolderSyncState, StepParams};
pub use sync::{MailFolderSyncResult, MailSyncRequestMode};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MESSAGE_LIMIT: usize = 200;
const DEFAULT_BODY_MAX_BYTES: usize = 256 * 1024;
/// Cap for HTML bodies after embedding inline CID images as data URLs for display.
const MAX_EMBEDDED_BODY_BYTES: usize = 5 * 1024 * 1024;
/// Skip individual CID parts larger than this when rewriting for display.
const MAX_INLINE_CID_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const OAUTH_REFRESH_SKEW_SECS: i64 = 300;
const OAUTH_REAUTHORIZE_REQUIRED: &str = "OAuth2 authorization expired or was revoked. Reauthorize this mail account in session settings.";
const IMAP_LOGIN_RETRY_DELAYS_MS: [u64; 2] = [500, 1500];
/// How long an idle live IMAP session (and its proxy forwarder) is kept.
const IMAP_LIVE_IDLE_TTL: Duration = Duration::from_secs(180);

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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthSettings {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub token_ref: Option<String>,
    #[serde(default)]
    pub refresh_token_ref: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailOAuthTokenBundle {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<i64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthDeviceCodeResponse {
    #[serde(default)]
    device_code: String,
    #[serde(default)]
    user_code: String,
    #[serde(default, alias = "verification_url")]
    verification_uri: String,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    interval: Option<i64>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthAuthorizeRequest {
    pub session_id: String,
    pub provider: MailProvider,
    pub email_address: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthDeviceStartRequest {
    pub provider: MailProvider,
    pub client_id: String,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthDeviceStartResult {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub message: String,
    pub expires_in: i64,
    pub interval: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthDeviceCompleteRequest {
    pub session_id: String,
    pub provider: MailProvider,
    pub email_address: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub device_code: String,
    #[serde(default)]
    pub interval: Option<i64>,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthAuthorizeResult {
    pub token_ref: String,
    pub expires_at: Option<i64>,
    pub scope: Option<String>,
    pub token_type: Option<String>,
}

struct OAuthCallback {
    code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailCacheSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_header_retention_days")]
    pub header_retention_days: u32,
    #[serde(default = "default_header_limit_per_folder")]
    pub header_limit_per_folder: u32,
    #[serde(default = "default_body_recent_limit")]
    pub body_recent_limit: u32,
    #[serde(default = "default_body_max_bytes")]
    pub body_max_bytes: u32,
    #[serde(default)]
    pub attachment_cache: bool,
    #[serde(default)]
    pub save_directory: Option<String>,
    #[serde(default)]
    pub storage_directory: Option<String>,
    #[serde(default)]
    pub full_message_mode: storage::FullMessageMode,
    #[serde(default)]
    pub full_message_folders: Vec<String>,
}

impl Default for MailCacheSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            header_retention_days: default_header_retention_days(),
            header_limit_per_folder: default_header_limit_per_folder(),
            body_recent_limit: default_body_recent_limit(),
            body_max_bytes: default_body_max_bytes(),
            attachment_cache: false,
            save_directory: None,
            storage_directory: None,
            full_message_mode: storage::FullMessageMode::All,
            full_message_folders: Vec::new(),
        }
    }
}

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

#[derive(Debug, Clone)]
struct ResolvedMailAccount {
    config: MailAccountConfig,
    auth_mode: MailAuthMode,
    network_settings: Option<NetworkSettings>,
    imap_username: String,
    imap_password: String,
    smtp_username: String,
    smtp_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAddress {
    pub name: Option<String>,
    pub address: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachmentInfo {
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub size: Option<usize>,
    /// IMAP section ("2", "1.3") for large messages listed via BODYSTRUCTURE;
    /// downloads then fetch only that part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolder {
    pub account_id: String,
    pub name: String,
    pub display_name: String,
    pub delimiter: Option<String>,
    pub flags: Vec<String>,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub total: Option<u32>,
    pub unread: Option<u32>,
    pub updated_at: i64,
    /// Lowest UID of the contiguous cached span (see `sync.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_low_uid: Option<u32>,
    /// Highest UID of the contiguous cached span.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_high_uid: Option<u32>,
    /// True once the cached span reaches the oldest server message (or the
    /// configured retention boundary), so no older backfill remains.
    #[serde(default)]
    pub sync_complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_count: Option<u32>,
    /// Last sync error for this folder; cleared by the next successful sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessageHeader {
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: String,
    pub from: Option<MailAddress>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub date_ts: Option<i64>,
    pub flags: Vec<String>,
    pub has_attachments: bool,
    pub attachment_count: usize,
    pub attachments: Vec<MailAttachmentInfo>,
    pub snippet: Option<String>,
    pub raw_size: Option<u32>,
    pub body_cached: bool,
    /// `In-Reply-To` message id (without angle brackets).
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// `References` message ids, oldest first (without angle brackets).
    #[serde(default)]
    pub references: Vec<String>,
    /// `List-Unsubscribe` of mailing-list mail (TASK-18).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_unsubscribe: Option<lists::MailListUnsubscribe>,
    /// `Disposition-Notification-To` address: the sender asked for a read
    /// receipt (RFC 8098, TASK-17).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessageBody {
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub snippet: Option<String>,
    pub attachments: Vec<MailAttachmentInfo>,
    pub raw_size: Option<u32>,
    pub cached_at: Option<i64>,
    pub source: String,
}

#[derive(Debug, Clone)]
struct MailMessageCached {
    header: MailMessageHeader,
    body_text: Option<String>,
    body_html: Option<String>,
    body_cached_at: Option<i64>,
    /// Server arrival time (IMAP INTERNALDATE); drives retention pruning.
    internal_ts: Option<i64>,
    /// True when `header.flags` came from a FETCH FLAGS response, so an empty
    /// list really means "no flags" (unread) and must overwrite cached flags.
    flags_authoritative: bool,
}

#[derive(Debug)]
struct DownloadedMailAttachment {
    name: Option<String>,
    content_type: Option<String>,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSyncResult {
    pub account_id: String,
    pub folder: String,
    pub folders: Vec<MailFolder>,
    pub messages: Vec<MailMessageHeader>,
    pub fetched_messages: usize,
    pub cached_bodies: usize,
    pub synced_at: i64,
    pub offset: u32,
    pub limit: u32,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSyncAllResult {
    pub account_id: String,
    pub folders: Vec<MailFolder>,
    pub fetched_messages: usize,
    /// Newly arrived unseen messages across folders (excludes initial sync,
    /// gap repair and backfill).
    pub new_messages: usize,
    pub new_unseen_by_folder: HashMap<String, usize>,
    pub failed_folders: Vec<MailFolderError>,
    /// Folders whose catch-up was bounded by `limit` and needs more steps.
    pub pending_folders: Vec<String>,
    /// Folders a STATUS check proved unchanged (skipped by a periodic scan).
    pub unchanged_folders: Vec<String>,
    pub cached_bodies: usize,
    pub synced_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolderError {
    pub name: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMarkReadResult {
    pub folder: String,
    pub marked: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailTestConnectionResult {
    pub imap_ok: bool,
    pub smtp_ok: bool,
    pub folder_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendRequest {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    #[serde(default)]
    pub text_body: Option<String>,
    #[serde(default)]
    pub html_body: Option<String>,
    #[serde(default)]
    pub attachments: Vec<MailSendAttachment>,
    /// Message id this message replies to (brackets optional).
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// Thread ancestry, oldest first (brackets optional).
    #[serde(default)]
    pub references: Vec<String>,
    /// Local draft whose server copy (Drafts folder) should be removed after
    /// a successful send.
    #[serde(default)]
    pub draft_id: Option<String>,
    /// `From:` of a non-default identity ("Name <addr>"); `None` = account.
    #[serde(default)]
    pub from: Option<String>,
    /// Reply-To of that identity (overrides the account Reply-To).
    #[serde(default)]
    pub reply_to: Option<String>,
    /// Ask for a read receipt (RFC 8098 `Disposition-Notification-To`).
    #[serde(default)]
    pub request_read_receipt: bool,
}

/// `Disposition-Notification-To` (RFC 8098); lettre has no typed header.
#[derive(Debug, Clone)]
struct DispositionNotificationTo(String);

impl lettre::message::header::Header for DispositionNotificationTo {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("Disposition-Notification-To")
    }

    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.trim().to_string()))
    }

    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

/// Queue state of a draft waiting in the local Outbox (TASK-17).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailOutboxState {
    /// Earliest send time (epoch seconds); `None` = wait for "Send now".
    #[serde(default)]
    pub send_at: Option<i64>,
    #[serde(default)]
    pub queued_at: i64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub read_receipt: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendAttachment {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub inline: bool,
    #[serde(default)]
    pub content_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendResult {
    pub accepted: bool,
    pub response: String,
    /// Folder that received the copy of the sent message (IMAP APPEND).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_copy_folder: Option<String>,
    /// Why no sent copy was stored, when saving one was attempted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_copy_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftAttachment {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub inline: bool,
    #[serde(default)]
    pub content_id: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftContext {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub uid: Option<u32>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
    /// Thread ancestry of the replied-to message, oldest first.
    #[serde(default)]
    pub references: Vec<String>,
    /// Sending identity chosen in the composer.
    #[serde(default)]
    pub identity_id: Option<String>,
    /// Present while the draft waits in the Outbox.
    #[serde(default)]
    pub outbox: Option<MailOutboxState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraft {
    pub id: String,
    pub account_id: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text_body: String,
    pub html_body: String,
    pub attachments: Vec<MailDraftAttachment>,
    #[serde(default)]
    pub reply_context: Option<MailDraftContext>,
    #[serde(default)]
    pub remote_draft_folder: Option<String>,
    #[serde(default)]
    pub remote_draft_uid: Option<u32>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftSaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub text_body: String,
    #[serde(default)]
    pub html_body: String,
    #[serde(default)]
    pub attachments: Vec<MailDraftAttachment>,
    #[serde(default)]
    pub reply_context: Option<MailDraftContext>,
    #[serde(default)]
    pub remote_draft_folder: Option<String>,
    #[serde(default)]
    pub remote_draft_uid: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailContactSuggestion {
    pub name: Option<String>,
    pub email: String,
    pub source: String,
    pub score: i64,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDownloadAttachmentResult {
    pub path: String,
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub size: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFlagResult {
    pub folder: String,
    pub updated: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMoveResult {
    pub folder: String,
    pub target: String,
    pub count: usize,
    pub mutation: Option<mutations::Progress>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDeleteResult {
    pub folder: String,
    pub deleted: usize,
    pub mutation: Option<mutations::Progress>,
}

/// Whether header sync should issue a remote IMAP LIST.
/// Refresh requests always list; otherwise list only when the local folder
/// cache is empty so the UI still gets a usable folder set.
fn should_list_remote_folders(refresh_folders: bool, cached_folder_count: usize) -> bool {
    refresh_folders || cached_folder_count == 0
}

/// Build the folder list returned by header sync: remote LIST (or cache) plus
/// the just-synced selected folder metadata.
fn folders_for_header_sync(base_folders: Vec<MailFolder>, selected: MailFolder) -> Vec<MailFolder> {
    let mut folders = base_folders;
    merge_selected_folder(&mut folders, selected);
    folders
}

fn non_empty_str(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() { None } else { Some(value) }
}

fn normalize_preview(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn default_true() -> bool {
    true
}

/// 0 = keep every header (full local header index).
fn default_header_retention_days() -> u32 {
    0
}

/// 0 = no per-folder header cap.
fn default_header_limit_per_folder() -> u32 {
    0
}

fn default_body_recent_limit() -> u32 {
    200
}

fn default_body_max_bytes() -> u32 {
    DEFAULT_BODY_MAX_BYTES as u32
}

fn default_sync_interval_minutes() -> u32 {
    5
}

fn default_max_fetch_per_sync() -> u32 {
    DEFAULT_MESSAGE_LIMIT as u32
}
