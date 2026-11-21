//! SQLite substring search and IMAP server search over mailbox headers.

use std::io::{Read, Write};

use rusqlite::{Connection, Result as SqlResult, ToSql, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::{
    MailMessageHeader,
    cache::{MailCacheSettings, row_to_header},
    imap_folders::quote_imap_string,
    imap_messages::Mailbox,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MailSearchField {
    #[default]
    All,
    Subject,
    Sender,
    Recipients,
    Body,
}

impl MailSearchField {
    fn fts_column(self) -> Option<&'static str> {
        match self {
            Self::All => None,
            Self::Subject => Some("subject"),
            Self::Sender => Some("sender"),
            Self::Recipients => Some("recipients"),
            Self::Body => Some("body"),
        }
    }

    fn like_columns(self) -> &'static [&'static str] {
        match self {
            Self::All => &[
                "m.subject",
                "m.from_name",
                "m.from_addr",
                "m.to_json",
                "m.cc_json",
                "m.snippet",
                "m.body_text",
            ],
            Self::Subject => &["m.subject"],
            Self::Sender => &["m.from_name", "m.from_addr"],
            Self::Recipients => &["m.to_json", "m.cc_json"],
            Self::Body => &["m.snippet", "m.body_text"],
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSearchQuery {
    #[serde(default)]
    pub text: String,
    /// `None` searches every cached folder of the account.
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub field: MailSearchField,
    #[serde(default)]
    pub unread_only: bool,
    #[serde(default)]
    pub flagged_only: bool,
    #[serde(default)]
    pub with_attachments: bool,
    /// Only messages carrying this IMAP keyword (tag).
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
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
            .map(|term| match query.field.fts_column() {
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
        let columns = query.field.like_columns();
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapSearchRequest {
    pub account_id: String,
    pub folder: String,
    pub query: MailSearchQuery,
}

/// IMAP SEARCH criteria for the text query (every term must match).
fn imap_search_criteria(query: &MailSearchQuery) -> (bool, String) {
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

#[cfg(test)]
mod tests;
