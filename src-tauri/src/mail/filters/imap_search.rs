use crate::mail::ActiveImapSession;
use std::collections::HashMap;
use std::collections::HashSet;
use taomni_mail_engine::filters::{
    MailFilter, MailFilterField, MailFilterOp, imap::imap_body_hits,
};

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
