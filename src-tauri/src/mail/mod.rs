//! Generic IMAP/SMTP mail backend.
//!
//! The first version intentionally uses short-lived connections. Each command
//! resolves credentials, performs one bounded IMAP/SMTP operation on a blocking
//! worker thread, then writes the result to the local SQLite header/body cache.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use lettre::message::{Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{Message, SmtpTransport, Transport};
use mail_parser::{Address as ParsedAddress, MessageParser, MimeHeaders, PartType};
use native_tls::TlsConnector;
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MESSAGE_LIMIT: usize = 200;
const DEFAULT_BODY_MAX_BYTES: usize = 256 * 1024;

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
}

impl Default for MailSyncSettings {
    fn default() -> Self {
        Self {
            on_open: true,
            interval_minutes: default_sync_interval_minutes(),
            max_fetch_per_sync: default_max_fetch_per_sync(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAccountConfig {
    pub session_id: String,
    pub email_address: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    pub imap: MailServerConfig,
    pub smtp: MailSmtpConfig,
    #[serde(default)]
    pub sync: MailSyncSettings,
    #[serde(default)]
    pub cache: MailCacheSettings,
    #[serde(default)]
    pub ai: MailAiSettings,
}

#[derive(Debug, Clone)]
struct ResolvedMailAccount {
    config: MailAccountConfig,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendResult {
    pub accepted: bool,
    pub response: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDownloadAttachmentResult {
    pub path: String,
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub size: usize,
}

enum ActiveImapSession {
    Tls(imap::Session<native_tls::TlsStream<TcpStream>>),
    Plain(imap::Session<TcpStream>),
}

impl ActiveImapSession {
    fn list_folders(&mut self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        match self {
            Self::Tls(session) => imap_list_folders(session, account_id),
            Self::Plain(session) => imap_list_folders(session, account_id),
        }
    }

    fn sync_folder(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
    ) -> Result<(MailFolder, Vec<MailMessageCached>), String> {
        match self {
            Self::Tls(session) => imap_sync_folder(session, account, folder),
            Self::Plain(session) => imap_sync_folder(session, account, folder),
        }
    }

    fn fetch_body(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        uid: u32,
    ) -> Result<MailMessageCached, String> {
        match self {
            Self::Tls(session) => imap_fetch_body(session, account, folder, uid),
            Self::Plain(session) => imap_fetch_body(session, account, folder, uid),
        }
    }

    fn download_attachment(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        uid: u32,
        attachment_index: usize,
        target_path: &str,
    ) -> Result<MailDownloadAttachmentResult, String> {
        match self {
            Self::Tls(session) => {
                imap_download_attachment(session, account, folder, uid, attachment_index, target_path)
            }
            Self::Plain(session) => {
                imap_download_attachment(session, account, folder, uid, attachment_index, target_path)
            }
        }
    }

    fn logout(&mut self) {
        let result = match self {
            Self::Tls(session) => session.logout(),
            Self::Plain(session) => session.logout(),
        };
        if let Err(e) = result {
            tracing::debug!("mail imap logout failed: {e}");
        }
    }
}

pub fn init_mail_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_folders (
            account_id TEXT NOT NULL,
            name TEXT NOT NULL,
            delimiter TEXT,
            flags_json TEXT NOT NULL DEFAULT '[]',
            uid_validity INTEGER,
            uid_next INTEGER,
            total INTEGER,
            unread INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, name)
        );

        CREATE TABLE IF NOT EXISTS mail_messages (
            account_id TEXT NOT NULL,
            folder TEXT NOT NULL,
            uid INTEGER NOT NULL,
            message_id TEXT,
            subject TEXT NOT NULL DEFAULT '',
            from_name TEXT,
            from_addr TEXT,
            to_json TEXT NOT NULL DEFAULT '[]',
            cc_json TEXT NOT NULL DEFAULT '[]',
            date_ts INTEGER,
            flags_json TEXT NOT NULL DEFAULT '[]',
            has_attachments INTEGER NOT NULL DEFAULT 0,
            attachment_count INTEGER NOT NULL DEFAULT 0,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            snippet TEXT,
            body_text TEXT,
            body_html TEXT,
            body_cached_at INTEGER,
            raw_size INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, folder, uid)
        );

        CREATE INDEX IF NOT EXISTS idx_mail_messages_folder_date
            ON mail_messages(account_id, folder, date_ts DESC, uid DESC);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_message_id
            ON mail_messages(account_id, message_id);",
    )
}

#[tauri::command]
pub async fn mail_test_connection(
    config: MailAccountConfig,
    state: State<'_, AppState>,
) -> Result<MailTestConnectionResult, String> {
    let account = resolve_config(&state, config)?;
    tokio::task::spawn_blocking(move || {
        let mut imap = connect_imap(&account)?;
        let folders = imap.list_folders(&account.config.session_id)?;
        imap.logout();
        test_smtp(&account)?;
        Ok(MailTestConnectionResult {
            imap_ok: true,
            smtp_ok: true,
            folder_count: folders.len(),
        })
    })
    .await
    .map_err(|e| format!("mail test task failed: {e}"))?
}

#[tauri::command]
pub async fn mail_sync_headers(
    config: MailAccountConfig,
    folder: Option<String>,
    state: State<'_, AppState>,
) -> Result<MailSyncResult, String> {
    let account = resolve_config(&state, config)?;
    let folder = folder
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| "INBOX".to_string());
    let cache_enabled = account.config.cache.enabled;
    let cache_settings = account.config.cache.clone();
    let account_id = account.config.session_id.clone();

    let mut result = tokio::task::spawn_blocking(move || {
        let mut imap = connect_imap(&account)?;
        let mut folders = imap.list_folders(&account.config.session_id)?;
        let (selected_folder, cached) = imap.sync_folder(&account, &folder)?;
        merge_selected_folder(&mut folders, selected_folder.clone());
        imap.logout();
        let cached_bodies = cached.iter().filter(|m| m.body_cached_at.is_some()).count();
        Ok::<_, String>((folders, selected_folder, cached, cached_bodies))
    })
    .await
    .map_err(|e| format!("mail sync task failed: {e}"))??;

    if cache_enabled {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        init_mail_tables(&db).map_err(|e| e.to_string())?;
        cache_sync_result(
            &db,
            &account_id,
            &result.0,
            &result.2,
            &result.1.name,
            &cache_settings,
        )
        .map_err(|e| e.to_string())?;
    }

    let synced_at = now_ts();
    let messages = result.2.drain(..).map(|m| m.header).collect::<Vec<_>>();
    Ok(MailSyncResult {
        account_id,
        folder: result.1.name,
        folders: result.0,
        fetched_messages: messages.len(),
        cached_bodies: result.3,
        messages,
        synced_at,
    })
}

#[tauri::command]
pub async fn mail_list_cached_folders(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    init_mail_tables(&db).map_err(|e| e.to_string())?;
    list_cached_folders(&db, &account_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mail_list_cached_messages(
    account_id: String,
    folder: String,
    limit: Option<u32>,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessageHeader>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    init_mail_tables(&db).map_err(|e| e.to_string())?;
    list_cached_messages(
        &db,
        &account_id,
        &folder,
        limit.unwrap_or(DEFAULT_MESSAGE_LIMIT as u32).min(1000),
        offset.unwrap_or(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mail_get_message_body(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    state: State<'_, AppState>,
) -> Result<MailMessageBody, String> {
    if config.cache.enabled {
        let cached = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            init_mail_tables(&db).map_err(|e| e.to_string())?;
            get_cached_body(&db, &config.session_id, &folder, uid).map_err(|e| e.to_string())?
        };
        if let Some(body) = cached {
            return Ok(body);
        }
    }

    let account = resolve_config(&state, config)?;
    let cache_enabled = account.config.cache.enabled;
    let message = tokio::task::spawn_blocking(move || {
        let mut imap = connect_imap(&account)?;
        let message = imap.fetch_body(&account, &folder, uid)?;
        imap.logout();
        Ok::<_, String>(message)
    })
    .await
    .map_err(|e| format!("mail body task failed: {e}"))??;

    if cache_enabled {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        init_mail_tables(&db).map_err(|e| e.to_string())?;
        upsert_message(&db, &message).map_err(|e| e.to_string())?;
    }

    Ok(cached_to_body(message, "remote"))
}

#[tauri::command]
pub async fn mail_download_attachment(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    attachment_index: usize,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<MailDownloadAttachmentResult, String> {
    let target_path = target_path.trim().to_string();
    if target_path.is_empty() {
        return Err("attachment download path is required".into());
    }
    let account = resolve_config(&state, config)?;
    tokio::task::spawn_blocking(move || {
        let mut imap = connect_imap(&account)?;
        let result =
            imap.download_attachment(&account, &folder, uid, attachment_index, &target_path);
        imap.logout();
        result
    })
    .await
    .map_err(|e| format!("mail attachment download task failed: {e}"))?
}

#[tauri::command]
pub async fn mail_send_message(
    config: MailAccountConfig,
    request: MailSendRequest,
    state: State<'_, AppState>,
) -> Result<MailSendResult, String> {
    let account = resolve_config(&state, config)?;
    validate_send_request(&request)?;
    tokio::task::spawn_blocking(move || send_smtp(&account, &request))
        .await
        .map_err(|e| format!("mail send task failed: {e}"))?
}

#[tauri::command]
pub async fn mail_clear_cache(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    init_mail_tables(&db).map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM mail_messages WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM mail_folders WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn resolve_config(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
) -> Result<ResolvedMailAccount, String> {
    let imap_host = config.imap.host.trim();
    if imap_host.is_empty() {
        return Err("IMAP host is required".into());
    }
    if config.smtp.host.trim().is_empty() {
        return Err("SMTP host is required".into());
    }
    let imap_username = config
        .imap
        .username
        .clone()
        .and_then(non_empty)
        .or_else(|| non_empty(config.email_address.clone()))
        .ok_or_else(|| "IMAP username is required".to_string())?;
    let imap_password = resolve_secret(state, config.imap.password.as_deref())?
        .ok_or_else(|| "IMAP password or app password token is required".to_string())?;

    let (smtp_username, smtp_password) = if config.smtp.use_imap_auth {
        (imap_username.clone(), imap_password.clone())
    } else {
        let username = config
            .smtp
            .username
            .clone()
            .and_then(non_empty)
            .or_else(|| non_empty(config.email_address.clone()))
            .ok_or_else(|| "SMTP username is required".to_string())?;
        let password = resolve_secret(state, config.smtp.password.as_deref())?
            .ok_or_else(|| "SMTP password or app password token is required".to_string())?;
        (username, password)
    };

    Ok(ResolvedMailAccount {
        config,
        imap_username,
        imap_password,
        smtp_username,
        smtp_password,
    })
}

fn resolve_secret(
    state: &State<'_, AppState>,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => match state.vault.resolve(v)? {
            Some(plain) => Ok(Some((*plain).clone())),
            None => Ok(Some(v.to_string())),
        },
        None => Ok(None),
    }
}

fn connect_imap(account: &ResolvedMailAccount) -> Result<ActiveImapSession, String> {
    let host = account.config.imap.host.trim();
    let port = account.config.imap.port;
    match account.config.imap.security {
        MailConnectionSecurity::Tls => {
            let stream = tcp_connect(host, port)?;
            let connector = TlsConnector::builder()
                .build()
                .map_err(|e| format!("failed to build IMAP TLS connector: {e}"))?;
            let tls_stream = connector
                .connect(host, stream)
                .map_err(|e| format!("IMAP TLS handshake failed: {e}"))?;
            let mut client = imap::Client::new(tls_stream);
            client
                .read_greeting()
                .map_err(|e| format!("IMAP greeting failed: {e}"))?;
            Ok(ActiveImapSession::Tls(login_imap_client(
                client,
                &account.imap_username,
                &account.imap_password,
            )?))
        }
        MailConnectionSecurity::Starttls => {
            let stream = tcp_connect(host, port)?;
            let mut client = imap::Client::new(stream);
            client
                .read_greeting()
                .map_err(|e| format!("IMAP greeting failed: {e}"))?;
            let connector = TlsConnector::builder()
                .build()
                .map_err(|e| format!("failed to build IMAP STARTTLS connector: {e}"))?;
            let client = client
                .secure(host, &connector)
                .map_err(|e| format!("IMAP STARTTLS failed: {e}"))?;
            Ok(ActiveImapSession::Tls(login_imap_client(
                client,
                &account.imap_username,
                &account.imap_password,
            )?))
        }
        MailConnectionSecurity::None => {
            let stream = tcp_connect(host, port)?;
            let mut client = imap::Client::new(stream);
            client
                .read_greeting()
                .map_err(|e| format!("IMAP greeting failed: {e}"))?;
            Ok(ActiveImapSession::Plain(login_imap_client(
                client,
                &account.imap_username,
                &account.imap_password,
            )?))
        }
    }
}

fn login_imap_client<T: Read + Write>(
    client: imap::Client<T>,
    username: &str,
    password: &str,
) -> Result<imap::Session<T>, String> {
    client
        .login(username, password)
        .map_err(|(e, _)| format!("IMAP login failed: {e}"))
}

fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let timeout = Duration::from_secs(DEFAULT_TIMEOUT_SECS);
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("failed to resolve {host}:{port}: {e}"))?;
    let mut last_error = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                return Ok(stream);
            }
            Err(e) => last_error = Some(e),
        }
    }
    Err(format!(
        "failed to connect to {host}:{port}: {}",
        last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "no resolved address".into())
    ))
}

