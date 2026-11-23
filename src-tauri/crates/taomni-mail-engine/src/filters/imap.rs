use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
};

pub use taomni_mail_api::imap_exchange::{BodyHits, FilterBodyQuery};

use crate::{imap_folders::quote_imap_string, imap_transport::ImapSession};

impl ImapSession {
    pub fn filter_body_hits(&mut self, query: &FilterBodyQuery) -> Result<BodyHits, String> {
        match self {
            Self::Plain(session) => {
                imap_body_hits(session, &query.folder, &query.uids, &query.needles)
            }
            Self::Tls(session) => {
                imap_body_hits(session, &query.folder, &query.uids, &query.needles)
            }
        }
    }
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

pub fn imap_body_hits<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    needles: &[String],
) -> Result<BodyHits, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let mut hits: HashMap<u32, HashSet<String>> = HashMap::new();
    for needle in needles {
        for chunk in uids.chunks(500) {
            let charset = if needle.is_ascii() {
                ""
            } else {
                "CHARSET UTF-8 "
            };
            let criteria = format!(
                "{charset}UID {} BODY {}",
                uid_set(chunk),
                quote_imap_string(needle)
            );
            let found = session
                .uid_search(&criteria)
                .map_err(|e| format!("IMAP UID SEARCH BODY failed: {e}"))?;
            for uid in found {
                hits.entry(uid).or_default().insert(needle.clone());
            }
        }
    }
    Ok(hits)
}
