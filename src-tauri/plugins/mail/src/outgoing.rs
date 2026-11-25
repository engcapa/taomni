use taomni_mail_api::{
    ImapDraftDiscard, ImapDraftStore, ImapSentCopy, MailIncomingProtocol, MimeUpload,
    RemoteDraftLocation, SmtpConnection, SmtpDelivery, SmtpResponse,
};
use taomni_mail_engine::imap_transport::imap_catch_result;
use taomni_mail_engine::smtp::{check_routed_connection, send_routed_message};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::io::AsyncReadExt;
use tokio::runtime::Runtime;

use super::incoming::{open_imap, while_current, with_socket};

pub(super) fn check(
    runtime: &Runtime,
    operation: &Operation,
    request: SmtpConnection,
) -> Result<Result<(), String>, RpcError> {
    validate_connection(&request)?;
    let result = runtime.block_on(super::incoming::while_current(operation, async {
        let (stream, _) = request.route.connect().await?;
        check_routed_connection(stream, &request).await
    }))?;
    operation.check_current()?;
    Ok(result)
}

pub(super) fn send(
    runtime: &Runtime,
    operation: &Operation,
    request: SmtpDelivery,
) -> Result<Result<String, String>, RpcError> {
    validate_connection(&request.connection)?;
    let result = runtime.block_on(super::incoming::while_current(
        operation,
        send_routed_message(request),
    ))?;
    Ok(result.map(|response| format!("{response:?}")))
}

pub(super) fn respond(
    runtime: &Runtime,
    operation: &Operation,
    request: SmtpResponse,
) -> Result<Result<(), String>, RpcError> {
    validate_connection(&request.connection)?;
    let bytes = match receive_mime(runtime, operation, request.content)? {
        Ok(bytes) => bytes,
        Err(error) => return Ok(Err(error)),
    };
    let response: taomni_mail_api::responses::ResponseRequest = serde_json::from_slice(&bytes)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let message = match taomni_mail_engine::responses::prepare_response(&response) {
        Ok(message) => message,
        Err(error) => return Ok(Err(error)),
    };
    operation.check_current()?;
    runtime.block_on(while_current(operation, async {
        taomni_mail_engine::smtp::send_prepared_response(&request.connection, &message)
            .await
            .map(drop)
    }))
}

fn validate_connection(request: &SmtpConnection) -> Result<(), RpcError> {
    if request.server_name.trim().is_empty() || request.username.trim().is_empty() {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    Ok(())
}

pub(super) fn store_sent(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapSentCopy,
) -> Result<Result<Option<String>, String>, RpcError> {
    let ImapSentCopy {
        connection,
        account_id,
        folder_override,
        mime,
        remote_draft,
    } = request;
    if connection.protocol != MailIncomingProtocol::Imap
        || account_id.trim().is_empty()
        || (mime.is_none() && remote_draft.is_none())
        || remote_draft
            .as_ref()
            .is_some_and(|draft| !valid_draft(draft))
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let bytes = if let Some(mime) = mime {
        match receive_mime(runtime, operation, mime)? {
            Ok(bytes) => Some(bytes),
            Err(error) => return Ok(Err(error)),
        }
    } else {
        None
    };
    with_socket(runtime, operation, connection, move |stream, input| {
        imap_catch_result(|| {
            open_imap(stream, &input)?.store_sent_copy(
                &account_id,
                folder_override.as_deref(),
                bytes.as_deref(),
                remote_draft.as_ref(),
            )
        })
    })
}

pub(super) fn store_draft(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapDraftStore,
) -> Result<Result<Option<RemoteDraftLocation>, String>, RpcError> {
    let ImapDraftStore {
        connection,
        account_id,
        folder_override,
        message_id,
        mime,
        previous,
    } = request;
    if connection.protocol != MailIncomingProtocol::Imap
        || account_id.trim().is_empty()
        || message_id.trim().is_empty()
        || previous.as_ref().is_some_and(|draft| !valid_draft(draft))
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let bytes = match receive_mime(runtime, operation, mime)? {
        Ok(bytes) => bytes,
        Err(error) => return Ok(Err(error)),
    };
    with_socket(runtime, operation, connection, move |stream, input| {
        imap_catch_result(|| {
            open_imap(stream, &input)?.store_remote_draft(
                &account_id,
                folder_override.as_deref(),
                &bytes,
                &message_id,
                previous.as_ref(),
            )
        })
    })
}

pub(super) fn discard_draft(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapDraftDiscard,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Imap || !valid_draft(&request.location)
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    with_socket(
        runtime,
        operation,
        request.connection,
        move |stream, input| {
            imap_catch_result(|| open_imap(stream, &input)?.discard_remote_draft(&request.location))
        },
    )
}

fn valid_draft(location: &RemoteDraftLocation) -> bool {
    !location.folder.trim().is_empty() && location.uid != 0
}

fn receive_mime(
    runtime: &Runtime,
    operation: &Operation,
    mime: MimeUpload,
) -> Result<Result<Vec<u8>, String>, RpcError> {
    runtime.block_on(while_current(operation, async {
        let (source, _) = mime.source.connect().await?;
        let mut bytes = Vec::new();
        source
            .take(mime.length.saturating_add(1))
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| format!("Read Mail message: {error}"))?;
        if bytes.is_empty() || bytes.len() as u64 != mime.length {
            return Err("Incomplete Mail message".into());
        }
        Ok(bytes)
    }))
}
