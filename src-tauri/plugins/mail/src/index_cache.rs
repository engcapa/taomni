//! Commit IMAP progress, cached headers and consistent UID watermarks together.

use rusqlite::OpenFlags;
use taomni_mail_api::{
    imap_index::{AppliedStep, ImapIndexAction, ImapIndexPublication},
    imap_sync::FolderStepOutcome,
};
use taomni_mail_engine::cache::{
    MailCacheSettings, apply_folder_round_in_transaction, apply_folder_step_in_transaction,
    cache_sync_result_in_transaction, record_folder_error,
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::runtime::Runtime;

use super::{
    account_cache::{lock_account_cache, receive_update},
    store::{apply_change, connect, unavailable, validate_account},
};

pub(super) fn serve(
    runtime: &Runtime,
    operation: &Operation,
    endpoint: Endpoint,
) -> Result<Result<Option<AppliedStep>, String>, RpcError> {
    let request = match receive_update(runtime, operation, endpoint)? {
        Ok(request) => request,
        Err(error) => return Ok(Err(error)),
    };
    apply(request, &|| operation.check_current()).map(Ok)
}

fn apply(
    request: ImapIndexPublication<ImapIndexAction>,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Option<AppliedStep>, RpcError> {
    let ImapIndexPublication {
        account_id,
        database,
        retention,
        started_at_ms,
        action,
    } = request;
    validate_account(&account_id)?;
    if !scope_matches(&account_id, &action) {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    check()?;
    let _access = lock_account_cache(&database, &account_id)
        .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
    let mut db = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let cache = MailCacheSettings {
        header_retention_days: retention.header_retention_days,
        header_limit_per_folder: retention.header_limit_per_folder,
        body_recent_limit: retention.body_recent_limit,
        ..MailCacheSettings::default()
    };
    apply_change(&mut db, check, |db| {
        match action {
            ImapIndexAction::Page {
                folders,
                messages,
                selected,
                listed,
            } => cache_sync_result_in_transaction(
                db,
                &account_id,
                &folders,
                &messages,
                &selected,
                &cache,
                listed,
            )
            .map(|()| None),
            ImapIndexAction::Step { outcome } => {
                apply_folder_step_in_transaction(db, &account_id, &outcome, &cache, started_at_ms)
                    .map(Some)
            }
            ImapIndexAction::Round {
                folder,
                steps,
                error,
            } => apply_folder_round_in_transaction(
                db,
                &folder,
                &steps,
                &cache,
                started_at_ms,
                error.as_deref(),
            )
            .map(|()| None),
            ImapIndexAction::Failure { folder, error } => {
                record_folder_error(db, &account_id, &folder, &error).map(|()| None)
            }
        }
        .map_err(|_| unavailable())
    })
}

fn scope_matches(account_id: &str, action: &ImapIndexAction) -> bool {
    match action {
        ImapIndexAction::Page {
            folders,
            messages,
            selected,
            ..
        } => {
            !selected.trim().is_empty()
                && folders.iter().all(|folder| folder.account_id == account_id)
                && messages.iter().all(|message| {
                    let header = &message.header;
                    header.account_id == account_id && header.folder == *selected && header.uid != 0
                })
        }
        ImapIndexAction::Step { outcome } => {
            step_matches(account_id, &outcome.folder.name, outcome)
        }
        ImapIndexAction::Round { folder, steps, .. } => {
            folder.account_id == account_id
                && !folder.name.trim().is_empty()
                && steps
                    .iter()
                    .all(|step| step_matches(account_id, &folder.name, step))
        }
        ImapIndexAction::Failure { folder, .. } => !folder.trim().is_empty(),
    }
}

fn step_matches(account_id: &str, folder: &str, step: &FolderStepOutcome) -> bool {
    step.folder.account_id == account_id
        && step.folder.name == folder
        && !folder.trim().is_empty()
        && step.messages.iter().all(|message| {
            let header = &message.header;
            header.account_id == account_id && header.folder == folder && header.uid != 0
        })
}

#[cfg(test)]
mod tests;
