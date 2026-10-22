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

mod limits;

mod schema;

mod model;

mod cache;

mod planning;

mod imap_protocol;

mod folder_step;

#[cfg(test)]
mod tests;

pub(super) use limits::FLAG_RECONCILE_WINDOW;

pub use schema::migrate_mail_tables;

pub use model::{MailFolderSyncResult, MailSyncMode, MailSyncRequestMode};

pub(super) use model::{
    AppliedStep, FolderStepOutcome, FolderSyncState, StepParams, Watermark, advance_state,
    step_result,
};

pub(super) use cache::{
    apply_folder_step, apply_prune_cut, count_unseen, load_folder_sync_state, now_ms,
    record_folder_error, reset_folder_cache,
};

pub(super) use planning::{
    BackfillPlan, FillPlan, plan_backfill, plan_fill_range, recent_window_start,
};

pub(super) use imap_protocol::{
    RemoteMailbox, imap_has_capability, parse_examine_response, quote_imap_string,
};

pub(super) use folder_step::imap_sync_folder_step;
