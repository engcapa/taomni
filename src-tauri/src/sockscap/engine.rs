//! SockscapOrchestrator — the engine state machine (plan §4.1, §9).
//!
//! States: Disabled → Preparing → Active → (Degraded) → Stopping → Disabled;
//! any prepare/stop failure lands in RecoveryRequired, which offers a one-click
//! "restore network". Start is a transaction: validate config/capabilities →
//! (compile rules / upstream tests happen in the caller) → write a recovery
//! marker → install capture → Active. Stop reverses it. Default is fail-open:
//! on a crash the helper/adapter uninstall restores direct networking (§9,
//! §16.2-4). The privileged capture itself is delegated to a [`CaptureAdapter`].

use std::sync::Arc;
use std::sync::Mutex;

use serde::Serialize;

use super::capture::CaptureAdapter;
use super::conflict::detect_conflicts;
use super::flow::StatsAggregator;
use super::model::RoutingProfile;

/// Engine lifecycle state (plan §9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "state", content = "detail")]
pub enum EngineState {
    Disabled,
    Preparing,
    Active,
    Degraded(String),
    Stopping,
    RecoveryRequired(String),
}

impl EngineState {
    pub fn is_active(&self) -> bool {
        matches!(self, EngineState::Active | EngineState::Degraded(_))
    }
}