fn imap_list_folders<T: Read + Write>(
    session: &mut imap::Session<T>,
    account_id: &str,
) -> Result<Vec<MailFolder>, String> {
    let names = session
        .list(None, Some("*"))
        .map_err(|e| format!("IMAP LIST failed: {e}"))?;
    let now = now_ts();
    Ok(names
        .iter()
        .map(|name| {
            let raw_name = name.name().to_string();
            MailFolder {
                account_id: account_id.to_string(),
                display_name: decode_imap_modified_utf7(&raw_name),
                name: raw_name,
                delimiter: name.delimiter().map(ToOwned::to_owned),
                flags: name
                    .attributes()
                    .iter()
                    .map(|attr| format!("{attr:?}"))
                    .collect(),
                uid_validity: None,
                uid_next: None,
                total: None,
                unread: None,
                updated_at: now,
            }
        })
        .collect())
}

fn imap_sync_folder<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
) -> Result<(MailFolder, Vec<MailMessageCached>), String> {
    let mailbox = session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let unread = session
        .uid_search("UNSEEN")
        .ok()
        .map(|ids| ids.len() as u32);
    let account_id = &account.config.session_id;
    let mut folder_info = MailFolder {
        account_id: account_id.clone(),
        name: folder.to_string(),
        display_name: decode_imap_modified_utf7(folder),
        delimiter: None,
        flags: mailbox.flags.iter().map(|flag| flag.to_string()).collect(),
        uid_validity: mailbox.uid_validity,
        uid_next: mailbox.uid_next,
        total: Some(mailbox.exists),
        unread,
        updated_at: now_ts(),
    };

    let mut uids = session
        .uid_search("ALL")
        .map_err(|e| format!("IMAP UID SEARCH failed: {e}"))?
        .into_iter()
        .collect::<Vec<_>>();
    uids.sort_unstable();
    let max_fetch = account.config.sync.max_fetch_per_sync.max(1).min(2000) as usize;
    let start = uids.len().saturating_sub(max_fetch);
    let fetch_uids = &uids[start..];
    if fetch_uids.is_empty() {
        folder_info.updated_at = now_ts();
        return Ok((folder_info, Vec::new()));
    }

    let uid_set = uid_set_string(fetch_uids);
    let fetches = session
        .uid_fetch(
            &uid_set,
            "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])",
        )
        .map_err(|e| format!("IMAP UID FETCH headers failed: {e}"))?;
    let mut messages = Vec::new();
    for fetch in fetches.iter() {
        if let Some(message) = parse_fetch_header(account_id, folder, fetch) {
            messages.push(message);
        }
    }
    messages.sort_by(|a, b| {
        a.header
            .date_ts
            .cmp(&b.header.date_ts)
            .then(a.header.uid.cmp(&b.header.uid))
    });

    let body_limit = account.config.cache.body_recent_limit as usize;
    if account.config.cache.enabled && body_limit > 0 {
        let body_uids = fetch_uids
            .iter()
            .rev()
            .take(body_limit.min(fetch_uids.len()))
            .copied()
            .collect::<Vec<_>>();
        let mut body_uids = body_uids;
        body_uids.sort_unstable();
        let body_uid_set = uid_set_string(&body_uids);
        let raw_limit = account
            .config
            .cache
            .body_max_bytes
            .max(1024)
            .min(10 * 1024 * 1024) as usize;
        let body_query = format!("(UID RFC822.SIZE BODY.PEEK[]<0.{raw_limit}>)");
        let body_fetches = session
            .uid_fetch(&body_uid_set, &body_query)
            .map_err(|e| format!("IMAP UID FETCH bodies failed: {e}"))?;
        let mut bodies = HashMap::new();
        for fetch in body_fetches.iter() {
            if let Some(uid) = fetch.uid {
                if let Some(body) = fetch.body() {
                    bodies.insert(
                        uid,
                        parse_body_message(account_id, folder, uid, fetch.size, body, raw_limit),
                    );
                }
            }
        }
        for message in &mut messages {
            if let Some(body) = bodies.remove(&message.header.uid) {
                merge_body(message, body);
            }
        }
    }

    messages.sort_by(|a, b| {
        b.header
            .date_ts
            .cmp(&a.header.date_ts)
            .then(b.header.uid.cmp(&a.header.uid))
    });
    Ok((folder_info, messages))
}

