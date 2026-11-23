//! Write a decoded body using the Mail host's account lease.

use rusqlite::OpenFlags;
use taomni_mail_api::{
    body_cache::{ImapBodyCacheSource, ImapBodyPublication},
    imap_exchange::read_body_frame,
    message::MailMessageCached,
};
use taomni_mail_engine::cache::{cache_body_if_current_in_transaction, upsert_message_at};
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
) -> Result<Result<bool, String>, RpcError> {
    let (mut peer, _) = match runtime.block_on(while_current(operation, endpoint.connect()))? {
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    let bytes = runtime
        .block_on(while_current(operation, read_body_frame(&mut peer)))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let request = serde_json::from_slice(&bytes)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    apply(request, &|| operation.check_current()).map(Ok)
}

fn apply(
    request: ImapBodyPublication<MailMessageCached>,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<bool, RpcError> {
    let ImapBodyPublication {
        database,
        account_id,
        observed_at,
        source,
        message,
    } = request;
    validate_account(&account_id)?;
    if message.header.account_id != account_id
        || message.header.folder.trim().is_empty()
        || message.header.uid == 0
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    check()?;
    let _access = lock_account_cache(&database, &account_id)
        .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
    let mut db = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    apply_change(&mut db, check, |transaction| {
        match source {
            ImapBodyCacheSource::Opened => {
                upsert_message_at(transaction, &message, Some(observed_at)).map(|()| true)
            }
            ImapBodyCacheSource::Prefetched { uid_validity } => {
                cache_body_if_current_in_transaction(
                    transaction,
                    message,
                    uid_validity,
                    observed_at,
                )
            }
        }
        .map_err(|_| unavailable())
    })
}

#[cfg(test)]
mod tests;
