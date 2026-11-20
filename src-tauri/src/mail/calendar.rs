//! Mail calendar commands over the desktop account, proxy and storage adapters.

use std::sync::Arc;

use lettre::Message;
use lettre::message::header::ContentType;
use lettre::message::{Mailbox, MultiPart, SinglePart};
use serde::Serialize;
use tauri::State;

use super::{
    ImapSessionOpts, MailAccountConfig, build_smtp_transport, now_ts, parse_mailbox,
    resolve_config, with_imap_session,
};
use crate::state::AppState;

pub use taomni_mail_engine::calendar::{MailInvite, MailInviteAttendee, MailInviteTime};
use taomni_mail_engine::calendar::{build_reply_ics, invite_from_message, partstat_of};
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
    if super::pop3::is_pop3(&config) {
        let raw = super::local_cmds::raw(&state, &config.session_id, &folder, uid)?;
        return Ok(invite_from_message(&raw));
    }
    let account = resolve_config(&state, config)?;
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| Ok(invite_from_message(&imap.fetch_raw(&folder, uid)?)),
        )
    })
    .await
    .map_err(|e| format!("invite task failed: {e}"))?
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
    let me = account.config.email_address.trim().to_string();
    let my_name = account.config.display_name.clone();
    let ics = build_reply_ics(&invite, &me, my_name.as_deref(), partstat, now_ts());
    let verb = match partstat {
        "ACCEPTED" => "Accepted",
        "TENTATIVE" => "Tentative",
        _ => "Declined",
    };
    let subject = format!("{verb}: {}", invite.summary);
    let from = Mailbox::new(
        my_name.clone(),
        me.parse()
            .map_err(|e| format!("invalid from address: {e}"))?,
    );
    let to = parse_mailbox(&organizer.email)?;
    let text = format!(
        "{} has {} this invitation.",
        my_name.as_deref().unwrap_or(&me),
        verb.to_lowercase()
    );
    let message = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::plain(text))
                .singlepart(
                    SinglePart::builder()
                        .header(
                            ContentType::parse("text/calendar; method=REPLY; charset=UTF-8")
                                .map_err(|e| format!("calendar content type: {e}"))?,
                        )
                        .body(ics),
                ),
        )
        .map_err(|e| format!("failed to build invitation reply: {e}"))?;
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let transport = build_smtp_transport(&account, &handle)?;
        transport.mailer.send(&message).map(|_| ())
    })
    .await
    .map_err(|e| format!("invite reply task failed: {e}"))??;
    Ok(MailInviteResponse {
        partstat: partstat.to_string(),
        sent_to: organizer.email,
    })
}