fn imap_fetch_body<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
) -> Result<MailMessageCached, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let raw_limit = account
        .config
        .cache
        .body_max_bytes
        .max(1024)
        .min(10 * 1024 * 1024) as usize;
    let query = format!(
        "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER] BODY.PEEK[]<0.{raw_limit}>)"
    );
    let fetches = session
        .uid_fetch(uid.to_string(), query)
        .map_err(|e| format!("IMAP UID FETCH body failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found in {folder}"))?;
    let mut message = parse_fetch_header(&account.config.session_id, folder, fetch)
        .unwrap_or_else(|| empty_cached_message(&account.config.session_id, folder, uid));
    if let Some(body) = fetch.body() {
        let parsed = parse_body_message(
            &account.config.session_id,
            folder,
            uid,
            fetch.size,
            body,
            raw_limit,
        );
        merge_body(&mut message, parsed);
    }
    Ok(message)
}

fn imap_download_attachment<T: Read + Write>(
    session: &mut imap::Session<T>,
    _account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
    attachment_index: usize,
    target_path: &str,
) -> Result<MailDownloadAttachmentResult, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let fetches = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .map_err(|e| format!("IMAP UID FETCH attachment failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found in {folder}"))?;
    let body = fetch
        .body()
        .ok_or_else(|| format!("message UID {uid} did not include a body"))?;
    let attachment = extract_attachment(body, attachment_index)?;
    let path = std::path::PathBuf::from(target_path);
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create attachment folder: {e}"))?;
    }
    std::fs::write(&path, &attachment.bytes)
        .map_err(|e| format!("failed to write attachment: {e}"))?;
    Ok(MailDownloadAttachmentResult {
        path: path.to_string_lossy().to_string(),
        name: attachment.name,
        content_type: attachment.content_type,
        size: attachment.bytes.len(),
    })
}

