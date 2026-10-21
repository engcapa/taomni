use super::storage::load_cards;
use crate::mail::MailContactSuggestion;
use rusqlite::Connection;
use rusqlite::Result as SqlResult;
use std::collections::HashSet;

/// Address book matches for the composer's autocomplete, best first.
pub(in crate::mail) fn address_book_suggestions(
    conn: &Connection,
    account_id: &str,
    query: &str,
    limit: u32,
) -> SqlResult<Vec<MailContactSuggestion>> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for stored in load_cards(conn, account_id)? {
        if stored.deleted {
            continue;
        }
        let name = stored.card.display_name.to_lowercase();
        for email in &stored.card.emails {
            let lower = email.to_lowercase();
            let name_hit = name.contains(&needle);
            if !name_hit && !lower.contains(&needle) {
                continue;
            }
            let score = 600
                + if lower.starts_with(&needle) { 260 } else { 0 }
                + if name.starts_with(&needle)
                    || name.split_whitespace().any(|w| w.starts_with(&needle))
                {
                    180
                } else {
                    0
                };
            out.push(MailContactSuggestion {
                name: Some(stored.card.display_name.clone())
                    .filter(|n| !n.is_empty() && n != email),
                email: email.clone(),
                source: "addressBook".into(),
                score,
                last_seen_at: None,
            });
        }
    }
    out.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.email.cmp(&b.email)));
    out.truncate(limit as usize);
    Ok(out)
}

/// Address book entries first (with their names), then collected contacts.
pub(in crate::mail) fn merge_suggestions(
    book: Vec<MailContactSuggestion>,
    collected: Vec<MailContactSuggestion>,
    limit: u32,
) -> Vec<MailContactSuggestion> {
    let mut seen = HashSet::new();
    book.into_iter()
        .chain(collected)
        .filter(|s| seen.insert(s.email.to_lowercase()))
        .take(limit as usize)
        .collect()
}
