//! Core-to-host Mail RPC contracts. A connection token grants access to one
//! destination selected by the core, and the TLS name remains the real server.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;
use zeroize::Zeroizing;

pub mod archive;
pub mod archive_index;
pub mod attachment_cache;
pub mod imap_exchange;
pub mod imap_mutation;
pub mod imap_sync;
pub mod message;
pub mod pop3_exchange;
pub mod search;

pub const SLUG: &str = "mail";
pub const LOCAL_DRAFTS: &str = "mail/local-drafts";
pub const ADDRESS_BOOK: &str = "mail/address-book";
pub const CALDAV_AGENDA: &str = "mail/caldav-agenda";
pub const FILTER_IMAP_BODIES: &str = "mail/filter-imap-bodies";
pub const FILTER_RULES: &str = "mail/filter-rules";
pub const ATTACHMENT_CACHE: &str = "mail/attachment-cache";
pub const CHECK_INCOMING: &str = "mail/check-incoming";
pub const CHECK_OUTGOING: &str = "mail/check-outgoing";
pub const IMAP_FOLDER_TREE: &str = "mail/imap-folder-tree";
pub const MUTATE_IMAP_FOLDER: &str = "mail/mutate-imap-folder";
pub const SYNC_IMAP_HEADERS: &str = "mail/sync-imap-headers";
pub const SYNC_IMAP_BODIES: &str = "mail/sync-imap-bodies";
pub const SYNC_IMAP_PAGE: &str = "mail/sync-imap-page";
pub const SYNC_IMAP_ROUND: &str = "mail/sync-imap-round";
pub const SEARCH_IMAP: &str = "mail/search-imap";
pub const SET_IMAP_FLAGS: &str = "mail/set-imap-flags";
pub const LIST_IMAP_UNREAD: &str = "mail/list-imap-unread";
pub const OPEN_IMAP_IDLE: &str = "mail/open-imap-idle";
pub const FETCH_IMAP_RAW: &str = "mail/fetch-imap-raw";
pub const FETCH_IMAP_BODY: &str = "mail/fetch-imap-body";
pub const PREFETCH_IMAP_BODIES: &str = "mail/prefetch-imap-bodies";
pub const DECODE_ARCHIVE_ORIGINAL: &str = "mail/decode-archive-original";
pub const DECODE_ARCHIVE_ATTACHMENT: &str = "mail/decode-archive-attachment";
pub const ENCODE_ARCHIVE_ORIGINAL: &str = "mail/encode-archive-original";
pub const OPEN_IMAP_ARCHIVE: &str = "mail/open-imap-archive";
pub const OPEN_IMAP_MUTATIONS: &str = "mail/open-imap-mutations";
pub const OPEN_IMAP_IMPORT: &str = "mail/open-imap-import";
pub const EXPORT_IMAP_MBOX: &str = "mail/export-imap-mbox";
pub const OPEN_POP3_SYNC: &str = "mail/open-pop3-sync";
pub const FETCH_IMAP_ATTACHMENT: &str = "mail/fetch-imap-attachment";
pub const SEND_RESPONSE: &str = "mail/send-response";
pub const SEND_SMTP: &str = "mail/send-smtp";
pub const STORE_IMAP_SENT: &str = "mail/store-imap-sent";
pub const STORE_IMAP_DRAFT: &str = "mail/store-imap-draft";
pub const DISCARD_IMAP_DRAFT: &str = "mail/discard-imap-draft";
pub const HOST_REQUEST_TIMEOUT: Duration = Duration::from_secs(70);
pub const SMTP_DELIVERY_UNKNOWN: &str = "SMTP delivery status unknown";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MailboxRequest<A> {
    pub account_id: String,
    pub action: A,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapFlagUpdate {
    pub folder: String,
    pub uids: Vec<u32>,
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailConnectionSecurity {
    #[default]
    #[serde(rename = "tls", alias = "TLS", alias = "Tls")]
    Tls,
    #[serde(rename = "starttls", alias = "STARTTLS", alias = "StartTls")]
    Starttls,
    #[serde(rename = "none", alias = "None", alias = "NONE")]
    None,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailProvider {
    #[default]
    #[serde(rename = "custom", alias = "Custom")]
    Custom,
    #[serde(rename = "gmail", alias = "Gmail")]
    Gmail,
    #[serde(rename = "outlook", alias = "Outlook", alias = "outlook.com")]
    Outlook,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailAuthMode {
    #[default]
    #[serde(rename = "password", alias = "Password")]
    Password,
    #[serde(rename = "oauth2", alias = "OAuth2", alias = "oauth")]
    OAuth2,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailIncomingProtocol {
    #[default]
    Imap,
    Pop3,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IncomingTest {
    pub route: Endpoint,
    pub server_name: String,
    pub security: MailConnectionSecurity,
    pub trusted_certificate: Option<String>,
    pub protocol: MailIncomingProtocol,
    pub provider: MailProvider,
    pub authentication: MailAuthMode,
    pub username: String,
    pub secret: Zeroizing<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmtpConnection {
    pub route: Endpoint,
    pub server_name: String,
    pub security: MailConnectionSecurity,
    pub trusted_certificate: Option<String>,
    pub authentication: MailAuthMode,
    pub username: String,
    pub secret: Zeroizing<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmtpDelivery {
    pub connection: SmtpConnection,
    pub sender: Option<String>,
    pub recipients: Vec<String>,
    pub mime_source: Endpoint,
    pub mime_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteDraftLocation {
    pub folder: String,
    pub uid: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmtpResponse {
    pub connection: SmtpConnection,
    pub content: MimeUpload,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapSentCopy {
    pub connection: IncomingTest,
    pub account_id: String,
    pub folder_override: Option<String>,
    pub mime: Option<MimeUpload>,
    pub remote_draft: Option<RemoteDraftLocation>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MimeUpload {
    pub source: Endpoint,
    pub length: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapDraftStore {
    pub connection: IncomingTest,
    pub account_id: String,
    pub folder_override: Option<String>,
    pub message_id: String,
    pub mime: MimeUpload,
    pub previous: Option<RemoteDraftLocation>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapDraftDiscard {
    pub connection: IncomingTest,
    pub location: RemoteDraftLocation,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapFolderTree {
    pub connection: IncomingTest,
    pub account_id: String,
    pub subscription: Option<FolderSubscription>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderSubscription {
    pub folder: String,
    pub subscribed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ImapFolderChange {
    Create { name: String },
    Rename { from: String, to: String },
    Delete { name: String },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapFolderMutation {
    pub account_id: String,
    pub change: ImapFolderChange,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mailbox_request_preserves_the_installed_host_wire_shape() {
        let stored = serde_json::json!({
            "accountId": "account",
            "action": {"operation": "list"}
        });
        let request: MailboxRequest<serde_json::Value> =
            serde_json::from_value(stored.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), stored);
    }

    #[test]
    fn preserved_session_values_load_after_moving_the_connection_types() {
        assert_eq!(
            serde_json::from_str::<MailProvider>(r#""outlook.com""#).unwrap(),
            MailProvider::Outlook
        );
        assert_eq!(
            serde_json::from_str::<MailAuthMode>(r#""OAuth2""#).unwrap(),
            MailAuthMode::OAuth2
        );
        assert_eq!(
            serde_json::from_str::<MailConnectionSecurity>(r#""STARTTLS""#).unwrap(),
            MailConnectionSecurity::Starttls
        );
        assert_eq!(
            serde_json::to_string(&MailIncomingProtocol::Pop3).unwrap(),
            r#""pop3""#
        );
    }
}
