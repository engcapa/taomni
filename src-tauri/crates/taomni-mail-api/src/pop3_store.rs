//! Account-scoped commands for the local mailbox of a POP3 account.

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;

use crate::{
    IncomingTest,
    archive_index::{ArchiveEntry, ArchiveKey, ArchiveSelection},
    search::MailSearchQuery,
};

pub const LOCAL_MAILBOX: &str = "mail/local-pop3-mailbox";
pub const SYNC_OWNED_MAILBOX: &str = "mail/sync-owned-pop3-mailbox";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnedPop3Round {
    pub account_id: String,
    pub connection: IncomingTest,
    pub reply: Endpoint,
    pub leave_days: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum LocalMailboxAction {
    Initialize,
    Folders,
    Messages {
        folder: String,
        limit: u32,
        offset: u32,
    },
    Body {
        folder: String,
        uid: u32,
    },
    Raw {
        folder: String,
        uid: u32,
    },
    Header {
        folder: String,
        uid: u32,
    },
    Search(MailSearchQuery),
    SearchContacts {
        query: String,
        limit: u32,
    },
    ReindexContacts,
    FilterCandidates {
        folder: String,
        incoming: bool,
        uids: Option<Vec<u32>>,
    },
    AdvanceFilterMark {
        folder: String,
        uid: u32,
    },
    SearchIndex {
        bodies: bool,
    },
    MarkRead {
        folder: String,
        uids: Option<Vec<u32>>,
    },
    SetFlags {
        folder: String,
        uids: Vec<u32>,
        add: Vec<String>,
        remove: Vec<String>,
    },
    MoveOrCopy {
        folder: String,
        uids: Vec<u32>,
        target: String,
        copy: bool,
    },
    Delete {
        folder: String,
        uids: Option<Vec<u32>>,
    },
    CreateFolder {
        name: String,
    },
    RenameFolder {
        from: String,
        to: String,
    },
    DeleteFolder {
        name: String,
    },
    Append {
        folder: String,
        originals: Vec<Vec<u8>>,
        sent_recipients: Vec<String>,
    },
    Originals {
        folder: String,
    },
    Archive(LocalArchiveAction),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum LocalArchiveAction {
    Paused,
    Pause,
    Begin {
        resume: bool,
    },
    Pending,
    Store {
        key: ArchiveKey,
    },
    Preview {
        selection: ArchiveSelection,
    },
    Cleanup {
        token: String,
    },
    Remove {
        entries: Vec<ArchiveEntry>,
    },
    Read {
        entry: ArchiveEntry,
    },
    Export {
        entry: ArchiveEntry,
        attachment_index: Option<usize>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchIndexRow {
    pub reference: String,
    pub subject: String,
    pub text: String,
    pub timestamp: i64,
}
