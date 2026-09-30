//! Manual-commit transaction bookkeeping for MySQL / PostgreSQL sessions.
//!
//! The session pool holds a single connection. In manual mode MySQL runs with
//! `autocommit=0`; PostgreSQL has no session autocommit switch, so a `BEGIN`
//! is issued before the first write. `pending` counts successful writes since
//! the last commit/rollback, and `generation` changes whenever the pool opens
//! a new physical connection (an open transaction is lost at that point).

use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxEffect {
    /// Does not change data (SELECT, SHOW, SET, USE, …).
    Read,
    /// Changes data inside the current transaction.
    Write,
    /// MySQL DDL / account statements that commit implicitly.
    ImplicitCommit,
    /// BEGIN / START TRANSACTION.
    Begin,
    /// COMMIT / ROLLBACK / END / ABORT.
    End,
}

#[derive(Debug, Default)]
pub struct TxState {
    manual: AtomicBool,
    pending: AtomicU32,
    open: AtomicBool,
    generation: AtomicU64,
}

pub type TxSlot = Arc<TxState>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbTxStatus {
    pub supported: bool,
    pub manual: bool,
    pub pending: u32,
    pub generation: u64,
}

impl TxState {
    pub fn shared() -> TxSlot {
        Arc::new(Self::default())
    }

    pub fn manual(&self) -> bool {
        self.manual.load(Ordering::SeqCst)
    }

    pub fn open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Called from the pool `after_connect` hook: a fresh connection has no
    /// transaction, so anything pending on the previous one is gone.
    pub fn on_new_connection(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.reset();
    }

    pub fn set_manual(&self, manual: bool) {
        self.manual.store(manual, Ordering::SeqCst);
        self.reset();
    }

    pub fn mark_open(&self) {
        self.open.store(true, Ordering::SeqCst);
    }

    /// Commit / rollback finished.
    pub fn reset(&self) {
        self.pending.store(0, Ordering::SeqCst);
        self.open.store(false, Ordering::SeqCst);
    }

    /// Record a successfully executed statement. No-op in auto-commit mode.
    pub fn note_executed(&self, effect: TxEffect) {
        if !self.manual() {
            return;
        }
        match effect {
            TxEffect::Read => {}
            TxEffect::Write => {
                self.pending.fetch_add(1, Ordering::SeqCst);
                self.mark_open();
            }
            TxEffect::Begin => self.mark_open(),
            TxEffect::End | TxEffect::ImplicitCommit => self.reset(),
        }
    }

    pub fn status(&self, supported: bool) -> DbTxStatus {
        DbTxStatus {
            supported,
            manual: supported && self.manual(),
            pending: if supported {
                self.pending.load(Ordering::SeqCst)
            } else {
                0
            },
            generation: self.generation.load(Ordering::SeqCst),
        }
    }
}

/// Skip leading whitespace and comments (`--`, `/* */`, and `#` for MySQL).
fn skip_leading_comments(sql: &str, mysql: bool) -> &str {
    let mut rest = sql;
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else if mysql && rest.starts_with('#') {
            rest = rest.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, tail)| tail);
        } else {
            return rest;
        }
    }
}

fn words(sql: &str) -> impl Iterator<Item = String> + '_ {
    sql.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|word| !word.is_empty())
        .map(|word| word.to_ascii_uppercase())
}

