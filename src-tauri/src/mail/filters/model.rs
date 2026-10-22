use crate::mail::MailMessageHeader;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MailFilterField {
    From,
    To,
    Cc,
    ToOrCc,
    Subject,
    Body,
    /// Message size in KB.
    SizeKb,
    /// Days since the Date header.
    AgeDays,
    /// IMAP keyword (tag) present.
    Tag,
    HasAttachment,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MailFilterOp {
    Contains,
    NotContains,
    Is,
    IsNot,
    BeginsWith,
    EndsWith,
    Matches,
    GreaterThan,
    LessThan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailFilterCondition {
    pub field: MailFilterField,
    pub op: MailFilterOp,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MailFilterActionKind {
    MoveTo,
    CopyTo,
    MarkRead,
    MarkUnread,
    Star,
    AddTag,
    Delete,
    Forward,
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailFilterAction {
    pub kind: MailFilterActionKind,
    /// Folder (move/copy), keyword (tag) or address (forward).
    #[serde(default)]
    pub value: Option<String>,
}

pub(super) fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailFilter {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Any condition matches (instead of all).
    #[serde(default)]
    pub match_any: bool,
    pub conditions: Vec<MailFilterCondition>,
    pub actions: Vec<MailFilterAction>,
    /// Run on new INBOX mail (manual runs always apply).
    #[serde(default = "default_true")]
    pub on_incoming: bool,
}

/// A message as the evaluator sees it. `body` is the cached text body; when
/// it is `None` body conditions ask `server_body` (server-side SEARCH).
pub(in crate::mail) struct FilterMessage<'a> {
    pub header: &'a MailMessageHeader,
    pub body: Option<&'a str>,
    pub server_body: Option<&'a HashSet<String>>,
    pub now: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFilterRunResult {
    pub folder: String,
    pub examined: usize,
    pub matched: usize,
    /// Messages moved away (moved or deleted).
    pub moved: usize,
    /// Failed actions; the affected messages stay where they are (AC-42).
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct FilterFile {
    pub(super) format: String,
    pub(super) version: u32,
    pub(super) filters: Vec<MailFilter>,
}

pub(super) const FILTER_FILE_FORMAT: &str = "taomni-mail-filters";
