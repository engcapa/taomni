//! Read and export verified archived originals from the current account cache.

use std::{
    io::{Seek, Write},
    path::Path,
};

use taomni_mail_api::{
    archive_index::ArchiveEntry,
    archive_original::{ArchiveOriginalRequest, MAX_ARCHIVE_ORIGINAL_REQUEST},
    imap_exchange::{read_bounded_body_frame, write_body_frame},
    pop3_store::LocalArchiveAction,
};
use taomni_mail_engine::{
    extract_attachment,
    storage::{self, OpenMessage},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::{io::AsyncWriteExt, net::TcpStream, runtime::Runtime};

use super::{
    account_cache::lock_account_cache,
    archive_decoding::encode_body,
    store::{open_database, unavailable, validate_account},
};

pub(super) fn serve(
    runtime: &Runtime,
    operation: &Operation,
    endpoint: Endpoint,
) -> Result<Result<(), String>, RpcError> {
    let (mut peer, _) = match runtime.block_on(operation.while_current(endpoint.connect()))? {
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    let request = runtime
        .block_on(operation.while_current(read_bounded_body_frame(
            &mut peer,
            MAX_ARCHIVE_ORIGINAL_REQUEST,
        )))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let ArchiveOriginalRequest {
        account_id,
        database,
        action,
    } = serde_json::from_slice(&request)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    validate_account(&account_id)?;
    operation.check_current()?;

    match action {
        LocalArchiveAction::Read { entry } => {
            let original = open(&database, &account_id, &entry)?;
            let body = original
                .read_with(|| operation.check_current().map_err(|error| error.message))
                .map_err(invalid_state)?;
            operation.check_current()?;
            let reply = encode_body(&account_id, &entry.folder, entry.uid, &body)?;
            Ok(runtime
                .block_on(operation.while_current(write_body_frame(&mut peer, &reply)))?
                .map_err(|error| error.to_string()))
        }
        LocalArchiveAction::Export {
            entry,
            attachment_index,
        } => {
            let original = open(&database, &account_id, &entry)?;
            send_export(runtime, operation, original, attachment_index, &mut peer)
        }
        _ => Err(RpcError::from_code(ErrorCode::InvalidParams)),
    }
}

fn open(database: &Path, account: &str, entry: &ArchiveEntry) -> Result<OpenMessage, RpcError> {
    let _access = lock_account_cache(database, account).map_err(invalid_state)?;
    let db = open_database(database)?;
    storage::open_entry(&db, account, entry).map_err(invalid_state)
}

/// Validate the entire original before sending its length and bytes. The core
/// owns the destination file and only publishes it after the transfer succeeds.
pub(super) fn send_export(
    runtime: &Runtime,
    operation: &Operation,
    original: OpenMessage,
    attachment_index: Option<usize>,
    peer: &mut TcpStream,
) -> Result<Result<(), String>, RpcError> {
    let mut staging = tempfile::tempfile().map_err(|_| unavailable())?;
    let check = || operation.check_current().map_err(|error| error.message);
    let length = if let Some(index) = attachment_index {
        let raw = original.read_with(check).map_err(invalid_state)?;
        let attachment = extract_attachment(&raw, index).map_err(invalid_state)?;
        staging
            .write_all(&attachment.bytes)
            .map_err(|_| unavailable())?;
        attachment.bytes.len() as u64
    } else {
        original
            .copy_verified(&mut staging, check)
            .map_err(invalid_state)?
    };
    staging.rewind().map_err(|_| unavailable())?;
    let mut file = tokio::fs::File::from_std(staging);
    runtime
        .block_on(operation.while_current(async {
            peer.write_u64(length).await?;
            tokio::io::copy(&mut file, peer).await
        }))?
        .map_err(|_| unavailable())?;
    Ok(Ok(()))
}

fn invalid_state(error: String) -> RpcError {
    RpcError::new(ErrorCode::InvalidState, error)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use taomni_mail_engine::{cache::init_mail_tables, database::mail_db_file_stem};

    use super::*;

    #[test]
    fn checks_the_account_path_and_exact_archived_generation() {
        let root = tempfile::tempdir().unwrap();
        let account = "archive-test";
        let database = root
            .path()
            .canonicalize()
            .unwrap()
            .join(format!("{}.db", mail_db_file_stem(account)));
        let raw = b"Subject: Retained original\r\n\r\nRead the retained cache";
        let db = Connection::open(&database).unwrap();
        init_mail_tables(&db).unwrap();
        storage::store(&db, account, "Archive", 7, 31, &raw[..]).unwrap();
        let mut entry = storage::list(&db, account, 0).unwrap().remove(0);

        assert_eq!(
            open(&database, account, &entry).unwrap().read().unwrap(),
            raw
        );
        assert!(open(&database, "another-account", &entry).is_err());
        entry.uid_validity = 32;
        assert!(open(&database, account, &entry).is_err());
    }
}
