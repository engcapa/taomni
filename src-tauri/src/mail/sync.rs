//! Desktop persistence and account adapters for the IMAP sync engine.

mod cache;

#[cfg(test)]
mod tests;

pub use taomni_mail_engine::imap_sync::{MailFolderSyncResult, MailSyncMode, MailSyncRequestMode};

pub(super) use taomni_mail_engine::imap_folders::quote_imap_string;
pub(super) use taomni_mail_engine::imap_sync::{
    AppliedStep, FLAG_RECONCILE_WINDOW, FolderStepOutcome, FolderSyncState, StepParams,
    advance_state, imap_has_capability, step_result,
};

pub(super) use cache::{
    apply_folder_step, apply_prune_cut, load_folder_sync_state, now_ms, record_folder_error,
    reset_folder_cache,
};

use super::{ResolvedMailAccount, imap_mailbox};
use std::io::{Read, Write};

pub(super) fn imap_sync_folder_step<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    state: &FolderSyncState,
    params: &StepParams,
) -> Result<FolderStepOutcome, String> {
    taomni_mail_engine::imap_sync::imap_sync_folder_step(
        session,
        &mut imap_mailbox(account, folder),
        state,
        params,
    )
}
