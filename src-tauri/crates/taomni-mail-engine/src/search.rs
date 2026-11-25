#[cfg(feature = "imap-runtime")]
use crate::{MailMessageHeader, cache::MailCacheSettings, imap_messages::Mailbox};
#[cfg(feature = "imap-runtime")]
use std::io::{Read, Write};
pub use taomni_mail_storage::search::*;

#[cfg(feature = "imap-runtime")]
pub fn search_imap_messages<T: Read + Write>(
    session: &mut imap::Session<T>,
    request: &ImapSearchRequest,
) -> Result<Vec<MailMessageHeader>, String> {
    let folder = &request.folder;
    let query = &request.query;
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let (_, criteria) = imap_search_criteria(query);
    let mut uids: Vec<u32> = session
        .uid_search(&criteria)
        .map_err(|e| format!("IMAP UID SEARCH failed: {e}"))?
        .into_iter()
        .collect();
    uids.sort_unstable();
    let limit = query.limit.unwrap_or(200).clamp(1, 1000) as usize;
    let newest: Vec<u32> = uids[uids.len().saturating_sub(limit)..].to_vec();
    let mut mailbox = Mailbox {
        account_id: &request.account_id,
        name: folder,
        cache: &MailCacheSettings::default(),
        save_original: |_, _: &[u8]| Err("A search cannot store message originals".into()),
    };
    let mut messages: Vec<_> = mailbox
        .fetch_messages(session, &newest, false)?
        .into_iter()
        .map(|message| message.header)
        .collect();
    if query.with_attachments {
        // Header-only fetches cannot see attachments; keep what is known.
        messages.retain(|message| message.has_attachments || message.attachment_count == 0);
    }
    messages.sort_by(|a, b| b.date_ts.cmp(&a.date_ts).then(b.uid.cmp(&a.uid)));
    Ok(messages)
}
