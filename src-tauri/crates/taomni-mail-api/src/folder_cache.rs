//! Apply the result of an IMAP folder operation to its authorized cache.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::message::MailFolder;

pub const UPDATE_IMAP_FOLDER_CACHE: &str = "mail/update-imap-folder-cache";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderCacheUpdate {
    pub account_id: String,
    pub database: PathBuf,
    pub action: FolderCacheAction,
    pub folders: Vec<MailFolder>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum FolderCacheAction {
    List,
    Subscription,
    Change { previous: Option<String> },
}
