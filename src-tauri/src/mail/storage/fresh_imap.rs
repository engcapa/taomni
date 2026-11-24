//! Assign an unused account ID to the module while saving a new IMAP session.

use std::{fs, io::ErrorKind, path::Path};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use taomni_mail_api::{INITIALIZE_IMAP_MAILBOX, SLUG};
use taomni_mail_storage::database::{
    ProcessLock, configured_directory, mail_db_file_stem, redirect_path,
};

use crate::{
    plugin::{LifecycleState, retained_data},
    session::{db, models::SessionConfig},
    state::AppState,
};

pub(super) fn reserve_save(state: &AppState, account: &str) -> Result<Option<ProcessLock>, String> {
    if !supports_initialization(state) && !state.has_owned_imap_mailbox(account)? {
        return Ok(None);
    }
    // The module control directory holds the short save lock outside portable
    // data. Both custom-directory and default saves of this ID share it.
    let control = state
        .plugins
        .root()
        .join(SLUG)
        .join(format!("{}.settings", mail_db_file_stem(account)));
    ProcessLock::access(&control).map(Some)
}

fn supports_initialization(state: &AppState) -> bool {
    state.plugins.get(SLUG).is_some_and(|record| {
        record.state == LifecycleState::Enabled
            && record.manifest.commands.contains(INITIALIZE_IMAP_MAILBOX)
    })
}

pub(super) fn save(
    state: &AppState,
    config: &SessionConfig,
    target_root: &Path,
) -> Result<bool, String> {
    let account = &config.id;
    let routing = state.legacy.mail.route_gate(account);
    let _route = routing.lock().map_err(|error| error.to_string())?;
    let owned = state.has_owned_imap_mailbox(account)?;
    let legacy_root = state.mail_cache_root();
    if !owned
        && (target_root != legacy_root
            || !new_imap_options(&config.options_json)?
            || !supports_initialization(state)
            || state.legacy.mail.uses_legacy_handle(account)?)
    {
        return Ok(false);
    }

    let mut main_db = state.core.db.lock().map_err(|error| error.to_string())?;
    save_session(
        &mut main_db,
        config,
        target_root,
        legacy_root,
        owned,
        || {
            let stem = mail_db_file_stem(account);
            if legacy_files_exist(legacy_root, &stem)?
                || retained_data::load(state.plugins.root(), SLUG)
                    .map_err(|error| error.to_string())?
                    .is_some_and(|locator| {
                        let database = format!("{stem}.db");
                        locator.files.iter().any(|file| file.path == database)
                    })
            {
                return Ok(false);
            }
            let result = state
                .plugins
                .invoke(
                    SLUG,
                    INITIALIZE_IMAP_MAILBOX,
                    serde_json::json!({"accountId": account}),
                )
                .map_err(|error| error.to_string())?;
            result
                .as_bool()
                .ok_or_else(|| "Invalid Mail account initialization response".into())
        },
    )
}

fn save_session(
    database: &mut Connection,
    config: &SessionConfig,
    target_root: &Path,
    legacy_root: &Path,
    owned: bool,
    initialize: impl FnOnce() -> Result<bool, String>,
) -> Result<bool, String> {
    // Reserve the session ID across instances before the host can publish its
    // account. A cancelled host request rolls back the settings save.
    let transaction = database
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let original = db::get_session(&transaction, &config.id)
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(original) = original {
        if !owned {
            return Ok(false);
        }
        if configured_directory(&original.options_json, legacy_root)? != target_root {
            return Err(
                "This mailbox is stored by the Mail module. Keep its original storage directory."
                    .into(),
            );
        }
    } else if !owned && !initialize()? {
        return Ok(false);
    }
    db::save_session(&transaction, config).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

fn new_imap_options(options: &str) -> Result<bool, String> {
    let options: serde_json::Value =
        serde_json::from_str(options).map_err(|error| error.to_string())?;
    Ok(options
        .get("mailIncoming")
        .is_none_or(|kind| kind.as_str() == Some("imap")))
}

fn legacy_files_exist(root: &Path, stem: &str) -> Result<bool, String> {
    let database = root.join(format!("{stem}.db"));
    for path in [
        database.clone(),
        redirect_path(&database),
        database.with_extension("generation"),
        database.with_extension("access.lock"),
        root.join(format!("{stem}.db-wal")),
        root.join(format!("{stem}.db-shm")),
        root.join(format!("{stem}.db-journal")),
        root.join(format!("{stem}.mail")),
        root.join("attachments").join(stem),
    ] {
        match fs::symlink_metadata(path) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests;
