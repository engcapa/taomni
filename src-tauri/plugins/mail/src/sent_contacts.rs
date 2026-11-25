use rusqlite::OpenFlags;
use taomni_mail_api::sent_contacts::SentContactsUpdate;
use taomni_mail_engine::cache::upsert_sent_contacts;
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
) -> Result<Result<usize, String>, RpcError> {
    match receive_update(runtime, operation, endpoint)? {
        Ok(request) => record(request, &|| operation.check_current()).map(Ok),
        Err(error) => Ok(Err(error)),
    }
}

fn record(
    request: SentContactsUpdate,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<usize, RpcError> {
    let SentContactsUpdate {
        account_id,
        database,
        recipients,
    } = request;
    validate_account(&account_id)?;
    check()?;
    let _cache = lock_account_cache(&database, &account_id)
        .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
    let mut db = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    apply_change(&mut db, check, |db| {
        upsert_sent_contacts(db, &account_id, recipients.iter().map(String::as_str))
            .map_err(|_| unavailable())
    })
}

#[cfg(test)]
mod tests;
