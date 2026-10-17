//! Bounded, idempotent read-flag operations. Run only on a blocking worker.
use super::*;
use crate::state::MailDbHandle;

// Even sparse ten-digit UIDs stay below a 4 KiB command-line limit.
pub(super) const UID_BATCH_SIZE: usize = 250;

pub(super) fn unread_uids<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
) -> Result<Vec<u32>, String> {
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    session
        .uid_search("UNSEEN")
        .map(|uids| uids.into_iter().collect())
        .map_err(|e| format!("IMAP UID SEARCH UNSEEN failed: {e}"))
}

pub(super) fn mark_read_cached(
    pool: &MailImapPool,
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
    db: &MailDbHandle,
    folder: &str,
    uids: Vec<u32>,
    all: bool,
) -> Result<MailMarkReadResult, String> {
    let account_id = &account.config.session_id;
    // Capture existing cached rows before the network operation: later arrivals
    // must not be swept into the local update when a folder operation finishes.
    let cached_unread = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        init_mail_tables(&conn).map_err(|e| e.to_string())?;
        if all {
            unread_cached_uids(&conn, account_id, folder).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        }
    };
    let mut targets = if all {
        with_imap_session(pool, account, runtime, ImapSessionOpts::default(), |imap| {
            imap.unread_uids(folder)
        })?
    } else {
        uids
    };
    targets.retain(|uid| *uid > 0);
    targets.sort_unstable();
    targets.dedup();

    let mut marked = 0;
    for batch in targets.chunks(UID_BATCH_SIZE) {
        // Release the account gate and cache mutex between batches, and retry
        // only this idempotent STORE if the server loses a response.
        with_imap_session(pool, account, runtime, ImapSessionOpts::default(), |imap| {
            imap.mark_read(folder, batch)
        })
        .map_err(|e| {
            format!(
                "Marked {marked}/{} messages as read; {e}. Retry to finish the remaining messages.",
                targets.len()
            )
        })?;
        let conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        mark_cached_messages_read(&tx, account_id, folder, batch).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        marked += batch.len();
    }

    let unread = if all {
        // This also corrects stale local flags for messages another client had
        // already read, and keeps the remote count when history is incomplete.
        let remaining =
            with_imap_session(pool, account, runtime, ImapSessionOpts::default(), |imap| {
                imap.unread_uids(folder)
            })?;
        let remaining_set: HashSet<u32> = remaining.iter().copied().collect();
        let reconciled: Vec<u32> = cached_unread
            .into_iter()
            .filter(|uid| !remaining_set.contains(uid))
            .collect();
        let conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        mark_cached_messages_read(&tx, account_id, folder, &reconciled)
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE mail_folders SET unread = ?3 WHERE account_id = ?1 AND name = ?2",
            params![account_id, folder, remaining.len() as i64],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Some(remaining.len())
    } else {
        None
    };
    Ok(MailMarkReadResult {
        folder: folder.into(),
        marked,
        unread,
    })
}
