use crate::servers::rdp::capture::Frame;
use std::collections::VecDeque;
use std::sync::Mutex;
use tokio::sync::Notify;

/// Cross-thread latest-frame mailbox. Unlike `mpsc::channel(1)` plus
/// `blocking_send`, publishing a new full frame replaces the stale pending
/// frame and never makes the native capture callback wait for an encoder.
///
/// Damage batches need stronger guarantees: a dropped rectangle can leave a
/// permanent hole in the client framebuffer. When a damage batch is already
/// pending or being drained we therefore ask the capture loop for one fresh
/// full frame, which safely supersedes all prior partial updates.
pub(super) struct LatestFrameMailbox {
    pub(super) state: Mutex<MailboxState>,
    pub(super) ready: Notify,
}

pub(super) struct MailboxState {
    pub(super) pending: Option<PendingFrames>,
    /// Latest complete desktop retained with reference-counted pixel storage.
    /// Partial damage is never stored here because it cannot seed a new client.
    pub(super) latest_full: Option<Frame>,
    pub(super) active_damage: bool,
    pub(super) closed: bool,
}

pub(super) enum PendingFrames {
    Full(Frame),
    Damage(VecDeque<Frame>),
}

pub(super) enum PublishResult {
    Published { replaced: bool },
    NeedsFullRefresh,
    Closed,
}

impl LatestFrameMailbox {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(MailboxState {
                pending: None,
                latest_full: None,
                active_damage: false,
                closed: false,
            }),
            ready: Notify::new(),
        }
    }

    pub(super) fn publish_full(&self, frame: Frame) -> PublishResult {
        let Ok(mut state) = self.state.lock() else {
            return PublishResult::Closed;
        };
        if state.closed {
            return PublishResult::Closed;
        }
        let replaced = state.pending.is_some() || state.active_damage;
        state.latest_full = Some(frame.clone());
        state.pending = Some(PendingFrames::Full(frame));
        self.ready.notify_one();
        PublishResult::Published { replaced }
    }

    pub(super) fn publish_damage(&self, frames: Vec<Frame>) -> PublishResult {
        let Ok(mut state) = self.state.lock() else {
            return PublishResult::Closed;
        };
        if state.closed {
            return PublishResult::Closed;
        }
        if frames.is_empty() {
            return PublishResult::Published { replaced: false };
        }
        if state.pending.is_some() || state.active_damage {
            return PublishResult::NeedsFullRefresh;
        }
        state.pending = Some(PendingFrames::Damage(frames.into()));
        self.ready.notify_one();
        PublishResult::Published { replaced: false }
    }

    pub(super) async fn take(&self) -> Option<PendingFrames> {
        loop {
            // Register interest before inspecting the state. This prevents a
            // producer notification between the empty check and `.await()`
            // from being lost.
            let notified = self.ready.notified();
            {
                let Ok(mut state) = self.state.lock() else {
                    return None;
                };
                if let Some(pending) = state.pending.take() {
                    state.active_damage = matches!(&pending, PendingFrames::Damage(_));
                    return Some(pending);
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    /// Queue the retained full desktop for a newly authenticated client. The
    /// clone only increments the `Bytes` reference count; pixel memory is not
    /// copied.
    pub(super) fn replay_latest_full(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.closed {
            return;
        }
        let Some(frame) = state.latest_full.clone() else {
            return;
        };
        state.pending = Some(PendingFrames::Full(frame));
        state.active_damage = false;
        self.ready.notify_one();
    }

    /// An active partial batch becomes obsolete as soon as a new full refresh
    /// is waiting. In that case the remaining rectangles must not be emitted.
    pub(super) fn full_refresh_waiting(&self) -> bool {
        self.state
            .lock()
            .ok()
            .is_some_and(|state| matches!(state.pending, Some(PendingFrames::Full(_))))
    }

    pub(super) fn finish_damage(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.active_damage = false;
        }
    }

    /// Whether the consuming client has gone away. The capture loop checks this
    /// on idle ticks, where it has no frame to publish and would otherwise not
    /// notice a disconnect.
    pub(super) fn is_closed(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.closed)
    }

    pub(super) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.pending = None;
            state.latest_full = None;
        }
        self.ready.notify_waiters();
    }
}
