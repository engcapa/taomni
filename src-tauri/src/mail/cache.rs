mod synchronization;

mod upsert;

mod contacts;

mod pruning;

mod reading;

mod flags;

mod mapping;

pub(super) use synchronization::{
    cache_sync_result, cache_synced_messages, reset_folder_if_uid_validity_changed,
};

pub(super) use upsert::{upsert_folder, upsert_message, upsert_message_at};

pub(super) use contacts::{
    clean_contact_name, contact_email, escape_like, mailbox_to_contact, reindex_cached_contacts,
    search_contacts, upsert_contact, upsert_sent_contacts,
};

pub(super) use pruning::{prune_mail_cache, purge_cached_folder, remove_cached_messages};

pub(super) use reading::{
    cached_header, get_cached_body, list_cached_folders, list_cached_messages, unread_cached_uids,
};

pub(super) use flags::{flags_include_seen, mark_cached_messages_read, update_cached_flags};

pub(super) use mapping::{cached_to_body, row_to_header};
