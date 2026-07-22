//! Linux capture plane abstraction (Strategist recommendation).

pub mod pid_filter;
pub mod tunnel;
pub mod relay;

use std::sync::Arc;

use tokio::sync::RwLock;

use crate::sockscap::config::SocksCapConfig;
use crate::sockscap::relay::RelayContext;

// Trait for platform capture.
pub trait LinuxCapture: Send + Sync {
    fn pid_filter(&self, pid: u32, target: Option<u32>) -> bool;
    fn apply_nat(&self, flow: &crate::sockscap::flow::FlowContext) -> bool;
    async fn start_relay(&self, ctx: Arc<RwLock<RelayContext>>) -> Result<(), String>;
}

pub struct LinuxCaptureImpl;

impl LinuxCapture for LinuxCaptureImpl {
    fn pid_filter(&self, pid: u32, target: Option<u32>) -> bool {
        crate::sockscap::capture::linux::pid_filter::pid_filter(pid, target)
    }

    fn apply_nat(&self, flow: &crate::sockscap::flow::FlowContext) -> bool {
        crate::sockscap::capture::linux::tunnel::apply_nat(flow) // placeholder
    }

    async fn start_relay(&self, ctx: Arc<RwLock<RelayContext>>) -> Result<(), String> {
        crate::sockscap::capture::linux::relay::start_linux_relay(ctx).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trait() {
        let impl_ = LinuxCaptureImpl;
        assert!(impl_.pid_filter(1234, Some(1234)));
    }
}