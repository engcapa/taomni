//! Locate the authoritative legacy or restored mailbox during first module access.
use crate::{
    plugin::{
        LifecycleState, PluginRegistry,
        data_contract::PluginDataRoot,
        retained_data::{self, DataFileKind},
    },
    state::{AppState, CoreState},
};
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;
use taomni_mail_storage::database::{configured_directory, mail_db_file_stem};

fn restored_mailbox(registry: &PluginRegistry, filename: &str) -> Result<bool, String> {
    Ok(retained_data::load(&registry.root(), "mail")
        .map_err(|e| e.to_string())?
        .is_some_and(|locator| {
            locator
                .files
                .iter()
                .any(|file| file.kind == DataFileKind::Sqlite && file.path == filename)
        }))
}

pub(super) fn import_source<T>(
    core: &CoreState,
    registry: &PluginRegistry,
    migrated: Result<bool, String>,
    legacy_root: &Path,
    account: &str,
    read: impl FnOnce(&Connection, &str) -> rusqlite::Result<T>,
) -> Result<(bool, Option<T>), String> {
    let migrated = migrated?;
    let filename = format!("{}.db", mail_db_file_stem(account));
    if restored_mailbox(registry, &filename)? {
        return Ok((false, None));
    }
    let db = core.db.lock().map_err(|e| e.to_string())?;
    let options: Option<String> = db
        .query_row(
            "SELECT options_json FROM sessions WHERE id=?1",
            [account],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    drop(db);
    let directory = configured_directory(options.as_deref().unwrap_or("{}"), legacy_root)?;
    let rows = taomni_mail_storage::migration::read_legacy_mailbox(
        &directory.join(filename),
        account,
        read,
    )?;
    Ok((migrated && rows.is_some(), rows))
}

pub(super) async fn is_hosted(
    state: &AppState,
    account: &str,
    method: &str,
) -> Result<bool, String> {
    // Keeping an older Mail package during a core-only update preserves the
    // same desktop cache it used before streaming draft operations existed.
    if let Some(record) = state.plugins.get("mail") {
        return Ok(
            record.state != LifecycleState::Enabled || record.manifest.commands.contains(method)
        );
    }
    if state.legacy.mail.migrated.clone()? {
        return Ok(true);
    }
    let registry = state.plugins.clone();
    let filename = format!("{}.db", mail_db_file_stem(account));
    tokio::task::spawn_blocking(move || {
        let plugins = registry.root();
        if !plugins.try_exists().map_err(|e| e.to_string())? {
            return Ok(false);
        }
        let data = PluginDataRoot::open(plugins, "mail").map_err(|e| e.to_string())?;
        if restored_mailbox(&registry, &filename)? {
            return Ok(true);
        }
        data.data
            .join(filename)
            .try_exists()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
