//! Mail search (TASK-08): a local SQLite FTS5 index over the cached headers
//! and bodies, plus IMAP `UID SEARCH` on the server for mail whose body is
//! not cached.
//!
//! The index uses the `trigram` tokenizer so substring search also works for
//! CJK text (no word segmentation needed). Terms shorter than three
//! characters cannot use a trigram index and fall back to `LIKE`.

use std::io::{Read, Write};
use std::sync::Arc;

use rusqlite::{Connection, Result as SqlResult, ToSql, params_from_iter};
use serde::Deserialize;
use tauri::State;

use super::sync::quote_imap_string;
use super::{
    ActiveImapSession, ImapSessionOpts, MailAccountConfig, MailMessageHeader, ResolvedMailAccount,
    imap_fetch_messages_for_uids, resolve_config, row_to_header, with_imap_session, with_mail_db,
};
use crate::state::AppState;

/// Content columns of the index. Kept in one place for the triggers.
const FTS_SELECT: &str = "COALESCE(subject, ''),
    COALESCE(from_name, '') || ' ' || COALESCE(from_addr, ''),
    COALESCE(to_json, '') || ' ' || COALESCE(cc_json, ''),
    COALESCE(snippet, '') || ' ' || COALESCE(body_text, '')";

/// Create the FTS table, its sync triggers and index existing rows.
pub(super) fn migrate_search_index(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS mail_messages_fts USING fts5(
            subject, sender, recipients, body,
            tokenize = 'trigram case_sensitive 0'
         );
         CREATE TRIGGER IF NOT EXISTS mail_messages_fts_ai AFTER INSERT ON mail_messages BEGIN
            INSERT INTO mail_messages_fts(rowid, subject, sender, recipients, body)
            SELECT new.rowid, {new_cols};
         END;
         CREATE TRIGGER IF NOT EXISTS mail_messages_fts_ad AFTER DELETE ON mail_messages BEGIN
            DELETE FROM mail_messages_fts WHERE rowid = old.rowid;
         END;
         CREATE TRIGGER IF NOT EXISTS mail_messages_fts_au AFTER UPDATE OF
            subject, from_name, from_addr, to_json, cc_json, snippet, body_text ON mail_messages BEGIN
            DELETE FROM mail_messages_fts WHERE rowid = old.rowid;
            INSERT INTO mail_messages_fts(rowid, subject, sender, recipients, body)
            SELECT new.rowid, {new_cols};
         END;
         DELETE FROM mail_messages_fts;
         INSERT INTO mail_messages_fts(rowid, subject, sender, recipients, body)
            SELECT rowid, {FTS_SELECT} FROM mail_messages;",
        new_cols = FTS_SELECT
            .replace("subject", "new.subject")
            .replace("from_name", "new.from_name")
            .replace("from_addr", "new.from_addr")
            .replace("to_json", "new.to_json")
            .replace("cc_json", "new.cc_json")
            .replace("snippet", "new.snippet")
            .replace("body_text", "new.body_text"),
    ))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
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

