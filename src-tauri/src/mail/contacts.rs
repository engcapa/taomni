//! Address book and CardDAV (TASK-19, DEC-13: in-tree vCard + WebDAV).
//!
//! Cards live per mail account in `mail_cards` (`book` = `local` or
//! `carddav`). CardDAV sync pushes local edits first (`If-Match` /
//! `If-None-Match`, server wins on conflict), then pulls: PROPFIND Depth 1
//! for ETags and `addressbook-multiget` (GET fallback) for changed cards.
//! Discovery follows `/.well-known/carddav`, `current-user-principal` and
//! `addressbook-home-set` (RFC 6352 / RFC 6764). The composer's address
//! autocomplete merges address book entries with collected contacts.

mod model;

mod dav_protocol;

mod dav_sync;

mod commands;

#[cfg(test)]
mod tests;

pub use model::{MailCardDavSettings, MailCardDavSyncResult};

pub use commands::{
    mail_carddav_sync, mail_delete_address_book_entry, mail_export_vcards, mail_import_vcards,
    mail_list_address_book, mail_save_address_book_entry,
};

pub(crate) use commands::{
    __cmd__mail_carddav_sync, __cmd__mail_delete_address_book_entry, __cmd__mail_export_vcards,
    __cmd__mail_import_vcards, __cmd__mail_list_address_book, __cmd__mail_save_address_book_entry,
    __tauri_command_name_mail_carddav_sync, __tauri_command_name_mail_delete_address_book_entry,
    __tauri_command_name_mail_export_vcards, __tauri_command_name_mail_import_vcards,
    __tauri_command_name_mail_list_address_book, __tauri_command_name_mail_save_address_book_entry,
};
