use super::model::MailAddressBookEntry;
use super::model::StoredCard;
use super::storage::load_card;
use super::storage::load_cards;
use super::storage::remove_card;
use super::storage::store_card;
use crate::mail::MailAccountConfig;
use crate::mail::now_ts;
use crate::mail::vcard::MailContactCard;
use crate::mail::vcard::parse_vcards;
use crate::mail::vcard::serialize_vcard;
use rusqlite::Connection;
use rusqlite::Result as SqlResult;

/// Save an edited or new entry; CardDAV cards are marked for upload.
pub(in crate::mail) fn save_entry(
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

pub(in crate::mail) fn delete_entry(
    conn: &Connection,
    account_id: &str,
    uid: &str,
) -> SqlResult<bool> {
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
pub(in crate::mail) fn import_cards(
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

pub(in crate::mail) fn export_cards(
    conn: &Connection,
    account_id: &str,
) -> SqlResult<(String, usize)> {
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

pub(super) fn default_book(config: &MailAccountConfig) -> &'static str {
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

pub(super) fn entries(conn: &Connection, account_id: &str) -> SqlResult<Vec<MailAddressBookEntry>> {
    Ok(load_cards(conn, account_id)?
        .into_iter()
        .filter(|s| !s.deleted)
        .map(|s| {
            let pending = s.dirty;
            MailAddressBookEntry::from_card(s.card, &s.book, pending)
        })
        .collect())
}
