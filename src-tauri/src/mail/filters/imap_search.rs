use super::model::MailFilter;
use super::model::MailFilterField;
use super::model::MailFilterOp;
use crate::mail::ActiveImapSession;
use crate::mail::sync::quote_imap_string;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Read;
use std::io::Write;

/// Body needles used by `contains` / `does not contain` conditions.
pub(super) fn body_needles(filters: &[&MailFilter]) -> Vec<String> {
    let mut needles: Vec<String> = filters
        .iter()
        .flat_map(|filter| filter.conditions.iter())
        .filter(|c| {
            c.field == MailFilterField::Body
                && matches!(c.op, MailFilterOp::Contains | MailFilterOp::NotContains)
        })
        .map(|c| c.value.to_lowercase())
        .filter(|value| !value.trim().is_empty())
        .collect();
    needles.sort();
    needles.dedup();
    needles
}

pub(super) fn uid_set(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

pub(super) fn imap_body_hits<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    needles: &[String],
) -> Result<HashMap<u32, HashSet<String>>, String> {
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

impl ActiveImapSession {
    pub(super) fn filter_body_hits(
        &mut self,
        folder: &str,
        uids: &[u32],
        needles: &[String],
    ) -> Result<HashMap<u32, HashSet<String>>, String> {
        match self {
            Self::Tls { session, .. } => imap_body_hits(session, folder, uids, needles),
            Self::Plain { session, .. } => imap_body_hits(session, folder, uids, needles),
        }
    }
}
