use taomni_mail_api::{ImapSentCopy, MailIncomingProtocol, SmtpConnection, SmtpDelivery};
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
            .is_some_and(|draft| draft.folder.trim().is_empty() || draft.uid == 0)
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let bytes = if let Some(mime) = mime {
        let received = runtime.block_on(while_current(operation, async {
            let (source, _) = mime.source.connect().await?;
            let mut bytes = Vec::new();
            source
                .take(mime.length.saturating_add(1))
                .read_to_end(&mut bytes)
                .await
                .map_err(|error| format!("Read Sent message: {error}"))?;
            if bytes.is_empty() || bytes.len() as u64 != mime.length {
                return Err("Incomplete Sent message".into());
            }
            Ok(bytes)
        }))?;
        match received {
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
