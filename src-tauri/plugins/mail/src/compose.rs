use serde_json::to_vec;
use taomni_mail_api::{
    compose::{ComposeEnvelope, ComposeRequest},
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_mail_engine::{
    compose::{MailSender, ResolvedSendAttachment, build_message},
    delivery::PreparedMail,
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::{io::AsyncWriteExt, runtime::Runtime};

use super::incoming::while_current;

pub(super) fn prepare(
    runtime: &Runtime,
    operation: &Operation,
    endpoint: Endpoint,
) -> Result<Result<(), String>, RpcError> {
    let (mut peer, _) = match runtime.block_on(while_current(operation, endpoint.connect()))? {
        Ok(pair) => pair,
        Err(error) => return Ok(Err(error)),
    };
    let input = runtime
        .block_on(while_current(operation, read_body_frame(&mut peer)))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let request: ComposeRequest = serde_json::from_slice(&input)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    if !request.message.attachments.is_empty() {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let sender = MailSender {
        email_address: &request.email_address,
        display_name: request.display_name.as_deref(),
        reply_to: request.reply_to.as_deref(),
    };
    let mut requested_attachments = false;
    let message = build_message(sender, &request.message, &request.options, |_| {
        if request.attachments.is_empty() {
            return Ok(Vec::new());
        }
        runtime
            .block_on(while_current(operation, async {
                // Ask for attachment bytes after validating the message fields.
                peer.write_u8(1).await?;
                requested_attachments = true;
                let mut attachments = Vec::new();
                for attachment in request.attachments {
                    attachments.push(ResolvedSendAttachment {
                        name: attachment.name,
                        content_type: attachment.content_type,
                        inline: attachment.inline,
                        content_id: attachment.content_id,
                        bytes: read_body_frame(&mut peer).await?,
                    });
                }
                Ok::<_, std::io::Error>(attachments)
            }))
            .map_err(|error| error.message)?
            .map_err(|error| error.to_string())
    })
    .map(PreparedMail::from);
    operation.check_current()?;
    let envelope = message.as_ref().map(|message| ComposeEnvelope {
        sender: message.sender(),
        recipients: message.recipients(),
    });
    let reply = to_vec(&envelope).map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
    Ok(runtime
        .block_on(while_current(operation, async {
            if !requested_attachments {
                peer.write_u8(0).await?;
            }
            write_body_frame(&mut peer, &reply).await?;
            if let Ok(message) = message {
                write_body_frame(&mut peer, &message.bytes).await?;
            }
            Ok::<(), std::io::Error>(())
        }))?
        .map_err(|error| error.to_string()))
}
