use std::time::Duration;

pub(super) const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(180);
pub(super) const FLOW_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const STOP_TIMEOUT: Duration = Duration::from_secs(4);
pub(super) const CAPTURE_STOP_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const BRIDGE_EXIT_TIMEOUT: Duration = Duration::from_secs(2);
pub(super) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
pub(super) const MAX_PENDING_HEARTBEATS: usize = 3;
pub(super) const UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) const DNS_UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const UDP_DATAGRAM_RATE_PER_SECOND: u64 = 2_048;
pub(super) const UDP_DATAGRAM_BURST: u64 = 4_096;
pub(super) const TARGET_NOFILE_LIMIT: libc::rlim_t = 4_096;
pub(super) const RESERVED_FILE_DESCRIPTORS: u64 = 128;
pub(super) const FILE_DESCRIPTORS_PER_FLOW: u64 = 2;
pub(super) const MIN_RELAY_FLOW_CAPACITY: usize = 32;
