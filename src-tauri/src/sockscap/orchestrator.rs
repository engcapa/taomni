//! SocksCap engine state machine.

use crate::sockscap::capture::SocksCapCapabilities;
use crate::sockscap::config::SocksCapConfig;
use crate::sockscap::relay::RelayHandle;
use crate::sockscap::rules::{CompiledRules, GfwListMeta};
use crate::sockscap::stats::{StatsCounters, StatsSnapshot};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnginePhase {
    Idle,
    Preparing,
    Active,
    Degraded,
    Stopping,
    RecoveryRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksCapStatus {
    pub phase: EnginePhase,
    pub message: String,
    pub rule_count: usize,
    pub capture_backend: String,
}

pub struct Orchestrator {
    phase: EnginePhase,
    message: String,
    config: Option<SocksCapConfig>,
    rules: Option<Arc<CompiledRules>>,
    pub stats: Arc<StatsCounters>,
    pub domains: Arc<std::sync::Mutex<crate::sockscap::stats::DomainTracker>>,
    capture_backend: String,
    /// Active local relay (if capture is running).
    pub relay: Option<RelayHandle>,
    /// Shared with the relay task so config/rules can hot-reload while Active.
    pub relay_ctx: Option<std::sync::Arc<tokio::sync::RwLock<crate::sockscap::relay::RelayContext>>>,
    /// Signal DNS cache refresher to exit when capture stops.
    pub dns_stop: Option<Arc<AtomicBool>>,
}

impl Orchestrator {
    pub fn new() -> Self {
        Self {
            phase: EnginePhase::Idle,
            message: "idle".into(),
            config: None,
            rules: None,
            stats: Arc::new(StatsCounters::default()),
            domains: Arc::new(std::sync::Mutex::new(crate::sockscap::stats::DomainTracker::new(200))),
            capture_backend: "none".into(),
            relay: None,
            relay_ctx: None,
            dns_stop: None,
        }
    }

    pub fn apply_config(&mut self, cfg: SocksCapConfig) {
        self.config = Some(cfg);
    }

    pub fn config(&self) -> Option<&SocksCapConfig> {
        self.config.as_ref()
    }

    pub fn set_rules(&mut self, rules: CompiledRules) {
        self.rules = Some(Arc::new(rules));
    }

    pub fn rules(&self) -> Option<&CompiledRules> {
        self.rules.as_deref()
    }

    pub fn rules_arc(&self) -> Option<Arc<CompiledRules>> {
        self.rules.clone()
    }

    pub fn gfwlist_meta(&self) -> Option<&GfwListMeta> {
        self.rules.as_ref().map(|r| &r.meta)
    }

    pub fn status(&self) -> SocksCapStatus {
        SocksCapStatus {
            phase: self.phase,
            message: self.message.clone(),
            rule_count: self.rules.as_ref().map(|r| r.meta.rule_count).unwrap_or(0),
            capture_backend: self.capture_backend.clone(),
        }
    }

    pub fn stats_snapshot(&self) -> StatsSnapshot {
        self.stats.snapshot()
    }

    pub fn set_preparing(&mut self, backend: &str) {
        self.phase = EnginePhase::Preparing;
        self.capture_backend = backend.to_string();
        self.message = "preparing capture".into();
        // Fresh session counters for the dashboard.
        self.stats.reset();
    }

    pub fn set_active(&mut self, backend: &str, message: impl Into<String>) {
        self.phase = EnginePhase::Active;
        self.capture_backend = backend.to_string();
        self.message = message.into();
    }

    pub fn set_degraded(&mut self, backend: &str, message: impl Into<String>) {
        self.phase = EnginePhase::Degraded;
        self.capture_backend = backend.to_string();
        self.message = message.into();
    }

    /// Phase-1 fallback when OS capture is unavailable.
    pub fn start_stub(&mut self, caps: &SocksCapCapabilities) -> Result<(), String> {
        if matches!(
            self.phase,
            EnginePhase::Active | EnginePhase::Preparing | EnginePhase::Degraded
        ) {
            return Err("sockscap already running".into());
        }
        let cfg = self
            .config
            .as_ref()
            .ok_or_else(|| "no config loaded".to_string())?;
        cfg.validate()?;

        self.phase = EnginePhase::Preparing;
        self.capture_backend = caps.capture_backend.clone();
        self.phase = EnginePhase::Degraded;
        self.message = format!(
            "rules engine ready; capture unavailable on {} ({})",
            caps.platform,
            caps.notes.first().cloned().unwrap_or_default()
        );
        Ok(())
    }

    /// Take the running relay out so the caller can stop it without holding
    /// the orchestrator write lock (avoids deadlocking status/stats polls).
    pub fn take_relay_for_stop(&mut self) -> Option<RelayHandle> {
        if !matches!(self.phase, EnginePhase::Idle) {
            self.phase = EnginePhase::Stopping;
            self.message = "stopping".into();
        }
        self.relay.take()
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        if matches!(self.phase, EnginePhase::Idle) && self.relay.is_none() {
            return Ok(());
        }
        self.phase = EnginePhase::Stopping;
        if let Some(relay) = self.relay.take() {
            relay.stop().await;
        }
        self.finish_stop();
        Ok(())
    }

    /// Clear runtime handles after relay has been stopped (or abandoned).
    pub fn finish_stop(&mut self) {
        if let Some(flag) = self.dns_stop.take() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.relay_ctx = None;
        self.relay = None;
        self.message = "stopped".into();
        self.phase = EnginePhase::Idle;
        self.capture_backend = "none".into();
    }

    pub fn force_idle(&mut self) {
        if let Some(flag) = self.dns_stop.take() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.phase = EnginePhase::Idle;
        self.message = "recovered".into();
        self.capture_backend = "none".into();
        self.relay_ctx = None;
        self.relay = None;
    }

    /// Hot-update policy surface used by the running relay.
    pub async fn hot_reload_policy(
        &self,
        cfg: SocksCapConfig,
        rules: Option<crate::sockscap::rules::CompiledRules>,
    ) {
        if let Some(ctx) = &self.relay_ctx {
            let mut g = ctx.write().await;
            g.config = cfg;
            if let Some(r) = rules {
                g.rules = Some(r);
            }
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(
            self.phase,
            EnginePhase::Active | EnginePhase::Preparing | EnginePhase::Degraded
        )
    }
}

impl Default for Orchestrator {
    fn default() -> Self {
        Self::new()
    }
}
