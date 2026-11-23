//! The archive scanner reads and advances a mailbox through its owning store.

use rusqlite::{Connection, params};

use crate::{
    cache::{MailCacheSettings, apply_folder_step_in_transaction, load_folder_sync_state},
    database::MailDatabase,
    imap_sync::{FolderStepOutcome, FolderSyncState},
    storage::{query::ArchiveKey, scan},
};

pub trait ArchiveScanStore {
    fn folder_state(&self, account: &str, folder: &str) -> Result<FolderSyncState, String>;
    fn commit_headers(
        &self,
        account: &str,
        outcome: FolderStepOutcome,
        body_recent_limit: u32,
        started_at_ms: i64,
    ) -> Result<u32, String>;
    fn pending(&self, account: &str, folder: &str) -> Result<(u32, Vec<u32>), String>;
    fn skip(&self, account: &str, key: &ArchiveKey) -> Result<(), String>;
}

impl ArchiveScanStore for MailDatabase {
    fn folder_state(&self, account: &str, folder: &str) -> Result<FolderSyncState, String> {
        let db = self.lock()?;
        load_folder_sync_state(&db, account, folder).map_err(|error| error.to_string())
    }

    fn commit_headers(
        &self,
        account: &str,
        outcome: FolderStepOutcome,
        body_recent_limit: u32,
        started_at_ms: i64,
    ) -> Result<u32, String> {
        let db = self.lock()?;
        let tx = db
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        let count =
            commit_headers_in_transaction(&tx, account, &outcome, body_recent_limit, started_at_ms)
                .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(count)
    }

    fn pending(&self, account: &str, folder: &str) -> Result<(u32, Vec<u32>), String> {
        let db = self.lock()?;
        scan::pending_imap(&db, account, folder).map_err(|error| error.to_string())
    }

    fn skip(&self, account: &str, key: &ArchiveKey) -> Result<(), String> {
        let db = self.lock()?;
        scan::skip(&db, account, key).map_err(|error| error.to_string())
    }
}

/// The archive keeps its complete header index and retains the configured body limit.
pub fn commit_headers_in_transaction(
    db: &Connection,
    account: &str,
    outcome: &FolderStepOutcome,
    body_recent_limit: u32,
    started_at_ms: i64,
) -> rusqlite::Result<u32> {
    let settings = MailCacheSettings {
        header_limit_per_folder: 0,
        header_retention_days: 0,
        body_recent_limit,
        ..MailCacheSettings::default()
    };
    apply_folder_step_in_transaction(db, account, outcome, &settings, started_at_ms)?;
    db.query_row(
        "SELECT COUNT(*) FROM mail_messages WHERE account_id=?1 AND folder=?2",
        params![account, outcome.folder.name],
        |row| row.get(0),
    )
}