fn parse_fetch_header(
    account_id: &str,
    folder: &str,
    fetch: &imap::types::Fetch,
) -> Option<MailMessageCached> {
    let uid = fetch.uid?;
    let header = fetch.header().unwrap_or_default();
    let parsed = MessageParser::default().parse(header);
    let flags = fetch.flags().iter().map(|flag| flag.to_string()).collect();
    let fallback_date = fetch.internal_date().map(|d| d.timestamp());
    let (message_id, subject, from, to, cc, date_ts) = match parsed {
        Some(message) => (
            message.message_id().map(clean_message_id),
            message.subject().unwrap_or("").to_string(),
            address_list(message.from()).into_iter().next(),
            address_list(message.to()),
            address_list(message.cc()),
            message.date().map(|d| d.to_timestamp()).or(fallback_date),
        ),
        None => (
            None,
            String::new(),
            None,
            Vec::new(),
            Vec::new(),
            fallback_date,
        ),
    };
    Some(MailMessageCached {
        header: MailMessageHeader {
            account_id: account_id.to_string(),
            folder: folder.to_string(),
            uid,
            message_id,
            subject,
            from,
            to,
            cc,
            date_ts,
            flags,
            has_attachments: false,
            attachment_count: 0,
            attachments: Vec::new(),
            snippet: None,
            raw_size: fetch.size,
            body_cached: false,
        },
        body_text: None,
        body_html: None,
        body_cached_at: None,
    })
}

fn parse_body_message(
    account_id: &str,
    folder: &str,
    uid: u32,
    raw_size: Option<u32>,
    body: &[u8],
    max_bytes: usize,
) -> MailMessageCached {
    match MessageParser::default().parse(body) {
        Some(message) => {
            let attachments = message
                .attachments()
                .map(|part| attachment_info(part))
                .collect::<Vec<_>>();
            let text = message
                .body_text(0)
                .map(|s| truncate_utf8_bytes(s.as_ref(), max_bytes));
            let html = message
                .body_html(0)
                .map(|s| truncate_utf8_bytes(s.as_ref(), max_bytes));
            MailMessageCached {
                header: MailMessageHeader {
                    account_id: account_id.to_string(),
                    folder: folder.to_string(),
                    uid,
                    message_id: message.message_id().map(clean_message_id),
                    subject: message.subject().unwrap_or("").to_string(),
                    from: address_list(message.from()).into_iter().next(),
                    to: address_list(message.to()),
                    cc: address_list(message.cc()),
                    date_ts: message.date().map(|d| d.to_timestamp()),
                    flags: Vec::new(),
                    has_attachments: !attachments.is_empty(),
                    attachment_count: attachments.len(),
                    attachments,
                    snippet: message
                        .body_preview(240)
                        .map(|s| normalize_preview(s.as_ref())),
                    raw_size,
                    body_cached: true,
                },
                body_text: text,
                body_html: html,
                body_cached_at: Some(now_ts()),
            }
        }
        None => {
            let text = truncate_utf8_bytes(&String::from_utf8_lossy(body), max_bytes);
            MailMessageCached {
                header: MailMessageHeader {
                    account_id: account_id.to_string(),
                    folder: folder.to_string(),
                    uid,
                    message_id: None,
                    subject: String::new(),
                    from: None,
                    to: Vec::new(),
                    cc: Vec::new(),
                    date_ts: None,
                    flags: Vec::new(),
                    has_attachments: false,
                    attachment_count: 0,
                    attachments: Vec::new(),
                    snippet: Some(normalize_preview(&text)),
                    raw_size,
                    body_cached: true,
                },
                body_text: Some(text),
                body_html: None,
                body_cached_at: Some(now_ts()),
            }
        }
    }
}

