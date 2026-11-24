//! Account-scoped filter definitions. UID marks stay in the message cache.
use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};

use super::{MailFilter, cache::replace_filters, load_filters, prepare_filters};

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum FilterRulesAction {
    List,
    Replace { rules: Vec<MailFilter> },
    Append { rules: Vec<MailFilter> },
}

#[derive(Default, Serialize, Deserialize)]
pub struct FilterRulesReply {
    rules: Vec<MailFilter>,
    error: Option<String>,
}

impl FilterRulesReply {
    pub fn into_result(self) -> std::result::Result<Vec<MailFilter>, String> {
        match self.error {
            Some(error) => Err(error),
            None => Ok(self.rules),
        }
    }
}

impl FilterRulesAction {
    pub fn writes(&self) -> bool {
        !matches!(self, Self::List)
    }

    /// A caller that writes must supply its account's writer transaction.
    pub fn execute(self, db: &Connection, account: &str) -> Result<FilterRulesReply> {
        let input = match self {
            Self::List => {
                return Ok(FilterRulesReply {
                    rules: load_filters(db, account)?,
                    error: None,
                });
            }
            Self::Replace { rules } => rules,
            Self::Append { rules } => {
                let mut all = load_filters(db, account)?;
                all.extend(rules);
                all
            }
        };
        let rules = match prepare_filters(input) {
            Ok(rules) => rules,
            Err(error) => {
                return Ok(FilterRulesReply {
                    error: Some(error),
                    ..Default::default()
                });
            }
        };
        replace_filters(db, account, &rules)?;
        Ok(FilterRulesReply { rules, error: None })
    }
}

#[derive(Default, Serialize, Deserialize)]
pub struct FilterRulesImport {
    pub snapshot: Option<Vec<MailFilter>>,
    pub replace_staged: bool,
}

fn table_exists(db: &Connection, table: &str) -> Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
}

pub fn read_account(db: &Connection, account: &str) -> Result<Vec<MailFilter>> {
    if table_exists(db, "mail_filters")? {
        load_filters(db, account)
    } else {
        Ok(Vec::new())
    }
}

pub fn is_owned(db: &Connection, account: &str) -> Result<bool> {
    if !table_exists(db, "mail_filter_owners")? {
        return Ok(false);
    }
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_filter_owners WHERE account_id=?1)",
        [account],
        |row| row.get(0),
    )
}

pub fn mark_owned(db: &Connection, account: &str) -> Result<()> {
    db.execute(
        "CREATE TABLE IF NOT EXISTS mail_filter_owners(account_id TEXT PRIMARY KEY NOT NULL)",
        [],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO mail_filter_owners VALUES (?1)",
        [account],
    )?;
    Ok(())
}

/// The first signed writer adopts the rules once. A restore or concurrent
/// request can provide a mailbox that already contains the authoritative rules.
pub fn adopt(db: &Connection, account: &str, source: FilterRulesImport) -> Result<()> {
    if is_owned(db, account)? {
        return Ok(());
    }
    if let Some(rules) = source.snapshot {
        if source.replace_staged || load_filters(db, account)?.is_empty() {
            replace_filters(db, account, &rules)?;
        }
    }
    mark_owned(db, account)
}
