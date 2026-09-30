//! Address book and CardDAV (TASK-19, DEC-13: in-tree vCard + WebDAV).
//!
//! Cards live per mail account in `mail_cards` (`book` = `local` or
//! `carddav`). CardDAV sync pushes local edits first (`If-Match` /
//! `If-None-Match`, server wins on conflict), then pulls: PROPFIND Depth 1
//! for ETags and `addressbook-multiget` (GET fallback) for changed cards.
//! Discovery follows `/.well-known/carddav`, `current-user-principal` and
//! `addressbook-home-set` (RFC 6352 / RFC 6764). The composer's address
//! autocomplete merges address book entries with collected contacts.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use quick_xml::Reader;
use quick_xml::events::Event;
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Method, Url};
use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::vcard::{MailContactCard, parse_vcards, serialize_vcard};
use super::{
    MailAccountConfig, MailAuthMode, MailContactSuggestion, now_ts, resolve_config, with_mail_db,
};
use crate::state::AppState;

/// CardDAV address book of a mail account (session options).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailCardDavSettings {
    /// Server, principal or address book URL (discovery finds the book).
    pub url: String,
    /// Login when it differs from the IMAP username.
    #[serde(default)]
    pub username: Option<String>,
}

/// One address book entry as the UI edits it (`raw` stays in the backend).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAddressBookEntry {
    #[serde(default)]
    pub uid: String,
    /// `local` or `carddav`.
    #[serde(default)]
    pub book: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub emails: Vec<String>,
    #[serde(default)]
    pub phones: Vec<String>,
    #[serde(default)]
    pub org: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// Local change not yet on the CardDAV server.
    #[serde(default)]
    pub pending_sync: bool,
}

impl MailAddressBookEntry {
    fn from_card(card: MailContactCard, book: &str, pending: bool) -> Self {
        Self {
            uid: card.uid,
            book: book.to_string(),
            display_name: card.display_name,
            emails: card.emails,
            phones: card.phones,
            org: card.org,
            note: card.note,
            pending_sync: pending,
        }
    }
}

pub(super) fn migrate_contact_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_cards (
            account_id TEXT NOT NULL,
            uid TEXT NOT NULL,
            book TEXT NOT NULL,
            href TEXT,
            etag TEXT,
            card_json TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            emails TEXT NOT NULL DEFAULT '',
            dirty INTEGER NOT NULL DEFAULT 0,
            deleted INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, uid)
        );
        CREATE INDEX IF NOT EXISTS idx_mail_cards_href ON mail_cards(account_id, href);
        CREATE TABLE IF NOT EXISTS mail_carddav_state (
            account_id TEXT PRIMARY KEY,
            collection_url TEXT,
            base_url TEXT,
            last_sync INTEGER,
            last_error TEXT
        );",
    )
}

#[derive(Debug, Clone)]
pub(super) struct StoredCard {
    pub card: MailContactCard,
    pub book: String,
    pub href: Option<String>,
    pub etag: Option<String>,
    pub dirty: bool,
    pub deleted: bool,
}

fn row_to_stored(row: &rusqlite::Row<'_>) -> SqlResult<StoredCard> {
    let json: String = row.get(0)?;
    Ok(StoredCard {
        card: serde_json::from_str(&json).unwrap_or_default(),
        book: row.get(1)?,
        href: row.get(2)?,
        etag: row.get(3)?,
        dirty: row.get::<_, i64>(4)? != 0,
        deleted: row.get::<_, i64>(5)? != 0,
    })
}

const CARD_COLUMNS: &str = "card_json, book, href, etag, dirty, deleted";

pub(super) fn load_cards(conn: &Connection, account_id: &str) -> SqlResult<Vec<StoredCard>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CARD_COLUMNS} FROM mail_cards WHERE account_id = ?1
         ORDER BY lower(display_name), uid"
    ))?;
    let rows = stmt.query_map(params![account_id], row_to_stored)?;
    rows.collect()
}

fn load_card(conn: &Connection, account_id: &str, uid: &str) -> SqlResult<Option<StoredCard>> {
    conn.query_row(
        &format!("SELECT {CARD_COLUMNS} FROM mail_cards WHERE account_id = ?1 AND uid = ?2"),
        params![account_id, uid],
        row_to_stored,
    )
    .optional()
}

pub(super) fn store_card(
    conn: &Connection,
    account_id: &str,
    stored: &StoredCard,
) -> SqlResult<()> {
    let emails = stored
        .card
        .emails
        .iter()
        .map(|e| e.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    conn.execute(
        "INSERT INTO mail_cards
         (account_id, uid, book, href, etag, card_json, display_name, emails, dirty, deleted, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(account_id, uid) DO UPDATE SET
            book = excluded.book, href = excluded.href, etag = excluded.etag,
            card_json = excluded.card_json, display_name = excluded.display_name,
            emails = excluded.emails, dirty = excluded.dirty, deleted = excluded.deleted,
            updated_at = excluded.updated_at",
        params![
            account_id,
            stored.card.uid,
            stored.book,
            stored.href,
            stored.etag,
            serde_json::to_string(&stored.card).unwrap_or_default(),
            stored.card.display_name,
            emails,
            stored.dirty as i64,
            stored.deleted as i64,
            now_ts()
        ],
    )?;
    Ok(())
}

fn remove_card(conn: &Connection, account_id: &str, uid: &str) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM mail_cards WHERE account_id = ?1 AND uid = ?2",
        params![account_id, uid],
    )?;
    Ok(())
}

