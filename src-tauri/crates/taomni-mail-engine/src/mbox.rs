pub use taomni_mail_storage::mbox::*;

#[cfg(feature = "imap-runtime")]
use std::io::{Read, Write};

/// `From - Tue Sep 30 03:38:00 2026` (asctime, UTC).
#[cfg(feature = "imap-runtime")]
const EXPORT_CHUNK: usize = 50;

#[cfg(feature = "imap-runtime")]
pub fn imap_export_folder<T: Read + Write, W: Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    out: &mut W,
) -> Result<usize, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let mut uids: Vec<u32> = session
        .uid_search("ALL")
        .map_err(|e| format!("IMAP UID SEARCH failed: {e}"))?
        .into_iter()
        .collect();
    uids.sort_unstable();
    let mut count = 0usize;
    for chunk in uids.chunks(EXPORT_CHUNK) {
        let set = chunk
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let fetches = session
            .uid_fetch(&set, "(UID INTERNALDATE BODY.PEEK[])")
            .map_err(|e| format!("IMAP FETCH failed: {e}"))?;
        let mut ordered: Vec<_> = fetches.iter().filter(|f| f.body().is_some()).collect();
        ordered.sort_by_key(|f| f.uid.unwrap_or(0));
        for fetch in ordered {
            let body = fetch.body().unwrap_or_default();
            let ts = fetch.internal_date().map(|d| d.timestamp());
            out.write_all(mbox_separator(ts).as_bytes())
                .and_then(|_| out.write_all(&mboxrd_escape(body)))
                .and_then(|_| {
                    if body.ends_with(b"\n") {
                        out.write_all(b"\n")
                    } else {
                        out.write_all(b"\n\n")
                    }
                })
                .map_err(|e| format!("writing mbox failed: {e}"))?;
            count += 1;
        }
    }
    Ok(count)
}
