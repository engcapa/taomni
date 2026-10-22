use super::message_model::MailFolder;
use super::message_model::MailMessageHeader;
use crate::mail::mutations;
use serde::Serialize;
use std::collections::HashMap;

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
