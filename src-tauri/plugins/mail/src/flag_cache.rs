//! Apply IMAP server acknowledgements without reopening the cache in the core.

use rusqlite::OpenFlags;
use taomni_mail_api::imap_flag_cache::{ImapFlagCacheAction, ImapFlagPublication};
use taomni_mail_engine::cache::{reconcile_cached_read, update_cached_flags};
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
) -> Result<Result<(), String>, RpcError> {
    let request = match receive_update(runtime, operation, endpoint)? {
        Ok(request) => request,
        Err(error) => return Ok(Err(error)),
    };
    apply(request, &|| operation.check_current()).map(Ok)
}

fn apply(
    request: ImapFlagPublication,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<(), RpcError> {
    let ImapFlagPublication {
        account_id,
        database,
        action,
    } = request;
    validate_account(&account_id)?;
    let (folder, uids) = match &action {
        ImapFlagCacheAction::Update { flags } => (&flags.folder, &flags.uids),
        ImapFlagCacheAction::Read { folder, uids, .. } => (folder, uids),
    };
    if folder.trim().is_empty() || uids.contains(&0) {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    check()?;
    let _access = lock_account_cache(&database, &account_id)
        .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
    let mut db = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    apply_change(&mut db, check, |db| {
        match action {
            ImapFlagCacheAction::Update { flags } => update_cached_flags(
                db,
                &account_id,
                &flags.folder,
                &flags.uids,
                &flags.add,
                &flags.remove,
            ),
            ImapFlagCacheAction::Read {
                folder,
                uids,
                remaining,
            } => reconcile_cached_read(db, &account_id, &folder, &uids, remaining),
        }
        .map_err(|_| unavailable())
    })
}

#[cfg(test)]
mod tests;
