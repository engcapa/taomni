//! Persisted mailbox sync state and results shared with the signed Mail host.

mod model;
/// Newest cached UIDs whose flags a quiet reconcile refreshes when the server
/// cannot report changes via CONDSTORE.
pub const FLAG_RECONCILE_WINDOW: usize = 500;
pub use model::{StepParams, advance_state, step_result};
pub use taomni_mail_api::imap_index::AppliedStep;
pub use taomni_mail_api::imap_sync::{
    BodySyncOutcome, BodySyncRequest, BodySyncTask, FolderRoundOutcome, FolderRoundRequest,
    FolderStepOutcome, FolderSyncState, HeaderPageOutcome, HeaderPageRequest, HeaderStepRequest,
    MailFolderSyncResult, MailSyncMode, MailSyncRequestMode, Watermark,
};
