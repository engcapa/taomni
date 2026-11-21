//! Execute IMAP requests over the authorized account route.

use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    ImapFlagUpdate, MailIncomingProtocol,
    imap_exchange::{ImapExchange, read_frame, write_frame},
};
use taomni_mail_engine::imap_sync::{FolderRoundRequest, HeaderStepRequest};
use taomni_mail_engine::imap_transport::{ImapSession, imap_catch_result};
use taomni_mail_engine::search::ImapSearchRequest;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::runtime::Runtime;

use super::incoming::{open_imap, while_current, with_socket};

pub(super) fn sync_headers(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    transfer(
        runtime,
        operation,
        request,
        |session, step: HeaderStepRequest| {
            validate_folder(&step.account_id, &step.folder)?;
            session.sync_headers(&step)
        },
    )
}

pub(super) fn sync_round(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    transfer(
        runtime,
        operation,
        request,
        |session, step: FolderRoundRequest| {
            validate_folder(&step.folder.account_id, &step.folder.name)?;
            Ok(session.sync_header_round(&step))
        },
    )
}

pub(super) fn search(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    transfer(
        runtime,
        operation,
        request,
        |session, query: ImapSearchRequest| {
            validate_folder(&query.account_id, &query.folder)?;
            session.search_imap(&query)
        },
    )
}

pub(super) fn set_flags(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    transfer(
        runtime,
        operation,
        request,
        |session, update: ImapFlagUpdate| {
            if update.folder.trim().is_empty() || update.uids.contains(&0) {
                return Err("IMAP flag update requires a folder and valid UIDs".into());
            }
            session.set_flags(&update)
        },
    )
}

pub(super) fn list_unread(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    transfer(runtime, operation, request, |session, folder: String| {
        if folder.trim().is_empty() {
            return Err("IMAP unread lookup requires a folder".into());
        }
        session.unread_uids(&folder)
    })
}

fn validate_folder(account_id: &str, folder: &str) -> Result<(), String> {
    if account_id.trim().is_empty() || folder.trim().is_empty() {
        return Err("Mail IMAP requests require an account and folder".into());
    }
    Ok(())
}

fn transfer<T: DeserializeOwned + Send + 'static, R: Serialize + Send + 'static>(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
    work: impl FnOnce(&mut ImapSession, T) -> Result<R, String> + Send + 'static,
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
    let step = serde_json::from_slice(&frame)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let outcome = with_socket(
        runtime,
        operation,
        request.connection,
        move |stream, input| imap_catch_result(|| work(&mut open_imap(stream, &input)?, step)),
    )?;
    let frame =
        serde_json::to_vec(&outcome).map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
    let sent = runtime.block_on(while_current(operation, write_frame(&mut exchange, &frame)))?;
    Ok(sent.map_err(|error| format!("Return Mail IMAP result: {error}")))
}
