//! Execute the IMAP header step over the core's authorized route.

use taomni_mail_api::{
    MailIncomingProtocol,
    folder_sync::{HeaderSync, read_frame, write_frame},
};
use taomni_mail_engine::imap_sync::HeaderStepRequest;
use taomni_mail_engine::imap_transport::imap_catch_result;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::runtime::Runtime;

use super::incoming::{open_imap, while_current, with_socket};

pub(super) fn run(
    runtime: &Runtime,
    operation: &Operation,
    request: HeaderSync,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Imap {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let (mut exchange, _) =
        match runtime.block_on(while_current(operation, request.exchange.connect()))? {
            Ok(stream) => stream,
            Err(error) => return Ok(Err(error)),
        };
    let frame = runtime
        .block_on(while_current(operation, read_frame(&mut exchange)))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let step: HeaderStepRequest = serde_json::from_slice(&frame)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    if step.account_id.trim().is_empty() || step.folder.trim().is_empty() {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let outcome = with_socket(
        runtime,
        operation,
        request.connection,
        move |stream, input| imap_catch_result(|| open_imap(stream, &input)?.sync_headers(&step)),
    )?;
    let frame =
        serde_json::to_vec(&outcome).map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
    let sent = runtime.block_on(while_current(operation, write_frame(&mut exchange, &frame)))?;
    Ok(sent.map_err(|error| format!("Return Mail sync result: {error}")))
}
