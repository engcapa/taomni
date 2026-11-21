use super::MailCacheSettings;
use super::contacts::contact_email;
use super::contacts::reindex_cached_contacts;
use super::contacts::upsert_contact;
use super::pruning::prune_mail_cache;
use super::upsert::upsert_folder;
use super::upsert::upsert_folder_status;
use super::upsert::upsert_message;
use super::upsert::upsert_message_at;
use super::watermarks::reset_folder_cache;
use crate::MailFolder;
use crate::MailMessageCached;
use crate::now_ts;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;
use std::collections::HashSet;

pub fn cache_sync_result(
    conn: &Connection,
    account_id: &str,
    folders: &[MailFolder],
    messages: &[MailMessageCached],
    folder: &str,
    cache: &MailCacheSettings,
    listed: bool,
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    for entry in folders
        .iter()
        .filter(|entry| listed || entry.name == folder)
    {
        reset_folder_if_uid_validity_changed(&tx, entry)?;
        if listed {
            upsert_folder(&tx, entry)?;
        } else {
            upsert_folder_status(&tx, entry)?;
        }
    }
    for message in messages {
        upsert_message(&tx, message)?;
    }
    prune_mail_cache(&tx, account_id, folder, cache)?;
    reindex_cached_contacts(&tx, account_id)?;
    tx.commit()
}

pub fn reset_folder_if_uid_validity_changed(
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
            reset_folder_cache(conn, &folder.account_id, &folder.name)?;
        }
    }
    Ok(())
}

/// Sync plans normally contain only missing UIDs. Index their contacts once,
/// instead of rebuilding all accounts' cached addresses after every page.
/// Replayed/replaced rows request a rebuild so counts stay idempotent.
pub fn cache_synced_messages(
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
