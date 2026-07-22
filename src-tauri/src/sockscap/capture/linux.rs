//! Linux capture plane stub (Phase 0 foundation).
//!
//! Uses /proc for PID filtering + basic TUN relay stub with smoltcp.
//! Full nft/cgroup or NFQUEUE implementation in Phase 2+.

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::sockscap::config::SocksCapConfig;
use crate::sockscap::relay::RelayContext;

// Simple PID filter stub.
pub fn pid_filter(pid: u32, target_pid: Option<u32>) -> bool {
    target_pid.map_or(true, |tp| pid == tp)
}

// Basic TUN relay stub - in production would bind to TUN device and run smoltcp stack.
pub async fn start_linux_relay(ctx: Arc<RwLock<RelayContext>>) -> Result<(), String> {
    // TODO: Real TUN creation + smoltcp forwarding loop
    tracing::info!("Linux capture relay stub started (PID filter + TUN ready for Phase 1)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pid_filter() {
        assert!(pid_filter(1234, Some(1234)));
        assert!(!pid_filter(1234, Some(5678)));
        assert!(pid_filter(1234, None));
    }
}