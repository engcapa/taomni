//! Commit IMAP folder metadata inside the signed host.

use rusqlite::OpenFlags;
use taomni_mail_api::{
    folder_cache::FolderCacheUpdate,
    imap_exchange::{read_frame, write_body_frame},
    message::MailFolder,
};
use taomni_mail_engine::cache::update_folder_cache_in_transaction;
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
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    let bytes = runtime
        .block_on(while_current(operation, read_frame(&mut peer)))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let request = serde_json::from_slice(&bytes)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let folders = apply(request, &|| operation.check_current())?;
    let reply = serde_json::to_vec(&folders).map_err(|_| unavailable())?;
    runtime
        .block_on(while_current(
            operation,
            write_body_frame(&mut peer, &reply),
        ))?
        .map_err(|_| unavailable())?;
    Ok(Ok(()))
}

fn apply(
    request: FolderCacheUpdate,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Vec<MailFolder>, RpcError> {
    let FolderCacheUpdate {
        account_id,
        database,
        action,
        folders,
    } = request;
    validate_account(&account_id)?;
    if folders.iter().any(|folder| folder.account_id != account_id) {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "Mail module returned folders for a different account",
        ));
    }
    check()?;
    let _access = lock_account_cache(&database, &account_id)
        .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
    let mut database = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    apply_change(&mut database, check, |transaction| {
        update_folder_cache_in_transaction(transaction, &account_id, action, folders)
            .map_err(|_| unavailable())
    })
}

#[cfg(test)]
mod tests;