/// A sink for recovery markers so the orchestrator can persist a "capture is
/// installed" marker before touching the system and clear it on clean stop
/// (plan §9, §16.6-23). The DB-backed impl lives in the command layer; tests
/// use an in-memory one.
pub trait RecoveryJournal: Send + Sync {
    fn write_marker(&self, state_json: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

/// A recovery journal that discards markers — for tests and headless use.
pub struct NoopRecoveryJournal;

impl RecoveryJournal for NoopRecoveryJournal {
    fn write_marker(&self, _state_json: &str) -> Result<(), String> {
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        Ok(())
    }
}

/// The orchestrator. Holds the current state, the capture adapter, the stats
/// aggregator and the recovery journal. Cloneable handles (`Arc`) are shared
/// with the command layer and background tasks.
pub struct SockscapOrchestrator {
    state: Mutex<EngineState>,
    adapter: Arc<dyn CaptureAdapter>,
    recovery: Arc<dyn RecoveryJournal>,
    pub stats: Arc<StatsAggregator>,
}

impl SockscapOrchestrator {
    pub fn new(
        adapter: Arc<dyn CaptureAdapter>,
        recovery: Arc<dyn RecoveryJournal>,
    ) -> SockscapOrchestrator {
        SockscapOrchestrator {
            state: Mutex::new(EngineState::Disabled),
            adapter,
            recovery,
            stats: Arc::new(StatsAggregator::new()),
        }
    }

    pub fn state(&self) -> EngineState {
        self.state.lock().unwrap().clone()
    }

    fn set_state(&self, s: EngineState) {
        *self.state.lock().unwrap() = s;
    }

    /// Start the engine for `profiles`. Validates conflicts and capability,
    /// writes a recovery marker, then installs capture. Any failure leaves a
    /// clean state (Disabled on config/capability errors; RecoveryRequired if
    /// install failed after the marker was written).
    pub async fn start(&self, profiles: &[RoutingProfile]) -> Result<(), String> {
        // Guard against double-start.
        if self.state().is_active() {
            return Ok(());
        }
        self.set_state(EngineState::Preparing);

        // Config validation (plan §9 step 2).
        let conflicts = detect_conflicts(profiles);
        if let Some(c) = conflicts.first() {
            self.set_state(EngineState::Disabled);
            return Err(format!("profile conflict: {}", c.explain()));
        }

        // Capability gate (plan §9 step 2, §8 — don't pretend).
        if !self.adapter.is_ready() {
            self.set_state(EngineState::Disabled);
            return Err(
                "capture backend not available; install/approve the platform helper first".into(),
            );
        }

        // Recovery marker before touching the system (plan §9 step 4).
        self.recovery
            .write_marker("{\"phase\":\"installing\"}")
            .map_err(|e| {
                self.set_state(EngineState::Disabled);
                format!("recovery journal: {e}")
            })?;

        // Install capture (plan §9 step 5). Failure ⇒ RecoveryRequired.
        if let Err(e) = self.adapter.install().await {
            self.set_state(EngineState::RecoveryRequired(format!("install failed: {e}")));
            return Err(format!("capture install failed: {e}"));
        }

        self.set_state(EngineState::Active);
        Ok(())
    }

    /// Stop the engine, restoring direct networking and clearing the recovery
    /// marker. On uninstall failure, land in RecoveryRequired.
    pub async fn stop(&self) -> Result<(), String> {
        if matches!(self.state(), EngineState::Disabled) {
            return Ok(());
        }
        self.set_state(EngineState::Stopping);
        if let Err(e) = self.adapter.uninstall().await {
            self.set_state(EngineState::RecoveryRequired(format!("uninstall failed: {e}")));
            return Err(format!("capture uninstall failed: {e}"));
        }
        let _ = self.recovery.clear();
        self.set_state(EngineState::Disabled);
        Ok(())
    }

    /// One-click "restore network": fail-open uninstall and clear the marker,
    /// independent of upstream availability (plan §9, §16.6-23).
    pub async fn recover(&self) -> Result<(), String> {
        // Best-effort uninstall; ignore errors so we always restore direct.
        let _ = self.adapter.uninstall().await;
        let _ = self.recovery.clear();
        self.set_state(EngineState::Disabled);
        Ok(())
    }

    /// Mark the engine degraded (e.g. SSH control connection dropped) without
    /// tearing capture down (plan §16.5-20).
    pub fn mark_degraded(&self, reason: impl Into<String>) {
        if self.state().is_active() {
            self.set_state(EngineState::Degraded(reason.into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::capture::NoopCaptureAdapter;
    use async_trait::async_trait;

    /// A ready adapter that records install/uninstall calls.
    struct MockAdapter {
        install_ok: bool,
        installs: Arc<Mutex<u32>>,
        uninstalls: Arc<Mutex<u32>>,
    }

    #[async_trait]
    impl CaptureAdapter for MockAdapter {
        fn capabilities(&self) -> crate::sockscap::capability::Capabilities {
            crate::sockscap::capability::detect()
        }
        fn is_ready(&self) -> bool {
            true
        }
        async fn install(&self) -> Result<(), String> {
            *self.installs.lock().unwrap() += 1;
            if self.install_ok {
                Ok(())
            } else {
                Err("mock install failure".into())
            }
        }
        async fn uninstall(&self) -> Result<(), String> {
            *self.uninstalls.lock().unwrap() += 1;
            Ok(())
        }
    }

    fn orch(adapter: Arc<dyn CaptureAdapter>) -> SockscapOrchestrator {
        SockscapOrchestrator::new(adapter, Arc::new(NoopRecoveryJournal))
    }

    #[tokio::test]
    async fn start_without_backend_stays_disabled() {
        let o = orch(Arc::new(NoopCaptureAdapter::new()));
        assert!(o.start(&[]).await.is_err());
        assert_eq!(o.state(), EngineState::Disabled);
    }

    #[tokio::test]
    async fn full_start_stop_cycle() {
        let installs = Arc::new(Mutex::new(0));
        let uninstalls = Arc::new(Mutex::new(0));
        let adapter = Arc::new(MockAdapter {
            install_ok: true,
            installs: installs.clone(),
            uninstalls: uninstalls.clone(),
        });
        let o = orch(adapter);
        o.start(&[]).await.unwrap();
        assert_eq!(o.state(), EngineState::Active);
        assert_eq!(*installs.lock().unwrap(), 1);
        o.stop().await.unwrap();
        assert_eq!(o.state(), EngineState::Disabled);
        assert_eq!(*uninstalls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn install_failure_requires_recovery() {
        let adapter = Arc::new(MockAdapter {
            install_ok: false,
            installs: Arc::new(Mutex::new(0)),
            uninstalls: Arc::new(Mutex::new(0)),
        });
        let o = orch(adapter);
        assert!(o.start(&[]).await.is_err());
        assert!(matches!(o.state(), EngineState::RecoveryRequired(_)));
        // Recover restores Disabled.
        o.recover().await.unwrap();
        assert_eq!(o.state(), EngineState::Disabled);
    }

    #[tokio::test]
    async fn conflicting_profiles_block_start() {
        use crate::sockscap::Action;
        use crate::sockscap::model::{
            DnsMode, EgressFailureAction, EgressKind, LocalNetworkPolicy, Scope, StatsPrivacy,
            UdpPolicy,
        };
        let mk = |id: &str| RoutingProfile {
            id: id.into(),
            name: id.into(),
            enabled: true,
            priority: 0,
            scope: Scope::Global,
            app_selectors: vec![],
            runtime_processes: vec![],
            include_children: true,
            egress_kind: EgressKind::ProxySession,
            egress_ref_id: "p".into(),
            egress_failure_action: EgressFailureAction::FailOpen,
            rule_source_ids: vec![],
            default_action: Action::Direct,
            dns_mode: DnsMode::SystemCapture,
            unknown_domain_action: Action::Direct,
            udp_policy: UdpPolicy::Block,
            local_network_policy: LocalNetworkPolicy::Direct,
            ssh_pool_options: None,
            stats_privacy: StatsPrivacy::default(),
        };
        let adapter = Arc::new(MockAdapter {
            install_ok: true,
            installs: Arc::new(Mutex::new(0)),
            uninstalls: Arc::new(Mutex::new(0)),
        });
        let o = orch(adapter);
        // Two enabled globals conflict → start refused, stays Disabled.
        let err = o.start(&[mk("g1"), mk("g2")]).await.unwrap_err();
        assert!(err.contains("conflict"));
        assert_eq!(o.state(), EngineState::Disabled);
    }
}
