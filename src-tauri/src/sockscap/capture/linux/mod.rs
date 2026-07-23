//! Linux transparent-capture backend.
//!
//! The backend is deliberately split into pure PID/rule primitives and the
//! small privileged lifecycle that joins them. nftables redirects selected TCP
//! OUTPUT flows to the loopback relay; the relay recovers the original target
//! with `SO_ORIGINAL_DST` and reuses SocksCap's shared policy/egress engine.

pub mod cgroup;
pub mod pid_filter;
pub mod relay;
pub mod tunnel;

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::RwLock;

use crate::sockscap::config::{ScopeMode, SocksCapConfig};
use crate::sockscap::relay::RelayContext;

/// A running Linux capture session. Dropping it is intentionally inert: callers
/// must call [`Self::stop`] so failures are visible and recovery can be offered.
pub struct LinuxCaptureHandle {
    relay_port: u16,
    relay: Option<crate::sockscap::relay::RelayHandle>,
    redirect: tunnel::NftRedirect,
    cgroups: cgroup::CgroupSession,
}

impl LinuxCaptureHandle {
    pub fn relay_port(&self) -> u16 {
        self.relay_port
    }

    /// Remove redirect rules before stopping the relay, then restore all cgroup
    /// assignments. This ordering prevents new intercepted connections from
    /// reaching a relay that is already shutting down.
    pub async fn stop(mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Err(error) = self.redirect.remove() {
            errors.push(error);
        }
        if let Some(relay) = self.relay.take() {
            relay.stop().await;
        }
        if let Err(error) = self.cgroups.cleanup() {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

#[async_trait]
pub trait LinuxCapture: Send + Sync {
    fn preflight(&self) -> Result<(), String>;

    async fn start(
        &self,
        config: &SocksCapConfig,
        ctx: Arc<RwLock<RelayContext>>,
    ) -> Result<LinuxCaptureHandle, String>;
}

#[derive(Debug, Default)]
pub struct LinuxCaptureImpl;

#[async_trait]
impl LinuxCapture for LinuxCaptureImpl {
    fn preflight(&self) -> Result<(), String> {
        cgroup::CgroupSession::preflight()?;
        tunnel::NftRedirect::preflight()?;
        Ok(())
    }

    async fn start(
        &self,
        config: &SocksCapConfig,
        ctx: Arc<RwLock<RelayContext>>,
    ) -> Result<LinuxCaptureHandle, String> {
        self.preflight()?;

        let target_pids = target_pids_for_config(config)?;
        let relay = relay::start_linux_relay(ctx).await?;
        let relay_port = relay.handle.port;

        let mut cgroups =
            match cgroup::CgroupSession::prepare(config.mode, &target_pids, std::process::id()) {
                Ok(cgroups) => cgroups,
                Err(error) => {
                    relay.handle.stop().await;
                    return Err(error);
                }
            };

        let plan = match tunnel::RedirectPlan::new(
            config.mode,
            relay_port,
            relay.ipv6_ready,
            &config.bypass_cidrs,
            cgroups.bypass_id(),
            cgroups.capture_ids(),
        ) {
            Ok(plan) => plan,
            Err(error) => {
                let _ = cgroups.cleanup();
                relay.handle.stop().await;
                return Err(error);
            }
        };

        let redirect = match tunnel::NftRedirect::install(&plan) {
            Ok(redirect) => redirect,
            Err(error) => {
                let _ = cgroups.cleanup();
                relay.handle.stop().await;
                return Err(error);
            }
        };

        tracing::info!(
            relay_port,
            mode = ?config.mode,
            app_targets = target_pids.len(),
            "sockscap Linux nftables transparent capture started"
        );
        Ok(LinuxCaptureHandle {
            relay_port,
            relay: Some(relay.handle),
            redirect,
            cgroups,
        })
    }
}

pub fn recover_system() -> Result<(), String> {
    tunnel::recover_rules()?;
    match cgroup::cleanup_empty_sessions() {
        Ok(()) => Ok(()),
        // The nft table is already removed. A live cgroup cannot be safely
        // moved by recovery, so leave it for the owning process and explain it.
        Err(error) => Err(format!(
            "nftables rules removed; cgroup cleanup incomplete: {error}"
        )),
    }
}

fn target_pids_for_config(config: &SocksCapConfig) -> Result<BTreeSet<u32>, String> {
    match config.mode {
        ScopeMode::Global => Ok(BTreeSet::new()),
        ScopeMode::Apps => pid_filter::resolve_target_pids(&config.apps),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::config::SocksCapConfig;

    #[test]
    fn global_mode_has_no_app_pid_targets() {
        let config = SocksCapConfig::default();
        assert!(target_pids_for_config(&config).unwrap().is_empty());
    }
}