fn merge_body(target: &mut MailMessageCached, body: MailMessageCached) {
    if target.header.message_id.is_none() {
        target.header.message_id = body.header.message_id;
    }
    if target.header.subject.is_empty() {
        target.header.subject = body.header.subject;
    }
    if target.header.from.is_none() {
        target.header.from = body.header.from;
    }
    if target.header.to.is_empty() {
        target.header.to = body.header.to;
    }
    if target.header.cc.is_empty() {
        target.header.cc = body.header.cc;
    }
    if target.header.date_ts.is_none() {
        target.header.date_ts = body.header.date_ts;
    }
    target.header.has_attachments = body.header.has_attachments;
    target.header.attachment_count = body.header.attachment_count;
    target.header.attachments = body.header.attachments;
    target.header.snippet = body.header.snippet;
    target.header.raw_size = body.header.raw_size.or(target.header.raw_size);
    target.header.body_cached = true;
    target.body_text = body.body_text;
    target.body_html = body.body_html;
    target.body_cached_at = body.body_cached_at;
}

fn empty_cached_message(account_id: &str, folder: &str, uid: u32) -> MailMessageCached {
    MailMessageCached {
        header: MailMessageHeader {
            account_id: account_id.to_string(),
            folder: folder.to_string(),
            uid,
            message_id: None,
            subject: String::new(),
            from: None,
            to: Vec::new(),
            cc: Vec::new(),
            date_ts: None,
            flags: Vec::new(),
            has_attachments: false,
            attachment_count: 0,
            attachments: Vec::new(),
            snippet: None,
            raw_size: None,
            body_cached: false,
        },
        body_text: None,
        body_html: None,
        body_cached_at: None,
    }
}

fn send_smtp(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
) -> Result<MailSendResult, String> {
    let message = build_send_message(account, request)?;
    let mailer = build_smtp_transport(account)?;
    let response = mailer
        .send(&message)
        .map_err(|e| format!("SMTP send failed: {e}"))?;
    Ok(MailSendResult {
        accepted: true,
        response: format!("{response:?}"),
    })
}

fn test_smtp(account: &ResolvedMailAccount) -> Result<(), String> {
    let mailer = build_smtp_transport(account)?;
    let connected = mailer
        .test_connection()
        .map_err(|e| format!("SMTP test failed: {e}"))?;
    if connected {
        Ok(())
    } else {
        Err("SMTP test did not establish a connection".into())
    }
}

fn build_smtp_transport(account: &ResolvedMailAccount) -> Result<SmtpTransport, String> {
    let host = account.config.smtp.host.trim();
    let mut builder = SmtpTransport::builder_dangerous(host)
        .port(account.config.smtp.port)
        .timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
        .credentials(Credentials::new(
            account.smtp_username.clone(),
            account.smtp_password.clone(),
        ));
    builder = match account.config.smtp.security {
        MailConnectionSecurity::Tls => {
            let params = TlsParameters::new(host.to_string())
                .map_err(|e| format!("SMTP TLS parameters failed: {e}"))?;
            builder.tls(Tls::Wrapper(params))
        }
        MailConnectionSecurity::Starttls => {
            let params = TlsParameters::new(host.to_string())
                .map_err(|e| format!("SMTP STARTTLS parameters failed: {e}"))?;
            builder.tls(Tls::Required(params))
        }
        MailConnectionSecurity::None => builder.tls(Tls::None),
    };
    Ok(builder.build())
}

fn build_send_message(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
) -> Result<Message, String> {
    let from = Mailbox::new(
        account.config.display_name.clone().and_then(non_empty),
        account
            .config
            .email_address
            .parse()
            .map_err(|e| format!("invalid from address: {e}"))?,
    );
    let mut builder = Message::builder()
        .from(from)
        .subject(request.subject.trim());
    if let Some(reply_to) = account
        .config
        .reply_to
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        builder = builder.reply_to(parse_mailbox(reply_to)?);
    }
    for to in &request.to {
        builder = builder.to(parse_mailbox(to)?);
    }
    for cc in &request.cc {
        builder = builder.cc(parse_mailbox(cc)?);
    }
    for bcc in &request.bcc {
        builder = builder.bcc(parse_mailbox(bcc)?);
    }

    match (&request.text_body, &request.html_body) {
        (Some(text), Some(html)) => builder
            .multipart(MultiPart::alternative_plain_html(
                text.clone(),
                html.clone(),
            ))
            .map_err(|e| format!("failed to build email body: {e}")),
        (Some(text), None) => builder
            .singlepart(SinglePart::plain(text.clone()))
            .map_err(|e| format!("failed to build email body: {e}")),
        (None, Some(html)) => builder
            .singlepart(SinglePart::html(html.clone()))
            .map_err(|e| format!("failed to build email body: {e}")),
        (None, None) => Err("email body is required".into()),
    }
}

fn parse_mailbox(input: &str) -> Result<Mailbox, String> {
    input
        .trim()
        .parse()
        .map_err(|e| format!("invalid email address '{input}': {e}"))
}

fn validate_send_request(request: &MailSendRequest) -> Result<(), String> {
    if request.to.is_empty() && request.cc.is_empty() && request.bcc.is_empty() {
        return Err("at least one recipient is required".into());
    }
    if request.subject.trim().is_empty() {
        return Err("email subject is required".into());
    }
    if request
        .text_body
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
        && request
            .html_body
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Err("email body is required".into());
    }
    Ok(())
}

