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

pub(super) struct CaptureTransactionCoordinator {
    store: Arc<SockscapStore>,
}

impl CaptureTransactionCoordinator {
    pub(super) fn new(store: Arc<SockscapStore>) -> Self {
        Self { store }
    }

    /// Install one generation and advance it to Active only after an
    /// authenticated helper heartbeat and its latest recovery receipt persist.
    pub(super) async fn install<A: CaptureAdapter + ?Sized>(
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
                adapter.id(),
            )
            .map_err(|error| store_error("CAPTURE_PREPARE_JOURNAL_FAILED", error, false))?;
        spec.generation = marker.generation;

        let installed = match adapter.install(&spec).await {
            Ok(handle) => handle,
            Err(error) => {
                return Err(self.finish_failed_install(adapter, marker.generation, error));
            }
        };
        let trusted_installed =
            match validate_capture_handle(adapter, marker.generation, &spec, &installed) {
                Ok(handle) => handle,
                Err(error) => {
                    return Err(self
                        .cleanup_after_commit_failure(adapter, marker.generation, None, error)
                        .await);
                }
            };

        if let Err(error) = self.record_installed(adapter, trusted_installed.as_handle()) {
            return Err(self
                .cleanup_after_commit_failure(
                    adapter,
                    marker.generation,
                    Some(trusted_installed),
                    error,
                )
                .await);
        }

        // Replace the pre-heartbeat receipt with an explicit generation-only
        // cleanup binding before the adapter can attach more members. A crash
        // or rejected response after this point must never recover through the
        // now-stale installed receipt.
        if let Err(error) = self.persist_generation_cleanup_binding(adapter, marker.generation) {
            return Err(self
                .cleanup_after_commit_failure(
                    adapter,
                    marker.generation,
                    Some(trusted_installed),
                    error,
                )
                .await);
        }

