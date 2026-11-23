//! Validate the account's selected cache before accessing it from the signed host.

use std::path::Path;

use serde::de::DeserializeOwned;
use taomni_mail_api::imap_exchange::read_body_frame;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::runtime::Runtime;

use taomni_mail_engine::database::{ProcessLock, mail_db_file_stem, redirect_path};

use super::{incoming::while_current, store::open_snapshot_file};

pub(super) fn lock_account_cache(database: &Path, account: &str) -> Result<ProcessLock, String> {
    let filename = format!("{}.db", mail_db_file_stem(account));
    if !database.is_absolute()
        || database.file_name().and_then(|name| name.to_str()) != Some(&filename)
    {
        return Err("Invalid Mail archive storage path".into());
    }
    // The host owns this lease through the SQLite operation, even
    // if the desktop stops waiting. Reject a path relocated before acquisition.
    let lease = ProcessLock::access(database)?;
    if redirect_path(database)
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        return Err("Mail storage moved before this archive operation. Retry storage".into());
    }
    open_snapshot_file(database).map_err(|error| error.message)?;
    Ok(lease)
}

pub(super) fn receive_update<T: DeserializeOwned>(
    runtime: &Runtime,
    operation: &Operation,
    endpoint: Endpoint,
) -> Result<Result<T, String>, RpcError> {
    let (mut peer, _) = match runtime.block_on(while_current(operation, endpoint.connect()))? {
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    let bytes = runtime
        .block_on(while_current(operation, read_body_frame(&mut peer)))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    serde_json::from_slice(&bytes)
        .map(Ok)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))
}
