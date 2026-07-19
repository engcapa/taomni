//! Durable capture lifecycle transaction.
//!
//! The coordinator writes the app-owned recovery marker before invoking a
//! privileged adapter, persists every returned artifact before advancing the
//! lifecycle, and clears the marker only after adapter cleanup succeeds.

use std::sync::Arc;

use serde_json::Value;

use super::{
    CaptureAdapter, CaptureArtifactState, CaptureError, CaptureHandle, CaptureInstallSpec,
};
use crate::sockscap::storage::{RecoveryJournal, RecoveryPhase, SockscapStore};

pub struct CaptureTransactionCoordinator {
    store: Arc<SockscapStore>,
}

impl CaptureTransactionCoordinator {
    pub fn new(store: Arc<SockscapStore>) -> Self {
        Self { store }
    }

    /// Install one generation and advance it to Active only after an
    /// authenticated helper heartbeat and its latest recovery receipt persist.
    pub async fn install<A: CaptureAdapter>(
        &self,
        adapter: &A,
        mut spec: CaptureInstallSpec,
        active_profile_ids: &[String],
        restore_after_recovery: bool,
    ) -> Result<CaptureHandle, CaptureError> {
        if adapter.platform() != spec.platform {
            return Err(CaptureError::invalid(
                "CAPTURE_ADAPTER_PLATFORM_MISMATCH",
                "capture adapter does not match the requested platform",
            ));
        }

        // Validate every field that does not depend on the allocated journal
        // generation before creating the durable marker.
        spec.generation = 1;
        spec.validate()?;
        let marker = self
            .store
            .begin_prepare(
                active_profile_ids,
                spec.config_revision,
                spec.platform,
                restore_after_recovery,
            )
            .map_err(|error| store_error("CAPTURE_PREPARE_JOURNAL_FAILED", error, false))?;
        spec.generation = marker.generation;

        let installed = match adapter.install(&spec).await {
            Ok(handle) => handle,
            Err(error) => return Err(self.finish_failed_install(marker.generation, error)),
        };
        if let Err(error) = installed.validate_for(&spec) {
            return Err(self
                .cleanup_after_commit_failure(adapter, &installed, error)
                .await);
        }

        if let Err(error) = self.record_installed(&installed) {
            return Err(self
                .cleanup_after_commit_failure(adapter, &installed, error)
                .await);
        }

        let refreshed = match adapter.heartbeat(&installed).await {
            Ok(handle) => handle,
            Err(error) => {
                return Err(self
                    .cleanup_after_commit_failure(adapter, &installed, error)
                    .await);
            }
        };
        if let Err(error) = refreshed.validate_for(&spec) {
            return Err(self
                .cleanup_after_commit_failure(adapter, &installed, error)
                .await);
        }
        if let Err(error) = self.persist_heartbeat(&refreshed) {
            return Err(self
                .cleanup_after_commit_failure(adapter, &refreshed, error)
                .await);
        }
        if let Err(error) = self.store.commit_active(refreshed.generation) {
            return Err(self
                .cleanup_after_commit_failure(
                    adapter,
                    &refreshed,
                    store_error("CAPTURE_ACTIVE_COMMIT_FAILED", error, true),
                )
                .await);
        }
        Ok(refreshed)
    }

    /// Refresh selectors or bypasses and durably replace the recovery receipt.
    pub async fn update<A: CaptureAdapter>(
        &self,
        adapter: &A,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        self.ensure_active_generation(handle.generation)?;
        spec.validate()?;
        if spec.generation != handle.generation || spec.config_revision != handle.config_revision {
            return Err(CaptureError::invalid(
                "CAPTURE_UPDATE_GENERATION_MISMATCH",
                "capture update must keep the active generation and configuration revision",
            ));
        }
        let updated = adapter.update(handle, spec).await.map_err(|error| {
            self.persist_runtime_failure(handle.generation, &handle.artifact, error)
        })?;
        if let Err(error) = updated.validate_for(spec) {
            return Err(self.persist_runtime_failure(handle.generation, &updated.artifact, error));
        }
        if let Err(error) = self.persist_artifact(&updated.artifact) {
            return Err(self.persist_runtime_failure(handle.generation, &updated.artifact, error));
        }
        Ok(updated)
    }

