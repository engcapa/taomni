//! Gap-free IMAP folder synchronisation.
//!
//! Invariant (per account + folder, stable UIDVALIDITY): the cache holds
//! exactly the server messages whose UID lies in `[sync_low_uid,
//! sync_high_uid]`. New mail is therefore always `sync_high_uid+1:*`, older
//! history is `1:sync_low_uid-1`, and reconciliation only needs to compare the
//! server's UID set inside the span with the cached one.
//!
//! The previous design inferred progress from `MAX(uid)` of a cache that was
//! filled by newest-N pages, so a newest page after a long absence pushed the
//! resume point past the messages in between and they were never fetched.
//! Every fetch here is planned as a set difference (server − cached), which is
//! idempotent: an interrupted step is simply recomputed by the next call.

#[cfg(feature = "imap-runtime")]
mod folder_step;
mod limits;
mod model;
#[cfg(any(feature = "imap-runtime", test))]
mod planning;
#[cfg(feature = "imap-runtime")]
mod protocol;
#[cfg(feature = "imap-runtime")]
mod round;

#[cfg(feature = "imap-runtime")]
pub use folder_step::imap_sync_folder_step;
pub use limits::FLAG_RECONCILE_WINDOW;
pub use model::{AppliedStep, StepParams, advance_state, step_result};
#[cfg(feature = "imap-runtime")]
pub use protocol::imap_has_capability;
#[cfg(feature = "imap-runtime")]
pub use round::{folder_unchanged, sync_folder_round};
pub use taomni_mail_api::imap_sync::{
    BodySyncOutcome, BodySyncRequest, BodySyncTask, FolderRoundOutcome, FolderRoundRequest,
    FolderStepOutcome, FolderSyncState, HeaderPageOutcome, HeaderPageRequest, HeaderStepRequest,
    MailFolderSyncResult, MailSyncMode, MailSyncRequestMode, Watermark,
};

#[cfg(test)]
mod tests;
