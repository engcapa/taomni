//! Native Notepad workbench backend services (Save As, Rename, Trash, Backup,
//! Hashes, Encodings, Macros integrity, Session JSON, Elevated Save, Folder Drop).
mod backup;
mod crypto_enc;
mod elevated;
mod file_ops;
mod macros;
mod session;

#[cfg(test)]
mod tests;

pub(crate) use backup::{backup_list, backup_prune, backup_read, backup_write, save_backup_copy};
pub(crate) use crypto_enc::{check_encoding_loss, compute_hash, list_encodings};
pub(crate) use elevated::write_text_elevated;
pub(crate) use file_ops::{
    list_dir_text_files, open_terminal_dir, rename_file, save_as, set_readonly_attr, trash_file,
};
pub(crate) use macros::{macros_accept, macros_load, macros_save, macros_validate};
pub(crate) use session::{session_load, session_save};

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotepadSaveAsResult {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotepadRenameResult {
    pub old_path: String,
    pub new_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotepadBackupEntry {
    pub id: String,
    pub doc_id: String,
    pub path: Option<String>,
    pub name: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: String,
    pub saved_hash: String,
    pub updated_at: u64,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotepadBackupContent {
    pub entry: NotepadBackupEntry,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotepadEncodingGroup {
    pub group: String,
    pub encodings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotepadEncodingLossReport {
    pub encoding: String,
    pub unrepresentable_count: usize,
    pub samples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotepadHashResult {
    pub algorithm: String,
    pub hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotepadMacroLoadResult {
    pub json: String,
    pub expected_hash: String,
    pub actual_hash: String,
    pub tampered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotepadDirFilesResult {
    pub files: Vec<String>,
    pub total_candidates: usize,
    pub skipped_binary: usize,
    pub truncated: bool,
}

pub(crate) fn notepad_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("notepad")
}
