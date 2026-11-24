//! Choose the single authoritative account store before a POP3 operation.

use rusqlite::{Connection, Result as SqlResult};
use serde::de::DeserializeOwned;
use taomni_mail_api::pop3_store::{LOCAL_MAILBOX, LocalMailboxAction, SYNC_OWNED_MAILBOX};

use super::{mail_db_task, module_host};
use crate::{
    plugin::{LifecycleState, data_contract::PluginDataRoot},
    state::AppState,
};

pub(crate) async fn is_hosted(state: &AppState, account: &str) -> Result<bool, String> {
    let directory = state.plugins.root().to_path_buf();
    let account = account.to_owned();
    let migrated = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        receipt_exists(&directory, &account)
    })
    .await
    .map_err(|e| e.to_string())??;
    if !migrated {
        return Ok(false);
    }
    let active = state
        .plugins
        .get("mail")
        .filter(|entry| entry.state == LifecycleState::Enabled)
        .ok_or("Enable the Mail module to open this POP3 mailbox")?;
    if supports_account_store(&active.manifest.commands) {
        Ok(true)
    } else {
        Err("Update the Mail module to open this POP3 mailbox".into())
    }
}

fn supports_account_store(commands: &std::collections::BTreeSet<String>) -> bool {
    [
        LOCAL_MAILBOX,
        SYNC_OWNED_MAILBOX,
        taomni_mail_api::archive_index::QUERY_ARCHIVE_INDEX,
    ]
    .into_iter()
    .all(|method| commands.contains(method))
}

pub(super) fn receipt_exists(plugins: &std::path::Path, account: &str) -> Result<bool, String> {
    if !plugins.try_exists().map_err(|e| e.to_string())? {
        return Ok(false);
    }
    let data = PluginDataRoot::open(plugins, "mail").map_err(|e| e.to_string())?;
    taomni_mail_storage::pop3::ownership::is_owned(&data.data, account).map_err(|e| e.to_string())
}

/// Older modular profiles can keep an untransferred mailbox in their original
/// storage. First-use accounts may take ownership directly when no such
/// account data exists.
pub(super) async fn prepare_fresh(state: &AppState, account: &str) -> Result<bool, String> {
    let _authority = state
        .legacy
        .mail
        .pop3_owner_gate(account)
        .lock_owned()
        .await;
    prepare_locked(state, account).await
}

pub(super) async fn prepare_locked(state: &AppState, account: &str) -> Result<bool, String> {
    if is_hosted(state, account).await? {
        return Ok(true);
    }
    if !state.plugins.get("mail").is_some_and(|entry| {
        entry.state == LifecycleState::Enabled && supports_account_store(&entry.manifest.commands)
    }) {
        return Ok(false);
    }
    let core = state.core.clone();
    let registry = state.plugins.clone();
    let root = state.mail_cache_root().to_owned();
    let migrated = state.legacy.mail.migrated.clone();
    let legacy_account = account.to_owned();
    let has_data = tokio::task::spawn_blocking(move || {
        super::local_storage::import_source(
            &core,
            &registry,
            migrated,
            &root,
            &legacy_account,
            has_local_account_data,
        )
        .map(|(_, bytes)| bytes.unwrap_or(false))
    })
    .await
    .map_err(|error| error.to_string())??;
    if has_data {
        return Ok(false);
    }
    hosted::<()>(state, account, LocalMailboxAction::Initialize).await?;
    Ok(true)
}

fn has_local_account_data(db: &Connection, account: &str) -> SqlResult<bool> {
    for table in [
        "mail_folders",
        "mail_messages",
        "mail_local_raw",
        "mail_pop3_uidl",
        "mail_full_messages",
        "mail_archive_skipped",
        "mail_archive_preferences",
        "mail_filter_marks",
        "mail_contacts",
    ] {
        let present: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )?;
        if present
            && db.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE account_id=?1)"),
                [account],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) async fn hosted<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: LocalMailboxAction,
) -> Result<T, String> {
    module_host::pop3_store::run(state.plugins.clone(), account, action).await
}

pub(crate) async fn run_legacy<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: LocalMailboxAction,
) -> Result<T, String> {
    module_host::pop3_store::run_legacy(
        state.plugins.clone(),
        state.mail_db(account)?,
        account,
        action,
    )
    .await
}

#[cfg(not(any(test, feature = "legacy-mail-pop3")))]
pub(super) fn legacy_unavailable(registry: &crate::plugin::PluginRegistry) -> String {
    if registry
        .get("mail")
        .is_some_and(|entry| entry.state == LifecycleState::Enabled)
    {
        "Update the Mail module to open this POP3 mailbox".into()
    } else {
        super::SIGNED_MAIL_CONNECTION_REQUIRED.into()
    }
}

pub(super) async fn run<T>(
    state: &AppState,
    account: &str,
    action: LocalMailboxAction,
    legacy: impl FnOnce(&Connection, &str) -> SqlResult<T> + Send + 'static,
) -> Result<T, String>
where
    T: DeserializeOwned + Send + 'static,
{
    let _authority = state
        .legacy
        .mail
        .pop3_owner_gate(account)
        .lock_owned()
        .await;
    if is_hosted(state, account).await? {
        return hosted(state, account, action).await;
    }
    if module_host::pop3_store::supports_legacy(&state.plugins) {
        return run_legacy(state, account, action).await;
    }
    mail_db_task(state.mail_db(account)?, account.to_owned(), legacy).await
}

#[cfg(not(any(test, feature = "legacy-mail-pop3")))]
pub(super) async fn run_with_host<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: LocalMailboxAction,
) -> Result<T, String> {
    let _authority = state
        .legacy
        .mail
        .pop3_owner_gate(account)
        .lock_owned()
        .await;
    if is_hosted(state, account).await? {
        return hosted(state, account, action).await;
    }
    if module_host::pop3_store::supports_legacy(&state.plugins) {
        return run_legacy(state, account, action).await;
    }
    Err(legacy_unavailable(&state.plugins))
}

pub(super) async fn with_account_owner<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: LocalMailboxAction,
    unowned: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let _authority = state
        .legacy
        .mail
        .pop3_owner_gate(account)
        .lock_owned()
        .await;
    if is_hosted(state, account).await? {
        return hosted(state, account, action).await;
    }
    unowned.await
}
