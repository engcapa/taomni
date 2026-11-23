//! Full originals and cleanup belong to the same account as the POP3 ledger.

use std::time::{Duration, Instant};

use taomni_mail_api::{
    archive_index::{ArchiveEntry, ArchiveKey},
    pop3_store::LocalArchiveAction,
};
use taomni_mail_engine::{
    archive::compress_message,
    cache::cached_to_body,
    parse_body_message,
    pop3::local_store,
    storage::{self, query, scan},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{net::TcpStream, runtime::Runtime};

use super::{Store, encode, unavailable};
use crate::archive_original::send_export;

pub(super) fn execute(
    store: &Store,
    account: &str,
    action: LocalArchiveAction,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    use LocalArchiveAction::*;

    check()?;
    let db = store.open_writable_mailbox(account)?;
    match action {
        Paused => encode(&scan::is_paused(&db, account).map_err(|_| unavailable())?),
        Pause => encode(&scan::pause(&db, account).map_err(|_| unavailable())?),
        Begin { resume } => encode(&scan::begin(&db, account, resume).map_err(|_| unavailable())?),
        Pending => encode(&scan::pending_local(&db, account).map_err(|_| unavailable())?),
        Store { key } => encode(&save(&db, account, &key, check).map_err(invalid_state)?),
        Preview { selection } => {
            let preview = query::preview(&db, account, &selection).map_err(invalid_state)?;
            let mut previews = store.archive_previews.lock().map_err(|_| unavailable())?;
            previews.retain(|_, (_, expires)| Instant::now() < *expires);
            previews.insert(
                account.to_owned(),
                (db, Instant::now() + Duration::from_secs(600)),
            );
            encode(&preview)
        }
        Cleanup { token } => {
            let (preview, expires) = store
                .archive_previews
                .lock()
                .map_err(|_| unavailable())?
                .remove(account)
                .ok_or_else(expired_preview)?;
            if Instant::now() >= expires {
                return Err(expired_preview());
            }
            encode(&query::remove_preview(&preview, account, &token).map_err(invalid_state)?)
        }
        Remove { entries } => {
            scan::pause(&db, account).map_err(|_| unavailable())?;
            encode(&storage::remove_entries(&db, account, &entries).map_err(invalid_state)?)
        }
        Read { entry } => {
            let original = storage::open_entry(&db, account, &entry).map_err(invalid_state)?;
            let size = u32::try_from(original.raw_size()).ok();
            let raw = original
                .read_with(|| check().map_err(|error| error.message))
                .map_err(invalid_state)?;
            let parsed = parse_body_message(
                account,
                &entry.folder,
                entry.uid,
                size,
                &raw,
                8 * 1024 * 1024,
            );
            encode(&cached_to_body(parsed, "archive"))
        }
        Export { .. } => Err(RpcError::from_code(ErrorCode::InvalidParams)),
    }
}

pub(super) fn export(
    runtime: &Runtime,
    operation: &Operation,
    store: &Store,
    account: &str,
    entry: &ArchiveEntry,
    attachment_index: Option<usize>,
    peer: &mut TcpStream,
) -> Result<Result<(), String>, RpcError> {
    operation.check_current()?;
    store.require_pop3_owner(account)?;
    let db = store.open_writable_mailbox(account)?;
    let original = storage::open_entry(&db, account, entry).map_err(invalid_state)?;
    send_export(runtime, operation, original, attachment_index, peer)
}

fn save(
    db: &rusqlite::Connection,
    account: &str,
    key: &ArchiveKey,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<bool, String> {
    if key.uid_validity != 1 {
        return Err("Invalid local message generation".into());
    }
    let Some(raw) = local_store::read_local_raw(db, account, &key.folder, key.uid)
        .map_err(|e| e.to_string())?
    else {
        return Ok(false);
    };
    let root = storage::account_root(db, account)?;
    let progress = || check().map_err(|error| error.message);
    let prepared = storage::prepare_with(&root, |output| {
        compress_message(raw.as_slice(), output, progress)
    })?;
    scan::publish_original(db, account, key, prepared, progress)?;
    Ok(true)
}

fn expired_preview() -> RpcError {
    invalid_state(
        "The cleanup preview expired or its messages changed. Review the selection again".into(),
    )
}

fn invalid_state(error: String) -> RpcError {
    RpcError::new(ErrorCode::InvalidState, error)
}