#[derive(Debug, Clone, Default, Deserialize)]
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
pub(super) fn search_terms(text: &str) -> Vec<String> {
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

pub(super) fn search_cached_messages(
    conn: &Connection,
    account_id: &str,
    query: &MailSearchQuery,
) -> SqlResult<Vec<MailMessageHeader>> {
    let mut sql = String::from(
        "SELECT m.account_id, m.folder, m.uid, m.message_id, m.subject, m.from_name, m.from_addr,
                m.to_json, m.cc_json, m.date_ts, m.flags_json, m.has_attachments, m.attachment_count,
                m.attachments_json, m.snippet, m.raw_size, m.body_cached_at, m.in_reply_to,
                m.references_json, m.list_unsubscribe_json
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

/// Search the local index (headers of every cached message, bodies that are
/// cached). Returns newest first.
#[tauri::command]
pub async fn mail_search_messages(
    account_id: String,
    query: MailSearchQuery,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessageHeader>, String> {
    with_mail_db(&state, &account_id, |db| {
        search_cached_messages(db, &account_id, &query)
    })
}

/// IMAP SEARCH criteria for the text query (every term must match).
pub(super) fn imap_search_criteria(query: &MailSearchQuery) -> (bool, String) {
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

fn imap_search_server<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    query: &MailSearchQuery,
) -> Result<Vec<MailMessageHeader>, String> {
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
    let mut messages: Vec<MailMessageHeader> =
        imap_fetch_messages_for_uids(session, account, folder, &newest, false)?
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

impl ActiveImapSession {
    fn search_server(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        query: &MailSearchQuery,
    ) -> Result<Vec<MailMessageHeader>, String> {
        match self {
            Self::Tls { session, .. } => imap_search_server(session, account, folder, query),
            Self::Plain { session, .. } => imap_search_server(session, account, folder, query),
        }
    }
}

/// Search one folder on the server (finds mail whose body is not cached).
/// Results are not written to the cache (the cached span stays contiguous).
#[tauri::command]
pub async fn mail_search_server(
    config: MailAccountConfig,
    folder: String,
    query: MailSearchQuery,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessageHeader>, String> {
    if super::pop3::is_pop3(&config) {
        // Local mailbox: the "server" is the local store.
        let local = MailSearchQuery {
            folder: Some(folder.clone()),
            ..query.clone()
        };
        return with_mail_db(&state, &config.session_id, |db| {
            search_cached_messages(db, &config.session_id, &local)
        });
    }
    let account = resolve_config(&state, config)?;
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| imap.search_server(&account, &folder, &query),
        )
    })
    .await
    .map_err(|e| format!("mail search task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::super::{MailAddress, MailMessageCached, init_mail_tables, upsert_message};
    use super::*;

    fn header(
        folder: &str,
        uid: u32,
        subject: &str,
        from: &str,
        flags: &[&str],
    ) -> MailMessageCached {
        MailMessageCached {
            header: MailMessageHeader {
                account_id: "acct".into(),
                folder: folder.into(),
                uid,
                message_id: Some(format!("{uid}@x")),
                subject: subject.into(),
                from: Some(MailAddress {
                    name: Some(from.into()),
                    address: Some(format!("{}@example.com", from.to_lowercase())),
                }),
                to: vec![],
                cc: vec![],
                date_ts: Some(uid as i64),
                flags: flags.iter().map(|flag| flag.to_string()).collect(),
                has_attachments: uid % 2 == 0,
                attachment_count: (uid % 2 == 0) as usize,
                attachments: vec![],
                snippet: Some(format!("snippet for {subject}")),
                raw_size: None,
                body_cached: false,
                in_reply_to: None,
                references: vec![],
                list_unsubscribe: None,
            },
            body_text: None,
            body_html: None,
            body_cached_at: None,
            internal_ts: None,
            flags_authoritative: true,
        }
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        for message in [
            header("INBOX", 1, "Quarterly budget review", "Alice", &["\\Seen"]),
            header("INBOX", 2, "季度预算评审会议", "Bob", &[]),
            header("INBOX", 3, "Lunch?", "Carol", &["\\Flagged", "$label1"]),
            header("Archive", 4, "Old budget notes", "Alice", &["\\Seen"]),
        ] {
            upsert_message(&conn, &message).unwrap();
        }
        conn
    }

    fn uids(results: Vec<MailMessageHeader>) -> Vec<u32> {
        results.into_iter().map(|m| m.uid).collect()
    }

    fn query(text: &str) -> MailSearchQuery {
        MailSearchQuery {
            text: text.into(),
            ..MailSearchQuery::default()
        }
    }

    #[test]
    fn full_text_search_spans_folders_and_supports_cjk() {
        let conn = db();
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &query("budget")).unwrap()),
            vec![4, 1]
        );
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &query("预算评审")).unwrap()),
            vec![2]
        );
        let scoped = MailSearchQuery {
            folder: Some("INBOX".into()),
            ..query("budget")
        };
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &scoped).unwrap()),
            vec![1]
        );
    }

    #[test]
    fn field_filters_and_short_terms() {
        let conn = db();
        let sender = MailSearchQuery {
            field: MailSearchField::Sender,
            ..query("alice")
        };
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &sender).unwrap()),
            vec![4, 1]
        );
        // Two-character terms fall back to LIKE.
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &query("季度")).unwrap()),
            vec![2]
        );
        let unread = MailSearchQuery {
            unread_only: true,
            ..query("")
        };
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &unread).unwrap()),
            vec![3, 2]
        );
        let flagged = MailSearchQuery {
            flagged_only: true,
            ..query("")
        };
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &flagged).unwrap()),
            vec![3]
        );
        let tagged = MailSearchQuery {
            keyword: Some("$label1".into()),
            ..query("")
        };
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &tagged).unwrap()),
            vec![3]
        );
        let attachments = MailSearchQuery {
            with_attachments: true,
            ..query("")
        };
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &attachments).unwrap()),
            vec![4, 2]
        );
    }

    #[test]
    fn index_follows_updates_and_deletes() {
        let conn = db();
        conn.execute(
            "UPDATE mail_messages SET body_text = 'contains the zebra keyword' WHERE uid = 3",
            [],
        )
        .unwrap();
        assert_eq!(
            uids(search_cached_messages(&conn, "acct", &query("zebra")).unwrap()),
            vec![3]
        );
        conn.execute("DELETE FROM mail_messages WHERE uid = 3", [])
            .unwrap();
        assert!(
            search_cached_messages(&conn, "acct", &query("zebra"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn quoted_phrases_and_fts_syntax_are_literal() {
        assert_eq!(
            search_terms(r#"budget "review meeting" x"#),
            vec!["budget", "review meeting", "x"]
        );
        let conn = db();
        // FTS operators in user text must not break the query.
        assert!(
            search_cached_messages(&conn, "acct", &query("NOT AND (budget"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn imap_criteria() {
        let (utf8, criteria) = imap_search_criteria(&MailSearchQuery {
            unread_only: true,
            ..query("budget \"q1 plan\"")
        });
        assert!(!utf8);
        assert_eq!(criteria, "TEXT \"budget\" TEXT \"q1 plan\" UNSEEN");
        let (utf8, criteria) = imap_search_criteria(&query("预算"));
        assert!(utf8);
        assert_eq!(criteria, "CHARSET UTF-8 TEXT \"预算\"");
        assert_eq!(imap_search_criteria(&query("")).1, "ALL");
    }
}
