//! SQLite mailbox schema, indexing and retention shared by desktop and module hosts.

mod contacts;
mod flags;
mod folder_tree;
mod header;
mod mapping;
mod prefetch;
mod pruning;
mod reading;
mod schema;
mod settings;
mod synchronization;
mod upsert;
mod watermarks;

use rusqlite::{Connection, Result as SqlResult};

pub use contacts::{
    MailContactSuggestion, clean_contact_name, contact_email, escape_like, mailbox_to_contact,
    reindex_cached_contacts, search_contacts, upsert_contact, upsert_sent_contacts,
};
pub use flags::{flags_include_seen, mark_cached_messages_read, update_cached_flags};
pub use folder_tree::{
    apply_folder_change, refresh_subscription_flags, sync_folder_tree,
    update_folder_cache_in_transaction,
};
pub use header::{cached_header, row_to_header};
pub use mapping::cached_to_body;
pub use prefetch::{cache_body_if_current, cache_body_if_current_in_transaction, pending_bodies};
pub use pruning::{prune_mail_cache, purge_cached_folder, remove_cached_messages};
pub use reading::{get_cached_body, list_cached_folders, list_cached_messages, unread_cached_uids};
pub use schema::{MAIL_SCHEMA_VERSION, init_cache_tables, migrate_mail_tables};
pub use settings::MailCacheSettings;
pub use synchronization::{
    cache_sync_result, cache_sync_result_in_transaction, cache_synced_messages,
    reset_folder_if_uid_validity_changed,
};
pub use upsert::{upsert_folder, upsert_folder_status, upsert_message, upsert_message_at};
pub use watermarks::{
    apply_folder_round, apply_folder_round_in_transaction, apply_folder_step,
    apply_folder_step_in_transaction, load_folder_sync_state, now_ms, record_folder_error,
};

pub fn init_mail_tables(conn: &Connection) -> SqlResult<()> {
    init_cache_tables(conn)?;
    crate::storage::init_tables(conn)?;
    crate::pop3::local_store::migrate_local_tables(conn)?;
    crate::filters::migrate_filter_tables(conn)?;
    schema::migrate_contact_tables(conn)?;
    schema::migrate_calendar_tables(conn)
}

#[cfg(test)]
mod tests;