fn cache_sync_result(
    conn: &Connection,
    account_id: &str,
    folders: &[MailFolder],
    messages: &[MailMessageCached],
    folder: &str,
    cache: &MailCacheSettings,
) -> SqlResult<()> {
    for folder in folders {
        upsert_folder(conn, folder)?;
    }
    for message in messages {
        upsert_message(conn, message)?;
    }
    prune_mail_cache(conn, account_id, folder, cache)?;
    Ok(())
}

fn upsert_folder(conn: &Connection, folder: &MailFolder) -> SqlResult<()> {
    let flags_json = serde_json::to_string(&folder.flags).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO mail_folders
         (account_id, name, delimiter, flags_json, uid_validity, uid_next, total, unread, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(account_id, name) DO UPDATE SET
            delimiter = excluded.delimiter,
            flags_json = excluded.flags_json,
            uid_validity = COALESCE(excluded.uid_validity, mail_folders.uid_validity),
            uid_next = COALESCE(excluded.uid_next, mail_folders.uid_next),
            total = COALESCE(excluded.total, mail_folders.total),
            unread = COALESCE(excluded.unread, mail_folders.unread),
            updated_at = excluded.updated_at",
        params![
            folder.account_id,
            folder.name,
            folder.delimiter,
            flags_json,
            folder.uid_validity,
            folder.uid_next,
            folder.total,
            folder.unread,
            folder.updated_at,
        ],
    )?;
    Ok(())
}

fn upsert_message(conn: &Connection, message: &MailMessageCached) -> SqlResult<()> {
    let header = &message.header;
    let to_json = serde_json::to_string(&header.to).unwrap_or_else(|_| "[]".into());
    let cc_json = serde_json::to_string(&header.cc).unwrap_or_else(|_| "[]".into());
    let flags_json = serde_json::to_string(&header.flags).unwrap_or_else(|_| "[]".into());
    let attachments_json =
        serde_json::to_string(&header.attachments).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO mail_messages
         (account_id, folder, uid, message_id, subject, from_name, from_addr,
          to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
          attachments_json, snippet, body_text, body_html, body_cached_at, raw_size, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17, ?18, ?19, ?20)
         ON CONFLICT(account_id, folder, uid) DO UPDATE SET
            message_id = COALESCE(excluded.message_id, mail_messages.message_id),
            subject = CASE WHEN excluded.subject != '' THEN excluded.subject ELSE mail_messages.subject END,
            from_name = COALESCE(excluded.from_name, mail_messages.from_name),
            from_addr = COALESCE(excluded.from_addr, mail_messages.from_addr),
            to_json = CASE WHEN excluded.to_json != '[]' THEN excluded.to_json ELSE mail_messages.to_json END,
            cc_json = CASE WHEN excluded.cc_json != '[]' THEN excluded.cc_json ELSE mail_messages.cc_json END,
            date_ts = COALESCE(excluded.date_ts, mail_messages.date_ts),
            flags_json = CASE WHEN excluded.flags_json != '[]' THEN excluded.flags_json ELSE mail_messages.flags_json END,
            has_attachments = CASE
                WHEN excluded.attachments_json != '[]' OR excluded.has_attachments = 1
                THEN excluded.has_attachments
                ELSE mail_messages.has_attachments
            END,
            attachment_count = CASE
                WHEN excluded.attachments_json != '[]' OR excluded.attachment_count > 0
                THEN excluded.attachment_count
                ELSE mail_messages.attachment_count
            END,
            attachments_json = CASE WHEN excluded.attachments_json != '[]' THEN excluded.attachments_json ELSE mail_messages.attachments_json END,
            snippet = COALESCE(excluded.snippet, mail_messages.snippet),
            body_text = COALESCE(excluded.body_text, mail_messages.body_text),
            body_html = COALESCE(excluded.body_html, mail_messages.body_html),
            body_cached_at = COALESCE(excluded.body_cached_at, mail_messages.body_cached_at),
            raw_size = COALESCE(excluded.raw_size, mail_messages.raw_size),
            updated_at = excluded.updated_at",
        params![
            header.account_id,
            header.folder,
            header.uid,
            header.message_id,
            header.subject,
            header.from.as_ref().and_then(|a| a.name.clone()),
            header.from.as_ref().and_then(|a| a.address.clone()),
            to_json,
            cc_json,
            header.date_ts,
            flags_json,
            header.has_attachments as i64,
            header.attachment_count as i64,
            attachments_json,
            header.snippet,
            message.body_text,
            message.body_html,
            message.body_cached_at,
            header.raw_size,
            now_ts(),
        ],
    )?;
    Ok(())
}

fn prune_mail_cache(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    cache: &MailCacheSettings,
) -> SqlResult<()> {
    if cache.header_retention_days > 0 {
        let cutoff = now_ts() - (cache.header_retention_days as i64 * 86_400);
        conn.execute(
            "DELETE FROM mail_messages
             WHERE account_id = ?1 AND folder = ?2 AND date_ts IS NOT NULL AND date_ts < ?3",
            params![account_id, folder, cutoff],
        )?;
    }
    if cache.header_limit_per_folder > 0 {
        conn.execute(
            "DELETE FROM mail_messages
             WHERE rowid IN (
                SELECT rowid FROM mail_messages
                WHERE account_id = ?1 AND folder = ?2
                ORDER BY uid DESC
                LIMIT -1 OFFSET ?3
             )",
            params![account_id, folder, cache.header_limit_per_folder],
        )?;
    }
    if cache.body_recent_limit == 0 {
        conn.execute(
            "UPDATE mail_messages
             SET body_text = NULL, body_html = NULL, body_cached_at = NULL
             WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
        )?;
    } else {
        conn.execute(
            "UPDATE mail_messages
             SET body_text = NULL, body_html = NULL, body_cached_at = NULL
             WHERE account_id = ?1 AND folder = ?2
               AND rowid NOT IN (
                 SELECT rowid FROM mail_messages
                 WHERE account_id = ?1 AND folder = ?2 AND body_cached_at IS NOT NULL
                 ORDER BY COALESCE(date_ts, 0) DESC, uid DESC
                 LIMIT ?3
               )",
            params![account_id, folder, cache.body_recent_limit],
        )?;
    }
    Ok(())
}

