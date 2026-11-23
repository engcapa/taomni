use std::sync::Arc;

use taomni_mail_api::calendar::{DECODE_INVITE, MailInvite};

use super::{PluginRegistry, mime_exchange::transform, supports};

pub(in crate::mail) fn require_invite_decoder(registry: &PluginRegistry) -> Result<(), String> {
    if !supports(registry, DECODE_INVITE) {
        return Err(
            "Enable or update Mail in the module store to open calendar invitations".into(),
        );
    }
    Ok(())
}

pub(in crate::mail) async fn decode_invite(
    registry: Arc<PluginRegistry>,
    raw: Vec<u8>,
) -> Result<Option<MailInvite>, String> {
    let reply = transform(
        registry,
        DECODE_INVITE,
        raw,
        |exchange| exchange,
        "Decoding the calendar invitation timed out",
    )
    .await?;
    tokio::task::spawn_blocking(move || {
        serde_json::from_slice(&reply).map_err(|_| "Invalid Mail invitation response".into())
    })
    .await
    .map_err(|error| format!("Mail invitation reply task failed: {error}"))?
}
