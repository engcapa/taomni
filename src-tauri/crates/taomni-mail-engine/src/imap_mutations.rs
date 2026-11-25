//! Bounded IMAP requests to update flags and delete selected messages.

use std::io::{Read, Write};

use crate::imap_messages::uid_set_string;

pub use taomni_mail_api::imap_mutation::UID_BATCH_SIZE;

pub fn unread_uids<T: Read + Write>(
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

pub fn imap_mark_read<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
) -> Result<usize, String> {
    if uids.is_empty() {
        return Ok(0);
    }
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    for batch in uids.chunks(UID_BATCH_SIZE) {
        session
            .uid_store(uid_set_string(batch), "+FLAGS.SILENT (\\Seen)")
            .map_err(|e| format!("IMAP UID STORE \\Seen failed: {e}"))?;
    }
    Ok(uids.len())
}

pub fn imap_set_flags<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> Result<usize, String> {
    if uids.is_empty() || (add.is_empty() && remove.is_empty()) {
        return Ok(0);
    }
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    for batch in uids.chunks(UID_BATCH_SIZE) {
        let uid_set = uid_set_string(batch);
        if !add.is_empty() {
            let query = format!("+FLAGS.SILENT ({})", add.join(" "));
            session
                .uid_store(&uid_set, &query)
                .map_err(|e| format!("IMAP UID STORE +FLAGS failed: {e}"))?;
        }
        if !remove.is_empty() {
            let query = format!("-FLAGS.SILENT ({})", remove.join(" "));
            session
                .uid_store(&uid_set, &query)
                .map_err(|e| format!("IMAP UID STORE -FLAGS failed: {e}"))?;
        }
    }
    Ok(uids.len())
}

pub fn imap_delete_messages<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    all: bool,
) -> Result<usize, String> {
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    let uid_list: Vec<u32> = if all {
        session
            .uid_search("ALL")
            .map_err(|e| format!("IMAP UID SEARCH failed: {e}"))?
            .into_iter()
            .collect()
    } else {
        uids.to_vec()
    };
    if uid_list.is_empty() {
        return Ok(0);
    }
    let caps = session
        .capabilities()
        .map_err(|e| format!("IMAP CAPABILITY failed: {e}"))?;
    if !caps.has_str("UIDPLUS") {
        return Err("Server cannot safely delete only these messages (UIDPLUS unavailable)".into());
    }
    for batch in uid_list.chunks(50) {
        let uid_set = uid_set_string(batch);
        session
            .uid_store(&uid_set, "+FLAGS.SILENT (\\Deleted)")
            .map_err(|e| format!("IMAP UID STORE failed: {e}"))?;
        session
            .uid_expunge(&uid_set)
            .map_err(|e| format!("IMAP UID EXPUNGE failed: {e}"))?;
    }
    Ok(uid_list.len())
}