/// Save an edited or new entry; CardDAV cards are marked for upload.
pub(super) fn save_entry(
    conn: &Connection,
    account_id: &str,
    entry: MailAddressBookEntry,
    default_book: &str,
) -> Result<MailAddressBookEntry, String> {
    let display_name = entry.display_name.trim().to_string();
    let emails: Vec<String> = entry
        .emails
        .iter()
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();
    if display_name.is_empty() && emails.is_empty() {
        return Err("a contact needs a name or an email address".into());
    }
    if let Some(bad) = emails
        .iter()
        .find(|e| !e.contains('@') || e.contains(char::is_whitespace))
    {
        return Err(format!("\"{bad}\" is not an email address"));
    }
    let existing = if entry.uid.trim().is_empty() {
        None
    } else {
        load_card(conn, account_id, entry.uid.trim()).map_err(|e| e.to_string())?
    };
    let uid = existing
        .as_ref()
        .map(|s| s.card.uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let book = existing
        .as_ref()
        .map(|s| s.book.clone())
        .unwrap_or_else(|| default_book.to_string());
    let card = MailContactCard {
        uid,
        display_name: if display_name.is_empty() {
            emails[0].clone()
        } else {
            display_name
        },
        emails,
        phones: entry
            .phones
            .iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect(),
        org: entry
            .org
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty()),
        note: entry
            .note
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty()),
        raw: existing.as_ref().and_then(|s| s.card.raw.clone()),
    };
    let dirty = book == "carddav";
    let stored = StoredCard {
        card,
        book: book.clone(),
        href: existing.as_ref().and_then(|s| s.href.clone()),
        etag: existing.as_ref().and_then(|s| s.etag.clone()),
        dirty,
        deleted: false,
    };
    store_card(conn, account_id, &stored).map_err(|e| e.to_string())?;
    Ok(MailAddressBookEntry::from_card(stored.card, &book, dirty))
}

pub(super) fn delete_entry(conn: &Connection, account_id: &str, uid: &str) -> SqlResult<bool> {
    let Some(mut stored) = load_card(conn, account_id, uid)? else {
        return Ok(false);
    };
    if stored.book == "carddav" && stored.href.is_some() {
        // Tombstone until the server copy is deleted on the next sync.
        stored.deleted = true;
        stored.dirty = true;
        store_card(conn, account_id, &stored)?;
    } else {
        remove_card(conn, account_id, uid)?;
    }
    Ok(true)
}

/// Import vCards; a card whose UID exists replaces that card's fields.
pub(super) fn import_cards(
    conn: &Connection,
    account_id: &str,
    text: &str,
    default_book: &str,
) -> SqlResult<usize> {
    let mut count = 0;
    for mut card in parse_vcards(text) {
        if card.uid.trim().is_empty() {
            card.uid = uuid::Uuid::new_v4().to_string();
        }
        let existing = load_card(conn, account_id, &card.uid)?;
        let book = existing
            .as_ref()
            .map(|s| s.book.clone())
            .unwrap_or_else(|| default_book.to_string());
        let stored = StoredCard {
            dirty: book == "carddav",
            href: existing.as_ref().and_then(|s| s.href.clone()),
            etag: existing.as_ref().and_then(|s| s.etag.clone()),
            deleted: false,
            book,
            card,
        };
        store_card(conn, account_id, &stored)?;
        count += 1;
    }
    Ok(count)
}

pub(super) fn export_cards(conn: &Connection, account_id: &str) -> SqlResult<(String, usize)> {
    let cards: Vec<StoredCard> = load_cards(conn, account_id)?
        .into_iter()
        .filter(|s| !s.deleted)
        .collect();
    let now = now_ts();
    let text = cards
        .iter()
        .map(|s| serialize_vcard(&s.card, now))
        .collect::<String>();
    Ok((text, cards.len()))
}