    /// Refresh helper liveness and persist membership changes before returning.
    pub async fn heartbeat<A: CaptureAdapter>(
        &self,
        adapter: &A,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        self.ensure_active_generation(handle.generation)?;
        let refreshed = adapter.heartbeat(handle).await.map_err(|error| {
            self.persist_runtime_failure(handle.generation, &handle.artifact, error)
        })?;
        if let Err(error) = refreshed.validate_for(spec) {
            return Err(self.persist_runtime_failure(
                handle.generation,
                &refreshed.artifact,
                error,
            ));
        }
        if let Err(error) = self.persist_heartbeat(&refreshed) {
            return Err(self.persist_runtime_failure(
                handle.generation,
                &refreshed.artifact,
                error,
            ));
        }
        Ok(refreshed)
    }

    /// Stop is idempotent only when the journal is already clean. Otherwise
    /// cleanup proof from the adapter is mandatory before clearing the marker.
    pub async fn stop<A: CaptureAdapter>(
        &self,
        adapter: &A,
        handle: &CaptureHandle,
    ) -> Result<RecoveryJournal, CaptureError> {
        let journal = self.read_journal()?;
        if !journal.cleanup_required && journal.phase == RecoveryPhase::Clean {
            return Ok(journal);
        }
        if journal.generation != handle.generation {
            return Err(CaptureError::recovery(
                "CAPTURE_GENERATION_MISMATCH",
                "active handle does not match the persisted recovery generation",
            ));
        }
        self.store
            .begin_stop(handle.generation)
            .map_err(|error| store_error("CAPTURE_STOP_JOURNAL_FAILED", error, true))?;
        match adapter.stop(handle).await {
            Ok(()) => self.complete(handle.generation),
            Err(error) => {
                let artifact = error
                    .artifact
                    .clone()
                    .unwrap_or_else(|| handle.artifact.clone());
                Err(self.persist_runtime_failure(handle.generation, &artifact, error))
            }
        }
    }

    /// Recover an interrupted generation from its typed, non-secret receipt.
    /// An empty receipt is deliberately not interpreted as proof of no residue.
    pub async fn recover<A: CaptureAdapter>(
        &self,
        adapter: &A,
    ) -> Result<RecoveryJournal, CaptureError> {
        let journal = self.read_journal()?;
        if !journal.cleanup_required && journal.phase == RecoveryPhase::Clean {
            return Ok(journal);
        }
        let artifact: CaptureArtifactState = serde_json::from_value(journal.artifact_state.clone())
            .map_err(|error| {
                CaptureError::recovery(
                    "CAPTURE_RECOVERY_RECEIPT_MISSING",
                    format!("recovery receipt is absent or invalid: {error}"),
                )
            })?;
        artifact.validate().map_err(|error| {
            CaptureError::recovery(
                "CAPTURE_RECOVERY_RECEIPT_INVALID",
                format!("persisted recovery receipt failed validation: {error}"),
            )
        })?;
        if artifact.generation != journal.generation {
            return Err(CaptureError::recovery(
                "CAPTURE_RECOVERY_GENERATION_MISMATCH",
                "recovery receipt generation does not match the journal",
            ));
        }
        self.store
            .begin_stop(journal.generation)
            .map_err(|error| store_error("CAPTURE_RECOVERY_JOURNAL_FAILED", error, true))?;
        match adapter.recover(&artifact).await {
            Ok(()) => self.complete(journal.generation),
            Err(error) => {
                let fallback = error.artifact.clone().unwrap_or_else(|| artifact.clone());
                Err(self.persist_runtime_failure(journal.generation, &fallback, error))
            }
        }
    }

    fn record_installed(&self, handle: &CaptureHandle) -> Result<RecoveryJournal, CaptureError> {
        let artifact = artifact_json(&handle.artifact)?;
        self.store
            .record_capture_installed(handle.generation, &artifact)
            .map_err(|error| store_error("CAPTURE_RECEIPT_PERSIST_FAILED", error, true))
    }

    fn persist_artifact(
        &self,
        artifact: &CaptureArtifactState,
    ) -> Result<RecoveryJournal, CaptureError> {
        let artifact_json = artifact_json(artifact)?;
        self.store
            .update_recovery_artifact(artifact.generation, &artifact_json)
            .map_err(|error| store_error("CAPTURE_RECEIPT_PERSIST_FAILED", error, true))
    }

    fn persist_heartbeat(&self, handle: &CaptureHandle) -> Result<RecoveryJournal, CaptureError> {
        self.persist_artifact(&handle.artifact)?;
        self.store
            .record_helper_heartbeat(handle.generation, handle.helper_pid)
            .map_err(|error| store_error("CAPTURE_HEARTBEAT_PERSIST_FAILED", error, true))
    }

