//! Desktop adapters for shared mailbox cache operations.
pub(super) use taomni_mail_storage::cache::{
    cache_sync_result, cache_synced_messages, cached_header, cached_to_body, clean_contact_name,
    contact_email, escape_like, flags_include_seen, get_cached_body, list_cached_folders,
    list_cached_messages, mark_cached_messages_read, prune_mail_cache, purge_cached_folder,
    reindex_cached_contacts, remove_cached_messages, reset_folder_if_uid_validity_changed,
    search_contacts, unread_cached_uids, update_cached_flags, upsert_contact, upsert_folder,
    upsert_message, upsert_message_at,
};
