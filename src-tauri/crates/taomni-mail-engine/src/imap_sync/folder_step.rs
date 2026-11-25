use super::FLAG_RECONCILE_WINDOW;
use super::planning::plan_backfill;
use super::planning::plan_fill_range;
use super::planning::recent_window_start;
use super::protocol::fetch_desc;
use super::protocol::imap_examine;
use super::protocol::imap_fetch_flags;
use super::protocol::imap_fetch_flags_for_uids;
use super::protocol::imap_search_older;
use super::protocol::imap_search_uid_range;
use super::{
    FolderStepOutcome, FolderSyncState, MailSyncMode, MailSyncRequestMode, StepParams, Watermark,
};
use crate::imap_folders::decode_imap_modified_utf7;
use crate::imap_messages::{Mailbox, imap_page_uids_newest_first, imap_unread_count};
use crate::{MailFolder, MailMessageCached, now_ts};
use std::collections::HashSet;
use std::io::Read;
use std::io::Write;

/// Run one bounded sync step for `folder` against the stored `state`.
pub fn imap_sync_folder_step<T: Read + Write>(
    session: &mut imap::Session<T>,
    mailbox: &mut Mailbox<'_, impl FnMut(u32, &[u8]) -> Result<(), String>>,
    state: &FolderSyncState,
    params: &StepParams,
) -> Result<FolderStepOutcome, String> {
    let folder = mailbox.name;
    let remote = imap_examine(session, folder, params.condstore)?;
    let unread = imap_unread_count(session);
    let folder_info = MailFolder {
        account_id: mailbox.account_id.to_owned(),
        name: folder.to_string(),
        display_name: decode_imap_modified_utf7(folder),
        flags: remote.flags.clone(),
        uid_validity: remote.uid_validity,
        uid_next: remote.uid_next,
        total: Some(remote.exists),
        unread,
        updated_at: now_ts(),
        ..MailFolder::default()
    };
    let limit = params.limit.clamp(1, 2000);

    let uid_validity_reset = matches!(
        (state.uid_validity, remote.uid_validity),
        (Some(old), Some(new)) if old != new
    );
    let mut state = if uid_validity_reset {
        FolderSyncState {
            uid_validity: remote.uid_validity,
            ..FolderSyncState::default()
        }
    } else {
        state.clone()
    };

    let mut outcome = FolderStepOutcome {
        folder: folder_info,
        mode: MailSyncMode::Catchup,
        messages: Vec::new(),
        vanished: Vec::new(),
        flag_updates: Vec::new(),
        watermark: Watermark::default(),
        highest_modseq: None,
        reconciled: false,
        uid_validity_reset,
        remaining: 0,
        more: false,
        new_unseen: 0,
    };

    // Never synced (or reset): take the newest page and start the span there.
    if state.high.is_none() && state.cached_uids.is_empty() {
        let (page, has_more) =
            imap_page_uids_newest_first(session, remote.uid_next, remote.exists, 0, limit)?;
        let messages = mailbox.fetch_messages(session, &page, params.include_bodies)?;
        let empty_high = remote
            .uid_next
            .map(|next| next.saturating_sub(1))
            .unwrap_or(0);
        outcome.mode = MailSyncMode::Initial;
        outcome.watermark = Watermark {
            low: Some(
                page.first()
                    .copied()
                    .unwrap_or(empty_high.saturating_add(1)),
            ),
            high: Some(page.last().copied().unwrap_or(empty_high)),
            complete: !has_more,
            needs_repair: false,
        };
        outcome.highest_modseq = remote.highest_modseq;
        outcome.messages = fetch_desc(messages);
        return Ok(outcome);
    }

    // Pre-watermark cache: adopt its span, verify it against the server.
    if state.high.is_none() {
        state.low = state.cached_uids.first().copied();
        state.high = state.cached_uids.last().copied();
        state.complete = false;
        state.needs_repair = true;
    }
    let low = state.low.unwrap_or(1);
    let high = state.high.unwrap_or(0);
    outcome.watermark = Watermark {
        low: Some(low),
        high: Some(high),
        complete: state.complete,
        needs_repair: state.needs_repair,
    };

    if state.needs_repair {
        let server = imap_search_uid_range(session, low, Some(high))?;
        let plan = plan_fill_range(&server, &state.cached_uids, low, Some(high), limit);
        let messages = mailbox.fetch_messages(session, &plan.fetch, params.include_bodies)?;
        outcome.mode = MailSyncMode::Repair;
        outcome.messages = fetch_desc(messages);
        outcome.vanished = plan.vanished;
        outcome.remaining = plan.remaining;
        outcome.watermark.needs_repair = plan.remaining > 0;
        // Repair only verifies the old span; the caller continues with catch-up.
        outcome.more = true;
        return Ok(outcome);
    }

    match params.request {
        MailSyncRequestMode::Auto | MailSyncRequestMode::Catchup => {
            let start = high.saturating_add(1);
            let server = imap_search_uid_range(session, start, None)?;
            let plan = plan_fill_range(&server, &state.cached_uids, start, None, limit);
            let messages = mailbox.fetch_messages(session, &plan.fetch, params.include_bodies)?;
            outcome.mode = MailSyncMode::Catchup;
            outcome.new_unseen = count_unseen(&messages);
            outcome.messages = fetch_desc(messages);
            outcome.vanished = plan.vanished;
            outcome.remaining = plan.remaining;
            outcome.more = plan.remaining > 0;
            if plan.remaining == 0 {
                if let Some(max) = plan.server_max {
                    outcome.watermark.high = Some(max.max(high));
                }
            }
        }
        MailSyncRequestMode::Backfill => {
            outcome.mode = MailSyncMode::Backfill;
            if state.complete {
                return Ok(outcome);
            }
            let (older, reached_start) = imap_search_older(session, low, limit)?;
            let plan = plan_backfill(&older, &state.cached_uids, reached_start, limit);
            let messages = mailbox.fetch_messages(session, &plan.fetch, params.include_bodies)?;
            outcome.messages = fetch_desc(messages);
            if let Some(new_low) = plan.new_low {
                outcome.watermark.low = Some(new_low.min(low));
            }
            outcome.watermark.complete = plan.complete;
            outcome.more = !plan.complete;
        }
        MailSyncRequestMode::Reconcile | MailSyncRequestMode::ReconcileFull => {
            let full = params.request == MailSyncRequestMode::ReconcileFull;
            outcome.mode = if full {
                MailSyncMode::ReconcileFull
            } else {
                MailSyncMode::Reconcile
            };
            if high < low {
                outcome.reconciled = true;
                outcome.highest_modseq = remote.highest_modseq;
                return Ok(outcome);
            }
            let lo = if full {
                low
            } else {
                recent_window_start(&state.cached_uids, low, FLAG_RECONCILE_WINDOW)
            };
            let server = imap_search_uid_range(session, lo, Some(high))?;
            let plan = plan_fill_range(&server, &state.cached_uids, lo, Some(high), limit);
            let messages = mailbox.fetch_messages(session, &plan.fetch, params.include_bodies)?;
            let fetched: HashSet<u32> = plan.fetch.iter().copied().collect();
            outcome.messages = fetch_desc(messages);
            outcome.vanished = plan.vanished;
            outcome.remaining = plan.remaining;
            outcome.more = plan.remaining > 0;

            let unchanged = params.condstore
                && remote.highest_modseq.is_some()
                && remote.highest_modseq == state.highest_modseq;
            if unchanged {
                outcome.reconciled = true;
            } else if let (true, Some(since)) = (params.condstore, state.highest_modseq) {
                // Only changed messages come back; covers the whole span.
                outcome.flag_updates =
                    imap_fetch_flags(session, &format!("{low}:{high}"), Some(since))?
                        .into_iter()
                        .filter(|(uid, _)| !fetched.contains(uid))
                        .collect();
                outcome.highest_modseq = remote.highest_modseq;
                outcome.reconciled = true;
            } else {
                let targets: Vec<u32> = server
                    .iter()
                    .copied()
                    .filter(|uid| !fetched.contains(uid))
                    .collect();
                outcome.flag_updates = imap_fetch_flags_for_uids(session, &targets)?;
                if full {
                    outcome.highest_modseq = remote.highest_modseq;
                    outcome.reconciled = true;
                }
            }
        }
    }
    Ok(outcome)
}

fn count_unseen(messages: &[MailMessageCached]) -> usize {
    messages
        .iter()
        .filter(|message| {
            !message
                .header
                .flags
                .iter()
                .any(|flag| flag.eq_ignore_ascii_case("\\Seen"))
        })
        .count()
}
