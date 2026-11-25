//! Perform archive and cache maintenance inside the signed mailbox owner.

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use taomni_mail_api::{
    archive_scan::{ArchiveScanAction, ArchiveScanRequest, ArchiveScanStatus},
    imap_exchange::write_body_frame,
};
use taomni_mail_engine::{
    archive::scan_store::commit_headers_in_transaction,
    cache::{clear_cached_account, load_folder_sync_state},
    database::{MAIL_MUTATION_LOCK, ProcessLock},
    pop3::local_store::has_local_store,
    storage::scan,
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::runtime::Runtime;

use super::{
    account_cache::lock_account_cache,
    store::{apply_change, connect, unavailable, validate_account},
};

pub(super) fn serve(
    runtime: &Runtime,
    operation: &Operation,
    endpoint: Endpoint,
) -> Result<Result<(), String>, RpcError> {
    use taomni_mail_api::imap_exchange::read_body_frame;

    let (mut peer, _) = match runtime.block_on(operation.while_current(endpoint.connect()))? {
        Ok(pair) => pair,
        Err(error) => return Ok(Err(error)),
    };
    let bytes = runtime
        .block_on(operation.while_current(read_body_frame(&mut peer)))?
        .map_err(|_| invalid())?;
    let request = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let reply = execute(request, &|| operation.check_current())?;
    Ok(runtime
        .block_on(operation.while_current(write_body_frame(&mut peer, &reply)))?
        .map_err(|error| error.to_string()))
}

fn execute(
    request: ArchiveScanRequest,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    use ArchiveScanAction::*;

    let ArchiveScanRequest {
        account_id,
        database,
        action,
    } = request;
    validate_account(&account_id)?;
    check()?;
    let _access = lock_account_cache(&database, &account_id).map_err(state_error)?;
    check()?;

    if matches!(action, Status | FolderState { .. } | Pending { .. }) {
        let db = connect(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let reply = match action {
            Status => {
                let paused = scan::is_paused(&db, &account_id).map_err(|_| unavailable())?;
                let shared = ProcessLock::try_at(&database, "archive")
                    .map_err(state_error)?
                    .is_none();
                encode(&ArchiveScanStatus { paused, shared })
            }
            FolderState { folder } => {
                validate_folder(&folder)?;
                encode(
                    &load_folder_sync_state(&db, &account_id, &folder)
                        .map_err(|_| unavailable())?,
                )
            }
            Pending { folder } => {
                validate_folder(&folder)?;
                encode(&scan::pending_imap(&db, &account_id, &folder).map_err(|_| unavailable())?)
            }
            _ => unreachable!("read-only archive action"),
        }?;
        check()?;
        return Ok(reply);
    }

    let _mutation = if matches!(action, ClearCache) {
        Some(
            ProcessLock::try_at(&database, MAIL_MUTATION_LOCK)
                .map_err(state_error)?
                .ok_or_else(|| state_error("Mail is changing messages in this account. Retry when the operation finishes"))?,
        )
    } else {
        None
    };
    let mut db = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    apply_change(&mut db, check, |db| match action {
        Pause => {
            scan::pause(db, &account_id).map_err(|_| unavailable())?;
            encode(&())
        }
        Begin { resume } => {
            encode(&scan::begin(db, &account_id, resume).map_err(|_| unavailable())?)
        }
        CommitHeaders {
            outcome,
            body_recent_limit,
            started_at_ms,
        } => {
            let folder = &outcome.folder.name;
            validate_folder(folder)?;
            if outcome.folder.account_id != account_id
                || outcome.messages.iter().any(|message| {
                    let header = &message.header;
                    header.account_id != account_id || header.folder != *folder || header.uid == 0
                })
            {
                return Err(invalid());
            }
            require_running(db, &account_id)?;
            let count = commit_headers_in_transaction(
                db,
                &account_id,
                &outcome,
                body_recent_limit,
                started_at_ms,
            )
            .map_err(|_| unavailable())?;
            encode(&count)
        }
        Skip { key } => {
            validate_folder(&key.folder)?;
            if key.uid == 0 {
                return Err(invalid());
            }
            require_running(db, &account_id)?;
            scan::skip(db, &account_id, &key).map_err(|_| unavailable())?;
            encode(&())
        }
        ClearCache => {
            if has_local_store(db, &account_id).map_err(|_| unavailable())? {
                return Err(state_error(taomni_mail_api::archive_scan::POP3_CLEAR_ERROR));
            }
            clear_cached_account(db, &account_id).map_err(|_| unavailable())?;
            encode(&())
        }
        _ => unreachable!("writable archive action"),
    })
}

fn require_running(db: &Connection, account: &str) -> Result<(), RpcError> {
    if scan::is_paused(db, account).map_err(|_| unavailable())? {
        return Err(state_error(scan::PAUSED));
    }
    Ok(())
}

fn validate_folder(folder: &str) -> Result<(), RpcError> {
    if folder.trim().is_empty() {
        return Err(invalid());
    }
    Ok(())
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>, RpcError> {
    serde_json::to_vec(value).map_err(|_| RpcError::from_code(ErrorCode::InternalError))
}

fn invalid() -> RpcError {
    RpcError::from_code(ErrorCode::InvalidParams)
}

fn state_error(error: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InvalidState, error)
}

#[cfg(test)]
mod tests;