    fn finish_failed_install(&self, generation: u64, error: CaptureError) -> CaptureError {
        if let Some(artifact) = &error.artifact {
            if let Err(persist_error) = self.persist_artifact(artifact) {
                return combine_errors(error, persist_error);
            }
        }
        if error.recovery_required || error.artifact.is_some() {
            if let Err(mark_error) = self.store.mark_recovery_required(generation, &error.code) {
                return combine_errors(
                    error,
                    store_error("CAPTURE_RECOVERY_MARK_FAILED", mark_error, true),
                );
            }
            error
        } else {
            match self.complete(generation) {
                Ok(_) => error,
                Err(clean_error) => combine_errors(error, clean_error),
            }
        }
    }

    async fn cleanup_after_commit_failure<A: CaptureAdapter>(
        &self,
        adapter: &A,
        handle: &CaptureHandle,
        original: CaptureError,
    ) -> CaptureError {
        let _ = self.persist_artifact(&handle.artifact);
        let _ = self.store.begin_stop(handle.generation);
        match adapter.stop(handle).await {
            Ok(()) => match self.complete(handle.generation) {
                Ok(_) => original,
                Err(clean_error) => combine_errors(original, clean_error),
            },
            Err(cleanup) => {
                let artifact = cleanup
                    .artifact
                    .clone()
                    .unwrap_or_else(|| handle.artifact.clone());
                self.persist_runtime_failure(
                    handle.generation,
                    &artifact,
                    combine_errors(original, cleanup),
                )
            }
        }
    }

    fn persist_runtime_failure(
        &self,
        generation: u64,
        fallback_artifact: &CaptureArtifactState,
        mut error: CaptureError,
    ) -> CaptureError {
        let artifact = error
            .artifact
            .clone()
            .unwrap_or_else(|| fallback_artifact.clone());
        error.recovery_required = true;
        error.artifact = Some(artifact.clone());
        if let Err(persist_error) = self.persist_artifact(&artifact) {
            error = combine_errors(error, persist_error);
        }
        if let Err(mark_error) = self.store.mark_recovery_required(generation, &error.code) {
            error = combine_errors(
                error,
                store_error("CAPTURE_RECOVERY_MARK_FAILED", mark_error, true),
            );
        }
        error
    }

    fn ensure_active_generation(&self, generation: u64) -> Result<(), CaptureError> {
        let journal = self.read_journal()?;
        if journal.generation != generation || journal.phase != RecoveryPhase::Active {
            return Err(CaptureError::recovery(
                "CAPTURE_STATE_MISMATCH",
                "capture operation requires the matching active recovery generation",
            ));
        }
        Ok(())
    }

    fn read_journal(&self) -> Result<RecoveryJournal, CaptureError> {
        self.store
            .recovery_journal()
            .map_err(|error| store_error("CAPTURE_JOURNAL_READ_FAILED", error, true))
    }

    fn complete(&self, generation: u64) -> Result<RecoveryJournal, CaptureError> {
        self.store
            .complete_recovery(generation)
            .map_err(|error| store_error("CAPTURE_RECOVERY_COMPLETE_FAILED", error, true))
    }
}

fn artifact_json(artifact: &CaptureArtifactState) -> Result<Value, CaptureError> {
    artifact.validate()?;
    serde_json::to_value(artifact).map_err(|error| {
        CaptureError::recovery(
            "CAPTURE_RECEIPT_ENCODE_FAILED",
            format!("could not encode recovery receipt: {error}"),
        )
    })
}

fn store_error(code: &str, message: String, recovery_required: bool) -> CaptureError {
    if recovery_required {
        CaptureError::recovery(code, message)
    } else {
        CaptureError::invalid(code, message)
    }
}

