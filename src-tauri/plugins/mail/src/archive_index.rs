//! Evaluate archive searches over the account's current SQLite index.

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use taomni_mail_api::{
    archive_index::{ArchiveIndexAction, ArchiveIndexRequest, ArchiveIndexSource},
    imap_exchange::{read_frame, write_body_frame},
};
use taomni_mail_engine::{database::mail_db_file_stem, storage};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::{io::AsyncWriteExt, runtime::Runtime};

use super::store::{Store, open_database, open_snapshot_file, unavailable};

pub(super) fn query(
    runtime: &Runtime,
    store: &Store,
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
    let input = serde_json::from_slice::<ArchiveIndexRequest>(&request)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    operation.check_current()?;
    let result = execute(store, &input)?;
    operation.check_current()?;
    Ok(runtime
        .block_on(operation.while_current(write_body_frame(&mut peer, &result)))?
        .map_err(|error| error.to_string()))
}

fn execute(store: &Store, input: &ArchiveIndexRequest) -> Result<Vec<u8>, RpcError> {
    let account = &input.account_id;
    let read = |db: &Connection| match &input.action {
        ArchiveIndexAction::Find { query, offset } => {
            encode(storage::query::query(db, account, query, *offset))
        }
        ArchiveIndexAction::List { offset } => encode(storage::list(db, account, *offset)),
    };
    match &input.source {
        ArchiveIndexSource::AccountCache { database } => {
            let db = open_account_cache(database, account)?;
            read(&db)
        }
        ArchiveIndexSource::ModuleData => {
            if let Some(bytes) = store.query(account, |db| Ok(Some(read(db))))? {
                return bytes;
            }
            let db = Connection::open_in_memory().map_err(|_| unavailable())?;
            storage::init_tables(&db).map_err(|_| unavailable())?;
            read(&db)
        }
    }
}

fn open_account_cache(database: &Path, account: &str) -> Result<Connection, RpcError> {
    let filename = format!("{}.db", mail_db_file_stem(account));
    if !database.is_absolute()
        || database.file_name().and_then(|name| name.to_str()) != Some(&filename)
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    // The private core route resolves relocation under the account cache lease.
    // Match the account basename and check the file before opening read-only.
    let _file = open_snapshot_file(database)?;
    open_database(database)
}

fn encode<T: Serialize>(result: Result<T, String>) -> Result<Vec<u8>, RpcError> {
    serde_json::to_vec(&result).map_err(|_| RpcError::from_code(ErrorCode::InternalError))
}

#[cfg(test)]
mod tests;
