use std::io::{Read, Write};

use crate::{
    imap_folders::{FolderStatus, imap_folder_status},
    imap_messages::Mailbox,
};

use super::{
    FolderRoundOutcome, FolderRoundRequest, FolderSyncState, MailSyncMode, MailSyncRequestMode,
    StepParams, advance_state, imap_has_capability, imap_sync_folder_step,
};

/// Complete one folder of an account-wide refresh using a single IMAP session.
/// The caller commits its completed steps before moving to the next folder.
pub fn sync_folder_round<T: Read + Write>(
    session: &mut imap::Session<T>,
    mailbox: &mut Mailbox<'_, impl FnMut(u32, &[u8]) -> Result<(), String>>,
    request: &FolderRoundRequest,
    include_bodies: bool,
) -> FolderRoundOutcome {
    let condstore = imap_has_capability(session, "CONDSTORE");
    let mut state = request.state.clone();
    if request.skip_unchanged
        && condstore
        && let Some(status) = imap_folder_status(session, mailbox.name, condstore)
        && folder_unchanged(&state, &status)
    {
        let mut folder = request.folder.clone();
        folder.total = status.messages;
        folder.unread = status.unseen;
        folder.uid_next = status.uid_next;
        folder.uid_validity = status.uid_validity;
        return FolderRoundOutcome {
            unchanged: Some(folder),
            ..Default::default()
        };
    }

    let mut result = FolderRoundOutcome::default();
    let mut params = StepParams {
        request: MailSyncRequestMode::Auto,
        limit: request.limit,
        include_bodies,
        condstore,
    };
    for _ in 0..2 {
        match imap_sync_folder_step(session, mailbox, &state, &params) {
            Ok(step) => {
                state = advance_state(&state, &step);
                // A completed repair is followed by a catch-up step.
                let repaired = step.mode == MailSyncMode::Repair && !step.watermark.needs_repair;
                let more = step.more;
                result.steps.push(step);
                if !repaired {
                    result.pending = more;
                    break;
                }
            }
            Err(error) => {
                result.error = Some(error);
                return result;
            }
        }
    }
    if state.high.is_some() && result.steps.last().is_some_and(|step| !step.more) {
        params.request = request.reconcile;
        match imap_sync_folder_step(session, mailbox, &state, &params) {
            Ok(step) => {
                result.pending = step.more;
                result.steps.push(step);
            }
            Err(error) => result.error = Some(error),
        }
    }
    result
}

/// STATUS can skip a folder only when high UID, UIDVALIDITY and MODSEQ agree.
pub fn folder_unchanged(state: &FolderSyncState, status: &FolderStatus) -> bool {
    let (Some(high), Some(uid_next)) = (state.high, status.uid_next) else {
        return false;
    };
    !state.needs_repair
        && state.uid_validity.is_some()
        && state.uid_validity == status.uid_validity
        && uid_next.saturating_sub(1) <= high
        && state.highest_modseq.is_some()
        && state.highest_modseq == status.highest_modseq
        && (!state.complete || status.messages == Some(state.cached_uids.len() as u32))
}
