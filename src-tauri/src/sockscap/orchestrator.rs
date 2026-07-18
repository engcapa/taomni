//! Sockscap engine lifecycle coordinator.
//!
//! Configuration always comes from an immutable `sockscap.db` snapshot. The
//! capture marker is intentionally not written until every preflight and
//! upstream gate passes; because platform capture is not implemented in this
//! phase, start discards its prepared snapshot and remains Disabled. A marker
//! left by another process is never cleared without a platform/helper cleanup
//! confirmation.

use std::sync::{Arc, Mutex};

use super::flow::stats::{
    FlowStatsSink, LiveConnectionsQuery, LiveConnectionsSnapshot, LiveFlowSampler,
};
use super::preflight::{PreflightReport, PreflightSeverity, run_preflight};
use super::storage::{RecoveryJournal, RecoveryPhase, SockscapStore};
use super::types::{EngineState, EngineStatus};

/// Process-global Sockscap engine handle.
pub struct SockscapEngine {
    inner: Mutex<EngineInner>,
    store: Option<Arc<SockscapStore>>,
    live_flows: Arc<LiveFlowSampler>,
}

struct EngineInner {
    status: EngineStatus,
    /// Last preflight report (if any), kept for diagnostics.
    last_preflight: Option<PreflightReport>,
}

