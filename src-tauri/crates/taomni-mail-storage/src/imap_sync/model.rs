use std::collections::HashSet;

use crate::{MailMessageHeader, now_ts};

use super::{
    AppliedStep, FolderStepOutcome, FolderSyncState, MailFolderSyncResult, MailSyncRequestMode,
};

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

pub struct StepParams {
    pub request: MailSyncRequestMode,
    pub limit: usize,
    pub include_bodies: bool,
    pub condstore: bool,
}

/// In-memory state after `outcome` is applied (for multi-step batches that
/// run inside one IMAP session before anything is written).
pub fn advance_state(state: &FolderSyncState, outcome: &FolderStepOutcome) -> FolderSyncState {
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
pub fn step_result(
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
