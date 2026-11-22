//! Execute a body-inclusive sync using the core's approved network and file routes.

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, MailIncomingProtocol,
    imap_exchange::{
        ImapExchange, read_frame,
        sync::{save_original, write_sync_reply},
    },
};
use taomni_mail_engine::{imap_sync::BodySyncRequest, imap_transport::imap_catch_result};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::runtime::Runtime;

use super::incoming::{open_imap, with_socket_and_reply};

pub(super) fn serve(
    runtime: &Runtime,
    operation: &Operation,
    exchange: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    if exchange.connection.protocol != MailIncomingProtocol::Imap {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let mut peer = match runtime.block_on(operation.while_current(exchange.exchange.connect()))? {
        Ok((peer, _)) => peer,
        Err(error) => return Ok(Err(error)),
    };
    let frame = match runtime.block_on(operation.while_current(read_frame(&mut peer)))? {
        Ok(frame) => frame,
        Err(error) => return Ok(Err(error.to_string())),
    };
    let request: BodySyncRequest = serde_json::from_slice(&frame)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let (account, folder) = request.task.mailbox();
    if account.trim().is_empty() || folder.trim().is_empty() {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let socket_error = |_| RpcError::new(ErrorCode::InternalError, "MAIL_SYNC_REPLY_UNAVAILABLE");
    let mut peer = peer.into_std().map_err(socket_error)?;
    peer.set_nonblocking(false).map_err(socket_error)?;
    peer.set_read_timeout(Some(HOST_REQUEST_TIMEOUT))
        .map_err(socket_error)?;
    peer.set_write_timeout(Some(HOST_REQUEST_TIMEOUT))
        .map_err(socket_error)?;
    let interrupt = peer.try_clone().map_err(socket_error)?;
    with_socket_and_reply(
        runtime,
        operation,
        exchange.connection,
        Some(interrupt),
        move |stream, connection| {
            let result = imap_catch_result(|| {
                let mut session = open_imap(stream, &connection)?;
                session.sync_with_bodies(&request, |uid, original: &[u8]| {
                    if request.save_original {
                        save_original(&mut peer, uid, original).map_err(|error| {
                            format!("Save Mail original through desktop: {error}")
                        })?
                    } else {
                        Ok(())
                    }
                })
            });
            let outcome = serde_json::to_vec(&result).map_err(|error| error.to_string())?;
            write_sync_reply(&mut peer, &outcome)
                .map_err(|error| format!("Return Mail sync result: {error}"))
        },
    )
}
