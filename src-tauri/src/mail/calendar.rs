//! Mail calendar commands over the desktop account, proxy and storage adapters.

use serde::Serialize;
use taomni_mail_api::responses::MailResponse;
use tauri::State;

use super::{MailAccountConfig, resolve_config};
use crate::state::AppState;

pub use taomni_mail_api::calendar::{MailInvite, MailInviteAttendee, MailInviteTime};
use taomni_mail_engine::calendar::partstat_of;
pub(super) use taomni_mail_engine::calendar::{
    fold, param, parse_time, split_property, unescape, unfold,
};

/// Invite of a message, parsed from the raw message (local store for POP3).
/// The reader only asks when the body lists a calendar part, and invitations
/// are small, so the raw fetch is cheap.
#[tauri::command]
pub async fn mail_get_invite(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    state: State<'_, AppState>,
) -> Result<Option<MailInvite>, String> {
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    #[cfg(feature = "legacy-mail-imap")]
    let legacy = state.plugins.get(taomni_mail_api::SLUG).is_none();
    #[cfg(not(feature = "legacy-mail-imap"))]
    let legacy = false;
    if !legacy {
        super::module_host::require_invite_decoder(&state.plugins)?;
    }
    let raw = if super::pop3::is_pop3(&config) {
        super::local_cmds::raw(&state, &config.session_id, &folder, uid).await?
    } else {
        super::message_source::fetch_original_from_server(&state, config, &folder, uid).await?
    };
    #[cfg(feature = "legacy-mail-imap")]
    if legacy {
        return tokio::task::spawn_blocking(move || {
            taomni_mail_engine::calendar::invite_from_message(&raw)
        })
        .await
        .map_err(|error| format!("Mail invitation task failed: {error}"));
    }
    super::module_host::decode_invite(state.plugins.clone(), raw).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailInviteResponse {
    pub partstat: String,
    pub sent_to: String,
}

/// Accept / tentatively accept / decline: send the iTIP REPLY (AC-62).
#[tauri::command]
pub async fn mail_respond_invite(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    response: String,
    state: State<'_, AppState>,
) -> Result<MailInviteResponse, String> {
    let partstat = partstat_of(&response)?;
    let invite = mail_get_invite(config.clone(), folder, uid, state.clone())
        .await?
        .ok_or_else(|| "this message has no calendar invitation".to_string())?;
    if invite.method != "REQUEST" {
        return Err(format!("cannot respond to a {} message", invite.method));
    }
    let organizer = invite
        .organizer
        .clone()
        .ok_or_else(|| "the invitation has no organizer".to_string())?;
    let account = resolve_config(&state, config)?;
    let response = MailResponse::Invitation {
        invite: Box::new(invite),
        response,
    };
    super::module_host::send_response(state.plugins.clone(), &account, response).await?;
    Ok(MailInviteResponse {
        partstat: partstat.to_string(),
        sent_to: organizer.email,
    })
}
