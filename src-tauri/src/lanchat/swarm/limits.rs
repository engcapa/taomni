use std::time::Duration;

/// Max pieces requested but not yet received, across all peers, per transfer.
pub(super) const MAX_INFLIGHT: usize = 32;
/// Max outstanding requests to a single peer (load-spreads across sources).
pub(super) const PER_PEER_WINDOW: usize = 8;
/// How long a requested piece may be outstanding before we re-request it.
pub(super) const PIECE_TIMEOUT: Duration = Duration::from_secs(10);
/// Drive-loop wakeup ceiling so timeouts are reaped even with no events.
pub(super) const DRIVE_TICK: Duration = Duration::from_millis(500);
