use super::message_model::MailFolder;
use crate::mail::folders;
use crate::mail::imap_messages::merge_selected_folder;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Whether header sync should issue a remote IMAP LIST.
/// Refresh requests always list; otherwise list only when the local folder
/// cache is empty so the UI still gets a usable folder set.
pub(super) fn should_list_remote_folders(
    refresh_folders: bool,
    cached_folder_count: usize,
) -> bool {
    refresh_folders || cached_folder_count == 0
}

/// Build the folder list returned by header sync: remote LIST (or cache) plus
/// the just-synced selected folder metadata.
pub(super) fn folders_for_header_sync(
    base_folders: Vec<MailFolder>,
    selected: MailFolder,
) -> Vec<MailFolder> {
    let mut folders = base_folders;
    merge_selected_folder(&mut folders, selected);
    folders
}

pub(super) fn non_empty_str(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() { None } else { Some(value) }
}

pub(super) fn normalize_preview(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
