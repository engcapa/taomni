//! Operations on one account's address book. Network discovery and the file
//! picker run outside the transaction. A sync commits against the cards it read.
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    CardChange, ContactWriteError, MailAddressBookEntry, StoredCard, address_book_suggestions,
    apply_changes, delete_entry, entries, export_cards, import_cards, load_cards, save_entry,
    storage::load_card,
};

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum BookAction {
    List,
    Save {
        entry: MailAddressBookEntry,
        carddav: bool,
    },
    Delete {
        uid: String,
    },
    Import {
        text: String,
        carddav: bool,
    },
    Export,
    Suggest {
        query: String,
        limit: u32,
    },
    StartSync,
    FinishSync {
        original: Vec<StoredCard>,
        changes: Vec<CardChange>,
        state: DavState,
    },
}

#[derive(Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DavState {
    pub collection_url: Option<String>,
    pub base_url: Option<String>,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
}

pub fn load_state(db: &Connection, account: &str) -> rusqlite::Result<Option<DavState>> {
    db.query_row(
        "SELECT collection_url, base_url, last_sync, last_error
         FROM mail_carddav_state WHERE account_id=?1",
        [account],
        |r| {
            Ok(DavState {
                collection_url: r.get(0)?,
                base_url: r.get(1)?,
                last_sync: r.get(2)?,
                last_error: r.get(3)?,
            })
        },
    )
    .optional()
}

pub(super) fn save_state(db: &Connection, account: &str, state: DavState) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO mail_carddav_state(account_id, collection_url, base_url, last_sync, last_error)
         VALUES (?1,?2,?3,?4,?5) ON CONFLICT(account_id) DO UPDATE SET
         collection_url=excluded.collection_url, base_url=excluded.base_url,
         last_sync=excluded.last_sync, last_error=excluded.last_error",
        params![account, state.collection_url, state.base_url, state.last_sync, state.last_error],
    )?;
    Ok(())
}

fn encode(value: impl Serialize) -> Result<Value, ContactWriteError> {
    serde_json::to_value(value)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)).into())
}

impl BookAction {
    pub fn writes(&self) -> bool {
        matches!(
            self,
            Self::Save { .. } | Self::Delete { .. } | Self::Import { .. } | Self::FinishSync { .. }
        )
    }

    pub fn execute(self, db: &Connection, account: &str) -> Result<Value, ContactWriteError> {
        let book = |carddav| if carddav { "carddav" } else { "local" };
        match self {
            Self::List => encode(entries(db, account)?),
            Self::Save { entry, carddav } => encode(save_entry(db, account, entry, book(carddav))?),
            Self::Delete { uid } => encode(delete_entry(db, account, uid.trim())?),
            Self::Import { text, carddav } => {
                encode(import_cards(db, account, &text, book(carddav))?)
            }
            Self::Export => encode(export_cards(db, account)?),
            Self::Suggest { query, limit } => encode(address_book_suggestions(
                db,
                account,
                &query,
                limit.clamp(1, 20),
            )?),
            Self::StartSync => encode((load_state(db, account)?, load_cards(db, account)?)),
            Self::FinishSync {
                original,
                changes,
                state,
            } => {
                apply_current(db, account, original, changes)?;
                save_state(db, account, state)?;
                encode(Value::Null)
            }
        }
    }
}

fn apply_current(
    db: &Connection,
    account: &str,
    original: Vec<StoredCard>,
    changes: Vec<CardChange>,
) -> rusqlite::Result<()> {
    let original: HashMap<_, _> = original
        .into_iter()
        .map(|c| (c.card.uid.clone(), c))
        .collect();
    // A pull can produce several changes for the same UID. Compare once,
    // before applying any of them, while the writer transaction is held.
    let mut changed_locally = HashSet::new();
    let touched: HashSet<_> = changes.iter().map(CardChange::uid).collect();
    for id in touched {
        if load_card(db, account, id)?.as_ref() != original.get(id) {
            changed_locally.insert(id.to_owned());
        }
    }
    let current: Vec<_> = changes
        .into_iter()
        .filter(|change| !changed_locally.contains(change.uid()))
        .collect();
    apply_changes(db, account, &current)
}