impl Default for SockscapEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SockscapEngine {
    /// Test/fallback constructor without persistence.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(EngineInner {
                status: EngineStatus::default(),
                last_preflight: None,
            }),
            store: None,
            live_flows: Arc::new(LiveFlowSampler::default()),
        }
    }

    /// Production constructor. Any non-clean journal is treated as crash
    /// recovery state because no live runtime has been attached yet.
    pub fn with_store(store: Arc<SockscapStore>) -> Self {
        let status = match store.recovery_journal() {
            Ok(journal) => startup_status(&journal),
            Err(error) => recovery_error_status(
                "RECOVERY_JOURNAL_UNAVAILABLE",
                format!("Sockscap recovery journal could not be read: {error}"),
                Vec::new(),
            ),
        };
        Self {
            inner: Mutex::new(EngineInner {
                status,
                last_preflight: None,
            }),
            store: Some(store),
            live_flows: Arc::new(LiveFlowSampler::default()),
        }
    }

    pub fn live_connections(
        &self,
        query: &LiveConnectionsQuery,
    ) -> Result<LiveConnectionsSnapshot, String> {
        self.live_flows.snapshot(query)
    }

    pub fn clear_live_connections(&self) -> u64 {
        self.live_flows.clear()
    }

    /// Capture adapters use this sink only after enabling profiles whose
    /// collection mode permits session-memory statistics.
    #[allow(dead_code)]
    pub fn live_flow_sink(&self) -> Arc<dyn FlowStatsSink> {
        Arc::clone(&self.live_flows) as Arc<dyn FlowStatsSink>
    }

    #[allow(dead_code)]
    pub fn set_live_sampling_profiles<I>(&self, profile_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.live_flows.set_enabled_profiles(profile_ids);
    }

    pub fn status(&self) -> EngineStatus {
        let current = self
            .inner
            .lock()
            .map(|guard| guard.status.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().status.clone());
        let Some(store) = &self.store else {
            return current;
        };
        match store.recovery_journal() {
            Ok(journal)
                if journal.phase == RecoveryPhase::RecoveryRequired
                    || (journal.cleanup_required
                        && matches!(
                            current.state,
                            EngineState::Disabled
                                | EngineState::Degraded
                                | EngineState::UserActionRequired
                                | EngineState::RecoveryRequired
                        )) =>
            {
                recovery_status(&journal)
            }
            Ok(_) => current,
            Err(error) => recovery_error_status(
                "RECOVERY_JOURNAL_UNAVAILABLE",
                format!("Sockscap recovery journal could not be read: {error}"),
                current.active_profile_ids,
            ),
        }
    }

    pub fn last_preflight(&self) -> Option<PreflightReport> {
        self.inner
            .lock()
            .map(|guard| guard.last_preflight.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().last_preflight.clone())
    }

    /// Prepare and validate one immutable snapshot of the saved profiles.
    /// Capture remains unavailable, so a successful pure preflight would still
    /// be refused before any recovery marker or system state is created.
    pub fn start(&self) -> Result<EngineStatus, String> {
        let store = self.store.as_ref().ok_or_else(|| {
            "SOCKSCAP_STORE_UNAVAILABLE: saved configuration store is not attached".to_string()
        })?;
        let journal = store.recovery_journal()?;
        if journal.cleanup_required || journal.phase != RecoveryPhase::Clean {
            let status = recovery_status(&journal);
            self.replace_status(status);
            return Err(format!(
                "RECOVERY_REQUIRED: generation {} must be cleaned before start",
                journal.generation
            ));
        }

        {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "sockscap engine lock poisoned".to_string())?;
            match guard.status.state {
                EngineState::Preparing | EngineState::Active | EngineState::Stopping => {
                    return Err(format!(
                        "ENGINE_STATE_CONFLICT: cannot start while engine is {:?}",
                        guard.status.state
                    ));
                }
                EngineState::RecoveryRequired => {
                    return Err(
                        "RECOVERY_REQUIRED: recover network state before starting Sockscap".into(),
                    );
                }
                EngineState::Disabled | EngineState::Degraded | EngineState::UserActionRequired => {
                }
            }
            guard.status.state = EngineState::Preparing;
            guard.status.message = "Preparing immutable Sockscap configuration".into();
            guard.status.last_error = None;
            guard.status.recovery_required = false;
            guard.status.capture_active = false;
            guard.status.active_profile_ids.clear();
        }

        let snapshot = match store.prepare_config_snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.fail_start("Configuration snapshot failed", &error);
                return Err(error);
            }
        };
        let preflight = run_preflight(&snapshot.profiles);
        {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "sockscap engine lock poisoned".to_string())?;
            guard.last_preflight = Some(preflight.clone());
            guard.status.active_profile_ids = snapshot
                .profiles
                .iter()
                .map(|profile| profile.id.clone())
                .collect();
        }

        if !preflight.ok {
            let message = preflight_error_message(&preflight);
            let discard_error = store
                .discard_prepared_config_snapshot(snapshot.revision)
                .err();
            let message = match discard_error {
                Some(error) => format!("{message}; CONFIG_SNAPSHOT_DISCARD_FAILED: {error}"),
                None => message,
            };
            self.fail_start("Sockscap preflight failed", &message);
            return Err(format!("SOCKSCAP_PREFLIGHT_FAILED: {message}"));
        }

        // This phase has no capture adapter/helper. Do not create a recovery
        // marker and do not publish the snapshot as committed/Active.
        let discard = store.discard_prepared_config_snapshot(snapshot.revision);
        let message = match discard {
            Ok(()) => "CAPTURE_ADAPTER_NOT_READY: platform capture is not available in this build"
                .to_string(),
            Err(error) => format!(
                "CAPTURE_ADAPTER_NOT_READY: platform capture is unavailable; CONFIG_SNAPSHOT_DISCARD_FAILED: {error}"
            ),
        };
        self.fail_start("Sockscap capture is unavailable", &message);
        Err(message)
    }

    /// Stop is idempotent while both the in-memory runtime and recovery
    /// journal are clean. It cannot clear a real marker without helper proof.
    pub fn stop(&self) -> Result<EngineStatus, String> {
        self.live_flows.disable();
        if let Some(store) = &self.store {
            let journal = store.recovery_journal()?;
            if journal.cleanup_required || journal.phase != RecoveryPhase::Clean {
                let status = recovery_status(&journal);
                self.replace_status(status);
                return Err(
                    "RECOVERY_HELPER_REQUIRED: platform cleanup must complete before stop can be confirmed"
                        .into(),
                );
            }
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "sockscap engine lock poisoned".to_string())?;
        match guard.status.state {
            EngineState::Preparing => {
                return Err(
                    "ENGINE_STATE_CONFLICT: start is still preparing; cancellation is not available in this build"
                        .into(),
                );
            }
            EngineState::Stopping => {
                return Err("ENGINE_STATE_CONFLICT: stop is already in progress".into());
            }
            _ => {}
        }
        guard.status.state = EngineState::Disabled;
        guard.status.message = "Sockscap engine is disabled".into();
        guard.status.capture_active = false;
        guard.status.recovery_required = false;
        guard.status.active_profile_ids.clear();
        guard.status.last_error = None;
        Ok(guard.status.clone())
    }

    /// One-click recovery is wired now, but cannot claim success until a
    /// platform adapter/helper explicitly confirms that system rules are gone.
    pub fn recover(&self) -> Result<EngineStatus, String> {
        self.live_flows.disable();
        if let Some(store) = &self.store {
            let journal = store.recovery_journal()?;
            if journal.cleanup_required || journal.phase != RecoveryPhase::Clean {
                let status = recovery_status(&journal);
                self.replace_status(status);
                return Err(
                    "RECOVERY_HELPER_REQUIRED: this build has no platform cleanup adapter; the recovery marker was preserved"
                        .into(),
                );
            }
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "sockscap engine lock poisoned".to_string())?;
        if matches!(
            guard.status.state,
            EngineState::Preparing | EngineState::Active | EngineState::Stopping
        ) {
            return Err(format!(
                "ENGINE_STATE_CONFLICT: cannot recover while engine is {:?}",
                guard.status.state
            ));
        }
        guard.status = EngineStatus::default();
        Ok(guard.status.clone())
    }

    /// Mark an in-process runtime failure. The persistent marker is owned by
    /// the capture/helper transaction and is updated there with a stable code.
    #[allow(dead_code)]
    pub fn mark_recovery_required(&self, reason: impl Into<String>) {
        let status = recovery_error_status(
            "ENGINE_RUNTIME_FAILURE",
            reason.into(),
            self.status().active_profile_ids,
        );
        self.replace_status(status);
    }

    fn fail_start(&self, message: &str, error: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.status.state = EngineState::Disabled;
            guard.status.message = message.to_string();
            guard.status.last_error = Some(error.to_string());
            guard.status.recovery_required = false;
            guard.status.capture_active = false;
            guard.status.active_profile_ids.clear();
        }
    }

    fn replace_status(&self, status: EngineStatus) {
        match self.inner.lock() {
            Ok(mut guard) => guard.status = status,
            Err(poisoned) => poisoned.into_inner().status = status,
        }
    }
}

