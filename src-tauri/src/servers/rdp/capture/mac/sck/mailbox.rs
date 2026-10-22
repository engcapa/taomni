use crate::servers::rdp::capture::mac::Frame;
use std::sync::Condvar;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

#[derive(Debug)]
pub(super) struct FrameSlot {
    pub(super) state: Mutex<FrameSlotState>,
    pub(super) wake: Condvar,
}

#[derive(Debug)]
pub(super) struct FrameSlotState {
    pub(super) latest: Option<Frame>,
    pub(super) stopped: Option<String>,
}

impl FrameSlot {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(FrameSlotState {
                latest: None,
                stopped: None,
            }),
            wake: Condvar::new(),
        }
    }

    pub(super) fn publish(&self, frame: Frame) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.stopped.is_none() {
            // Replacing the previous frame is intentional: only the newest
            // visual state is useful once RDP falls behind.
            state.latest = Some(frame);
            self.wake.notify_one();
        }
    }

    pub(super) fn stop(&self, reason: impl Into<String>) {
        if let Ok(mut state) = self.state.lock() {
            state.stopped.get_or_insert_with(|| reason.into());
            state.latest = None;
        }
        self.wake.notify_all();
    }

    pub(super) fn discard_pending(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.latest = None;
        }
    }

    /// Wait up to `timeout` for the next frame. `Ok(None)` means the timeout
    /// elapsed with the desktop unchanged, which is not an error: the stream is
    /// healthy and simply has nothing new to show. Only a stopped stream or a
    /// poisoned lock is reported as `Err`.
    pub(super) fn take_or_idle(&self, timeout: Duration) -> anyhow::Result<Option<Frame>> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ScreenCaptureKit frame mailbox lock poisoned"))?;
        loop {
            if let Some(frame) = state.latest.take() {
                return Ok(Some(frame));
            }
            if let Some(reason) = &state.stopped {
                anyhow::bail!("ScreenCaptureKit stream stopped: {reason}");
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            let remaining = deadline.saturating_duration_since(now);
            let (next, wait) = self
                .wake
                .wait_timeout(state, remaining)
                .map_err(|_| anyhow::anyhow!("ScreenCaptureKit frame mailbox lock poisoned"))?;
            state = next;
            if wait.timed_out() && state.latest.is_none() && state.stopped.is_none() {
                return Ok(None);
            }
        }
    }

    /// Wait for a frame and treat the timeout as a failure. Used where a frame
    /// is genuinely required — starting the stream and probing the desktop size.
    pub(super) fn take(&self, timeout: Duration) -> anyhow::Result<Frame> {
        self.take_or_idle(timeout)?.ok_or_else(|| {
            anyhow::anyhow!(
                "ScreenCaptureKit stream produced no frame within {} seconds",
                timeout.as_secs()
            )
        })
    }
}
