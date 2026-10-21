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

mod imap_messages;

mod attachment_files;

mod mime;

mod cache;

#[cfg(test)]
mod tests;

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

pub use sync::{MailFolderSyncResult, MailSyncRequestMode};

use imap_transport::*;

use account_config::*;

use imap_messages::*;

use attachment_files::*;

use mime::*;

use cache::*;

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

use sync::{FolderStepOutcome, FolderSyncState, StepParams};

mod limits;

mod connection_model;

mod oauth_model;

mod account_model;

mod message_model;

mod result_model;

mod outgoing_model;

mod utilities;

use limits::{
    DEFAULT_BODY_MAX_BYTES, DEFAULT_MESSAGE_LIMIT, DEFAULT_TIMEOUT_SECS, IMAP_LIVE_IDLE_TTL,
    IMAP_LOGIN_RETRY_DELAYS_MS, MAX_EMBEDDED_BODY_BYTES, MAX_INLINE_CID_IMAGE_BYTES,
    OAUTH_REAUTHORIZE_REQUIRED, OAUTH_REFRESH_SKEW_SECS,
};

pub use connection_model::{
    MailAuthMode, MailConnectionSecurity, MailIncomingProtocol, MailProvider, MailServerConfig,
    MailSmtpConfig,
};

use connection_model::ResolvedMailAccount;

pub use oauth_model::{
    MailOAuthAuthorizeRequest, MailOAuthAuthorizeResult, MailOAuthDeviceCompleteRequest,
    MailOAuthDeviceStartRequest, MailOAuthDeviceStartResult, MailOAuthSettings,
};

use oauth_model::{
    MailOAuthTokenBundle, OAuthCallback, OAuthDeviceCodeResponse, OAuthTokenResponse,
};

pub use account_model::{MailAccountConfig, MailAiSettings, MailCacheSettings, MailSyncSettings};

use account_model::{
    default_body_max_bytes, default_body_recent_limit, default_header_limit_per_folder,
    default_header_retention_days, default_max_fetch_per_sync, default_sync_interval_minutes,
    default_true,
};

pub use message_model::{
    MailAddress, MailAttachmentInfo, MailFolder, MailMessageBody, MailMessageHeader,
};

use message_model::{DownloadedMailAttachment, MailMessageCached};

pub use result_model::{
    MailContactSuggestion, MailDeleteResult, MailDownloadAttachmentResult, MailFlagResult,
    MailFolderError, MailMarkReadResult, MailMoveResult, MailSyncAllResult, MailSyncResult,
    MailTestConnectionResult,
};

pub use outgoing_model::{
    MailDraft, MailDraftAttachment, MailDraftContext, MailDraftSaveRequest, MailOutboxState,
    MailSendAttachment, MailSendRequest, MailSendResult,
};

use outgoing_model::DispositionNotificationTo;

use utilities::{
    folders_for_header_sync, non_empty, non_empty_str, normalize_preview, now_ts,
    should_list_remote_folders,
};