fn preflight_error_message(preflight: &PreflightReport) -> String {
    let message = preflight
        .findings
        .iter()
        .filter(|finding| finding.severity == PreflightSeverity::Error)
        .map(|finding| finding.message.clone())
        .collect::<Vec<_>>()
        .join("; ");
    if message.is_empty() {
        "preflight did not pass".into()
    } else {
        message
    }
}

fn startup_status(journal: &RecoveryJournal) -> EngineStatus {
    if journal.cleanup_required || journal.phase != RecoveryPhase::Clean {
        recovery_status(journal)
    } else {
        EngineStatus::default()
    }
}

fn recovery_status(journal: &RecoveryJournal) -> EngineStatus {
    recovery_error_status(
        journal
            .last_error_code
            .as_deref()
            .unwrap_or("RECOVERY_REQUIRED"),
        format!(
            "Sockscap recovery generation {} is {:?}; platform cleanup is required",
            journal.generation, journal.phase
        ),
        journal.active_profile_ids.clone(),
    )
}

fn recovery_error_status(
    code: &str,
    message: String,
    active_profile_ids: Vec<String>,
) -> EngineStatus {
    EngineStatus {
        state: EngineState::RecoveryRequired,
        message: "Sockscap network recovery is required".into(),
        active_profile_ids,
        last_error: Some(format!("{code}: {message}")),
        recovery_required: true,
        capture_active: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::types::{
        CapturePlatform, EgressKind, ProfileScope, RouteAction, RoutingProfileDraft,
    };

    fn profile() -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: "p1".into(),
            name: "Test".into(),
            enabled: true,
            scope: ProfileScope::Global,
            egress_kind: Some(EgressKind::ProxySession),
            egress_ref_id: Some("px".into()),
            default_action: RouteAction::Proxy,
            ..Default::default()
        }
    }

    fn store_with_profile() -> Arc<SockscapStore> {
        let store = Arc::new(SockscapStore::open_in_memory().expect("open Sockscap store"));
        store
            .upsert_profile(&profile(), Some(0))
            .expect("save routing profile");
        store
    }

    #[test]
    fn start_uses_saved_snapshot_and_discards_it_after_preflight_failure() {
        let store = store_with_profile();
        let engine = SockscapEngine::with_store(Arc::clone(&store));
        let error = engine.start().expect_err("capture preflight must fail");
        assert!(error.contains("SOCKSCAP_PREFLIGHT_FAILED"));
        let status = engine.status();
        assert_eq!(status.state, EngineState::Disabled);
        assert!(!status.capture_active);
        assert!(engine.last_preflight().is_some());
        let discard_again = store
            .discard_prepared_config_snapshot(1)
            .expect_err("failed-start snapshot must already be discarded");
        assert!(discard_again.contains("CONFIG_SNAPSHOT_NOT_FOUND"));
    }

    #[test]
    fn stop_is_idempotent_when_journal_is_clean() {
        let store = store_with_profile();
        let engine = SockscapEngine::with_store(store);
        let status = engine.stop().expect("stop clean engine");
        assert_eq!(status.state, EngineState::Disabled);
    }

    #[test]
    fn startup_preserves_recovery_marker_and_recover_cannot_fake_cleanup() {
        let store = store_with_profile();
        let journal = store
            .begin_prepare(&["p1".into()], 1, CapturePlatform::current(), true)
            .expect("write recovery marker");
        let engine = SockscapEngine::with_store(Arc::clone(&store));
        assert_eq!(engine.status().state, EngineState::RecoveryRequired);
        let error = engine.recover().expect_err("helper cleanup is unavailable");
        assert!(error.contains("RECOVERY_HELPER_REQUIRED"));
        let persisted = store.recovery_journal().expect("read recovery journal");
        assert_eq!(persisted.generation, journal.generation);
        assert!(persisted.cleanup_required);
        assert_eq!(persisted.phase, RecoveryPhase::Preparing);
    }

    #[test]
    fn in_memory_test_engine_can_clear_only_its_nonpersistent_flag() {
        let engine = SockscapEngine::new();
        engine.mark_recovery_required("test-only failure");
        assert_eq!(engine.status().state, EngineState::RecoveryRequired);
        let status = engine.recover().expect("clear in-memory status");
        assert_eq!(status.state, EngineState::Disabled);
        assert!(!status.recovery_required);
    }
}
