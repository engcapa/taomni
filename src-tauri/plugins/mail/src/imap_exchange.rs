//! Execute IMAP requests over the authorized account route.

use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    ImapFlagUpdate, MailIncomingProtocol,
    imap_exchange::{ImapExchange, RawMessageRequest, read_frame, write_body_frame, write_frame},
};
use taomni_mail_engine::imap_sync::{FolderRoundRequest, HeaderStepRequest};
use taomni_mail_engine::imap_transport::{
    ImapBodyReply, ImapBodyRequest, ImapSession, imap_catch_result,
};
use taomni_mail_engine::search::ImapSearchRequest;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::io::AsyncWriteExt;
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

pub(super) fn fetch_raw(
    runtime: &Runtime,
    operation: &Operation,
    request: RawMessageRequest,
) -> Result<Result<usize, String>, RpcError> {
    let RawMessageRequest {
        connection,
        exchange,
        folder,
        uid,
    } = request;
    if connection.protocol != MailIncomingProtocol::Imap || folder.trim().is_empty() || uid == 0 {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let mut output = match runtime.block_on(while_current(operation, exchange.connect()))? {
        Ok((output, _)) => output,
        Err(error) => return Ok(Err(error)),
    };
    let raw = match with_socket(runtime, operation, connection, move |stream, input| {
        imap_catch_result(|| open_imap(stream, &input)?.fetch_raw(&folder, uid))
    })? {
        Ok(raw) => raw,
        Err(error) => return Ok(Err(error)),
    };
    let written = runtime.block_on(while_current(operation, output.write_all(&raw)))?;
    Ok(written
        .map(|()| raw.len())
        .map_err(|error| format!("Return original message: {error}")))
}

pub(super) fn fetch_body(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    transfer_with_original(
        runtime,
        operation,
        request,
        ReplyEncoding::MessageBody,
        |session, input: ImapBodyRequest| {
            validate_folder(&input.account_id, &input.folder)?;
            if input.uid == 0 {
                return Err("IMAP body lookup requires a valid UID".into());
            }
            let (message, original) = session.fetch_body(&input)?;
            let reply = ImapBodyReply {
                message,
                original_size: original.as_ref().map(Vec::len),
            };
            Ok((reply, original))
        },
    )
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
    transfer_with_original(
        runtime,
        operation,
        request,
        ReplyEncoding::Standard,
        move |session, input| work(session, input).map(|result| (result, None)),
    )
}

enum ReplyEncoding {
    Standard,
    MessageBody,
}

fn transfer_with_original<T: DeserializeOwned + Send + 'static, R: Serialize + Send + 'static>(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
    encoding: ReplyEncoding,
    work: impl FnOnce(&mut ImapSession, T) -> Result<(R, Option<Vec<u8>>), String> + Send + 'static,
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
    let (outcome, original) = match outcome {
        Ok((result, original)) => (Ok(result), original),
        Err(error) => (Err(error), None),
    };
    let frame =
        serde_json::to_vec(&outcome).map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
    let sent = runtime.block_on(while_current(operation, async {
        match encoding {
            ReplyEncoding::Standard => write_frame(&mut exchange, &frame).await?,
            ReplyEncoding::MessageBody => write_body_frame(&mut exchange, &frame).await?,
        }
        if let Some(original) = original {
            write_frame(&mut exchange, &original).await?;
        }
        Ok::<_, std::io::Error>(())
    }))?;
    Ok(sent.map_err(|error| format!("Return Mail IMAP result: {error}")))
}