        // Heartbeat may already have attached new child processes before it
        // returns. Once invoked, the pre-heartbeat receipt can no longer prove
        // exhaustive cleanup; every error or rejected refreshed receipt must
        // use generation-wide recovery instead of stop(old_handle).
        let refreshed = match adapter.heartbeat(trusted_installed.as_handle()).await {
            Ok(handle) => handle,
            Err(error) => {
                return Err(self
                    .cleanup_after_commit_failure(adapter, marker.generation, None, error)
                    .await);
            }
        };
        let trusted_refreshed =
            match validate_capture_handle(adapter, marker.generation, &spec, &refreshed) {
                Ok(handle) => handle,
                Err(error) => {
                    return Err(self
                        .cleanup_after_commit_failure(adapter, marker.generation, None, error)
                        .await);
                }
            };
        if let Err(error) =
            ensure_handle_lineage(trusted_installed.as_handle(), trusted_refreshed.as_handle())
        {
            return Err(self
                .cleanup_after_commit_failure(adapter, marker.generation, None, error)
                .await);
        }
        if let Err(error) = self.persist_heartbeat(adapter, trusted_refreshed.as_handle()) {
            return Err(self
                .cleanup_after_commit_failure(
                    adapter,
                    marker.generation,
                    Some(trusted_refreshed),
                    error,
                )
                .await);
        }
        if let Err(error) = self.store.commit_active(refreshed.generation) {
            return Err(self
                .cleanup_after_commit_failure(
                    adapter,
                    marker.generation,
                    Some(trusted_refreshed),
                    store_error("CAPTURE_ACTIVE_COMMIT_FAILED", error, true),
                )
                .await);
        }
        Ok(refreshed)
    }

    /// Refresh selectors or bypasses and durably replace the recovery receipt.
    pub(super) async fn update<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        let journal = self.ensure_active_generation(handle.generation)?;
        ensure_adapter_context(adapter, &journal)?;
        spec.validate()?;
        ensure_spec_context(spec, &journal)?;
        handle.validate_for(spec)?;
        ensure_handle_context(handle, &journal)?;
        ensure_adapter_receipt(adapter, handle.generation, &handle.artifact)?;
        if spec.generation != handle.generation || spec.config_revision != handle.config_revision {
            return Err(CaptureError::invalid(
                "CAPTURE_UPDATE_GENERATION_MISMATCH",
                "capture update must keep the active generation and configuration revision",
            ));
        }
        let updated = adapter.update(handle, spec).await.map_err(|error| {
            self.persist_adapter_runtime_failure(
                adapter,
                handle.generation,
                &handle.artifact,
                error,
            )
        })?;
        if let Err(error) = ensure_adapter_receipt(adapter, handle.generation, &updated.artifact) {
            return Err(self.persist_runtime_failure(handle.generation, &handle.artifact, error));
        }
        if let Err(error) = updated.validate_for(spec) {
            return Err(self.persist_runtime_failure(handle.generation, &updated.artifact, error));
        }
        if let Err(error) = ensure_handle_lineage(handle, &updated) {
            return Err(self.persist_runtime_failure(handle.generation, &updated.artifact, error));
        }
        if let Err(error) = self.persist_artifact(&updated.artifact) {
            return Err(self.persist_runtime_failure(handle.generation, &updated.artifact, error));
        }
        Ok(updated)
    }

    /// Refresh helper liveness and persist membership changes before returning.
    pub(super) async fn heartbeat<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        let journal = self.ensure_active_generation(handle.generation)?;
        ensure_adapter_context(adapter, &journal)?;
        spec.validate()?;
        ensure_spec_context(spec, &journal)?;
        handle.validate_for(spec)?;
        ensure_handle_context(handle, &journal)?;
        ensure_adapter_receipt(adapter, handle.generation, &handle.artifact)?;
        let refreshed = adapter.heartbeat(handle).await.map_err(|error| {
            self.persist_adapter_runtime_failure(
                adapter,
                handle.generation,
                &handle.artifact,
                error,
            )
        })?;
        if let Err(error) = ensure_adapter_receipt(adapter, handle.generation, &refreshed.artifact)
        {
            return Err(self.persist_runtime_failure(handle.generation, &handle.artifact, error));
        }
        if let Err(error) = refreshed.validate_for(spec) {
            return Err(self.persist_runtime_failure(
                handle.generation,
                &refreshed.artifact,
                error,
            ));
        }
        if let Err(error) = ensure_handle_lineage(handle, &refreshed) {
            return Err(self.persist_runtime_failure(
                handle.generation,
                &refreshed.artifact,
                error,
            ));
        }
        if let Err(error) = self.persist_heartbeat(adapter, &refreshed) {
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
    pub(super) async fn stop<A: CaptureAdapter + ?Sized>(
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
        ensure_adapter_context(adapter, &journal)?;
        ensure_handle_context(handle, &journal)?;
        ensure_adapter_receipt(adapter, handle.generation, &handle.artifact)?;
        self.store
            .begin_stop(handle.generation)
            .map_err(|error| store_error("CAPTURE_STOP_JOURNAL_FAILED", error, true))?;
        match adapter.stop(handle).await {
            Ok(()) => self.complete(handle.generation),
            Err(error) => Err(self.persist_adapter_runtime_failure(
                adapter,
                handle.generation,
                &handle.artifact,
                error,
            )),
        }
    }

    /// Recover an interrupted generation from its typed, non-secret receipt.
    /// The caller must bind the attempt to the generation it observed before
    /// entering the runtime owner; a newer generation is never cleaned by a
    /// stale request. A legacy unbound receipt is deliberately not interpreted
    /// as proof of no residue.
    pub(super) async fn recover<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        expected_generation: u64,
    ) -> Result<RecoveryJournal, CaptureError> {
        let journal = self.read_journal()?;
        if journal.generation != expected_generation {
            return Err(CaptureError::recovery(
                "CAPTURE_RECOVERY_GENERATION_MISMATCH",
                "recovery request does not match the currently persisted generation",
            ));
        }
        if !journal.cleanup_required && journal.phase == RecoveryPhase::Clean {
            return Ok(journal);
        }
        ensure_adapter_context(adapter, &journal)?;
        if let Some(binding) = pending_adapter_binding(&journal.artifact_state)? {
            if !matches!(
                journal.phase,
                RecoveryPhase::Preparing
                    | RecoveryPhase::CaptureInstalled
                    | RecoveryPhase::Stopping
                    | RecoveryPhase::RecoveryRequired
            ) {
                return Err(CaptureError::recovery(
                    "CAPTURE_RECOVERY_BINDING_STATE_INVALID",
                    "a pending adapter binding exists in an impossible lifecycle phase",
                ));
            }
            if binding.generation != journal.generation {
                return Err(CaptureError::recovery(
                    "CAPTURE_RECOVERY_GENERATION_MISMATCH",
                    "pending adapter binding generation does not match the journal",
                ));
            }
            if binding.adapter != adapter.id() {
                return Err(CaptureError::recovery(
                    "CAPTURE_RECOVERY_ADAPTER_MISMATCH",
                    "pending recovery generation belongs to a different adapter",
                ));
            }
            self.ensure_stopping(&journal)?;
            return match adapter.recover_generation(journal.generation).await {
                Ok(()) => self.complete(journal.generation),
                Err(error) => Err(self.persist_generation_recovery_failure(
                    adapter,
                    journal.generation,
                    error,
                )),
            };
        }
        if journal.artifact_state == serde_json::json!({}) {
            return Err(CaptureError::recovery(
                "CAPTURE_RECOVERY_ADAPTER_UNBOUND",
                "legacy recovery marker has no durable adapter binding; automatic cleanup is unsafe",
            ));
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
        if artifact.adapter != adapter.id() {
            return Err(CaptureError::recovery_with_artifact(
                "CAPTURE_RECOVERY_ADAPTER_MISMATCH",
                "recovery receipt does not belong to the selected platform adapter",
                artifact,
            ));
        }
        self.ensure_stopping(&journal)?;
        match adapter.recover(&artifact).await {
            Ok(()) => self.complete(journal.generation),
            Err(error) => Err(self.persist_adapter_runtime_failure(
                adapter,
                journal.generation,
                &artifact,
                error,
            )),
        }
    }

    fn record_installed<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        handle: &CaptureHandle,
    ) -> Result<RecoveryJournal, CaptureError> {
        ensure_adapter_receipt(adapter, handle.generation, &handle.artifact)?;
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

    fn persist_generation_cleanup_binding<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        generation: u64,
    ) -> Result<RecoveryJournal, CaptureError> {
        let binding = serde_json::json!({
            "bindingSchemaVersion": 1,
            "bindingState": "adapter_selected",
            "adapter": adapter.id(),
            "generation": generation,
        });
        self.store
            .update_recovery_artifact(generation, &binding)
            .map_err(|error| store_error("CAPTURE_GENERATION_BINDING_FAILED", error, true))
    }

    fn persist_heartbeat<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        handle: &CaptureHandle,
    ) -> Result<RecoveryJournal, CaptureError> {
        ensure_adapter_receipt(adapter, handle.generation, &handle.artifact)?;
        self.persist_artifact(&handle.artifact)?;
        self.store
            .record_helper_heartbeat(handle.generation, handle.helper_pid)
            .map_err(|error| store_error("CAPTURE_HEARTBEAT_PERSIST_FAILED", error, true))
    }

    fn finish_failed_install<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        generation: u64,
        mut error: CaptureError,
    ) -> CaptureError {
        if let Some(artifact) = error.artifact.clone() {
            if let Err(binding_error) = ensure_adapter_receipt(adapter, generation, &artifact) {
                error = combine_errors(error, binding_error);
                error.artifact = None;
            } else if let Err(persist_error) = self.persist_artifact(&artifact) {
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

    fn persist_generation_recovery_failure<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        generation: u64,
        mut error: CaptureError,
    ) -> CaptureError {
        if let Some(artifact) = error.artifact.clone() {
            if let Err(binding_error) = ensure_adapter_receipt(adapter, generation, &artifact) {
                error = combine_errors(error, binding_error);
                error.artifact = None;
            } else if let Err(persist_error) = self.persist_artifact(&artifact) {
                error = combine_errors(error, persist_error);
            }
        }
        if let Err(mark_error) = self.store.mark_recovery_required(generation, &error.code) {
            combine_errors(
                error,
                store_error("CAPTURE_RECOVERY_MARK_FAILED", mark_error, true),
            )
        } else {
            error
        }
    }

    async fn cleanup_after_commit_failure<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        generation: u64,
        trusted_handle: Option<ValidatedCaptureHandle<'_>>,
        mut original: CaptureError,
    ) -> CaptureError {
        if let Some(handle) = trusted_handle {
            if let Err(persist_error) = self.persist_artifact(&handle.as_handle().artifact) {
                original = combine_errors(original, persist_error);
            }
        }
        if let Err(stop_error) = self.store.begin_stop(generation) {
            original = combine_errors(
                original,
                store_error("CAPTURE_STOP_JOURNAL_FAILED", stop_error, true),
            );
        }

        // A rejected receipt is never passed back to a privileged stop path.
        // The durable pending binding permits only generation-scoped rollback
        // through the adapter that was selected before install began.
        let cleanup_result = match trusted_handle {
            Some(handle) => adapter.stop(handle.as_handle()).await,
            None => adapter.recover_generation(generation).await,
        };
        match cleanup_result {
            Ok(()) => match self.complete(generation) {
                Ok(_) => original,
                Err(clean_error) => combine_errors(original, clean_error),
            },
            Err(cleanup) => {
                let artifact = cleanup
                    .artifact
                    .clone()
                    .filter(|artifact| {
                        ensure_adapter_receipt(adapter, generation, artifact).is_ok()
                    })
                    .or_else(|| trusted_handle.map(|handle| handle.as_handle().artifact.clone()));
                let mut combined = combine_errors(original, cleanup);
                combined.artifact = artifact.clone();
                match artifact {
                    Some(artifact) => self.persist_runtime_failure(generation, &artifact, combined),
                    None => self.persist_runtime_failure_without_receipt(generation, combined),
                }
            }
        }
    }

    fn persist_adapter_runtime_failure<A: CaptureAdapter + ?Sized>(
        &self,
        adapter: &A,
        generation: u64,
        fallback_artifact: &CaptureArtifactState,
        mut error: CaptureError,
    ) -> CaptureError {
        if let Some(artifact) = error.artifact.clone()
            && let Err(binding_error) = ensure_adapter_receipt(adapter, generation, &artifact)
        {
            error = combine_errors(error, binding_error);
            error.artifact = None;
        }
        self.persist_runtime_failure(generation, fallback_artifact, error)
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

    fn persist_runtime_failure_without_receipt(
        &self,
        generation: u64,
        mut error: CaptureError,
    ) -> CaptureError {
        error.recovery_required = true;
        error.artifact = None;
        if let Err(mark_error) = self.store.mark_recovery_required(generation, &error.code) {
            error = combine_errors(
                error,
                store_error("CAPTURE_RECOVERY_MARK_FAILED", mark_error, true),
            );
        }
        error
    }

    fn ensure_active_generation(&self, generation: u64) -> Result<RecoveryJournal, CaptureError> {
        let journal = self.read_journal()?;
        if journal.generation != generation || journal.phase != RecoveryPhase::Active {
            return Err(CaptureError::recovery(
                "CAPTURE_STATE_MISMATCH",
                "capture operation requires the matching active recovery generation",
            ));
        }
        Ok(journal)
    }

    fn read_journal(&self) -> Result<RecoveryJournal, CaptureError> {
        self.store
            .recovery_journal()
            .map_err(|error| store_error("CAPTURE_JOURNAL_READ_FAILED", error, true))
    }

    fn ensure_stopping(&self, journal: &RecoveryJournal) -> Result<(), CaptureError> {
        if journal.phase == RecoveryPhase::Stopping {
            return Ok(());
        }
        self.store
            .begin_stop(journal.generation)
            .map(|_| ())
            .map_err(|error| store_error("CAPTURE_RECOVERY_JOURNAL_FAILED", error, true))
    }

    fn complete(&self, generation: u64) -> Result<RecoveryJournal, CaptureError> {
        self.store
            .complete_recovery(generation)
            .map_err(|error| store_error("CAPTURE_RECOVERY_COMPLETE_FAILED", error, true))
    }
}

fn ensure_adapter_context<A: CaptureAdapter + ?Sized>(
    adapter: &A,
    journal: &RecoveryJournal,
) -> Result<(), CaptureError> {
    if adapter.platform() != journal.platform {
        return Err(CaptureError::recovery(
            "CAPTURE_ADAPTER_PLATFORM_MISMATCH",
            "capture adapter does not match the persisted capture platform",
        ));
    }
    Ok(())
}

fn ensure_spec_context(
    spec: &CaptureInstallSpec,
    journal: &RecoveryJournal,
) -> Result<(), CaptureError> {
    if spec.platform != journal.platform {
        return Err(CaptureError::recovery(
            "CAPTURE_SPEC_PLATFORM_MISMATCH",
            "capture operation does not match the persisted capture platform",
        ));
    }
    if spec.generation != journal.generation || spec.config_revision != journal.config_revision {
        return Err(CaptureError::recovery(
            "CAPTURE_SPEC_JOURNAL_MISMATCH",
            "capture operation does not match the persisted transaction",
        ));
    }
    Ok(())
}

fn ensure_handle_context(
    handle: &CaptureHandle,
    journal: &RecoveryJournal,
) -> Result<(), CaptureError> {
    handle.artifact.validate()?;
    if handle.generation == 0
        || handle.config_revision == 0
        || handle.helper_pid == 0
        || handle.artifact.generation != handle.generation
        || handle.generation != journal.generation
        || handle.config_revision != journal.config_revision
        || journal.helper_pid != Some(handle.helper_pid)
        || artifact_json(&handle.artifact)? != journal.artifact_state
    {
        return Err(CaptureError::recovery(
            "CAPTURE_HANDLE_JOURNAL_MISMATCH",
            "capture handle does not match the persisted transaction receipt",
        ));
    }
    Ok(())
}

/// Private proof that a newly returned handle passed its adapter binding,
/// generation, configuration, helper identity, and complete artifact checks.
/// Privileged stop cleanup accepts this proof instead of an arbitrary adapter
/// response.
#[derive(Clone, Copy)]
struct ValidatedCaptureHandle<'a>(&'a CaptureHandle);