fn combine_errors(mut primary: CaptureError, secondary: CaptureError) -> CaptureError {
    primary.message = format!(
        "{}; {}: {}",
        primary.message, secondary.code, secondary.message
    );
    primary.recovery_required |= secondary.recovery_required;
    if primary.artifact.is_none() {
        primary.artifact = secondary.artifact;
    }
    primary
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::sockscap::capture::{AdapterProbe, CaptureMode};
    use crate::sockscap::types::CapturePlatform;

    #[derive(Default)]
    struct FakeAdapter {
        fail_install: bool,
        fail_stop: bool,
        calls: Mutex<Vec<&'static str>>,
    }

    impl FakeAdapter {
        fn artifact(generation: u64) -> CaptureArtifactState {
            CaptureArtifactState {
                adapter: "fake_linux".into(),
                generation,
                owner_uid: Some(1000),
                interface_names: vec![format!("tun-{generation}")],
                rule_ids: Vec::new(),
                route_ids: Vec::new(),
                cgroup_paths: Vec::new(),
                driver_service: None,
                extension_bundle_id: None,
                process_restores: Vec::new(),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl CaptureAdapter for FakeAdapter {
        fn id(&self) -> &'static str {
            "fake_linux"
        }

        fn platform(&self) -> CapturePlatform {
            CapturePlatform::current()
        }

        async fn probe(&self) -> AdapterProbe {
            unreachable!()
        }

        async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
            self.calls.lock().unwrap().push("install");
            let artifact = Self::artifact(spec.generation);
            if self.fail_install {
                return Err(CaptureError::recovery_with_artifact(
                    "FAKE_INSTALL_FAILED",
                    "partial fake install",
                    artifact,
                ));
            }
            Ok(CaptureHandle {
                generation: spec.generation,
                config_revision: spec.config_revision,
                helper_pid: 99,
                artifact,
            })
        }

        async fn update(
            &self,
            handle: &CaptureHandle,
            _spec: &CaptureInstallSpec,
        ) -> Result<CaptureHandle, CaptureError> {
            Ok(handle.clone())
        }

        async fn stop(&self, _handle: &CaptureHandle) -> Result<(), CaptureError> {
            self.calls.lock().unwrap().push("stop");
            if self.fail_stop {
                Err(CaptureError::recovery("FAKE_STOP_FAILED", "fake residue"))
            } else {
                Ok(())
            }
        }

        async fn recover(&self, _artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
            self.calls.lock().unwrap().push("recover");
            Ok(())
        }

        async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
            self.calls.lock().unwrap().push("heartbeat");
            let mut refreshed = handle.clone();
            refreshed
                .artifact
                .rule_ids
                .push("membership-refreshed".into());
            Ok(refreshed)
        }
    }

    fn spec() -> CaptureInstallSpec {
        CaptureInstallSpec {
            generation: 0,
            config_revision: 7,
            platform: CapturePlatform::current(),
            mode: CaptureMode::Global,
            gateway: "127.0.0.1:32100".parse().unwrap(),
            route_ipv6: false,
            selectors: Vec::new(),
            bypass_ips: vec!["192.0.2.1".parse().unwrap()],
            taomni_pid: 42,
            helper_pid: None,
        }
    }

    #[tokio::test]
    async fn install_heartbeat_and_stop_preserve_ordered_receipt() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter::default();
        let handle = coordinator
            .install(&adapter, spec(), &["global".into()], false)
            .await
            .unwrap();
        let active = store.recovery_journal().unwrap();
        assert_eq!(active.phase, RecoveryPhase::Active);
        assert_eq!(active.helper_pid, Some(99));
        assert_eq!(
            active.artifact_state["ruleIds"],
            serde_json::json!(["membership-refreshed"])
        );
        assert_eq!(adapter.calls(), vec!["install", "heartbeat"]);

        let clean = coordinator.stop(&adapter, &handle).await.unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert!(!clean.cleanup_required);
        assert_eq!(adapter.calls(), vec!["install", "heartbeat", "stop"]);
    }

    #[tokio::test]
    async fn partial_install_is_persisted_and_recovered() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            fail_install: true,
            ..Default::default()
        };
        let error = coordinator
            .install(&adapter, spec(), &["global".into()], false)
            .await
            .unwrap_err();
        assert!(error.recovery_required);
        let dirty = store.recovery_journal().unwrap();
        assert_eq!(dirty.phase, RecoveryPhase::RecoveryRequired);
        assert_eq!(dirty.artifact_state["adapter"], "fake_linux");

        let clean = coordinator.recover(&adapter).await.unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert_eq!(adapter.calls(), vec!["install", "recover"]);
    }

    #[tokio::test]
    async fn failed_stop_keeps_marker_and_receipt() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            fail_stop: true,
            ..Default::default()
        };
        let handle = coordinator
            .install(&adapter, spec(), &["global".into()], false)
            .await
            .unwrap();
        let error = coordinator.stop(&adapter, &handle).await.unwrap_err();
        assert!(error.recovery_required);
        let dirty = store.recovery_journal().unwrap();
        assert_eq!(dirty.phase, RecoveryPhase::RecoveryRequired);
        assert!(dirty.cleanup_required);
        assert_eq!(dirty.artifact_state["adapter"], "fake_linux");
    }

    #[tokio::test]
    async fn empty_crash_marker_cannot_be_cleared_without_receipt() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        store
            .begin_prepare(&["global".into()], 7, CapturePlatform::current(), false)
            .unwrap();
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let error = coordinator
            .recover(&FakeAdapter::default())
            .await
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_RECOVERY_RECEIPT_MISSING");
        assert!(store.recovery_journal().unwrap().cleanup_required);
    }
}
