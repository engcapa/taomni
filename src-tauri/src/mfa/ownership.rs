//! Select the canonical MFA data store from the profile's migration or restore state.
use std::{fs, io::ErrorKind, path::Path};

use crate::plugin::{
    data_contract::{PluginDataRoot, open_regular},
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
    // A fresh profile can create module data without a migration journal. The
    // store stays authoritative across restart, including after uninstall.
    let root = PluginDataRoot::open(&plugins, "mfa").map_err(|error| error.to_string())?;
    let database = root.data.join("mfa.db");
    let module_store = match fs::symlink_metadata(&database) {
        Ok(_) => {
            root.open_file("mfa.db")
                .map_err(|error| error.to_string())?;
            true
        }
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };
    // Profiles with preexisting accounts still use their explicit migration.
    Ok((restored_store || module_store) && !legacy_has_accounts(profile)?)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopened_profile_uses_module_store_unless_legacy_accounts_still_need_migration() {
        let profile = tempfile::tempdir().unwrap();
        let data = profile.path().join("plugins/mfa/data");
        fs::create_dir_all(&data).unwrap();
        assert!(!uses_module_data(profile.path()).unwrap());
        rusqlite::Connection::open(data.join("mfa.db")).unwrap();
        assert!(uses_module_data(profile.path()).unwrap());

        let legacy = rusqlite::Connection::open(profile.path().join("mfa.db")).unwrap();
        legacy
            .execute("CREATE TABLE mfa_accounts(id TEXT PRIMARY KEY)", [])
            .unwrap();
        assert!(uses_module_data(profile.path()).unwrap());
        legacy
            .execute("INSERT INTO mfa_accounts VALUES ('legacy')", [])
            .unwrap();
        assert!(!uses_module_data(profile.path()).unwrap());
    }
}
