//! One-use bulk transfer for account data that has moved to the Mail host.
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use taomni_mail_api::{
    MailboxRequest,
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::{io::AsyncWriteExt, runtime::Runtime};

use super::{
    incoming::while_current,
    store::{Store, unavailable},
};

pub(super) fn serve<A: DeserializeOwned, I: DeserializeOwned>(
    io: &Runtime,
    store: &Store,
    operation: &Operation,
    endpoint: Endpoint,
    owned: fn(&Connection, &str) -> rusqlite::Result<bool>,
    adopt: fn(&Connection, &str, I) -> rusqlite::Result<()>,
    execute: fn(
        &Store,
        MailboxRequest<A>,
        &dyn Fn() -> Result<(), RpcError>,
    ) -> Result<Vec<u8>, RpcError>,
) -> Result<Result<(), String>, RpcError> {
    let (mut peer, _) = match io.block_on(while_current(operation, endpoint.connect()))? {
        Ok(pair) => pair,
        Err(error) => return Ok(Err(error)),
    };
    let bytes = io
        .block_on(while_current(operation, read_body_frame(&mut peer)))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let input: MailboxRequest<A> = serde_json::from_slice(&bytes)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    operation.check_current()?;
    let account = &input.account_id;
    let needs_import = !store.query(account, |db| owned(db, account))?;
    io.block_on(while_current(
        operation,
        peer.write_u8(u8::from(needs_import)),
    ))?
    .map_err(|_| unavailable())?;
    if needs_import {
        let import = io
            .block_on(while_current(operation, read_body_frame(&mut peer)))?
            .map_err(|_| unavailable())?;
        let source: I = serde_json::from_slice(&import)
            .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
        store.mutate(account, true, &|| operation.check_current(), |db| {
            adopt(db, account, source).map_err(|_| unavailable())
        })?;
    }
    let bytes = execute(store, input, &|| operation.check_current())?;
    io.block_on(while_current(
        operation,
        write_body_frame(&mut peer, &bytes),
    ))?
    .map_err(|_| unavailable())?;
    Ok(Ok(()))
}
