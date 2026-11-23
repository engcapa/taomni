//! Validate the account's selected cache before accessing it from the signed host.

use std::path::Path;

use taomni_mail_engine::database::{ProcessLock, mail_db_file_stem, redirect_path};

use super::store::open_snapshot_file;

pub(super) fn lock_account_cache(database: &Path, account: &str) -> Result<ProcessLock, String> {
    let filename = format!("{}.db", mail_db_file_stem(account));
    if !database.is_absolute()
        || database.file_name().and_then(|name| name.to_str()) != Some(&filename)
    {
        return Err("Invalid Mail archive storage path".into());
    }
    // The host owns this lease through the SQLite operation, even
    // if the desktop stops waiting. Reject a path relocated before acquisition.
    let lease = ProcessLock::access(database)?;
    if redirect_path(database)
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        return Err("Mail storage moved before this archive operation. Retry storage".into());
    }
    open_snapshot_file(database).map_err(|error| error.message)?;
    Ok(lease)
}