impl<'a> ValidatedCaptureHandle<'a> {
    fn as_handle(self) -> &'a CaptureHandle {
        self.0
    }
}

fn validate_capture_handle<'a, A: CaptureAdapter + ?Sized>(
    adapter: &A,
    generation: u64,
    spec: &CaptureInstallSpec,
    handle: &'a CaptureHandle,
) -> Result<ValidatedCaptureHandle<'a>, CaptureError> {
    ensure_adapter_receipt(adapter, generation, &handle.artifact)?;
    handle.validate_for(spec)?;
    Ok(ValidatedCaptureHandle(handle))
}

fn ensure_handle_lineage(
    previous: &CaptureHandle,
    next: &CaptureHandle,
) -> Result<(), CaptureError> {
    if next.generation != previous.generation
        || next.config_revision != previous.config_revision
        || next.helper_pid != previous.helper_pid
    {
        return Err(CaptureError::recovery_with_artifact(
            "CAPTURE_HANDLE_IDENTITY_CHANGED",
            "an active generation cannot silently change generation, revision, or helper identity",
            next.artifact.clone(),
        ));
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingAdapterBinding {
    binding_schema_version: u32,
    binding_state: String,
    adapter: String,
    generation: u64,
}

fn pending_adapter_binding(value: &Value) -> Result<Option<PendingAdapterBinding>, CaptureError> {
    if value.get("bindingState").is_none() {
        return Ok(None);
    }
    let binding: PendingAdapterBinding =
        serde_json::from_value(value.clone()).map_err(|error| {
            CaptureError::recovery(
                "CAPTURE_RECOVERY_BINDING_INVALID",
                format!("pending recovery adapter binding is invalid: {error}"),
            )
        })?;
    if binding.binding_schema_version != 1
        || binding.binding_state != "adapter_selected"
        || binding.adapter.is_empty()
        || binding.generation == 0
    {
        return Err(CaptureError::recovery(
            "CAPTURE_RECOVERY_BINDING_INVALID",
            "pending recovery adapter binding has unsupported or empty fields",
        ));
    }
    Ok(Some(binding))
}

fn ensure_adapter_receipt<A: CaptureAdapter + ?Sized>(
    adapter: &A,
    generation: u64,
    artifact: &CaptureArtifactState,
) -> Result<(), CaptureError> {
    if artifact.adapter != adapter.id() {
        return Err(CaptureError::recovery(
            "CAPTURE_ADAPTER_RECEIPT_MISMATCH",
            format!(
                "capture adapter '{}' returned a recovery receipt owned by '{}'",
                adapter.id(),
                artifact.adapter
            ),
        ));
    }
    if artifact.generation != generation {
        return Err(CaptureError::recovery(
            "CAPTURE_ADAPTER_RECEIPT_GENERATION_MISMATCH",
            "capture adapter returned a recovery receipt for a different generation",
        ));
    }
    Ok(())
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
        generation_recovery: bool,
        generation_recovery_artifact_failure: bool,
        platform: Option<CapturePlatform>,
        adapter_id: Option<&'static str>,
        foreign_install_receipt: bool,
        invalid_install_artifact: bool,
        foreign_update_receipt: bool,
        foreign_heartbeat_receipt: bool,
        changed_update_helper_pid: bool,
        changed_heartbeat_helper_pid: bool,
        fail_heartbeat_after_membership: bool,
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
            self.adapter_id.unwrap_or("fake_linux")
        }

        fn platform(&self) -> CapturePlatform {
            self.platform.unwrap_or_else(CapturePlatform::current)
        }

        async fn probe(&self) -> AdapterProbe {
            unreachable!()
        }

        async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
            self.calls.lock().unwrap().push("install");
            let mut artifact = Self::artifact(spec.generation);
            if self.foreign_install_receipt {
                artifact.adapter = "foreign_adapter".into();
            }
            if self.invalid_install_artifact {
                artifact.rule_ids.push("invalid\0rule".into());
            }
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
            self.calls.lock().unwrap().push("update");
            let mut updated = handle.clone();
            if self.foreign_update_receipt {
                updated.artifact.adapter = "foreign_adapter".into();
            }
            if self.changed_update_helper_pid {
                updated.helper_pid += 1;
            }
            Ok(updated)
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

        async fn recover_generation(&self, generation: u64) -> Result<(), CaptureError> {
            self.calls.lock().unwrap().push("recover_generation");
            if self.generation_recovery_artifact_failure {
                return Err(CaptureError::recovery_with_artifact(
                    "FAKE_GENERATION_RECOVERY_FAILED",
                    "generation recovery found an exact receipt",
                    Self::artifact(generation),
                ));
            }
            if !self.generation_recovery {
                return Err(CaptureError::recovery(
                    "CAPTURE_RECOVERY_RECEIPT_MISSING",
                    "fake adapter has no generation-only recovery receipt",
                ));
            }
            Ok(())
        }

        async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
            self.calls.lock().unwrap().push("heartbeat");
            let mut refreshed = handle.clone();
            refreshed
                .artifact
                .rule_ids
                .push("membership-refreshed".into());
            if self.fail_heartbeat_after_membership {
                return Err(CaptureError::recovery_with_artifact(
                    "FAKE_HEARTBEAT_FAILED",
                    "heartbeat failed after adding a member",
                    refreshed.artifact,
                ));
            }
            if self.foreign_heartbeat_receipt {
                refreshed.artifact.adapter = "foreign_adapter".into();
            }
            if self.changed_heartbeat_helper_pid {
                refreshed.helper_pid += 1;
            }
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

    fn foreign_platform() -> CapturePlatform {
        match CapturePlatform::current() {
            CapturePlatform::Windows => CapturePlatform::Linux,
            CapturePlatform::Macos | CapturePlatform::Linux | CapturePlatform::Unknown => {
                CapturePlatform::Windows
            }
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
    async fn adapter_bound_preparing_marker_uses_generation_only_recovery() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            generation_recovery: true,
            ..Default::default()
        };
        let marker = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        let clean = coordinator
            .recover(&adapter, marker.generation)
            .await
            .unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert!(!clean.cleanup_required);
        assert_eq!(adapter.calls(), vec!["recover_generation"]);
    }

    #[tokio::test]
    async fn pre_heartbeat_capture_installed_binding_uses_generation_only_recovery() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            generation_recovery: true,
            ..Default::default()
        };
        let marker = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        let installed = serde_json::to_value(FakeAdapter::artifact(marker.generation)).unwrap();
        store
            .record_capture_installed(marker.generation, &installed)
            .unwrap();
        let bound = coordinator
            .persist_generation_cleanup_binding(&adapter, marker.generation)
            .unwrap();
        assert_eq!(bound.phase, RecoveryPhase::CaptureInstalled);
        assert_eq!(bound.artifact_state["bindingState"], "adapter_selected");

        let clean = coordinator
            .recover(&adapter, marker.generation)
            .await
            .unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert!(!clean.cleanup_required);
        assert_eq!(adapter.calls(), vec!["recover_generation"]);
    }

    #[tokio::test]
    async fn cancelled_bound_recovery_retries_from_stopping_generation() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let marker = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        store.begin_stop(marker.generation).unwrap();
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            generation_recovery: true,
            ..Default::default()
        };

        let clean = coordinator
            .recover(&adapter, marker.generation)
            .await
            .unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert_eq!(adapter.calls(), vec!["recover_generation"]);
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

        let clean = coordinator
            .recover(&adapter, dirty.generation)
            .await
            .unwrap();
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
    async fn bound_crash_marker_cannot_be_cleared_without_helper_receipt() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let error = coordinator
            .recover(
                &FakeAdapter::default(),
                store.recovery_journal().unwrap().generation,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_RECOVERY_RECEIPT_MISSING");
        assert!(store.recovery_journal().unwrap().cleanup_required);
    }

    #[tokio::test]
    async fn pending_recovery_rejects_a_different_same_platform_adapter() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let marker = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            adapter_id: Some("other_linux"),
            generation_recovery: true,
            ..Default::default()
        };

        let error = coordinator
            .recover(&adapter, marker.generation)
            .await
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_RECOVERY_ADAPTER_MISMATCH");
        assert!(adapter.calls().is_empty());
        let persisted = store.recovery_journal().unwrap();
        assert_eq!(persisted.generation, marker.generation);
        assert_eq!(persisted.phase, RecoveryPhase::Preparing);
        assert!(persisted.cleanup_required);
    }

    #[tokio::test]
    async fn legacy_unbound_marker_refuses_guessing_an_adapter() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let marker = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        store
            .update_recovery_artifact(marker.generation, &serde_json::json!({}))
            .unwrap();
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            generation_recovery: true,
            ..Default::default()
        };

        let error = coordinator
            .recover(&adapter, marker.generation)
            .await
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_RECOVERY_ADAPTER_UNBOUND");
        assert!(adapter.calls().is_empty());
        assert!(store.recovery_journal().unwrap().cleanup_required);
    }

    #[tokio::test]
    async fn generation_recovery_failure_persists_returned_exact_artifact() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let marker = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            generation_recovery_artifact_failure: true,
            ..Default::default()
        };

        let error = coordinator
            .recover(&adapter, marker.generation)
            .await
            .unwrap_err();
        assert_eq!(error.code, "FAKE_GENERATION_RECOVERY_FAILED");
        let persisted = store.recovery_journal().unwrap();
        assert_eq!(persisted.generation, marker.generation);
        assert_eq!(persisted.phase, RecoveryPhase::RecoveryRequired);
        assert_eq!(persisted.artifact_state["adapter"], "fake_linux");
        assert_eq!(
            persisted.artifact_state["generation"],
            serde_json::json!(marker.generation)
        );
    }

    #[tokio::test]
    async fn recovery_rejects_wrong_platform_before_mutating_the_journal() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let foreign_platform = foreign_platform();
        let marker = store
            .begin_prepare(&["global".into()], 7, foreign_platform, false, "fake_linux")
            .unwrap();
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            generation_recovery: true,
            ..Default::default()
        };

        let error = coordinator
            .recover(&adapter, marker.generation)
            .await
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_ADAPTER_PLATFORM_MISMATCH");
        assert!(adapter.calls().is_empty());
        let persisted = store.recovery_journal().unwrap();
        assert_eq!(persisted.generation, marker.generation);
        assert_eq!(persisted.phase, RecoveryPhase::Preparing);
        assert!(persisted.cleanup_required);
    }

    #[tokio::test]
    async fn recovery_rejects_foreign_adapter_receipt_before_cleanup() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let marker = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        let mut artifact = FakeAdapter::artifact(marker.generation);
        artifact.adapter = "foreign_adapter".into();
        store
            .record_capture_installed(marker.generation, &serde_json::to_value(&artifact).unwrap())
            .unwrap();
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter::default();

        let error = coordinator
            .recover(&adapter, marker.generation)
            .await
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_RECOVERY_ADAPTER_MISMATCH");
        assert!(adapter.calls().is_empty());
        let persisted = store.recovery_journal().unwrap();
        assert_eq!(persisted.generation, marker.generation);
        assert_eq!(persisted.phase, RecoveryPhase::CaptureInstalled);
        assert!(persisted.cleanup_required);
    }

    #[tokio::test]
    async fn foreign_install_receipt_uses_only_generation_scoped_cleanup() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            foreign_install_receipt: true,
            generation_recovery: true,
            ..Default::default()
        };

        let error = coordinator
            .install(&adapter, spec(), &["global".into()], false)
            .await
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_ADAPTER_RECEIPT_MISMATCH");
        assert_eq!(adapter.calls(), vec!["install", "recover_generation"]);
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::Clean);
        assert!(!journal.cleanup_required);
        assert_eq!(journal.artifact_state, serde_json::json!({}));
    }

    #[tokio::test]
    async fn invalid_same_adapter_install_handle_never_reaches_stop() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            invalid_install_artifact: true,
            generation_recovery: true,
            ..Default::default()
        };

        let error = coordinator
            .install(&adapter, spec(), &["global".into()], false)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_ARTIFACT_INVALID");
        assert_eq!(adapter.calls(), vec!["install", "recover_generation"]);
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::Clean);
        assert!(!journal.cleanup_required);
    }

    #[tokio::test]
    async fn foreign_install_receipt_never_reaches_stop_and_failed_rollback_stays_dirty() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            foreign_install_receipt: true,
            ..Default::default()
        };

        let error = coordinator
            .install(&adapter, spec(), &["global".into()], false)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_ADAPTER_RECEIPT_MISMATCH");
        assert!(error.recovery_required);
        assert_eq!(adapter.calls(), vec!["install", "recover_generation"]);
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::RecoveryRequired);
        assert!(journal.cleanup_required);
        assert_eq!(journal.artifact_state["adapter"], "fake_linux");
        assert_eq!(journal.artifact_state["bindingState"], "adapter_selected");
    }

    #[tokio::test]
    async fn stale_recovery_request_cannot_mutate_a_newer_generation() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let old = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        store.complete_recovery(old.generation).unwrap();
        let current = store
            .begin_prepare(
                &["global".into()],
                8,
                CapturePlatform::current(),
                false,
                "fake_linux",
            )
            .unwrap();
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            generation_recovery: true,
            ..Default::default()
        };

        let error = coordinator
            .recover(&adapter, old.generation)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_RECOVERY_GENERATION_MISMATCH");
        assert!(adapter.calls().is_empty());
        let persisted = store.recovery_journal().unwrap();
        assert_eq!(persisted.generation, current.generation);
        assert_eq!(persisted.phase, RecoveryPhase::Preparing);
        assert!(persisted.cleanup_required);
    }

    #[tokio::test]
    async fn foreign_update_receipt_marks_failure_with_last_trusted_receipt() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let mut update_spec = spec();
        update_spec.generation = handle.generation;
        let adapter = FakeAdapter {
            foreign_update_receipt: true,
            ..Default::default()
        };

        let error = coordinator
            .update(&adapter, &handle, &update_spec)
            .await
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_ADAPTER_RECEIPT_MISMATCH");
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::RecoveryRequired);
        assert_eq!(journal.artifact_state["adapter"], "fake_linux");
        assert_ne!(journal.artifact_state["adapter"], "foreign_adapter");
    }

    #[tokio::test]
    async fn foreign_heartbeat_receipt_marks_failure_with_last_trusted_receipt() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let mut active_spec = spec();
        active_spec.generation = handle.generation;
        let adapter = FakeAdapter {
            foreign_heartbeat_receipt: true,
            ..Default::default()
        };

        let error = coordinator
            .heartbeat(&adapter, &handle, &active_spec)
            .await
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_ADAPTER_RECEIPT_MISMATCH");
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::RecoveryRequired);
        assert_eq!(journal.artifact_state["adapter"], "fake_linux");
        assert_ne!(journal.artifact_state["adapter"], "foreign_adapter");
    }

    #[tokio::test]
    async fn update_rejects_silent_helper_identity_change() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let mut update_spec = spec();
        update_spec.generation = handle.generation;
        let adapter = FakeAdapter {
            changed_update_helper_pid: true,
            ..Default::default()
        };

        let error = coordinator
            .update(&adapter, &handle, &update_spec)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_HANDLE_IDENTITY_CHANGED");
        assert_eq!(adapter.calls(), vec!["update"]);
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::RecoveryRequired);
        assert_eq!(journal.helper_pid, Some(handle.helper_pid));
    }

    #[tokio::test]
    async fn heartbeat_rejects_silent_helper_identity_change() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let mut active_spec = spec();
        active_spec.generation = handle.generation;
        let adapter = FakeAdapter {
            changed_heartbeat_helper_pid: true,
            ..Default::default()
        };

        let error = coordinator
            .heartbeat(&adapter, &handle, &active_spec)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_HANDLE_IDENTITY_CHANGED");
        assert_eq!(adapter.calls(), vec!["heartbeat"]);
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::RecoveryRequired);
        assert_eq!(journal.helper_pid, Some(handle.helper_pid));
    }

    #[tokio::test]
    async fn install_rejected_post_heartbeat_receipt_never_stops_with_the_old_handle() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            changed_heartbeat_helper_pid: true,
            ..Default::default()
        };

        let error = coordinator
            .install(&adapter, spec(), &["global".into()], false)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_HANDLE_IDENTITY_CHANGED");
        assert!(error.message.contains("CAPTURE_RECOVERY_RECEIPT_MISSING"));
        assert_eq!(
            adapter.calls(),
            vec!["install", "heartbeat", "recover_generation"]
        );
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::RecoveryRequired);
        assert!(journal.cleanup_required);
        assert_eq!(journal.artifact_state["bindingState"], "adapter_selected");
        assert_eq!(journal.artifact_state["adapter"], "fake_linux");
    }

    #[tokio::test]
    async fn install_heartbeat_error_retains_its_latest_exact_recovery_artifact() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let adapter = FakeAdapter {
            fail_heartbeat_after_membership: true,
            ..Default::default()
        };

        let error = coordinator
            .install(&adapter, spec(), &["global".into()], false)
            .await
            .unwrap_err();

        assert_eq!(error.code, "FAKE_HEARTBEAT_FAILED");
        assert!(error.message.contains("CAPTURE_RECOVERY_RECEIPT_MISSING"));
        assert_eq!(
            adapter.calls(),
            vec!["install", "heartbeat", "recover_generation"]
        );
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::RecoveryRequired);
        assert!(journal.cleanup_required);
        assert_eq!(journal.artifact_state["bindingState"], "adapter_selected");
        assert_eq!(journal.artifact_state["adapter"], "fake_linux");
    }

    #[tokio::test]
    async fn update_rejects_wrong_platform_before_calling_adapter() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let mut update_spec = spec();
        update_spec.generation = handle.generation;
        let adapter = FakeAdapter {
            platform: Some(foreign_platform()),
            ..Default::default()
        };

        let error = coordinator
            .update(&adapter, &handle, &update_spec)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_ADAPTER_PLATFORM_MISMATCH");
        assert!(adapter.calls().is_empty());
        assert_eq!(
            store.recovery_journal().unwrap().phase,
            RecoveryPhase::Active
        );
    }

    #[tokio::test]
    async fn heartbeat_rejects_wrong_platform_before_calling_adapter() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let mut active_spec = spec();
        active_spec.generation = handle.generation;
        let adapter = FakeAdapter {
            platform: Some(foreign_platform()),
            ..Default::default()
        };

        let error = coordinator
            .heartbeat(&adapter, &handle, &active_spec)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_ADAPTER_PLATFORM_MISMATCH");
        assert!(adapter.calls().is_empty());
        assert_eq!(
            store.recovery_journal().unwrap().phase,
            RecoveryPhase::Active
        );
    }

    #[tokio::test]
    async fn stop_rejects_wrong_platform_before_calling_adapter() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let adapter = FakeAdapter {
            platform: Some(foreign_platform()),
            ..Default::default()
        };

        let error = coordinator.stop(&adapter, &handle).await.unwrap_err();

        assert_eq!(error.code, "CAPTURE_ADAPTER_PLATFORM_MISMATCH");
        assert!(adapter.calls().is_empty());
        assert_eq!(
            store.recovery_journal().unwrap().phase,
            RecoveryPhase::Active
        );
    }

    #[tokio::test]
    async fn update_rejects_wrong_spec_platform_before_calling_adapter() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let adapter = FakeAdapter::default();
        let mut update_spec = spec();
        update_spec.generation = handle.generation;
        update_spec.platform = foreign_platform();

        let error = coordinator
            .update(&adapter, &handle, &update_spec)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_PLATFORM_MISMATCH");
        assert!(adapter.calls().is_empty());
        assert_eq!(
            store.recovery_journal().unwrap().phase,
            RecoveryPhase::Active
        );
    }

    #[tokio::test]
    async fn update_rejects_invalid_spec_before_calling_adapter() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let adapter = FakeAdapter::default();
        let mut update_spec = spec();
        update_spec.generation = handle.generation;
        update_spec.gateway = "0.0.0.0:32100".parse().unwrap();

        let error = coordinator
            .update(&adapter, &handle, &update_spec)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_GATEWAY_INVALID");
        assert!(adapter.calls().is_empty());
        assert_eq!(
            store.recovery_journal().unwrap().phase,
            RecoveryPhase::Active
        );
    }

    #[tokio::test]
    async fn heartbeat_rejects_invalid_handle_before_calling_adapter() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let mut handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let adapter = FakeAdapter::default();
        let mut active_spec = spec();
        active_spec.generation = handle.generation;
        handle.artifact.rule_ids.push("invalid\0rule".into());

        let error = coordinator
            .heartbeat(&adapter, &handle, &active_spec)
            .await
            .unwrap_err();

        assert_eq!(error.code, "CAPTURE_ARTIFACT_INVALID");
        assert!(adapter.calls().is_empty());
        assert_eq!(
            store.recovery_journal().unwrap().phase,
            RecoveryPhase::Active
        );
    }

    #[tokio::test]
    async fn stop_rejects_tampered_handle_before_calling_adapter() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
        let mut handle = coordinator
            .install(&FakeAdapter::default(), spec(), &["global".into()], false)
            .await
            .unwrap();
        let adapter = FakeAdapter::default();
        handle
            .artifact
            .route_ids
            .push("caller-injected-route".into());

        let error = coordinator.stop(&adapter, &handle).await.unwrap_err();

        assert_eq!(error.code, "CAPTURE_HANDLE_JOURNAL_MISMATCH");
        assert!(adapter.calls().is_empty());
        assert_eq!(
            store.recovery_journal().unwrap().phase,
            RecoveryPhase::Active
        );
    }
}
