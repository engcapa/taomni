use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FullMessageMode {
    #[default]
    All,
    Include,
    Exclude,
}

#[derive(Debug, Clone)]
pub struct FullMessage {
    pub hash: String,
    pub raw_size: u64,
    pub stored_size: u64,
}

pub struct PreparedMessage {
    pub(super) temp: tempfile::NamedTempFile,
    pub(super) hash: String,
    pub(super) raw_size: u64,
    pub(super) has_attachments: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub folder: String,
    pub uid: u32,
    pub uid_validity: u32,
    pub subject: String,
    pub raw_size: u64,
    pub stored_size: u64,
    pub stored_at: i64,
}
