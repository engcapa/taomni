//! Account-scoped address book data, vCard conversion and recipient suggestions.

mod entries;
mod model;
mod storage;
mod suggestions;

pub use entries::{
    delete_entry, entries, export_cards, import_cards, list_entries_page, save_entry,
};
pub use model::{CardChange, ContactWriteError, MailAddressBookEntry, StoredCard};
pub use storage::{apply_changes, load_cards, store_card};
pub use suggestions::search_recipient_suggestions;

#[cfg(test)]
mod tests;
