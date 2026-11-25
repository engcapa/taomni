//! Resolve the data owner before accessing drafts, server-copy metadata or the Outbox.
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use taomni_mail_api::{LOCAL_DRAFTS, RemoteDraftLocation};
use taomni_mail_storage::draft_import::DraftImport;
use taomni_mail_storage::drafts::{
    DraftAction, DraftRequest, MailDraft, MailDraftSaveRequest, delete_mail_draft, get_mail_draft,
    list_mail_drafts, replace_remote_location, save_mail_draft,
};

use super::module_host;
use crate::state::AppState;

pub(crate) async fn is_hosted(state: &AppState, account: &str) -> Result<bool, String> {
    super::local_storage::is_hosted(state, account, LOCAL_DRAFTS).await
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
    module_host::local_mailbox(state.plugins.clone(), LOCAL_DRAFTS, request, move || {
        let (replace_staged, rows) = super::local_storage::import_source(
            &core,
            &registry,
            migrated,
            &root,
            &account,
            taomni_mail_storage::draft_import::read_account,
        )?;
        Ok(DraftImport {
            replace_staged,
            rows: rows.unwrap_or_default(),
        })
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
) -> Result<Vec<taomni_mail_storage::drafts::DraftSearchEntry>, String> {
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