/// Address book matches for the composer's autocomplete, best first.
pub(super) fn address_book_suggestions(
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
pub(super) fn merge_suggestions(
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

/// One `<response>` of a WebDAV multistatus with its successful props.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct DavResponse {
    pub href: String,
    /// Prop local name -> text (nested `<href>` text for principal/home;
    /// child element names for `resourcetype`).
    pub props: HashMap<String, String>,
}

pub(super) fn parse_multistatus(xml: &str) -> Vec<DavResponse> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut responses = Vec::new();
    let mut current: Option<DavResponse> = None;
    let mut stack: Vec<String> = Vec::new();
    // Props of the current propstat, kept only when its status is 2xx.
    let mut pending: HashMap<String, String> = HashMap::new();
    let mut status_ok = true;
    let mut text = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                match name.as_str() {
                    "response" => current = Some(DavResponse::default()),
                    "propstat" => {
                        pending.clear();
                        status_ok = true;
                    }
                    _ => {}
                }
                // A child of <resourcetype> names the resource type.
                if stack.last().map(String::as_str) == Some("resourcetype") {
                    let entry = pending.entry("resourcetype".into()).or_default();
                    entry.push(' ');
                    entry.push_str(&name);
                }
                stack.push(name);
                text.clear();
            }
            Ok(Event::Empty(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                if stack.last().map(String::as_str) == Some("resourcetype") {
                    let entry = pending.entry("resourcetype".into()).or_default();
                    entry.push(' ');
                    entry.push_str(&name);
                } else if stack.iter().any(|s| s == "prop") {
                    pending.entry(name).or_default();
                }
            }
            Ok(Event::Text(t)) => {
                text.push_str(&t.decode().map(|v| v.to_string()).unwrap_or_default())
            }
            Ok(Event::GeneralRef(r)) => {
                let entity = String::from_utf8_lossy(r.as_ref()).to_string();
                text.push_str(match entity.as_str() {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "apos" => "'",
                    _ => "",
                });
                if let Some(code) = entity.strip_prefix('#') {
                    let parsed = code.strip_prefix('x').map_or_else(
                        || code.parse::<u32>().ok(),
                        |hex| u32::from_str_radix(hex, 16).ok(),
                    );
                    if let Some(ch) = parsed.and_then(char::from_u32) {
                        text.push(ch);
                    }
                }
            }
            Ok(Event::CData(c)) => text.push_str(&String::from_utf8_lossy(c.as_ref())),
            Ok(Event::End(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                stack.pop();
                let parent = stack.last().cloned().unwrap_or_default();
                match name.as_str() {
                    "href" if parent == "response" => {
                        if let Some(response) = current.as_mut() {
                            response.href = text.trim().to_string();
                        }
                    }
                    "href" => {
                        // href inside a prop (current-user-principal etc.).
                        if let Some(prop) = stack.iter().skip_while(|s| *s != "prop").nth(1) {
                            pending.insert(prop.clone(), text.trim().to_string());
                        }
                    }
                    "status" if parent == "propstat" => {
                        status_ok = text
                            .split_whitespace()
                            .nth(1)
                            .is_some_and(|code| code.starts_with('2'));
                    }
                    "propstat" => {
                        if status_ok {
                            if let Some(response) = current.as_mut() {
                                response.props.extend(pending.drain());
                            }
                        }
                        pending.clear();
                    }
                    "response" => {
                        if let Some(response) = current.take() {
                            responses.push(response);
                        }
                    }
                    _ if parent == "prop" && name != "resourcetype" => {
                        pending
                            .entry(name)
                            .or_insert_with(|| text.trim().to_string());
                    }
                    _ => {}
                }
                text.clear();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    responses
}

fn has_type(response: &DavResponse, kind: &str) -> bool {
    response.props.get("resourcetype").is_some_and(|types| {
        types
            .split_whitespace()
            .any(|t| t.eq_ignore_ascii_case(kind))
    })
}

enum DavAuth {
    Basic(String, String),
    Bearer(String),
}

struct DavClient {
    http: reqwest::Client,
    auth: DavAuth,
}

struct DavReply {
    status: u16,
    headers: HeaderMap,
    body: String,
}

const XML: &str = "application/xml; charset=utf-8";
const PROPFIND_DISCOVERY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:resourcetype/><d:current-user-principal/><card:addressbook-home-set/><d:displayname/></d:prop></d:propfind>"#;
const PROPFIND_ETAGS: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>"#;

impl DavClient {
    fn new(auth: DavAuth, allow_invalid_certs: bool) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(allow_invalid_certs)
            .build()
            .map_err(|e| format!("CardDAV client: {e}"))?;
        Ok(Self { http, auth })
    }

    async fn send(
        &self,
        method: &str,
        url: &Url,
        depth: Option<&str>,
        body: Option<(String, &'static str)>,
        extra: &[(&str, String)],
    ) -> Result<DavReply, String> {
        let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        // Follow redirects by hand so PROPFIND stays PROPFIND.
        let mut target = url.clone();
        for _ in 0..5 {
            let mut request = self.http.request(method.clone(), target.clone());
            request = match &self.auth {
                DavAuth::Basic(user, pass) => request.basic_auth(user, Some(pass)),
                DavAuth::Bearer(token) => request.bearer_auth(token),
            };
            if let Some(depth) = depth {
                request = request.header("Depth", depth);
            }
            for (name, value) in extra {
                request = request.header(*name, value.as_str());
            }
            if let Some((body, content_type)) = &body {
                request = request
                    .header("Content-Type", HeaderValue::from_static(content_type))
                    .body(body.clone());
            }
            let response = request
                .send()
                .await
                .map_err(|e| format!("CardDAV {method} {target} failed: {e}"))?;
            let status = response.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if let Some(location) = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                {
                    target = target
                        .join(location)
                        .map_err(|e| format!("CardDAV redirect: {e}"))?;
                    continue;
                }
            }
            let headers = response.headers().clone();
            let body = response.text().await.unwrap_or_default();
            if status == 401 || status == 403 {
                return Err(format!(
                    "CardDAV login rejected ({status}). Check the CardDAV username; many providers need an app password."
                ));
            }
            return Ok(DavReply {
                status,
                headers,
                body,
            });
        }
        Err("CardDAV: too many redirects".into())
    }

    async fn propfind(
        &self,
        url: &Url,
        depth: &str,
        body: &str,
    ) -> Result<Vec<DavResponse>, String> {
        let reply = self
            .send(
                "PROPFIND",
                url,
                Some(depth),
                Some((body.to_string(), XML)),
                &[],
            )
            .await?;
        if reply.status != 207 {
            return Err(format!("CardDAV PROPFIND {url} returned {}", reply.status));
        }
        Ok(parse_multistatus(&reply.body))
    }

    /// Address book collection behind `start` (RFC 6764 bootstrap).
    async fn discover(&self, start: &Url) -> Result<Url, String> {
        let mut probe = vec![start.clone()];
        if start.path() == "/" || start.path().is_empty() {
            probe.insert(
                0,
                start
                    .join("/.well-known/carddav")
                    .map_err(|e| e.to_string())?,
            );
        }
        let mut last_error = String::from("no CardDAV address book found");
        for url in probe {
            match self.discover_from(&url).await {
                Ok(found) => return Ok(found),
                Err(e) => last_error = e,
            }
        }
        Err(last_error)
    }

    async fn discover_from(&self, url: &Url) -> Result<Url, String> {
        let responses = self.propfind(url, "0", PROPFIND_DISCOVERY).await?;
        let first = responses.first().cloned().unwrap_or_default();
        if has_type(&first, "addressbook") {
            return Ok(url.clone());
        }
        let home = match first
            .props
            .get("addressbook-home-set")
            .filter(|h| !h.is_empty())
        {
            Some(home) => url.join(home).map_err(|e| e.to_string())?,
            None => {
                let principal = first
                    .props
                    .get("current-user-principal")
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| format!("{url} is not a CardDAV server"))?;
                let principal = url.join(principal).map_err(|e| e.to_string())?;
                let found = self.propfind(&principal, "0", PROPFIND_DISCOVERY).await?;
                let home = found
                    .first()
                    .and_then(|r| r.props.get("addressbook-home-set").cloned())
                    .filter(|h| !h.is_empty())
                    .ok_or_else(|| "the CardDAV principal has no address book home".to_string())?;
                principal.join(&home).map_err(|e| e.to_string())?
            }
        };
        let books = self.propfind(&home, "1", PROPFIND_DISCOVERY).await?;
        let book = books
            .iter()
            .find(|r| has_type(r, "addressbook"))
            .ok_or_else(|| "no address book in the CardDAV home".to_string())?;
        home.join(&book.href).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailCardDavSyncResult {
    pub collection: String,
    /// Cards added or updated from the server.
    pub pulled: usize,
    /// Local cards removed because the server no longer has them.
    pub removed: usize,
    /// Local changes uploaded (including deletions).
    pub pushed: usize,
    /// Local edits dropped because the server copy changed (server wins).
    pub conflicts: usize,
    pub errors: Vec<String>,
}

fn etag_of(headers: &HeaderMap) -> Option<String> {
    headers
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
}

fn card_file_name(uid: &str) -> String {
    let safe: String = uid
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}.vcf")
}

fn multiget_body(hrefs: &[String]) -> String {
    let items: String = hrefs
        .iter()
        .map(|href| {
            let escaped = href.replace('&', "&amp;").replace('<', "&lt;");
            format!("<d:href>{escaped}</d:href>")
        })
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop>{items}</card:addressbook-multiget>"#
    )
}

