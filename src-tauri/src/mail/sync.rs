//! Desktop account adapter for the IMAP sync engine.

#[cfg(test)]
mod tests;

pub use taomni_mail_storage::imap_sync::{MailFolderSyncResult, MailSyncMode, MailSyncRequestMode};

pub(super) use taomni_mail_storage::imap_folders::quote_imap_string;
pub(super) use taomni_mail_storage::imap_sync::{
    FLAG_RECONCILE_WINDOW, FolderStepOutcome, FolderSyncState, StepParams, advance_state,
    step_result,
};

pub(super) use taomni_mail_storage::cache::{
    apply_folder_step, load_folder_sync_state, now_ms, record_folder_error,
};

#[cfg(any(test, feature = "legacy-mail-imap"))]
pub(super) use taomni_mail_engine::imap_sync::imap_has_capability;

#[cfg(any(test, feature = "legacy-mail-imap"))]
use super::{ResolvedMailAccount, imap_mailbox};
#[cfg(any(test, feature = "legacy-mail-imap"))]
use std::io::{Read, Write};

#[cfg(any(test, feature = "legacy-mail-imap"))]
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
