//! Sockscap engine lifecycle coordinator.
//!
//! Configuration always comes from an immutable `sockscap.db` snapshot. The
//! capture marker is intentionally not written until every preflight and
//! upstream gate passes; because platform capture is not implemented in this
//! command/runtime adapter wiring is still disabled, start discards its
//! prepared snapshot and remains Disabled. A marker left by another process is
//! never cleared without a platform/helper cleanup confirmation.

use std::sync::{Arc, Mutex};

use super::capture::CaptureAdapter;
use super::capture::runtime::CaptureRuntimeOwner;
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
    /// Explicitly injected product adapter/coordinator owner. The default app
    /// constructor deliberately leaves this absent until native release gates
    /// and a concrete data-plane provider are available.
    capture_runtime: Option<Arc<CaptureRuntimeOwner>>,
    live_flows: Arc<LiveFlowSampler>,
}

struct EngineInner {
    status: EngineStatus,
    /// Last preflight report (if any), kept for diagnostics.
    last_preflight: Option<PreflightReport>,
    /// Identifies a recovery transition whose async adapter call is currently
    /// owned by `reconcile_recovery`. Drop of that call restores a retryable
    /// state from the durable journal before releasing the owner.
    recovery_attempt_generation: Option<u64>,
}

struct RecoveryAttemptGuard<'a> {
    engine: &'a SockscapEngine,
    generation: u64,
    armed: bool,
}

