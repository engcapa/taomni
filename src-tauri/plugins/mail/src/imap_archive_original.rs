//! Serve verified originals from the regular IMAP reader's archive.

use std::io::{self, Seek};

use taomni_mail_api::{
    archive_original::{ImapArchiveAction, ImapArchiveRequest, MAX_ARCHIVE_ORIGINAL_REQUEST},
    imap_exchange::{AttachmentReceipt, read_bounded_body_frame, write_body_frame},
};
use taomni_mail_engine::{
    extract_attachment, extract_attachment_section,
    storage::{self, OpenMessage},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::{
    io::{AsyncRead, AsyncWriteExt},
    net::TcpStream,
    runtime::Runtime,
};

use super::{
    account_cache::lock_account_cache,
    store::{open_database, open_snapshot_file, unavailable, validate_account},
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
    let bytes = runtime
        .block_on(operation.while_current(read_bounded_body_frame(
            &mut peer,
            MAX_ARCHIVE_ORIGINAL_REQUEST,
        )))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let request: ImapArchiveRequest = serde_json::from_slice(&bytes)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    validate_account(&request.account_id)?;
    if request.folder.trim().is_empty() || request.uid == 0 {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    operation.check_current()?;
    let Some(original) = open(&request)? else {
        return send(runtime, operation, &mut peer, None, tokio::io::empty());
    };
    let check = || operation.check_current().map_err(|error| error.message);
    match request.action {
        ImapArchiveAction::SaveOriginal => {
            // Staging keeps archive validation streaming even for very large EML files.
            let mut staging = tempfile::tempfile().map_err(|_| unavailable())?;
            let size = original
                .copy_verified(&mut staging, check)
                .map_err(invalid_state)?;
            staging.rewind().map_err(|_| unavailable())?;
            let size = usize::try_from(size).map_err(|_| unavailable())?;
            send(
                runtime,
                operation,
                &mut peer,
                Some(original_receipt(size)),
                tokio::fs::File::from_std(staging),
            )
        }
        ImapArchiveAction::ViewSource => {
            let raw = original.read_with(check).map_err(invalid_state)?;
            send(
                runtime,
                operation,
                &mut peer,
                Some(original_receipt(raw.len())),
                raw.as_slice(),
            )
        }
        ImapArchiveAction::Attachment { index, section } => {
            let raw = original.read_with(check).map_err(invalid_state)?;
            let attachment = match section.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(section) => extract_attachment_section(&raw, section),
                None => extract_attachment(&raw, index),
            }
            .map_err(invalid_state)?;
            let receipt = AttachmentReceipt {
                name: attachment.name,
                content_type: attachment.content_type,
                size: attachment.bytes.len(),
            };
            send(
                runtime,
                operation,
                &mut peer,
                Some(receipt),
                attachment.bytes.as_slice(),
            )
        }
    }
}

fn open(request: &ImapArchiveRequest) -> Result<Option<OpenMessage>, RpcError> {
    let _access =
        lock_account_cache(&request.database, &request.account_id).map_err(invalid_state)?;
    let db = open_database(&request.database)?;
    storage::open_with(
        &db,
        &request.account_id,
        &request.folder,
        request.uid,
        |path| open_snapshot_file(path).map_err(|error| error.message),
    )
    .map_err(invalid_state)
}

fn original_receipt(size: usize) -> AttachmentReceipt {
    AttachmentReceipt {
        name: None,
        content_type: Some("message/rfc822".into()),
        size,
    }
}

pub(super) fn send(
    runtime: &Runtime,
    operation: &Operation,
    peer: &mut TcpStream,
    receipt: Option<AttachmentReceipt>,
    mut source: impl AsyncRead + Unpin,
) -> Result<Result<(), String>, RpcError> {
    let expected = receipt.as_ref().map_or(0, |value| value.size as u64);
    let header =
        serde_json::to_vec(&receipt).map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
    Ok(runtime
        .block_on(operation.while_current(async {
            write_body_frame(peer, &header).await?;
            let copied = tokio::io::copy(&mut source, peer).await?;
            if copied != expected {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Incomplete Mail archive read",
                ));
            }
            peer.shutdown().await
        }))?
        .map_err(|error| error.to_string()))
}

fn invalid_state(error: String) -> RpcError {
    RpcError::new(ErrorCode::InvalidState, error)
}