/// Normalize an href to the collection's absolute path for comparisons.
fn href_path(collection: &Url, href: &str) -> String {
    collection
        .join(href)
        .map(|u| u.path().to_string())
        .unwrap_or_else(|_| href.to_string())
}

/// Upload local changes, then pull the server state.
async fn sync_collection(
    client: &DavClient,
    collection: &Url,
    cards: Vec<StoredCard>,
) -> (MailCardDavSyncResult, Vec<CardChange>) {
    let mut result = MailCardDavSyncResult {
        collection: collection.to_string(),
        ..MailCardDavSyncResult::default()
    };
    let mut changes = Vec::new();
    let mut known: HashMap<String, StoredCard> = HashMap::new();
    let now = now_ts();

    for mut stored in cards.into_iter().filter(|s| s.book == "carddav") {
        if stored.dirty {
            if stored.deleted {
                match &stored.href {
                    Some(href) => {
                        let url = match collection.join(href) {
                            Ok(url) => url,
                            Err(e) => {
                                result.errors.push(e.to_string());
                                continue;
                            }
                        };
                        let headers: Vec<(&str, String)> = stored
                            .etag
                            .iter()
                            .map(|e| ("If-Match", e.clone()))
                            .collect();
                        match client.send("DELETE", &url, None, None, &headers).await {
                            Ok(r) if (200..300).contains(&r.status) || r.status == 404 => {
                                result.pushed += 1;
                                changes.push(CardChange::Remove(stored.card.uid.clone()));
                                continue;
                            }
                            Ok(r) if r.status == 412 => {
                                result.conflicts += 1;
                                stored.deleted = false;
                                stored.dirty = false;
                                stored.etag = None;
                            }
                            Ok(r) => {
                                result.errors.push(format!(
                                    "delete {}: HTTP {}",
                                    stored.card.display_name, r.status
                                ));
                                continue;
                            }
                            Err(e) => {
                                result.errors.push(e);
                                continue;
                            }
                        }
                    }
                    None => {
                        changes.push(CardChange::Remove(stored.card.uid.clone()));
                        continue;
                    }
                }
            } else {
                let href = stored
                    .href
                    .clone()
                    .unwrap_or_else(|| href_path(collection, &card_file_name(&stored.card.uid)));
                let url = match collection.join(&href) {
                    Ok(url) => url,
                    Err(e) => {
                        result.errors.push(e.to_string());
                        continue;
                    }
                };
                let condition = match (&stored.href, &stored.etag) {
                    (Some(_), Some(etag)) => ("If-Match", etag.clone()),
                    (Some(_), None) => ("If-Match", "*".to_string()),
                    (None, _) => ("If-None-Match", "*".to_string()),
                };
                let body = serialize_vcard(&stored.card, now);
                let reply = client
                    .send(
                        "PUT",
                        &url,
                        None,
                        Some((body.clone(), "text/vcard; charset=utf-8")),
                        &[condition],
                    )
                    .await;
                match reply {
                    Ok(r) if (200..300).contains(&r.status) => {
                        result.pushed += 1;
                        stored.etag = etag_of(&r.headers);
                        stored.href = Some(href);
                        stored.dirty = false;
                        stored.card.raw = Some(body);
                    }
                    Ok(r) if r.status == 412 => {
                        // Someone else changed it: take the server copy.
                        result.conflicts += 1;
                        stored.dirty = false;
                        stored.etag = None;
                        stored.href = Some(href);
                    }
                    Ok(r) => result.errors.push(format!(
                        "upload {}: HTTP {}",
                        stored.card.display_name, r.status
                    )),
                    Err(e) => result
                        .errors
                        .push(format!("upload {}: {e}", stored.card.display_name)),
                }
            }
            changes.push(CardChange::Store(stored.clone()));
        }
        if let Some(href) = &stored.href {
            known.insert(href_path(collection, href), stored);
        }
    }

    // Pull: ETags of every card in the collection.
    let listing = match client.propfind(collection, "1", PROPFIND_ETAGS).await {
        Ok(listing) => listing,
        Err(e) => {
            result.errors.push(e);
            return (result, changes);
        }
    };
    let own_path = collection.path().to_string();
    let mut server: HashMap<String, String> = HashMap::new();
    for response in listing {
        let path = href_path(collection, &response.href);
        if path == own_path
            || path.trim_end_matches('/') == own_path.trim_end_matches('/')
            || has_type(&response, "collection")
        {
            continue;
        }
        server.insert(
            path,
            response.props.get("getetag").cloned().unwrap_or_default(),
        );
    }
    for (path, stored) in &known {
        if !server.contains_key(path) && !stored.dirty {
            result.removed += 1;
            changes.push(CardChange::Remove(stored.card.uid.clone()));
        }
    }
    let wanted: Vec<String> = server
        .iter()
        .filter(|(path, etag)| {
            known.get(*path).is_none_or(|s| {
                !s.dirty && (s.etag.as_deref() != Some(etag.as_str()) || etag.is_empty())
            })
        })
        .map(|(path, _)| path.clone())
        .collect();
    for chunk in wanted.chunks(50) {
        let fetched = fetch_cards(client, collection, chunk).await;
        match fetched {
            Ok(items) => {
                for (path, etag, text) in items {
                    for mut card in parse_vcards(&text) {
                        if card.uid.trim().is_empty() {
                            card.uid = path.clone();
                        }
                        let previous = known.get(&path);
                        if let Some(prev) = previous.filter(|p| p.card.uid != card.uid) {
                            changes.push(CardChange::Remove(prev.card.uid.clone()));
                        }
                        result.pulled += 1;
                        changes.push(CardChange::Store(StoredCard {
                            card,
                            book: "carddav".into(),
                            href: Some(path.clone()),
                            etag: Some(etag.clone()).filter(|e| !e.is_empty()),
                            dirty: false,
                            deleted: false,
                        }));
                    }
                }
            }
            Err(e) => result.errors.push(e),
        }
    }
    (result, changes)
}

