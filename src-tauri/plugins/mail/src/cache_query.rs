//! Read account folders, message pages, search results and cached bodies for the desktop.

use std::io::{self, Write};

use serde::Serialize;
use taomni_mail_api::{
    cache_query::{
        CacheQuery, CacheQueryRequest, MAX_CACHE_QUERY_BYTES, MAX_CACHE_REPLY_BYTES,
        MAX_CACHED_MESSAGE_PAGE,
    },
    imap_exchange::{read_bounded_body_frame, write_body_frame},
    message::MailMessageBody,
};
use taomni_mail_engine::{cache, search::search_cached_messages, storage};
use taomni_plugin_api::{ErrorCode, RpcError, services::CoreServiceError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::{CancellationToken, routed_tcp::Endpoint};
use tokio::runtime::Runtime;

use super::{
    account_cache::lock_account_cache,
    archive_decoding::archived_body,
    store::{open_database, open_snapshot_file, unavailable, validate_account},
};

pub(super) fn serve(
    runtime: &Runtime,
    operation: &Operation,
    method: &str,
    endpoint: Endpoint,
) -> Result<Result<(), String>, RpcError> {
    let (mut peer, _) = match runtime.block_on(operation.while_current(endpoint.connect()))? {
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    let request = runtime
        .block_on(
            operation.while_current(read_bounded_body_frame(&mut peer, MAX_CACHE_QUERY_BYTES)),
        )?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let request: CacheQueryRequest = serde_json::from_slice(&request)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    if request.query.host_method() != method {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let reply = runtime.block_on(async {
        let cancellation = CancellationToken::new();
        let mut task = tokio::task::spawn_blocking({
            let cancellation = cancellation.clone();
            move || execute(request, cancellation)
        });
        match operation.while_current(&mut task).await {
            Ok(result) => result.map_err(|_| RpcError::from_code(ErrorCode::InternalError))?,
            Err(error) => {
                cancellation.cancel();
                let _ = task.await;
                Err(error)
            }
        }
    })?;
    Ok(runtime
        .block_on(operation.while_current(write_body_frame(&mut peer, &reply)))?
        .map_err(|error| error.to_string()))
}

fn execute(
    request: CacheQueryRequest,
    cancellation: CancellationToken,
) -> Result<Vec<u8>, RpcError> {
    let CacheQueryRequest {
        account_id,
        database,
        query,
    } = request;
    validate_account(&account_id)?;
    check(&cancellation)?;
    let access = lock_account_cache(&database, &account_id)
        .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
    check(&cancellation)?;
    let db = open_database(&database)?;
    let progress = cancellation.clone();
    db.progress_handler(1_000, Some(move || progress.is_cancelled()))
        .map_err(|_| unavailable())?;

    // A response larger than the transfer limit fails without a partial page.
    match query {
        CacheQuery::Folders => {
            serialize_result(cache::list_cached_folders(&db, &account_id), &cancellation)
        }
        CacheQuery::Messages {
            folder,
            limit,
            offset,
        } => serialize_result(
            cache::list_cached_messages(
                &db,
                &account_id,
                &folder,
                limit.min(MAX_CACHED_MESSAGE_PAGE),
                offset,
            ),
            &cancellation,
        ),
        CacheQuery::Search(query) => serialize_result(
            search_cached_messages(&db, &account_id, &query),
            &cancellation,
        ),
        CacheQuery::Body {
            folder,
            uid,
            cache_enabled,
        } => {
            let original = storage::open_with(&db, &account_id, &folder, uid, |path| {
                open_snapshot_file(path).map_err(|error| error.message)
            })
            .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
            if let Some(original) = original {
                // The open file stays valid if cleanup or relocation removes its
                // directory entry. MIME verification leaves the account unlocked.
                drop(db);
                drop(access);
                let raw =
                    original.read_with(|| check(&cancellation).map_err(|error| error.message));
                check(&cancellation)?;
                let raw = raw.map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
                let body = archived_body(&account_id, &folder, uid, &raw);
                serialize_result(Ok(Some(body)), &cancellation)
            } else {
                let cached = if cache_enabled {
                    cache::get_cached_body(&db, &account_id, &folder, uid)
                } else {
                    Ok(None::<MailMessageBody>)
                };
                serialize_result(cached, &cancellation)
            }
        }
    }
}

fn check(token: &CancellationToken) -> Result<(), RpcError> {
    if token.is_cancelled() {
        Err(CoreServiceError::Cancelled.into_rpc_error())
    } else {
        Ok(())
    }
}

fn serialize_result<T: Serialize>(
    result: rusqlite::Result<T>,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, RpcError> {
    check(cancellation)?;
    let rows = result.map_err(|_| unavailable())?;
    encode(&rows, MAX_CACHE_REPLY_BYTES as usize)
}

fn encode<T: Serialize>(rows: &T, limit: usize) -> Result<Vec<u8>, RpcError> {
    let mut reply = BoundedReply {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut reply, rows).map_err(|error| {
        if error.io_error_kind() == Some(io::ErrorKind::FileTooLarge) {
            RpcError::new(
                ErrorCode::InvalidState,
                "Mail cache result is too large. Narrow the search or use a smaller message page",
            )
        } else {
            RpcError::from_code(ErrorCode::InternalError)
        }
    })?;
    Ok(reply.bytes)
}

struct BoundedReply {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for BoundedReply {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        if input.len() > self.limit - self.bytes.len() {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        self.bytes.extend_from_slice(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
