use super::contacts::contact_email;
use super::contacts::reindex_cached_contacts;
use super::contacts::upsert_contact;
use super::pruning::prune_mail_cache;
use super::upsert::upsert_folder;
use super::upsert::upsert_message;
use super::upsert::upsert_message_at;
use crate::mail::account_model::MailCacheSettings;
use crate::mail::cache;
use crate::mail::folders;
use crate::mail::message_model::MailFolder;
use crate::mail::message_model::MailMessageCached;
use crate::mail::sync;
use crate::mail::utilities::now_ts;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;
use std::collections::HashSet;

pub(in crate::mail) fn cache_sync_result(
    conn: &Connection,
    account_id: &str,
    folders: &[MailFolder],
    messages: &[MailMessageCached],
    folder: &str,
    cache: &MailCacheSettings,
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    for folder in folders {
        reset_folder_if_uid_validity_changed(&tx, folder)?;
        upsert_folder(&tx, folder)?;
    }
    for message in messages {
        upsert_message(&tx, message)?;
    }
    prune_mail_cache(&tx, account_id, folder, cache)?;
    reindex_cached_contacts(&tx, account_id)?;
    tx.commit()
}

pub(in crate::mail) fn reset_folder_if_uid_validity_changed(
    conn: &Connection,
    folder: &MailFolder,
) -> SqlResult<()> {
    let Some(next_uid_validity) = folder.uid_validity else {
        return Ok(());
    };
    let current: Option<Option<i64>> = conn
        .query_row(
            "SELECT uid_validity FROM mail_folders WHERE account_id = ?1 AND name = ?2",
            params![folder.account_id, folder.name],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(Some(current_uid_validity)) = current {
        if current_uid_validity as u32 != next_uid_validity {
            sync::reset_folder_cache(conn, &folder.account_id, &folder.name)?;
        }
    }
    Ok(())
}

/// Sync plans normally contain only missing UIDs. Index their contacts once,
/// instead of rebuilding all accounts' cached addresses after every page.
/// Replayed/replaced rows request a rebuild so counts stay idempotent.
pub(in crate::mail) fn cache_synced_messages(
    conn: &Connection,
    messages: &[MailMessageCached],
    started_ms: i64,
) -> SqlResult<bool> {
    let mut replaced = false;
    let mut exists = conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3)",
    )?;
    for message in messages {
        let header = &message.header;
        let known: bool = exists.query_row(
            params![header.account_id, header.folder, header.uid],
            |row| row.get(0),
        )?;
        upsert_message_at(conn, message, Some(started_ms))?;
        if known {
            replaced = true;
        } else {
            let mut seen = HashSet::new();
            for address in header.from.iter().chain(&header.to).chain(&header.cc) {
                let Some(email) = contact_email(address) else {
                    continue;
                };
                if seen.insert(email) {
                    upsert_contact(
                        conn,
                        &header.account_id,
                        address,
                        header.date_ts.unwrap_or_else(now_ts),
                        1,
                        0,
                        1,
                    )?;
                }
            }
        }
    }
    Ok(replaced)
}