async fn fetch_cards(
    client: &DavClient,
    collection: &Url,
    paths: &[String],
) -> Result<Vec<(String, String, String)>, String> {
    let reply = client
        .send(
            "REPORT",
            collection,
            Some("1"),
            Some((multiget_body(paths), XML)),
            &[],
        )
        .await?;
    if reply.status == 207 {
        let items: Vec<_> = parse_multistatus(&reply.body)
            .into_iter()
            .filter_map(|r| {
                let data = r.props.get("address-data")?.clone();
                Some((
                    href_path(collection, &r.href),
                    r.props.get("getetag").cloned().unwrap_or_default(),
                    data,
                ))
            })
            .collect();
        if !items.is_empty() || paths.is_empty() {
            return Ok(items);
        }
    }
    // Servers without addressbook-multiget: fetch one by one.
    let mut items = Vec::new();
    for path in paths {
        let url = collection.join(path).map_err(|e| e.to_string())?;
        let reply = client.send("GET", &url, None, None, &[]).await?;
        if (200..300).contains(&reply.status) {
            items.push((
                path.clone(),
                etag_of(&reply.headers).unwrap_or_default(),
                reply.body,
            ));
        }
    }
    Ok(items)
}

pub(super) fn apply_changes(
    conn: &Connection,
    account_id: &str,
    changes: &[CardChange],
) -> SqlResult<()> {
    for change in changes {
        match change {
            CardChange::Store(stored) => store_card(conn, account_id, stored)?,
            CardChange::Remove(uid) => remove_card(conn, account_id, uid)?,
        }
    }
    Ok(())
}

pub(super) enum CardChange {
    Store(StoredCard),
    Remove(String),
}

