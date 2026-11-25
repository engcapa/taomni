//! Search stored message rows and build criteria from a user query.

use crate::{MailMessageHeader, cache::row_to_header, imap_folders::quote_imap_string};
use rusqlite::{Connection, Result as SqlResult, ToSql, params_from_iter};

pub use taomni_mail_api::search::{ImapSearchRequest, MailSearchField, MailSearchQuery};

fn fts_column(field: MailSearchField) -> Option<&'static str> {
    match field {
        MailSearchField::All => None,
        MailSearchField::Subject => Some("subject"),
        MailSearchField::Sender => Some("sender"),
        MailSearchField::Recipients => Some("recipients"),
        MailSearchField::Body => Some("body"),
    }
}

fn like_columns(field: MailSearchField) -> &'static [&'static str] {
    match field {
        MailSearchField::All => &[
            "m.subject",
            "m.from_name",
            "m.from_addr",
            "m.to_json",
            "m.cc_json",
            "m.snippet",
            "m.body_text",
        ],
        MailSearchField::Subject => &["m.subject"],
        MailSearchField::Sender => &["m.from_name", "m.from_addr"],
        MailSearchField::Recipients => &["m.to_json", "m.cc_json"],
        MailSearchField::Body => &["m.snippet", "m.body_text"],
    }
}

/// Split into terms, honouring "double quoted phrases".
fn search_terms(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in text.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                if !quoted && !current.trim().is_empty() {
                    terms.push(current.trim().to_string());
                    current.clear();
                }
            }
            ch if ch.is_whitespace() && !quoted => {
                if !current.trim().is_empty() {
                    terms.push(current.trim().to_string());
                }
                current.clear();
            }
            ch => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        terms.push(current.trim().to_string());
    }
    terms
}

fn fts_phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub fn search_cached_messages(
    conn: &Connection,
    account_id: &str,
    query: &MailSearchQuery,
) -> SqlResult<Vec<MailMessageHeader>> {
    let mut sql = String::from(
        "SELECT m.account_id, m.folder, m.uid, m.message_id, m.subject, m.from_name, m.from_addr,
                m.to_json, m.cc_json, m.date_ts, m.flags_json, m.has_attachments, m.attachment_count,
                m.attachments_json, m.snippet, m.raw_size, m.body_cached_at, m.in_reply_to,
                m.references_json, m.list_unsubscribe_json, m.receipt_to
         FROM mail_messages m
         WHERE m.account_id = ?",
    );
    let mut values: Vec<Box<dyn ToSql>> = vec![Box::new(account_id.to_string())];
    if let Some(folder) = query.folder.as_ref().filter(|folder| !folder.is_empty()) {
        sql.push_str(" AND m.folder = ?");
        values.push(Box::new(folder.clone()));
    }
    let terms = search_terms(&query.text);
    let (long, short): (Vec<&String>, Vec<&String>) =
        terms.iter().partition(|term| term.chars().count() >= 3);
    if !long.is_empty() {
        let expr = long
            .iter()
            .map(|term| match fts_column(query.field) {
                Some(column) => format!("{column} : {}", fts_phrase(term)),
                None => fts_phrase(term),
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        sql.push_str(
            " AND m.rowid IN (SELECT rowid FROM mail_messages_fts WHERE mail_messages_fts MATCH ?)",
        );
        values.push(Box::new(expr));
    }
    for term in short {
        let columns = like_columns(query.field);
        let clause = columns
            .iter()
            .map(|column| format!("{column} LIKE ? ESCAPE '\\'"))
            .collect::<Vec<_>>()
            .join(" OR ");
        sql.push_str(&format!(" AND ({clause})"));
        for _ in columns {
            values.push(Box::new(like_pattern(term)));
        }
    }
    if query.unread_only {
        sql.push_str(" AND m.flags_json NOT LIKE '%\\\\Seen%'");
    }
    if query.flagged_only {
        sql.push_str(" AND m.flags_json LIKE '%\\\\Flagged%'");
    }
    if query.with_attachments {
        sql.push_str(" AND m.has_attachments = 1");
    }
    if let Some(keyword) = query.keyword.as_ref().filter(|k| !k.is_empty()) {
        sql.push_str(" AND m.flags_json LIKE ?");
        values.push(Box::new(format!("%\"{}\"%", keyword.replace('"', ""))));
    }
    sql.push_str(" ORDER BY COALESCE(m.date_ts, 0) DESC, m.uid DESC LIMIT ?");
    values.push(Box::new(query.limit.unwrap_or(500).clamp(1, 5000)));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        params_from_iter(values.iter().map(|v| v.as_ref())),
        row_to_header,
    )?;
    rows.collect()
}

/// IMAP SEARCH criteria for the text query (every term must match).
pub fn imap_search_criteria(query: &MailSearchQuery) -> (bool, String) {
    let key = match query.field {
        MailSearchField::All => "TEXT",
        MailSearchField::Subject => "SUBJECT",
        MailSearchField::Sender => "FROM",
        MailSearchField::Recipients => "TO",
        MailSearchField::Body => "BODY",
    };
    let terms = search_terms(&query.text);
    let mut parts: Vec<String> = terms
        .iter()
        .map(|term| format!("{key} {}", quote_imap_string(term)))
        .collect();
    if query.unread_only {
        parts.push("UNSEEN".into());
    }
    if query.flagged_only {
        parts.push("FLAGGED".into());
    }
    if let Some(keyword) = query.keyword.as_ref().filter(|k| !k.is_empty()) {
        parts.push(format!(
            "KEYWORD {}",
            keyword.replace([' ', '"', '(', ')'], "")
        ));
    }
    if parts.is_empty() {
        parts.push("ALL".into());
    }
    let utf8 = !query.text.is_ascii();
    let criteria = parts.join(" ");
    (
        utf8,
        if utf8 {
            format!("CHARSET UTF-8 {criteria}")
        } else {
            criteria
        },
    )
}

#[cfg(test)]
mod tests;
