//! The signed host publishes verified objects for the selected account cache.

use rusqlite::OpenFlags;
use taomni_mail_api::{
    archive::PublishArchiveOriginal,
    imap_exchange::{read_frame, write_frame},
};
use taomni_mail_engine::storage::{open_staged_original, scan};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::{io::AsyncWriteExt, runtime::Runtime};

use super::{
    account_cache::lock_account_cache,
    store::{connect, open_snapshot_file},
};

pub(super) fn publish(
    runtime: &Runtime,
    operation: &Operation,
    endpoint: Endpoint,
) -> Result<Result<(), String>, RpcError> {
    let (mut peer, _) = match runtime.block_on(operation.while_current(endpoint.connect()))? {
        Ok(pair) => pair,
        Err(error) => return Ok(Err(error.to_string())),
    };
    let request = runtime
        .block_on(operation.while_current(async {
            peer.write_u8(1).await?;
            read_frame(&mut peer).await
        }))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let request = serde_json::from_slice(&request)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let result = publish_request(request, || {
        operation.check_current().map_err(|error| error.message)
    });
    let reply =
        serde_json::to_vec(&result).map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
    Ok(runtime
        .block_on(operation.while_current(write_frame(&mut peer, &reply)))?
        .map_err(|error| error.to_string()))
}

fn publish_request(
    request: PublishArchiveOriginal,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    if request.key.folder.trim().is_empty() || request.key.uid == 0 {
        return Err("Invalid Mail archive key".into());
    }
    check()?;
    let _access = lock_account_cache(&request.cache_database, &request.account_id)?;
    check()?;
    let db = connect(&request.cache_database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| error.message)?;
    let prepared = open_staged_original(&db, &request.account_id, request.staged, |path| {
        open_snapshot_file(path).map_err(|error| error.message)
    })?;
    scan::publish_original(&db, &request.account_id, &request.key, prepared, check).map(drop)
}

#[cfg(test)]
mod tests;
