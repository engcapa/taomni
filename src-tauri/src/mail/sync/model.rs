use crate::mail::MailFolder;
use crate::mail::MailMessageCached;
use crate::mail::MailMessageHeader;
use crate::mail::now_ts;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashSet;

/// Which work a `mail_sync_folder` call should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MailSyncRequestMode {
    /// Initialise / repair / fetch new mail, whichever the stored state needs.
    #[default]
    Auto,
    Catchup,
    /// Fetch the next block of older history below `sync_low_uid`.
    Backfill,
    /// Reconcile deletions and flags for the newest cached window.
    Reconcile,
    /// Reconcile deletions and flags for the whole cached span.
    ReconcileFull,
}

/// The work a step actually performed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MailSyncMode {
    Initial,
    Repair,
    Catchup,
    Backfill,
    Reconcile,
    ReconcileFull,
    /// Cache disabled: a stateless newest page was fetched.
    Uncached,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolderSyncResult {
    pub account_id: String,
    pub folder: MailFolder,
    pub mode: MailSyncMode,
    /// Headers fetched by this step (newest first).
    pub messages: Vec<MailMessageHeader>,
    pub fetched: usize,
    /// Newly arrived messages without `\Seen` (never counts initial sync,
    /// repair of an old gap or history backfill).
    pub new_unseen: usize,
    pub vanished: usize,
    pub flags_updated: usize,
    /// Messages still missing in the planned range after this step.
    pub remaining_new: usize,
    /// True when the caller should call again to finish the requested work.
    pub more: bool,
    pub sync_complete: bool,
    pub uid_validity_reset: bool,
    pub synced_at: i64,
}

/// Persisted per-folder sync state plus the cached UID set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::mail) struct FolderSyncState {
    pub uid_validity: Option<u32>,
    pub low: Option<u32>,
    pub high: Option<u32>,
    pub complete: bool,
    /// The span was adopted from a pre-watermark cache and still has to be
    /// verified against the server (it may contain gaps).
    pub needs_repair: bool,
    pub highest_modseq: Option<u64>,
    /// Sorted, de-duplicated cached UIDs of the folder.
    pub cached_uids: Vec<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(in crate::mail) struct Watermark {
    pub low: Option<u32>,
    pub high: Option<u32>,
    pub complete: bool,
    pub needs_repair: bool,
}

/// Result of one IMAP step before it is written to the cache.
#[derive(Debug)]
pub(in crate::mail) struct FolderStepOutcome {
    pub folder: MailFolder,
    pub mode: MailSyncMode,
    pub messages: Vec<MailMessageCached>,
    pub vanished: Vec<u32>,
    pub flag_updates: Vec<(u32, Vec<String>)>,
    pub watermark: Watermark,
    /// New HIGHESTMODSEQ to store once flags were fully reconciled.
    pub highest_modseq: Option<u64>,
    pub reconciled: bool,
    pub uid_validity_reset: bool,
    pub remaining: usize,
    pub more: bool,
    pub new_unseen: usize,
}

pub(in crate::mail) struct AppliedStep {
    pub flags_updated: usize,
    pub folder: Option<MailFolder>,
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

pub(in crate::mail) struct StepParams {
    pub request: MailSyncRequestMode,
    pub limit: usize,
    pub include_bodies: bool,
    pub condstore: bool,
}

/// In-memory state after `outcome` is applied (for multi-step batches that
/// run inside one IMAP session before anything is written).
pub(in crate::mail) fn advance_state(
    state: &FolderSyncState,
    outcome: &FolderStepOutcome,
) -> FolderSyncState {
    let mut cached: HashSet<u32> = if outcome.uid_validity_reset {
        HashSet::new()
    } else {
        state.cached_uids.iter().copied().collect()
    };
    for message in &outcome.messages {
        cached.insert(message.header.uid);
    }
    for uid in &outcome.vanished {
        cached.remove(uid);
    }
    let mut cached_uids: Vec<u32> = cached.into_iter().collect();
    cached_uids.sort_unstable();
    let wm = outcome.watermark;
    FolderSyncState {
        uid_validity: outcome.folder.uid_validity.or(state.uid_validity),
        low: wm.low,
        high: wm.high,
        complete: wm.complete,
        needs_repair: wm.needs_repair,
        highest_modseq: outcome.highest_modseq.or(state.highest_modseq),
        cached_uids,
    }
}

/// Build the IPC result from a step outcome after it was applied.
pub(in crate::mail) fn step_result(
    account_id: &str,
    outcome: FolderStepOutcome,
    applied: Option<AppliedStep>,
) -> MailFolderSyncResult {
    let (flags_updated, folder) = match applied {
        Some(applied) => (applied.flags_updated, applied.folder),
        None => (outcome.flag_updates.len(), None),
    };
    let mut folder = folder.unwrap_or_else(|| outcome.folder.clone());
    if folder.sync_high_uid.is_none() {
        folder.sync_low_uid = outcome.watermark.low;
        folder.sync_high_uid = outcome.watermark.high;
        folder.sync_complete = outcome.watermark.complete;
    }
    let messages: Vec<MailMessageHeader> =
        outcome.messages.iter().map(|m| m.header.clone()).collect();
    MailFolderSyncResult {
        account_id: account_id.to_string(),
        sync_complete: folder.sync_complete,
        folder,
        mode: outcome.mode,
        fetched: messages.len(),
        messages,
        new_unseen: outcome.new_unseen,
        vanished: outcome.vanished.len(),
        flags_updated,
        remaining_new: outcome.remaining,
        more: outcome.more,
        uid_validity_reset: outcome.uid_validity_reset,
        synced_at: now_ts(),
    }
}
