use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

#[derive(Debug)]
pub(super) struct RawFrame {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) bgra: Vec<u8>,
    pub(super) captured_at: Instant,
}

pub(super) struct FrameMailbox {
    pub(super) frame: Mutex<Option<RawFrame>>,
    pub(super) ready: Condvar,
    pub(super) closed: AtomicBool,
}

impl Default for FrameMailbox {
    fn default() -> Self {
        Self {
            frame: Mutex::new(None),
            ready: Condvar::new(),
            closed: AtomicBool::new(false),
        }
    }
}

impl FrameMailbox {
    pub(super) fn publish(&self, frame: RawFrame) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut pending) = self.frame.lock() {
            if self.closed.load(Ordering::Acquire) {
                return;
            }
            *pending = Some(frame);
            self.ready.notify_one();
        }
    }

    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.ready.notify_all();
    }

    pub(super) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(super) fn take_timeout(&self, timeout: Duration) -> anyhow::Result<Option<RawFrame>> {
        let mut pending = self
            .frame
            .lock()
            .map_err(|_| anyhow::anyhow!("Wayland frame mailbox poisoned"))?;
        if pending.is_none() {
            let (guard, _) = self
                .ready
                .wait_timeout(pending, timeout)
                .map_err(|_| anyhow::anyhow!("Wayland frame mailbox poisoned"))?;
            pending = guard;
        }
        Ok(pending.take())
    }
}
