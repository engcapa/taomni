//! Account-scoped address book data, vCard conversion and recipient suggestions.

mod entries;
pub mod handoff;
pub mod mailbox;
mod model;
mod storage;
mod suggestions;

pub use entries::{
    delete_entry, entries, export_cards, import_cards, list_entries_page, save_entry,
};
pub use model::{CardChange, ContactWriteError, MailAddressBookEntry, StoredCard};
pub use storage::{apply_changes, load_cards, store_card};
pub use suggestions::{address_book_suggestions, merge_suggestions, search_recipient_suggestions};

#[cfg(test)]
mod handoff_tests;
#[cfg(test)]
mod tests;