fn list_cached_folders(conn: &Connection, account_id: &str) -> SqlResult<Vec<MailFolder>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, name, delimiter, flags_json, uid_validity, uid_next,
                total, unread, updated_at
         FROM mail_folders
         WHERE account_id = ?1
         ORDER BY CASE WHEN name = 'INBOX' THEN 0 ELSE 1 END, name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let flags_json: String = row.get(3)?;
        let name: String = row.get(1)?;
        Ok(MailFolder {
            account_id: row.get(0)?,
            display_name: decode_imap_modified_utf7(&name),
            name,
            delimiter: row.get(2)?,
            flags: serde_json::from_str(&flags_json).unwrap_or_default(),
            uid_validity: row.get(4)?,
            uid_next: row.get(5)?,
            total: row.get(6)?,
            unread: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;
    rows.collect()
}

fn list_cached_messages(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    limit: u32,
    offset: u32,
) -> SqlResult<Vec<MailMessageHeader>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2
         ORDER BY COALESCE(date_ts, 0) DESC, uid DESC
         LIMIT ?3 OFFSET ?4",
    )?;
    let rows = stmt.query_map(params![account_id, folder, limit, offset], row_to_header)?;
    rows.collect()
}

fn get_cached_body(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> SqlResult<Option<MailMessageBody>> {
    conn.query_row(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, body_text, body_html
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3
           AND body_cached_at IS NOT NULL
           AND (body_text IS NOT NULL OR body_html IS NOT NULL)",
        params![account_id, folder, uid],
        |row| {
            let mut header = row_to_header(row)?;
            let body_text: Option<String> = row.get(17)?;
            let body_html: Option<String> = row.get(18)?;
            header.body_cached = true;
            Ok(MailMessageBody {
                account_id: header.account_id,
                folder: header.folder,
                uid: header.uid,
                message_id: header.message_id,
                subject: header.subject,
                text: body_text,
                html: body_html,
                snippet: header.snippet,
                attachments: header.attachments,
                raw_size: header.raw_size,
                cached_at: row.get(16)?,
                source: "cache".into(),
            })
        },
    )
    .optional()
}

fn row_to_header(row: &rusqlite::Row<'_>) -> SqlResult<MailMessageHeader> {
    let to_json: String = row.get(7)?;
    let cc_json: String = row.get(8)?;
    let flags_json: String = row.get(10)?;
    let attachments_json: String = row.get(13)?;
    let from_name: Option<String> = row.get(5)?;
    let from_addr: Option<String> = row.get(6)?;
    let from = if from_name.is_some() || from_addr.is_some() {
        Some(MailAddress {
            name: from_name,
            address: from_addr,
        })
    } else {
        None
    };
    let body_cached_at: Option<i64> = row.get(16)?;
    Ok(MailMessageHeader {
        account_id: row.get(0)?,
        folder: row.get(1)?,
        uid: row.get::<_, i64>(2)? as u32,
        message_id: row.get(3)?,
        subject: row.get(4)?,
        from,
        to: serde_json::from_str(&to_json).unwrap_or_default(),
        cc: serde_json::from_str(&cc_json).unwrap_or_default(),
        date_ts: row.get(9)?,
        flags: serde_json::from_str(&flags_json).unwrap_or_default(),
        has_attachments: row.get::<_, i64>(11)? != 0,
        attachment_count: row.get::<_, i64>(12)? as usize,
        attachments: serde_json::from_str(&attachments_json).unwrap_or_default(),
        snippet: row.get(14)?,
        raw_size: row.get(15)?,
        body_cached: body_cached_at.is_some(),
    })
}

fn cached_to_body(message: MailMessageCached, source: &str) -> MailMessageBody {
    MailMessageBody {
        account_id: message.header.account_id,
        folder: message.header.folder,
        uid: message.header.uid,
        message_id: message.header.message_id,
        subject: message.header.subject,
        text: message.body_text,
        html: message.body_html,
        snippet: message.header.snippet,
        attachments: message.header.attachments,
        raw_size: message.header.raw_size,
        cached_at: message.body_cached_at,
        source: source.into(),
    }
}

fn merge_selected_folder(folders: &mut Vec<MailFolder>, selected: MailFolder) {
    if let Some(existing) = folders.iter_mut().find(|f| f.name == selected.name) {
        *existing = selected;
    } else {
        folders.push(selected);
    }
}

fn address_list(addr: Option<&ParsedAddress<'_>>) -> Vec<MailAddress> {
    addr.map(|addr| {
        addr.iter()
            .map(|item| MailAddress {
                name: item.name.as_ref().map(|v| v.to_string()),
                address: item.address.as_ref().map(|v| v.to_string()),
            })
            .collect()
    })
    .unwrap_or_default()
}

fn attachment_info(part: &mail_parser::MessagePart<'_>) -> MailAttachmentInfo {
    let size = match &part.body {
        PartType::Text(s) | PartType::Html(s) => Some(s.len()),
        PartType::Binary(b) | PartType::InlineBinary(b) => Some(b.len()),
        PartType::Message(message) => Some(message.raw_message.len()),
        PartType::Multipart(_) => None,
    };
    let content_type = part.content_type().map(|ct| match ct.c_subtype.as_ref() {
        Some(subtype) => format!("{}/{}", ct.c_type, subtype),
        None => ct.c_type.to_string(),
    });
    MailAttachmentInfo {
        name: part.attachment_name().map(ToOwned::to_owned),
        content_type,
        size,
    }
}

fn extract_attachment(body: &[u8], attachment_index: usize) -> Result<DownloadedMailAttachment, String> {
    let message = MessageParser::default()
        .parse(body)
        .ok_or_else(|| "failed to parse message attachments".to_string())?;
    let mut attachments = message.attachments();
    let part = attachments
        .nth(attachment_index)
        .ok_or_else(|| format!("attachment #{} not found", attachment_index + 1))?;
    let info = attachment_info(part);
    let bytes = match &part.body {
        PartType::Text(s) | PartType::Html(s) => s.as_ref().as_bytes().to_vec(),
        PartType::Binary(b) | PartType::InlineBinary(b) => b.as_ref().to_vec(),
        PartType::Message(message) => message.raw_message.to_vec(),
        PartType::Multipart(_) => {
            return Err("selected attachment is a multipart container".into());
        }
    };
    Ok(DownloadedMailAttachment {
        name: info.name,
        content_type: info.content_type,
        bytes,
    })
}

fn decode_imap_modified_utf7(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let rest = &input[index..];
        if !rest.starts_with('&') {
            let ch = rest.chars().next().unwrap_or_default();
            out.push(ch);
            index += ch.len_utf8();
            continue;
        }

        let after_amp = index + 1;
        let Some(relative_end) = input[after_amp..].find('-') else {
            out.push_str(rest);
            break;
        };
        let end = after_amp + relative_end;
        let encoded = &input[after_amp..end];
        if encoded.is_empty() {
            out.push('&');
            index = end + 1;
            continue;
        }

        match decode_imap_modified_utf7_segment(encoded) {
            Some(decoded) => out.push_str(&decoded),
            None => out.push_str(&input[index..=end]),
        }
        index = end + 1;
    }
    out
}

