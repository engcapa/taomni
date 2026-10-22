use std::time::Duration;

/// Each TCP relay consumes an accepted socket and normally one egress socket.
///
/// Windows global capture funnels *every* TCP connection on the machine through
/// here; a browser alone opens hundreds. 256 was far too low for that and made
/// saturation a routine event rather than an emergency. Windows has no
/// per-process descriptor limit worth defending against, so allow a real
/// ceiling there; on Linux stay well below the common 1024 soft
/// `RLIMIT_NOFILE`, which the rest of the desktop app also draws from.
pub(crate) const MAX_ACTIVE_RELAY_FLOWS: usize = if cfg!(windows) { 2048 } else { 512 };
pub(crate) const ACCEPT_BACKOFF_INITIAL: Duration = Duration::from_millis(50);
pub(crate) const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(1);
pub(super) const RELAY_DIAL_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const RELAY_PREFIX_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an accepted connection waits for a flow slot before being refused.
pub(crate) const RELAY_PERMIT_WAIT: Duration = Duration::from_secs(5);
/// A bridged flow that moves no bytes in *either* direction within this window
/// is treated as broken and torn down.
///
/// Deliberately only enforced before the first byte. Once a flow has carried
/// data, going quiet is normal — an idle SSH session, a websocket with
/// minute-scale pings — and tearing those down would be a regression. Keepalive
/// is the right detector for a peer that dies mid-session.
pub(super) const RELAY_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(300);
/// Start probing an idle connection after this long, then every interval.
pub(super) const RELAY_KEEPALIVE_IDLE: Duration = Duration::from_secs(60);
pub(super) const RELAY_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// ProxyAll/off/bypass decisions do not need a hostname. Give already-buffered
/// SNI/HTTP Host a small chance to arrive for better diagnostics and proxy-side
/// DNS, but do not put it on the critical path.
pub(super) const HOSTNAME_SNIFF_OPPORTUNISTIC: Duration = Duration::from_millis(75);
/// GFWList and hostname user rules require attribution. DNS observation is the
/// fallback, so a long per-connection stall is no longer useful.
pub(super) const HOSTNAME_SNIFF_REQUIRED: Duration = Duration::from_millis(350);
