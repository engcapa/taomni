use super::limits::MAX_PENDING_FLOWS;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Notify;

#[derive(Debug, Clone)]
pub struct ProcessIdentity {
    pub profile_id: String,
    pub configured_path: String,
}

#[derive(Debug, Clone)]
pub struct TracedFlow {
    pub destination: SocketAddr,
    pub pid: u32,
    pub process_path: String,
    pub profile_id: String,
}

pub(super) struct QueuedFlow {
    pub(super) id: u64,
    pub(super) flow: TracedFlow,
}

#[derive(Default)]
pub(super) struct FlowQueueState {
    pub(super) pending: VecDeque<QueuedFlow>,
}

/// Synchronous producer/asynchronous consumer handoff between the tracer and
/// loopback ingress. The tracer executes one rewritten connect at a time, so
/// accept order is an exact and race-free flow identity.
#[derive(Default)]
pub struct FlowQueue {
    pub(super) state: Mutex<FlowQueueState>,
    pub(super) claimed: Condvar,
    pub(super) available: Notify,
    pub(super) next_id: AtomicU64,
}

impl FlowQueue {
    pub(super) fn push(&self, flow: TracedFlow) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut state = self
            .state
            .lock()
            .map_err(|_| "rootless flow queue lock is poisoned".to_string())?;
        if state.pending.len() >= MAX_PENDING_FLOWS {
            return Err(format!(
                "rootless flow queue reached its {MAX_PENDING_FLOWS}-connection limit"
            ));
        }
        state.pending.push_back(QueuedFlow { id, flow });
        drop(state);
        self.available.notify_waiters();
        Ok(id)
    }

    pub(super) fn cancel(&self, id: u64) {
        if let Ok(mut state) = self.state.lock()
            && let Some(index) = state.pending.iter().position(|entry| entry.id == id)
        {
            state.pending.remove(index);
            self.claimed.notify_all();
        }
    }

    pub(super) fn wait_claimed(&self, id: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        loop {
            if !state.pending.iter().any(|entry| entry.id == id) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let Ok((next, result)) = self.claimed.wait_timeout(state, deadline - now) else {
                return false;
            };
            state = next;
            if result.timed_out() {
                return !state.pending.iter().any(|entry| entry.id == id);
            }
        }
    }

    pub async fn wait_take(&self, timeout: Duration) -> Option<TracedFlow> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.available.notified();
            if let Ok(mut state) = self.state.lock()
                && let Some(entry) = state.pending.pop_front()
            {
                self.claimed.notify_all();
                return Some(entry.flow);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline
                || tokio::time::timeout(deadline - now, notified)
                    .await
                    .is_err()
            {
                return None;
            }
        }
    }
}
