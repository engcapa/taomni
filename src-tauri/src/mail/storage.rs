//! Desktop integration for mail storage and cache relocation.

mod relocation;

#[cfg(test)]
mod tests;

pub(super) use relocation::relocate;
pub use relocation::{configured_directory, save_mail_session};

pub use taomni_mail_engine::storage::{
    ArchiveEntry, FullMessage, FullMessageMode, OpenMessage, PreparedMessage, account_root,
    as_sql_error, collect_garbage, init_tables, list, lookup, open, open_entry, prepare,
    remove_entries, snapshot_objects, snapshot_objects_with, store,
};

#[cfg(test)]
pub fn read(
    db: &rusqlite::Connection,
    account: &str,
    folder: &str,
    uid: u32,
) -> Result<Option<Vec<u8>>, String> {
    open(db, account, folder, uid)?
        .map(OpenMessage::read)
        .transpose()
}

pub fn stores_full(settings: &super::MailCacheSettings, folder: &str) -> bool {
    // Keep old exact server keys working, and accept the full readable path
    // entered before the account has ever connected or cached its folders.
    let readable_folder = super::decode_imap_modified_utf7(folder);
    let selected = settings.full_message_folders.iter().any(|name| {
        let name = name.trim();
        name == folder
            || name == readable_folder
            || (name.eq_ignore_ascii_case("INBOX") && folder.eq_ignore_ascii_case("INBOX"))
    });
    match settings.full_message_mode {
        FullMessageMode::All => true,
        FullMessageMode::Include => selected,
        FullMessageMode::Exclude => !selected,
    }
}
