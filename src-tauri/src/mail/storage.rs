//! Desktop integration for mail storage and cache relocation.

mod fresh_imap;
mod relocation;

#[cfg(test)]
mod tests;

pub(super) use relocation::relocate;
pub use relocation::{configured_directory, save_mail_session};

pub use taomni_mail_storage::storage::{
    ArchiveEntry, FullMessage, FullMessageMode, OpenMessage, PreparedMessage, account_root,
    as_sql_error, collect_garbage, init_tables, list, lookup, open, open_entry, remove_entries,
    snapshot_objects, snapshot_objects_with,
};
#[cfg(any(test, feature = "legacy-mail-imap", feature = "legacy-mail-pop3"))]
pub use taomni_mail_storage::storage::{prepare, store};

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

#[cfg(test)]
pub(super) use taomni_mail_storage::archive::scanner::stores_full;