fn default_book(config: &MailAccountConfig) -> &'static str {
    if config
        .carddav
        .as_ref()
        .is_some_and(|c| !c.url.trim().is_empty())
    {
        "carddav"
    } else {
        "local"
    }
}

fn entries(conn: &Connection, account_id: &str) -> SqlResult<Vec<MailAddressBookEntry>> {
    Ok(load_cards(conn, account_id)?
        .into_iter()
        .filter(|s| !s.deleted)
        .map(|s| {
            let pending = s.dirty;
            MailAddressBookEntry::from_card(s.card, &s.book, pending)
        })
        .collect())
}

#[tauri::command]
pub async fn mail_list_address_book(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailAddressBookEntry>, String> {
    with_mail_db(&state, &account_id, |db| entries(db, &account_id))
}

#[tauri::command]
pub async fn mail_save_address_book_entry(
    config: MailAccountConfig,
    entry: MailAddressBookEntry,
    state: State<'_, AppState>,
) -> Result<MailAddressBookEntry, String> {
    let account_id = config.session_id.clone();
    let book = default_book(&config);
    let db = state.mail_db(&account_id)?;
    let db = db.lock().map_err(|e| e.to_string())?;
    super::init_mail_tables(&db).map_err(|e| e.to_string())?;
    save_entry(&db, &account_id, entry, book)
}

#[tauri::command]
pub async fn mail_delete_address_book_entry(
    account_id: String,
    uid: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    with_mail_db(&state, &account_id, |db| {
        delete_entry(db, &account_id, uid.trim())
    })
}

#[tauri::command]
pub async fn mail_import_vcards(
    config: MailAccountConfig,
    source_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let bytes =
        std::fs::read(source_path.trim()).map_err(|e| format!("failed to read vCard file: {e}"))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("vCard file is larger than 64 MB".into());
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    let book = default_book(&config);
    let account_id = config.session_id.clone();
    let count = with_mail_db(&state, &account_id, |db| {
        import_cards(db, &account_id, &text, book)
    })?;
    if count == 0 {
        return Err("no contacts found in the file".into());
    }
    Ok(count)
}

#[tauri::command]
pub async fn mail_export_vcards(
    account_id: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let (text, count) = with_mail_db(&state, &account_id, |db| export_cards(db, &account_id))?;
    std::fs::write(target_path.trim(), text)
        .map_err(|e| format!("failed to write vCard file: {e}"))?;
    Ok(count)
}

fn collection_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw.trim()).map_err(|e| format!("invalid CardDAV URL: {e}"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("the CardDAV URL must start with https://".into());
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

/// Two-way sync with the account's CardDAV address book (AC-60).
#[tauri::command]
pub async fn mail_carddav_sync(
    config: MailAccountConfig,
    state: State<'_, AppState>,
) -> Result<MailCardDavSyncResult, String> {
    let settings = config
        .carddav
        .clone()
        .filter(|c| !c.url.trim().is_empty())
        .ok_or_else(|| "no CardDAV address book is configured for this account".to_string())?;
    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let auth = if account.auth_mode == MailAuthMode::OAuth2 {
        DavAuth::Bearer(account.imap_password.clone())
    } else {
        let user = settings
            .username
            .clone()
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| account.imap_username.clone());
        DavAuth::Basic(user, account.imap_password.clone())
    };
    let client = DavClient::new(auth, false)?;
    let base = settings.url.trim().to_string();
    let cached: Option<(Option<String>, Option<String>)> =
        with_mail_db(&state, &account_id, |db| {
            db.query_row(
                "SELECT collection_url, base_url FROM mail_carddav_state WHERE account_id = ?1",
                params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        })?;
    let collection = match cached {
        Some((Some(url), Some(cached_base))) if cached_base == base => collection_url(&url)?,
        _ => {
            let start = Url::parse(&base).map_err(|e| format!("invalid CardDAV URL: {e}"))?;
            collection_url(client.discover(&start).await?.as_str())?
        }
    };
    let cards = with_mail_db(&state, &account_id, |db| load_cards(db, &account_id))?;
    let (result, changes) = sync_collection(&client, &collection, cards).await;
    let error = result.errors.first().cloned();
    with_mail_db(&state, &account_id, |db| {
        apply_changes(db, &account_id, &changes)?;
        db.execute(
            "INSERT INTO mail_carddav_state (account_id, collection_url, base_url, last_sync, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_id) DO UPDATE SET collection_url = excluded.collection_url,
                base_url = excluded.base_url, last_sync = excluded.last_sync, last_error = excluded.last_error",
            params![account_id, collection.as_str(), base, now_ts(), error],
        )?;
        Ok(())
    })?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeDav {
        cards: BTreeMap<String, (String, String)>,
        next_etag: u32,
        log: Vec<String>,
    }

    const BOOK: &str = "/dav/books/u/contacts/";

    fn card_text(uid: &str, name: &str, email: &str) -> String {
        format!(
            "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:{uid}\r\nFN:{name}\r\nEMAIL:{email}\r\nX-CUSTOM:keep\r\nEND:VCARD\r\n"
        )
    }

    fn multistatus(responses: &[String]) -> String {
        format!(
            r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">{}</d:multistatus>"#,
            responses.concat()
        )
    }

    fn response(href: &str, props: &str) -> String {
        format!(
            "<d:response><d:href>{href}</d:href><d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>"
        )
    }

    fn handle(
        dav: &Mutex<FakeDav>,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: &str,
    ) -> (u16, Vec<(String, String)>, String) {
        let mut dav = dav.lock().unwrap();
        dav.log.push(format!("{method} {path}"));
        if headers.get("authorization").map(String::as_str) != Some("Basic dTpw") {
            return (401, vec![], String::new());
        }
        let depth = headers.get("depth").cloned().unwrap_or_default();
        match (method, path) {
            ("PROPFIND", "/.well-known/carddav") => (
                301,
                vec![("Location".into(), "/dav/".into())],
                String::new(),
            ),
            ("PROPFIND", "/dav/") => (
                207,
                vec![],
                multistatus(&[response(
                    "/dav/",
                    "<d:resourcetype><d:collection/></d:resourcetype><d:current-user-principal><d:href>/dav/principals/u/</d:href></d:current-user-principal>",
                )]),
            ),
            ("PROPFIND", "/dav/principals/u/") => (
                207,
                vec![],
                multistatus(&[response(
                    "/dav/principals/u/",
                    "<d:resourcetype><d:principal/></d:resourcetype><card:addressbook-home-set><d:href>/dav/books/u/</d:href></card:addressbook-home-set>",
                )]),
            ),
            ("PROPFIND", "/dav/books/u/") => (
                207,
                vec![],
                multistatus(&[
                    response(
                        "/dav/books/u/",
                        "<d:resourcetype><d:collection/></d:resourcetype>",
                    ),
                    response(
                        BOOK,
                        "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>",
                    ),
                ]),
            ),
            ("PROPFIND", BOOK) => {
                let mut items = vec![response(
                    BOOK,
                    "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>",
                )];
                if depth == "1" {
                    for (href, (etag, _)) in &dav.cards {
                        items.push(response(
                            href,
                            &format!("<d:resourcetype/><d:getetag>&quot;{etag}&quot;</d:getetag>"),
                        ));
                    }
                }
                (207, vec![], multistatus(&items))
            }
            ("REPORT", BOOK) => {
                let items: Vec<String> = body
                    .split("<d:href>")
                    .skip(1)
                    .filter_map(|part| part.split("</d:href>").next())
                    .filter_map(|href| {
                        let (etag, text) = dav.cards.get(href)?;
                        Some(response(href, &format!("<d:getetag>\"{etag}\"</d:getetag><card:address-data>{text}</card:address-data>")))
                    })
                    .collect();
                (207, vec![], multistatus(&items))
            }
            ("PUT", _) => {
                let current = dav.cards.get(path).map(|(etag, _)| format!("\"{etag}\""));
                let if_match = headers.get("if-match");
                let if_none = headers.get("if-none-match");
                let conflict = (if_none.is_some() && current.is_some())
                    || if_match.is_some_and(|want| want != "*" && Some(want) != current.as_ref())
                    || (if_match.is_some() && current.is_none());
                if conflict {
                    return (412, vec![], String::new());
                }
                dav.next_etag += 1;
                let etag = format!("e{}", dav.next_etag);
                dav.cards
                    .insert(path.to_string(), (etag.clone(), body.to_string()));
                (
                    201,
                    vec![("ETag".into(), format!("\"{etag}\""))],
                    String::new(),
                )
            }
            ("DELETE", _) => {
                let current = dav.cards.get(path).map(|(etag, _)| format!("\"{etag}\""));
                if headers
                    .get("if-match")
                    .is_some_and(|want| Some(want) != current.as_ref())
                {
                    return (412, vec![], String::new());
                }
                dav.cards.remove(path);
                (204, vec![], String::new())
            }
            _ => (404, vec![], String::new()),
        }
    }

    fn start(dav: Arc<Mutex<FakeDav>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let dav = Arc::clone(&dav);
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request_line = String::new();
                    if reader.read_line(&mut request_line).is_err() {
                        return;
                    }
                    let mut parts = request_line.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("").to_string();
                    let mut headers = HashMap::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        if let Some((name, value)) = line.split_once(':') {
                            headers
                                .insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
                        }
                    }
                    let length: usize = headers
                        .get("content-length")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    let mut body = vec![0; length];
                    let _ = reader.read_exact(&mut body);
                    let (status, extra, text) = handle(
                        &dav,
                        &method,
                        &path,
                        &headers,
                        &String::from_utf8_lossy(&body),
                    );
                    let mut reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                        text.len()
                    );
                    for (name, value) in extra {
                        reply.push_str(&format!("{name}: {value}\r\n"));
                    }
                    reply.push_str("\r\n");
                    reply.push_str(&text);
                    let _ = stream.write_all(reply.as_bytes());
                });
            }
        });
        port
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::mail::init_mail_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn multistatus_keeps_only_successful_props() {
        let xml = multistatus(&[response(
            "/a/",
            "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:getetag>&quot;x&amp;y&quot;</d:getetag>",
        )]);
        let parsed = parse_multistatus(&xml);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].href, "/a/");
        assert!(has_type(&parsed[0], "addressbook"));
        assert_eq!(
            parsed[0].props.get("getetag").map(String::as_str),
            Some("\"x&y\"")
        );
        assert!(
            !parsed[0].props.contains_key("displayname"),
            "404 propstat dropped"
        );
    }

    #[test]
    fn local_entries_suggestions_and_files() {
        let conn = db();
        let saved = save_entry(
            &conn,
            "acct",
            MailAddressBookEntry {
                display_name: "Jane Doe".into(),
                emails: vec![" jane@example.com ".into()],
                ..Default::default()
            },
            "local",
        )
        .unwrap();
        assert!(!saved.uid.is_empty());
        assert_eq!(saved.book, "local");
        assert!(!saved.pending_sync);
        assert!(save_entry(&conn, "acct", MailAddressBookEntry::default(), "local").is_err());
        let bad = MailAddressBookEntry {
            display_name: "x".into(),
            emails: vec!["nope".into()],
            ..Default::default()
        };
        assert!(
            save_entry(&conn, "acct", bad, "local")
                .unwrap_err()
                .contains("not an email")
        );

        let hits = address_book_suggestions(&conn, "acct", "doe", 5).unwrap();
        assert_eq!(hits[0].email, "jane@example.com");
        assert_eq!(hits[0].source, "addressBook");
        let collected = vec![MailContactSuggestion {
            name: None,
            email: "JANE@example.com".into(),
            source: "history".into(),
            score: 10,
            last_seen_at: None,
        }];
        assert_eq!(
            merge_suggestions(hits, collected, 5).len(),
            1,
            "dedupe by email"
        );

        assert_eq!(
            import_cards(
                &conn,
                "acct",
                &card_text("imp-1", "Imported", "imp@example.com"),
                "local"
            )
            .unwrap(),
            1
        );
        let (text, count) = export_cards(&conn, "acct").unwrap();
        assert_eq!(count, 2);
        assert!(text.contains("UID:imp-1") && text.contains("X-CUSTOM:keep"));
        assert!(delete_entry(&conn, "acct", &saved.uid).unwrap());
        assert_eq!(load_cards(&conn, "acct").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn carddav_discovers_pushes_pulls_and_resolves_conflicts() {
        let dav = Arc::new(Mutex::new(FakeDav::default()));
        dav.lock().unwrap().cards.insert(
            format!("{BOOK}a1.vcf"),
            ("s1".into(), card_text("a1", "Alice", "alice@example.com")),
        );
        let port = start(Arc::clone(&dav));
        let client = DavClient::new(DavAuth::Basic("u".into(), "p".into()), false).unwrap();
        let start_url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        let collection = client.discover(&start_url).await.unwrap();
        assert_eq!(collection.path(), BOOK);

        let conn = db();
        let local = save_entry(
            &conn,
            "acct",
            MailAddressBookEntry {
                display_name: "New Person".into(),
                emails: vec!["new@example.com".into()],
                ..Default::default()
            },
            "carddav",
        )
        .unwrap();
        assert!(local.pending_sync);

        let (result, changes) =
            sync_collection(&client, &collection, load_cards(&conn, "acct").unwrap()).await;
        apply_changes(&conn, "acct", &changes).unwrap();
        assert_eq!(
            (result.pushed, result.pulled, result.conflicts),
            (1, 1, 0),
            "{result:?}"
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let cards = load_cards(&conn, "acct").unwrap();
        assert_eq!(cards.len(), 2);
        assert!(cards.iter().all(|c| !c.dirty && c.href.is_some()));
        let pushed_path = format!("{BOOK}{}", card_file_name(&local.uid));
        assert!(
            dav.lock().unwrap().cards[&pushed_path]
                .1
                .contains("EMAIL;TYPE=INTERNET:new@example.com")
        );

        // Server edits Alice and deletes the new card; we edit Alice too.
        {
            let mut server = dav.lock().unwrap();
            server.cards.insert(
                format!("{BOOK}a1.vcf"),
                (
                    "s9".into(),
                    card_text("a1", "Alice Server", "alice@server.example"),
                ),
            );
            server.cards.remove(&pushed_path);
        }
        let alice = cards.iter().find(|c| c.card.uid == "a1").unwrap();
        save_entry(
            &conn,
            "acct",
            MailAddressBookEntry {
                uid: "a1".into(),
                display_name: "Alice Local".into(),
                emails: vec!["alice@local.example".into()],
                ..Default::default()
            },
            "carddav",
        )
        .unwrap();
        assert_eq!(alice.book, "carddav");
        let (result, changes) =
            sync_collection(&client, &collection, load_cards(&conn, "acct").unwrap()).await;
        apply_changes(&conn, "acct", &changes).unwrap();
        assert_eq!(
            (result.conflicts, result.removed, result.pulled),
            (1, 1, 1),
            "{result:?}"
        );
        let cards = load_cards(&conn, "acct").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].card.display_name, "Alice Server", "server wins");

        // Deleting locally removes the server copy.
        delete_entry(&conn, "acct", "a1").unwrap();
        let (result, changes) =
            sync_collection(&client, &collection, load_cards(&conn, "acct").unwrap()).await;
        apply_changes(&conn, "acct", &changes).unwrap();
        assert_eq!(result.pushed, 1, "{result:?}");
        assert!(dav.lock().unwrap().cards.is_empty());
        assert!(load_cards(&conn, "acct").unwrap().is_empty());

        let bad = DavClient::new(DavAuth::Basic("u".into(), "wrong".into()), false).unwrap();
        assert!(
            bad.discover(&start_url)
                .await
                .unwrap_err()
                .contains("login rejected")
        );
    }
}
