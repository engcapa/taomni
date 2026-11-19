//! Select the canonical MFA data store from the profile's migration or restore state.
use std::{fs, io::ErrorKind, path::Path};

use crate::plugin::{
    data_contract::open_regular,
    migration::MigrationJournal,
    retained_data::{self, DataFileKind},
};

pub(crate) fn uses_module_data(profile: &Path) -> Result<bool, String> {
    if MigrationJournal::profile_mfa_committed(profile)? {
        return Ok(true);
    }
    let plugins = profile.join("plugins");
    match fs::symlink_metadata(&plugins) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let restored_store = retained_data::load(&plugins, "mfa")
        .map_err(|error| error.to_string())?
        .is_some_and(|locator| {
            locator
                .files
                .iter()
                .any(|file| file.path == "mfa.db" && file.kind == DataFileKind::Sqlite)
        });
    // The restore transaction publishes the locator with the data. If an older
    // profile contains both stores, keep the established legacy accounts visible.
    Ok(restored_store && !legacy_has_accounts(profile)?)
}

pub(crate) fn legacy_has_accounts(profile: &Path) -> Result<bool, String> {
    let path = profile.join("mfa.db");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let file = open_regular(&path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() == 0 {
        return Ok(false);
    }
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Cannot check existing MFA data: {error}"))?;
    let has_table: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mfa_accounts')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !has_table {
        return Ok(false);
    }
    db.query_row("SELECT EXISTS(SELECT 1 FROM mfa_accounts)", [], |row| {
        row.get(0)
    })
    .map_err(|error| error.to_string())
}
