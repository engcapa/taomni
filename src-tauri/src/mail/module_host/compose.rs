use std::sync::Arc;

use taomni_mail_api::{
    COMPOSE_MESSAGE, HOST_REQUEST_TIMEOUT,
    compose::{
        ComposeEnvelope, ComposeRequest, MailSendRequest, MessageBuildOptions, PreparedMail,
    },
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::AsyncReadExt;

use super::{PluginRegistry, ResolvedMailAccount, invoke, supports};
use crate::mail::smtp::{attachment_metadata, build_send_message_with, read_attachment_bytes};

pub(in crate::mail) async fn compose_message(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    mut message: MailSendRequest,
    options: MessageBuildOptions,
) -> Result<PreparedMail, String> {
    if !supports(&registry, COMPOSE_MESSAGE) {
        let account = account.clone();
        return tokio::task::spawn_blocking(move || {
            build_send_message_with(&account, &message, &options)
        })
        .await
        .map_err(|error| format!("Mail compose task failed: {error}"))?;
    }
    let local_attachments = std::mem::take(&mut message.attachments);
    let attachments = local_attachments
        .iter()
        .enumerate()
        .map(|(index, attachment)| attachment_metadata(attachment, index))
        .collect();
    let request = ComposeRequest {
        email_address: account.config.email_address.clone(),
        display_name: account.config.display_name.clone(),
        reply_to: account.config.reply_to.clone(),
        message,
        options,
        attachments,
    };
    let data = tokio::task::spawn_blocking(move || serde_json::to_vec(&request))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let exchange = async {
        write_body_frame(&mut peer, &data)
            .await
            .map_err(|error| error.to_string())?;
        match peer.read_u8().await.map_err(|error| error.to_string())? {
            0 => (),
            1 => {
                for (index, attachment) in local_attachments.into_iter().enumerate() {
                    let bytes = tokio::task::spawn_blocking(move || {
                        read_attachment_bytes(&attachment, index)
                    })
                    .await
                    .map_err(|error| error.to_string())??;
                    write_body_frame(&mut peer, &bytes)
                        .await
                        .map_err(|error| error.to_string())?;
                }
            }
            _ => return Err("Invalid Mail attachment request".into()),
        }
        let reply = read_body_frame(&mut peer)
            .await
            .map_err(|error| error.to_string())?;
        let envelope = serde_json::from_slice::<Result<ComposeEnvelope, String>>(&reply)
            .map_err(|_| "Invalid Mail compose result".to_owned())??;
        let bytes = read_body_frame(&mut peer)
            .await
            .map_err(|error| error.to_string())?;
        if envelope.recipients.is_empty() {
            return Err("Mail compose result has no envelope recipients".into());
        }
        Ok(PreparedMail { envelope, bytes })
    };
    let ((), prepared) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, COMPOSE_MESSAGE, endpoint),
            exchange
        )
    })
    .await
    .map_err(|_| "Mail compose request timed out".to_owned())??;
    Ok(prepared)
}