/// Classify a single statement by its leading keyword.
pub fn classify(sql: &str, mysql: bool) -> TxEffect {
    let body = skip_leading_comments(sql, mysql);
    let mut tokens = words(body);
    let Some(first) = tokens.next() else {
        return TxEffect::Read;
    };
    let second = tokens.next();
    match first.as_str() {
        "COMMIT" | "END" | "ABORT" => TxEffect::End,
        "ROLLBACK" => match second.as_deref() {
            Some("TO") => TxEffect::Read,
            Some("WORK" | "TRANSACTION") if matches!(tokens.next().as_deref(), Some("TO")) => {
                TxEffect::Read
            }
            _ => TxEffect::End,
        },
        "BEGIN" => TxEffect::Begin,
        "START" if second.as_deref() == Some("TRANSACTION") => TxEffect::Begin,
        "SELECT" | "SHOW" | "EXPLAIN" | "DESC" | "DESCRIBE" | "USE" | "SET" | "VALUES"
        | "TABLE" | "SAVEPOINT" | "RELEASE" | "HELP" => TxEffect::Read,
        "WITH" => {
            let writes = words(body)
                .any(|word| matches!(word.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE"));
            if writes {
                TxEffect::Write
            } else {
                TxEffect::Read
            }
        }
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" if mysql => {
            TxEffect::ImplicitCommit
        }
        _ => TxEffect::Write,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_leading_keyword() {
        assert_eq!(classify("select 1", true), TxEffect::Read);
        assert_eq!(
            classify("  -- note\n/* x */ SHOW TABLES", true),
            TxEffect::Read
        );
        assert_eq!(
            classify("# mysql\ninsert into t values (1)", true),
            TxEffect::Write
        );
        assert_eq!(classify("update t set a = 1", false), TxEffect::Write);
        assert_eq!(classify("commit", true), TxEffect::End);
        assert_eq!(classify("END", false), TxEffect::End);
        assert_eq!(classify("rollback", false), TxEffect::End);
        assert_eq!(classify("ROLLBACK TO SAVEPOINT s1", false), TxEffect::Read);
        assert_eq!(classify("rollback work to s1", true), TxEffect::Read);
        assert_eq!(classify("start transaction", true), TxEffect::Begin);
        assert_eq!(classify("begin", false), TxEffect::Begin);
        assert_eq!(
            classify("with x as (select 1) select * from x", false),
            TxEffect::Read
        );
        assert_eq!(
            classify(
                "with d as (delete from t returning *) select * from d",
                false
            ),
            TxEffect::Write
        );
        assert_eq!(classify("", true), TxEffect::Read);
    }

    #[test]
    fn ddl_commits_implicitly_only_on_mysql() {
        assert_eq!(
            classify("create table t (id int)", true),
            TxEffect::ImplicitCommit
        );
        assert_eq!(classify("TRUNCATE t", true), TxEffect::ImplicitCommit);
        assert_eq!(classify("create table t (id int)", false), TxEffect::Write);
    }

    #[test]
    fn counts_writes_only_in_manual_mode() {
        let tx = TxState::default();
        tx.note_executed(TxEffect::Write);
        assert_eq!(tx.status(true).pending, 0);

        tx.set_manual(true);
        tx.note_executed(TxEffect::Read);
        tx.note_executed(TxEffect::Write);
        tx.note_executed(TxEffect::Write);
        assert_eq!(tx.status(true).pending, 2);
        assert!(tx.open());
        tx.note_executed(TxEffect::End);
        assert_eq!(tx.status(true).pending, 0);
        assert!(!tx.open());

        tx.note_executed(TxEffect::Write);
        tx.note_executed(TxEffect::ImplicitCommit);
        assert_eq!(tx.status(true).pending, 0);
        tx.note_executed(TxEffect::Begin);
        assert!(tx.open());
    }

    #[test]
    fn new_connection_bumps_generation_and_clears_pending() {
        let tx = TxState::default();
        tx.on_new_connection();
        tx.set_manual(true);
        tx.note_executed(TxEffect::Write);
        let before = tx.status(true);
        assert_eq!((before.generation, before.pending), (1, 1));

        tx.on_new_connection();
        let after = tx.status(true);
        assert_eq!(
            (after.generation, after.pending, after.manual),
            (2, 0, true)
        );
        assert!(!tx.open());
    }

    #[test]
    fn unsupported_engines_report_auto_mode() {
        let tx = TxState::default();
        tx.set_manual(true);
        let status = tx.status(false);
        assert!(!status.supported && !status.manual);
        assert_eq!(status.pending, 0);
    }
}
