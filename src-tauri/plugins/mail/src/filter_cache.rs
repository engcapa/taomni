//! Select candidates and persist an IMAP folder's filter watermark.

use rusqlite::OpenFlags;
use taomni_mail_api::{
    filter_cache::{FilterCacheAction, FilterCandidates, ImapFilterCacheRequest},
    imap_exchange::{read_frame, write_body_frame},
};
use taomni_mail_engine::filters::{
    advance_filter_mark, ensure_filter_mark, select_filter_candidates,
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::runtime::Runtime;

use super::{
    account_cache::lock_account_cache,
    incoming::while_current,
    store::{apply_change, connect, unavailable, validate_account},
};

pub(super) fn serve(
    runtime: &Runtime,
    operation: &Operation,
    endpoint: Endpoint,
) -> Result<Result<(), String>, RpcError> {
    let (mut peer, _) = match runtime.block_on(while_current(operation, endpoint.connect()))? {
        Ok(pair) => pair,
        Err(error) => return Ok(Err(error)),
    };
    let bytes = runtime
        .block_on(while_current(operation, read_frame(&mut peer)))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let request = serde_json::from_slice(&bytes)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let result = apply(request, &|| operation.check_current())?;
    let bytes = serde_json::to_vec(&result).map_err(|_| unavailable())?;
    runtime
        .block_on(while_current(
            operation,
            write_body_frame(&mut peer, &bytes),
        ))?
        .map_err(|_| unavailable())?;
    Ok(Ok(()))
}

fn apply(
    request: ImapFilterCacheRequest,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Option<FilterCandidates>, RpcError> {
    let ImapFilterCacheRequest {
        account_id,
        database,
        action,
    } = request;
    validate_account(&account_id)?;
    let folder = match &action {
        FilterCacheAction::Candidates { folder, .. }
        | FilterCacheAction::Baseline { folder }
        | FilterCacheAction::Advance { folder, .. } => folder,
    };
    if folder.trim().is_empty() {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    check()?;
    let _access = lock_account_cache(&database, &account_id)
        .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
    let mut db = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    apply_change(&mut db, check, |db| {
        match action {
            FilterCacheAction::Candidates {
                folder,
                incoming,
                uids,
            } => select_filter_candidates(db, &account_id, &folder, incoming, uids).map(Some),
            FilterCacheAction::Baseline { folder } => {
                ensure_filter_mark(db, &account_id, &folder).map(|()| None)
            }
            FilterCacheAction::Advance {
                folder,
                uid,
                uid_validity,
            } => advance_filter_mark(db, &account_id, &folder, uid, uid_validity).map(|()| None),
        }
        .map_err(|_| unavailable())
    })
}

#[cfg(test)]
mod tests;
