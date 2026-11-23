//! Read receipts we send back (TASK-17): RFC 8098 Message Disposition
//! Notifications, and the RFC 3503 `$MDNSent` keyword so a request is
//! answered (or declined) only once, from any client.

use serde::Serialize;
use taomni_mail_api::pop3_store::LocalMailboxAction;
use taomni_mail_engine::responses::{MailResponse, Receipt};
use tauri::State;

use super::{MailAccountConfig, resolve_config};
use crate::state::AppState;

/// IMAP keyword marking "receipt handled" (sent or declined).
pub const MDN_SENT: &str = "$MDNSent";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailReceiptResult {
    pub sent_to: String,
}

/// Send the read receipt the sender of `uid` asked for, then mark it
/// `$MDNSent` (`automatic` = sent by the "always" policy, not a click).
#[tauri::command]
pub async fn mail_send_receipt(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    automatic: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailReceiptResult, String> {
    let folder = folder.trim().to_string();
    let account_id = config.session_id.clone();
    let header_folder = folder.clone();
    let header = super::pop3_store::run(
        &state,
        &account_id,
        LocalMailboxAction::Header {
            folder: header_folder.clone(),
            uid,
        },
        move |db, account| super::cached_header(db, account, &header_folder, uid),
    )
    .await?
    .ok_or_else(|| "the message is not in the local cache".to_string())?;
    let receipt_to = header
        .receipt_to
        .clone()
        .ok_or_else(|| "the sender did not ask for a read receipt".to_string())?;
    if header
        .flags
        .iter()
        .any(|f| f.eq_ignore_ascii_case(MDN_SENT))
    {
        return Err("a read receipt was already handled for this message".into());
    }
    let account = resolve_config(&state, config.clone())?;
    let response = MailResponse::Receipt(Receipt {
        uid,
        message_id: header.message_id,
        subject: header.subject,
        recipient: receipt_to.clone(),
        automatic: automatic.unwrap_or(false),
    });
    super::module_host::send_response(state.plugins.clone(), &account, response).await?;
    super::mail_set_flags(
        config,
        folder,
        vec![uid],
        Some(vec![MDN_SENT.into()]),
        None,
        state,
    )
    .await?;
    Ok(MailReceiptResult {
        sent_to: receipt_to,
    })
}