fn decode_imap_modified_utf7_segment(encoded: &str) -> Option<String> {
    let mut b64 = encoded.replace(',', "/");
    while b64.len() % 4 != 0 {
        b64.push('=');
    }
    let bytes = BASE64_STANDARD.decode(b64.as_bytes()).ok()?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&units).ok()
}

fn uid_set_string(uids: &[u32]) -> String {
    uids.iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn clean_message_id(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_string()
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
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

fn default_header_retention_days() -> u32 {
    30
}

fn default_header_limit_per_folder() -> u32 {
    2000
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_message() -> Vec<u8> {
        b"From: Example Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nDate: Tue, 30 Jun 2026 08:00:00 +0800\r\nMessage-ID: <sample@example.com>\r\nSubject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from Taomni Mail.\r\n"
            .to_vec()
    }

    fn sample_attachment_message() -> Vec<u8> {
        b"From: Example Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nSubject: Attachment sample\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody text.\r\n--b\r\nContent-Type: text/plain; name=\"report.txt\"\r\nContent-Disposition: attachment; filename=\"report.txt\"\r\n\r\nAttachment content.\r\n--b--\r\n"
            .to_vec()
    }

    #[test]
    fn decode_imap_modified_utf7_mailbox_names() {
        assert_eq!(decode_imap_modified_utf7("INBOX"), "INBOX");
        assert_eq!(decode_imap_modified_utf7("A &- B"), "A & B");
        assert_eq!(
            decode_imap_modified_utf7("~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
            "~peter/mail/台北/日本語"
        );
    }

    #[test]
    fn parse_body_decodes_headers_and_preview() {
        let parsed = parse_body_message("acct", "INBOX", 7, Some(512), &sample_message(), 4096);
        assert_eq!(parsed.header.subject, "测试邮件");
        assert_eq!(
            parsed.header.message_id.as_deref(),
            Some("sample@example.com")
        );
        assert_eq!(
            parsed
                .header
                .from
                .as_ref()
                .and_then(|a| a.address.as_deref()),
            Some("sender@example.com")
        );
        assert_eq!(
            parsed.header.snippet.as_deref(),
            Some("Hello from Taomni Mail.")
        );
        assert!(parsed.body_text.as_deref().unwrap().contains("Taomni Mail"));
    }

    #[test]
    fn parse_and_extract_attachment() {
        let raw = sample_attachment_message();
        let parsed = parse_body_message("acct", "INBOX", 8, Some(raw.len() as u32), &raw, 4096);
        assert!(parsed.header.has_attachments);
        assert_eq!(parsed.header.attachment_count, 1);
        assert_eq!(parsed.header.attachments[0].name.as_deref(), Some("report.txt"));

        let attachment = extract_attachment(&raw, 0).unwrap();
        assert_eq!(attachment.name.as_deref(), Some("report.txt"));
        assert_eq!(attachment.content_type.as_deref(), Some("text/plain"));
        assert_eq!(attachment.bytes, b"Attachment content.");
    }

    #[test]
    fn cache_roundtrips_folders_messages_and_body() {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        let mut message =
            parse_body_message("acct", "INBOX", 10, Some(512), &sample_message(), 4096);
        message.header.flags = vec!["\\Seen".into()];
        let folder = MailFolder {
            account_id: "acct".into(),
            name: "INBOX".into(),
            display_name: "INBOX".into(),
            delimiter: Some("/".into()),
            flags: vec![],
            uid_validity: Some(1),
            uid_next: Some(11),
            total: Some(1),
            unread: Some(0),
            updated_at: now_ts(),
        };
        cache_sync_result(
            &conn,
            "acct",
            &[folder],
            &[message],
            "INBOX",
            &MailCacheSettings::default(),
        )
        .unwrap();

        let folders = list_cached_folders(&conn, "acct").unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].uid_next, Some(11));

        let messages = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].subject, "测试邮件");
        assert!(messages[0].body_cached);

        let body = get_cached_body(&conn, "acct", "INBOX", 10)
            .unwrap()
            .unwrap();
        assert_eq!(body.source, "cache");
        assert!(body.text.unwrap().contains("Taomni Mail"));
    }
}
