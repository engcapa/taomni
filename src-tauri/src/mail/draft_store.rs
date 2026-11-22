//! Resolve the data owner before accessing drafts, server-copy metadata or the Outbox.
use rusqlite::{Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use std::path::Path;
use taomni_mail_api::{LOCAL_DRAFTS, RemoteDraftLocation};
use taomni_mail_engine::draft_import::DraftImport;
use taomni_mail_engine::{
    database::{configured_directory, mail_db_file_stem},
    drafts::{
        DraftAction, DraftRequest, MailDraft, MailDraftSaveRequest, delete_mail_draft,
        get_mail_draft, list_mail_drafts, replace_remote_location, save_mail_draft,
    },
};

use super::module_host;
use crate::{
    plugin::{
        LifecycleState, PluginRegistry,
        data_contract::PluginDataRoot,
        retained_data::{self, DataFileKind},
    },
    state::{AppState, CoreState},
};

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

fn import_source(
    core: &CoreState,
    registry: &PluginRegistry,
    migrated: Result<bool, String>,
    legacy_root: &Path,
    account: &str,
) -> Result<DraftImport, String> {
    let migrated = migrated?;
    let filename = format!("{}.db", mail_db_file_stem(account));
    if restored_mailbox(registry, &filename)? {
        return Ok(DraftImport::default());
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
    let rows = taomni_mail_engine::migration::legacy_drafts(&directory.join(filename), account)?;
    Ok(DraftImport {
        replace_staged: migrated && rows.is_some(),
        rows: rows.unwrap_or_default(),
    })
}

pub(crate) async fn is_hosted(state: &AppState, account: &str) -> Result<bool, String> {
    // Keeping an older Mail package during a core-only update preserves the
    // same desktop cache it used before streaming draft operations existed.
    if let Some(record) = state.plugins.get("mail") {
        return Ok(record.state != LifecycleState::Enabled
            || record.manifest.commands.contains(LOCAL_DRAFTS));
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

async fn hosted<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: DraftAction,
) -> Result<T, String> {
    let core = state.core.clone();
    let registry = state.plugins.clone();
    let migrated = state.legacy.mail.migrated.clone();
    let root = state.mail_cache_root().to_owned();
    let account = account.to_owned();
    let request = DraftRequest {
        account_id: account.clone(),
        action,
    };
    module_host::local_drafts(state.plugins.clone(), request, move || {
        import_source(&core, &registry, migrated, &root, &account)
    })
    .await
}

pub(crate) async fn list(state: &AppState, account: &str) -> Result<Vec<MailDraft>, String> {
    run(
        state,
        account,
        (),
        |()| DraftAction::List,
        |db, account, ()| list_mail_drafts(db, account),
    )
    .await
}

pub(crate) async fn hosted_search_index(
    state: &AppState,
    account: &str,
) -> Result<Vec<taomni_mail_engine::drafts::DraftSearchEntry>, String> {
    if !state
        .plugins
        .get("mail")
        .is_some_and(|record| record.state == crate::plugin::LifecycleState::Enabled)
    {
        return Ok(Vec::new());
    }
    hosted(state, account, DraftAction::SearchIndex).await
}

pub(super) async fn get(
    state: &AppState,
    account: &str,
    id: &str,
) -> Result<Option<MailDraft>, String> {
    run(
        state,
        account,
        id.to_owned(),
        |id| DraftAction::Get { id },
        |db, account, id| get_mail_draft(db, account, &id),
    )
    .await
}

pub(super) async fn save(
    state: &AppState,
    account: &str,
    draft: MailDraftSaveRequest,
) -> Result<MailDraft, String> {
    run(
        state,
        account,
        draft,
        |draft| DraftAction::Save { draft },
        save_mail_draft,
    )
    .await
}

pub(super) async fn delete(state: &AppState, account: &str, id: String) -> Result<(), String> {
    run(
        state,
        account,
        id,
        |id| DraftAction::Delete { id },
        |db, account, id| delete_mail_draft(db, account, &id),
    )
    .await
}

pub(super) async fn set_location(
    state: &AppState,
    account: &str,
    id: String,
    previous: Option<RemoteDraftLocation>,
    next: Option<RemoteDraftLocation>,
) -> Result<Option<MailDraft>, String> {
    run(
        state,
        account,
        (id, previous, next),
        |(id, previous, next)| DraftAction::SetLocation { id, previous, next },
        |db, account, (id, previous, next)| {
            let tx = db.unchecked_transaction()?;
            let draft =
                replace_remote_location(&tx, account, &id, previous.as_ref(), next.as_ref())?;
            tx.commit()?;
            Ok(draft)
        },
    )
    .await
}

async fn run<A: Send + 'static, T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    args: A,
    action: impl FnOnce(A) -> DraftAction + Send,
    legacy: impl FnOnce(&Connection, &str, A) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, String> {
    if is_hosted(state, account).await? {
        hosted(state, account, action(args)).await
    } else {
        super::mail_db_task(
            state.mail_db(account)?,
            account.to_owned(),
            move |db, account| legacy(db, account, args),
        )
        .await
    }
}
