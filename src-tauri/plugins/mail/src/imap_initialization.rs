//! Publish the first module-owned IMAP database and its account receipt.

use std::{fs, io::ErrorKind, path::Path};

use rusqlite::{Connection, params};
use taomni_mail_engine::{database::mail_db_file_stem, imap_ownership};
use taomni_plugin_api::RpcError;

use super::store::{
    Store, check_missing_sidecars, create_database, database_for, open_database, regular,
    unavailable, validate_account,
};

pub(super) fn initialize(
    store: &Store,
    account: &str,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<bool, RpcError> {
    validate_account(account)?;
    check()?;
    let _creation = store.creation.lock().map_err(|_| unavailable())?;
    let root = store.data_root(true)?.ok_or_else(unavailable)?;
    if imap_ownership::database(&root, account)
        .map_err(|_| unavailable())?
        .is_some()
    {
        return Ok(true);
    }
    let path = database_for(&root, account);
    if has_retained_files(&root, account)? {
        return Ok(false);
    }
    if regular(&path)? {
        // The row is created inside the staged SQLite snapshot. It authorizes
        // completing the receipt after a cancellation or interrupted save.
        if !initialization_pending(&open_database(&path)?, account).map_err(|_| unavailable())? {
            return Ok(false);
        }
    } else {
        check_missing_sidecars(&path)?;
        create_database(&path, check, |db| {
            db.execute(
                "CREATE TABLE mail_imap_initialization(account_id TEXT PRIMARY KEY)",
                [],
            )
            .map_err(|_| unavailable())?;
            db.execute("INSERT INTO mail_imap_initialization VALUES(?1)", [account])
                .map_err(|_| unavailable())?;
            Ok(())
        })?;
    }
    check()?;
    imap_ownership::mark_owned(&root, account).map_err(|_| unavailable())?;
    Ok(true)
}

fn initialization_pending(db: &Connection, account: &str) -> rusqlite::Result<bool> {
    let exists = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mail_imap_initialization')",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        return Ok(false);
    }
    db.query_row(
        "SELECT COUNT(*)=1 AND COALESCE(MIN(account_id), '')=?1 FROM mail_imap_initialization",
        params![account],
        |row| row.get(0),
    )
}

fn has_retained_files(root: &Path, account: &str) -> Result<bool, RpcError> {
    let stem = mail_db_file_stem(account);
    for path in [
        root.join(format!("{stem}.mail")),
        root.join("attachments").join(&stem),
        root.join(format!("{stem}.pop3-owner")),
    ] {
        match fs::symlink_metadata(path) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => (),
            Err(_) => return Err(unavailable()),
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests;
