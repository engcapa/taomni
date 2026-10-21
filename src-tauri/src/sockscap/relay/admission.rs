use super::limits::MAX_ACTIVE_RELAY_FLOWS;
use super::limits::RELAY_KEEPALIVE_IDLE;
use super::limits::RELAY_KEEPALIVE_INTERVAL;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::OwnedSemaphorePermit;
use tokio::sync::Semaphore;

pub(crate) fn new_relay_flow_limiter() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(MAX_ACTIVE_RELAY_FLOWS))
}

/// Wait up to `max_wait` for relay capacity, polling `stop` so Stop is never
/// held up behind a full semaphore. The permit is owned by the spawned flow task
/// and releases on every success, error, cancellation, or panic path.
///
/// Returns `None` when the relay is stopping, the semaphore is closed, or the
/// wait elapsed; callers distinguish by testing `stop`.
pub(crate) async fn acquire_relay_flow_permit(
    limiter: &Arc<Semaphore>,
    stop: &AtomicBool,
    max_wait: Duration,
) -> Option<OwnedSemaphorePermit> {
    let deadline = tokio::time::Instant::now() + max_wait;
    loop {
        if stop.load(Ordering::SeqCst) {
            return None;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return None;
        }
        let slice = std::cmp::min(Duration::from_millis(100), deadline - now);
        match tokio::time::timeout(slice, Arc::clone(limiter).acquire_owned()).await {
            Ok(Ok(permit)) => return Some(permit),
            Ok(Err(_)) => return None,
            Err(_) => {}
        }
    }
}

/// Enable TCP keepalive so a peer that disappears silently — process killed,
/// NAT idle timeout, laptop suspended, route withdrawn — is detected instead of
/// holding a flow slot until the process restarts.
pub(super) fn enable_keepalive(stream: &TcpStream) {
    let params = socket2::TcpKeepalive::new()
        .with_time(RELAY_KEEPALIVE_IDLE)
        .with_interval(RELAY_KEEPALIVE_INTERVAL);
    if let Err(e) = socket2::SockRef::from(stream).set_tcp_keepalive(&params) {
        tracing::debug!("sockscap relay: could not enable TCP keepalive: {e}");
    }
}