impl RecoveryAttemptGuard<'_> {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RecoveryAttemptGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.engine.cancel_recovery_attempt(self.generation);
        }
    }
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
                recovery_attempt_generation: None,
            }),
            store: None,
            capture_runtime: None,
            live_flows: Arc::new(LiveFlowSampler::default()),
        }
    }

    /// Production constructor. Any non-clean journal is treated as crash
    /// recovery state because no live runtime has been attached yet.
    pub fn with_store(store: Arc<SockscapStore>) -> Self {
        Self::with_optional_capture_runtime(store, None)
    }

    /// Product integration seam for a release-gated platform adapter. Merely
    /// injecting the adapter performs no probe, helper launch or host mutation;
    /// only [`Self::reconcile_recovery`] may use it in this slice.
    pub fn with_capture_adapter(
        store: Arc<SockscapStore>,
        adapter: Arc<dyn CaptureAdapter>,
    ) -> Self {
        let capture_runtime = Arc::new(CaptureRuntimeOwner::new(Arc::clone(&store), adapter));
        Self::with_optional_capture_runtime(store, Some(capture_runtime))
    }

    fn with_optional_capture_runtime(
        store: Arc<SockscapStore>,
        capture_runtime: Option<Arc<CaptureRuntimeOwner>>,
    ) -> Self {
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
                recovery_attempt_generation: None,
            }),
            store: Some(store),
            capture_runtime,
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

        // Capture/helper source modules exist, but this product orchestrator is
        // not yet attached to an installed platform adapter. Do not create a
        // recovery marker or publish the snapshot as committed/Active.
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

    /// Restore after an operating-system login from the last snapshot that
    /// reached Active. Draft rows are deliberately never consulted here.
    /// No installed adapter is attached to this runtime yet, so the method
    /// stops at the capability gate without creating a marker or system state.
    pub fn restore_last_committed(&self) -> Result<EngineStatus, String> {
        let store = self.store.as_ref().ok_or_else(|| {
            "SOCKSCAP_STORE_UNAVAILABLE: saved configuration store is not attached".to_string()
        })?;
        let journal = store.recovery_journal()?;
        if journal.cleanup_required || journal.phase != RecoveryPhase::Clean {
            let status = recovery_status(&journal);
            self.replace_status(status);
            return Err(format!(
                "RECOVERY_REQUIRED: generation {} must be cleaned before automatic restore",
                journal.generation
            ));
        }
        let Some(snapshot) = store.last_committed_config_snapshot()? else {
            let message = "LAST_COMMITTED_CONFIG_MISSING: start Sockscap successfully once before enabling automatic restore";
            self.fail_start(
                "Sockscap automatic restore has no committed configuration",
                message,
            );
            return Err(message.into());
        };
        let message = format!(
            "CAPTURE_ADAPTER_NOT_READY: automatic restore of committed revision {} is unavailable in this build",
            snapshot.revision
        );
        self.fail_start("Sockscap automatic restore is unavailable", &message);
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

    /// Reconcile a dirty durable journal through the explicitly injected
    /// platform adapter. This is intentionally separate from the current
    /// synchronous IPC command: the default product constructor has no adapter
    /// and therefore continues to preserve the marker without launching a
    /// privileged helper.
    pub async fn reconcile_recovery(&self) -> Result<EngineStatus, String> {
        let store = self.store.as_ref().ok_or_else(|| {
            "SOCKSCAP_STORE_UNAVAILABLE: saved configuration store is not attached".to_string()
        })?;
        let journal = store.recovery_journal()?;
        if !journal.cleanup_required && journal.phase == RecoveryPhase::Clean {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "sockscap engine lock poisoned".to_string())?;
            if matches!(
                guard.status.state,
                EngineState::Preparing | EngineState::Active | EngineState::Stopping
            ) {
                return Err(format!(
                    "ENGINE_STATE_CONFLICT: cannot reconcile a clean journal while engine is {:?}",
                    guard.status.state
                ));
            }
            guard.status = EngineStatus::default();
            guard.recovery_attempt_generation = None;
            return Ok(guard.status.clone());
        }
        let Some(capture_runtime) = self.capture_runtime.as_ref() else {
            let status = recovery_status(&journal);
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "sockscap engine lock poisoned".to_string())?;
            if matches!(
                guard.status.state,
                EngineState::Preparing | EngineState::Active | EngineState::Stopping
            ) {
                return Err(format!(
                    "ENGINE_STATE_CONFLICT: cannot reconcile recovery while engine is {:?}",
                    guard.status.state
                ));
            }
            guard.status = status;
            guard.recovery_attempt_generation = None;
            drop(guard);
            self.live_flows.disable();
            return Err(
                "RECOVERY_HELPER_REQUIRED: no release-gated platform adapter is attached; the recovery marker was preserved"
                    .into(),
            );
        };

        let mut attempt = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "sockscap engine lock poisoned".to_string())?;
            if matches!(
                guard.status.state,
                EngineState::Preparing | EngineState::Active | EngineState::Stopping
            ) {
                return Err(format!(
                    "ENGINE_STATE_CONFLICT: cannot reconcile recovery while engine is {:?}",
                    guard.status.state
                ));
            }
            guard.status.state = EngineState::Stopping;
            guard.status.message = format!(
                "Reconciling Sockscap recovery generation {} with {}",
                journal.generation,
                capture_runtime.adapter_id()
            );
            guard.status.capture_active = false;
            guard.status.recovery_required = true;
            guard.recovery_attempt_generation = Some(journal.generation);
            RecoveryAttemptGuard {
                engine: self,
                generation: journal.generation,
                armed: true,
            }
        };
        self.live_flows.disable();

        let result = match capture_runtime.reconcile_recovery(journal.generation).await {
            Ok(clean) if clean.phase == RecoveryPhase::Clean && !clean.cleanup_required => {
                let status = EngineStatus::default();
                self.finish_recovery_attempt(journal.generation, status.clone());
                Ok(status)
            }
            Ok(clean) => {
                let status = recovery_status(&clean);
                self.finish_recovery_attempt(journal.generation, status);
                Err("CAPTURE_RECOVERY_INCOMPLETE: coordinator returned a dirty journal".into())
            }
            Err(error) => {
                let status = match store.recovery_journal() {
                    Ok(journal)
                        if !journal.cleanup_required && journal.phase == RecoveryPhase::Clean =>
                    {
                        EngineStatus::default()
                    }
                    Ok(journal) => recovery_status(&journal),
                    Err(read_error) => recovery_error_status(
                        "RECOVERY_JOURNAL_UNAVAILABLE",
                        format!(
                            "{}; Sockscap recovery journal could not be read: {read_error}",
                            error
                        ),
                        Vec::new(),
                    ),
                };
                self.finish_recovery_attempt(journal.generation, status);
                Err(format!("{}: {}", error.code, error.message))
            }
        };
        attempt.disarm();
        result
    }

    fn finish_recovery_attempt(&self, generation: u64, status: EngineStatus) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.recovery_attempt_generation == Some(generation) {
            guard.status = status;
            guard.recovery_attempt_generation = None;
        }
    }

    fn cancel_recovery_attempt(&self, generation: u64) {
        let status = match self.store.as_ref() {
            Some(store) => match store.recovery_journal() {
                Ok(journal)
                    if journal.cleanup_required || journal.phase != RecoveryPhase::Clean =>
                {
                    recovery_status(&journal)
                }
                Ok(_) => EngineStatus::default(),
                Err(error) => recovery_error_status(
                    "RECOVERY_JOURNAL_UNAVAILABLE",
                    format!(
                        "Sockscap recovery journal could not be read after cancellation: {error}"
                    ),
                    Vec::new(),
                ),
            },
            None => recovery_error_status(
                "SOCKSCAP_STORE_UNAVAILABLE",
                "saved configuration store is not attached after recovery cancellation".into(),
                Vec::new(),
            ),
        };
        self.finish_recovery_attempt(generation, status);
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use rusqlite::Connection;
    use tempfile::tempdir;
    use tokio::sync::Notify;

    use super::*;
    use crate::sockscap::capture::{
        AdapterProbe, CaptureArtifactState, CaptureError, CaptureHandle, CaptureInstallSpec,
    };
    use crate::sockscap::flow::stats::{FlowOutcomeKind, FlowStatsEvent};
    use crate::sockscap::types::{
        CapturePlatform, EgressKind, HostnameSource, ProfileScope, RouteAction, RoutingProfileDraft,
    };

    #[derive(Default)]
    struct RecoveryAdapter {
        generations: Mutex<Vec<u64>>,
        completed_generations: Mutex<Vec<u64>>,
        attempts: AtomicUsize,
        block_first_attempt: bool,
        first_attempt_entered: Notify,
        first_attempt_release: Notify,
    }

    #[async_trait]
    impl CaptureAdapter for RecoveryAdapter {
        fn id(&self) -> &'static str {
            "recovery_test"
        }

        fn platform(&self) -> CapturePlatform {
            CapturePlatform::current()
        }

        async fn probe(&self) -> AdapterProbe {
            unreachable!()
        }

        async fn install(&self, _spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
            unreachable!()
        }

        async fn update(
            &self,
            _handle: &CaptureHandle,
            _spec: &CaptureInstallSpec,
        ) -> Result<CaptureHandle, CaptureError> {
            unreachable!()
        }

        async fn stop(&self, _handle: &CaptureHandle) -> Result<(), CaptureError> {
            unreachable!()
        }

        async fn recover(&self, _artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
            unreachable!()
        }

        async fn recover_generation(&self, generation: u64) -> Result<(), CaptureError> {
            self.generations.lock().unwrap().push(generation);
            let attempt = self.attempts.fetch_add(1, Ordering::AcqRel);
            if self.block_first_attempt && attempt == 0 {
                self.first_attempt_entered.notify_one();
                self.first_attempt_release.notified().await;
            }
            self.completed_generations.lock().unwrap().push(generation);
            Ok(())
        }

        async fn heartbeat(&self, _handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
            unreachable!()
        }
    }

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
    fn stop_refuses_exit_cleanup_without_clearing_a_dirty_marker() {
        let store = store_with_profile();
        let marker = store
            .begin_prepare(
                &["p1".into()],
                1,
                CapturePlatform::current(),
                false,
                "unavailable_test",
            )
            .expect("write recovery marker");
        let engine = SockscapEngine::with_store(Arc::clone(&store));

        let error = engine
            .stop()
            .expect_err("stop must wait for platform helper proof");
        assert!(error.contains("RECOVERY_HELPER_REQUIRED"));
        let persisted = store.recovery_journal().expect("read recovery marker");
        assert_eq!(persisted.generation, marker.generation);
        assert_eq!(persisted.phase, RecoveryPhase::Preparing);
        assert!(persisted.cleanup_required);
    }

    #[test]
    fn login_restore_reads_only_the_last_committed_snapshot_and_stays_gated() {
        let store = store_with_profile();
        let prepared = store.prepare_config_snapshot().expect("prepare config");
        let committed = store
            .commit_config_snapshot(prepared.revision)
            .expect("commit config");
        let current = store.get_profile("p1").unwrap().unwrap();
        let mut draft = current.profile;
        draft.name = "Uncommitted draft edit".into();
        store
            .upsert_profile(&draft, Some(current.revision))
            .expect("edit draft after commit");

        let engine = SockscapEngine::with_store(Arc::clone(&store));
        let error = engine
            .restore_last_committed()
            .expect_err("capture adapter must remain a hard gate");
        assert!(error.contains(&format!("committed revision {}", committed.revision)));
        assert_eq!(
            store
                .last_committed_config_snapshot()
                .unwrap()
                .unwrap()
                .profiles[0]
                .name,
            "Test"
        );
        assert_eq!(
            store.recovery_journal().unwrap().phase,
            RecoveryPhase::Clean
        );
        assert!(!store.recovery_journal().unwrap().cleanup_required);
        assert_eq!(engine.status().state, EngineState::Disabled);
        assert!(!engine.status().capture_active);
    }

    #[test]
    fn startup_preserves_recovery_marker_and_recover_cannot_fake_cleanup() {
        let store = store_with_profile();
        let journal = store
            .begin_prepare(
                &["p1".into()],
                1,
                CapturePlatform::current(),
                true,
                "unavailable_test",
            )
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

    #[tokio::test]
    async fn injected_runtime_reconciles_the_exact_dirty_generation() {
        let store = store_with_profile();
        let marker = store
            .begin_prepare(
                &["p1".into()],
                1,
                CapturePlatform::current(),
                true,
                "recovery_test",
            )
            .expect("write recovery marker");
        let adapter = Arc::new(RecoveryAdapter::default());
        let engine = SockscapEngine::with_capture_adapter(Arc::clone(&store), adapter.clone());

        let status = engine
            .reconcile_recovery()
            .await
            .expect("reconcile recovery");
        assert_eq!(status.state, EngineState::Disabled);
        assert!(!status.recovery_required);
        assert_eq!(
            adapter.generations.lock().unwrap().as_slice(),
            &[marker.generation]
        );
        let clean = store.recovery_journal().unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert!(!clean.cleanup_required);
    }

    #[tokio::test]
    async fn injected_runtime_does_not_clean_a_foreign_platform_generation() {
        let store = store_with_profile();
        let foreign_platform = match CapturePlatform::current() {
            CapturePlatform::Windows => CapturePlatform::Linux,
            _ => CapturePlatform::Windows,
        };
        let marker = store
            .begin_prepare(&["p1".into()], 1, foreign_platform, true, "recovery_test")
            .expect("write recovery marker");
        let adapter = Arc::new(RecoveryAdapter::default());
        let engine = SockscapEngine::with_capture_adapter(Arc::clone(&store), adapter.clone());

        let error = engine.reconcile_recovery().await.unwrap_err();
        assert!(error.contains("CAPTURE_ADAPTER_PLATFORM_MISMATCH"));
        assert!(adapter.generations.lock().unwrap().is_empty());
        let persisted = store.recovery_journal().unwrap();
        assert_eq!(persisted.generation, marker.generation);
        assert_eq!(persisted.phase, RecoveryPhase::Preparing);
        assert!(persisted.cleanup_required);
        assert_eq!(engine.status().state, EngineState::RecoveryRequired);
    }

    #[tokio::test]
    async fn aborted_adapter_recovery_keeps_owned_transaction_and_cleans_once() {
        let store = store_with_profile();
        let marker = store
            .begin_prepare(
                &["p1".into()],
                1,
                CapturePlatform::current(),
                true,
                "recovery_test",
            )
            .expect("write recovery marker");
        let adapter = Arc::new(RecoveryAdapter {
            block_first_attempt: true,
            ..Default::default()
        });
        let engine = Arc::new(SockscapEngine::with_capture_adapter(
            Arc::clone(&store),
            adapter.clone(),
        ));

        let task_engine = Arc::clone(&engine);
        let task = tokio::spawn(async move { task_engine.reconcile_recovery().await });
        adapter.first_attempt_entered.notified().await;
        assert_eq!(engine.status().state, EngineState::Stopping);
        assert_eq!(
            store.recovery_journal().unwrap().phase,
            RecoveryPhase::Stopping
        );

        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(engine.status().state, EngineState::RecoveryRequired);
        assert_eq!(
            engine.inner.lock().unwrap().recovery_attempt_generation,
            None
        );

        adapter.first_attempt_release.notify_one();
        let status = engine
            .reconcile_recovery()
            .await
            .expect("retry cancelled recovery");
        assert_eq!(status.state, EngineState::Disabled);
        assert_eq!(
            adapter.generations.lock().unwrap().as_slice(),
            &[marker.generation]
        );
        assert_eq!(
            adapter.completed_generations.lock().unwrap().as_slice(),
            &[marker.generation]
        );
        let clean = store.recovery_journal().unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert!(!clean.cleanup_required);
    }

    #[tokio::test]
    async fn aborted_recovery_restores_status_when_journal_is_unavailable() {
        let directory = tempdir().unwrap();
        let store = Arc::new(SockscapStore::open(directory.path()).unwrap());
        store
            .upsert_profile(&profile(), Some(0))
            .expect("save routing profile");
        let marker = store
            .begin_prepare(
                &["p1".into()],
                1,
                CapturePlatform::current(),
                true,
                "recovery_test",
            )
            .expect("write recovery marker");
        let adapter = Arc::new(RecoveryAdapter {
            block_first_attempt: true,
            ..Default::default()
        });
        let engine = Arc::new(SockscapEngine::with_capture_adapter(
            Arc::clone(&store),
            adapter.clone(),
        ));

        let task_engine = Arc::clone(&engine);
        let task = tokio::spawn(async move { task_engine.reconcile_recovery().await });
        adapter.first_attempt_entered.notified().await;
        assert_eq!(engine.status().state, EngineState::Stopping);

        let database_path = store.database_path().unwrap().to_path_buf();
        Connection::open(database_path)
            .unwrap()
            .execute("DROP TABLE engine_recovery_journal", [])
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());

        let inner = engine.inner.lock().unwrap();
        assert_eq!(inner.recovery_attempt_generation, None);
        assert_eq!(inner.status.state, EngineState::RecoveryRequired);
        assert!(inner.status.recovery_required);
        let last_error = inner.status.last_error.as_deref().unwrap();
        assert!(last_error.contains("RECOVERY_JOURNAL_UNAVAILABLE"));
        assert!(last_error.contains("after cancellation"));
        assert_eq!(marker.generation, 1);
        drop(inner);
        adapter.first_attempt_release.notify_one();
    }

    #[tokio::test]
    async fn clean_journal_does_not_overwrite_active_or_preparing_state() {
        let store = store_with_profile();
        let engine = SockscapEngine::with_store(store);

        for state in [EngineState::Preparing, EngineState::Active] {
            engine.set_live_sampling_profiles(["p1".to_string()]);
            {
                let mut inner = engine.inner.lock().unwrap();
                inner.status.state = state;
                inner.status.message = format!("future {state:?} runtime");
                inner.status.active_profile_ids = vec!["p1".into()];
                inner.status.capture_active = state == EngineState::Active;
                inner.status.recovery_required = false;
                inner.recovery_attempt_generation = None;
            }

            let error = engine.reconcile_recovery().await.unwrap_err();
            assert!(error.contains("ENGINE_STATE_CONFLICT"));
            let status = engine.status();
            assert_eq!(status.state, state);
            assert_eq!(status.active_profile_ids, vec!["p1"]);
            assert_eq!(status.capture_active, state == EngineState::Active);

            engine.live_flow_sink().record(FlowStatsEvent {
                profile_id: "p1".into(),
                protocol: "tcp".into(),
                hostname_source: HostnameSource::IpOnly,
                policy_action: RouteAction::Proxy,
                effective_action: RouteAction::Proxy,
                outcome: FlowOutcomeKind::Established,
                connector: Some("test".into()),
                error_code: None,
                connect_millis: 1,
            });
            assert_eq!(
                engine
                    .live_connections(&LiveConnectionsQuery {
                        since_unix: None,
                        limit: 10,
                    })
                    .unwrap()
                    .samples
                    .len(),
                if state == EngineState::Preparing {
                    1
                } else {
                    2
                }
            );
        }
    }
}
