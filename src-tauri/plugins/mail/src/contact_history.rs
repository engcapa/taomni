use rusqlite::OpenFlags;
use serde_json::Value;
use taomni_mail_api::contact_history::{
    ContactHistoryAction, ContactHistoryRequest, MAX_CONTACT_SUGGESTIONS,
};
use taomni_mail_engine::cache::{reindex_cached_contacts, search_contacts};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::runtime::Runtime;

use super::{
    account_cache::{lock_account_cache, receive_update},
    store::{apply_change, connect, open_database, unavailable, validate_account},
};

pub(super) fn serve(
    runtime: &Runtime,
    operation: &Operation,
    endpoint: Endpoint,
) -> Result<Result<Value, String>, RpcError> {
    match receive_update(runtime, operation, endpoint)? {
        Ok(request) => apply(request, &|| operation.check_current()).map(Ok),
        Err(error) => Ok(Err(error)),
    }
}

pub(super) fn apply(
    request: ContactHistoryRequest,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Value, RpcError> {
    let ContactHistoryRequest {
        account_id,
        database,
        action,
    } = request;
    validate_account(&account_id)?;
    check()?;
    let _cache = lock_account_cache(&database, &account_id)
        .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
    check()?;
    let result = match action {
        ContactHistoryAction::Reindex => {
            let mut db = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
            let count = apply_change(&mut db, check, |db| {
                reindex_cached_contacts(db, &account_id).map_err(|_| unavailable())
            })?;
            serde_json::to_value(count)
        }
        ContactHistoryAction::Search { query, limit } => {
            let db = open_database(&database)?;
            let contacts =
                search_contacts(&db, &account_id, &query, limit.min(MAX_CONTACT_SUGGESTIONS))
                    .map_err(|_| unavailable())?;
            check()?;
            serde_json::to_value(contacts)
        }
    };
    result.map_err(|_| unavailable())
}
