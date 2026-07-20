//! Product-level owner for a platform adapter and its durable coordinator.
//!
//! The owner serializes the complete coordinator transaction surface.  It is
//! dependency-injected only: the default product still constructs no platform
//! adapter, so exposing this common async seam does not weaken capability or
//! release gates.

use std::sync::Arc;

use tokio::sync::Mutex;

use super::coordinator::CaptureTransactionCoordinator;
use super::{CaptureAdapter, CaptureError, CaptureHandle, CaptureInstallSpec};
use crate::sockscap::storage::{RecoveryJournal, SockscapStore};
use crate::sockscap::types::CapturePlatform;

/// Serializes product reconciliation around one durable store and one platform
/// adapter.  A second caller observes the journal after the first call rather
/// than issuing duplicate privileged cleanup.
pub struct CaptureRuntimeOwner {
    coordinator: Arc<CaptureTransactionCoordinator>,
    adapter: Arc<dyn CaptureAdapter>,
    operation: Arc<Mutex<()>>,
}

impl CaptureRuntimeOwner {
    pub fn new(store: Arc<SockscapStore>, adapter: Arc<dyn CaptureAdapter>) -> Self {
        let operation = store.capture_operation();
        Self {
            coordinator: Arc::new(CaptureTransactionCoordinator::new(store)),
            adapter,
            operation,
        }
    }

    pub fn adapter_id(&self) -> &'static str {
        self.adapter.id()
    }

    pub fn platform(&self) -> CapturePlatform {
        self.adapter.platform()
    }

    pub async fn install(
        &self,
        spec: CaptureInstallSpec,
        active_profile_ids: &[String],
        restore_after_recovery: bool,
    ) -> Result<CaptureHandle, CaptureError> {
        let coordinator = Arc::clone(&self.coordinator);
        let adapter = Arc::clone(&self.adapter);
        let operation = Arc::clone(&self.operation);
        let active_profile_ids = active_profile_ids.to_vec();
        join_transaction(tokio::spawn(async move {
            let _operation = operation.lock().await;
            coordinator
                .install(
                    adapter.as_ref(),
                    spec,
                    &active_profile_ids,
                    restore_after_recovery,
                )
                .await
        }))
        .await
    }

    pub async fn update(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        let coordinator = Arc::clone(&self.coordinator);
        let adapter = Arc::clone(&self.adapter);
        let operation = Arc::clone(&self.operation);
        let handle = handle.clone();
        let spec = spec.clone();
        join_transaction(tokio::spawn(async move {
            let _operation = operation.lock().await;
            coordinator.update(adapter.as_ref(), &handle, &spec).await
        }))
        .await
    }

    pub async fn heartbeat(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        let coordinator = Arc::clone(&self.coordinator);
        let adapter = Arc::clone(&self.adapter);
        let operation = Arc::clone(&self.operation);
        let handle = handle.clone();
        let spec = spec.clone();
        join_transaction(tokio::spawn(async move {
            let _operation = operation.lock().await;
            coordinator
                .heartbeat(adapter.as_ref(), &handle, &spec)
                .await
        }))
        .await
    }

    pub async fn stop(&self, handle: &CaptureHandle) -> Result<RecoveryJournal, CaptureError> {
        let coordinator = Arc::clone(&self.coordinator);
        let adapter = Arc::clone(&self.adapter);
        let operation = Arc::clone(&self.operation);
        let handle = handle.clone();
        join_transaction(tokio::spawn(async move {
            let _operation = operation.lock().await;
            coordinator.stop(adapter.as_ref(), &handle).await
        }))
        .await
    }

    pub async fn reconcile_recovery(
        &self,
        expected_generation: u64,
    ) -> Result<RecoveryJournal, CaptureError> {
        let coordinator = Arc::clone(&self.coordinator);
        let adapter = Arc::clone(&self.adapter);
        let operation = Arc::clone(&self.operation);
        join_transaction(tokio::spawn(async move {
            let _operation = operation.lock().await;
            coordinator
                .recover(adapter.as_ref(), expected_generation)
                .await
        }))
        .await
    }
}

/// Awaiting callers may be cancelled, but the spawned transaction retains the
/// operation mutex and all owned inputs until the privileged call and journal
/// transition finish. Dropping the JoinHandle detaches rather than aborts it.
async fn join_transaction<T>(
    task: tokio::task::JoinHandle<Result<T, CaptureError>>,
) -> Result<T, CaptureError>
where
    T: Send + 'static,
{
    task.await.map_err(|error| {
        CaptureError::recovery(
            "CAPTURE_RUNTIME_TASK_FAILED",
            format!("capture runtime transaction task failed: {error}"),
        )
    })?
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use async_trait::async_trait;
    use tokio::sync::Notify;

    use super::*;
    use crate::sockscap::capture::{
        AdapterProbe, CaptureArtifactState, CaptureHandle, CaptureInstallSpec, CaptureMode,
    };
    use crate::sockscap::storage::RecoveryPhase;

    struct BlockingRecoveryAdapter {
        entered: Notify,
        release: Notify,
        generations: StdMutex<Vec<u64>>,
    }

    impl BlockingRecoveryAdapter {
        fn new() -> Self {
            Self {
                entered: Notify::new(),
                release: Notify::new(),
                generations: StdMutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl CaptureAdapter for BlockingRecoveryAdapter {
        fn id(&self) -> &'static str {
            "runtime_fake"
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
            self.entered.notify_one();
            self.release.notified().await;
            Ok(())
        }

        async fn heartbeat(&self, _handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
            unreachable!()
        }
    }

    #[derive(Default)]
    struct LifecycleAdapter {
        calls: StdMutex<Vec<&'static str>>,
    }

    impl LifecycleAdapter {
        fn handle(spec: &CaptureInstallSpec) -> CaptureHandle {
            CaptureHandle {
                generation: spec.generation,
                config_revision: spec.config_revision,
                helper_pid: 99,
                artifact: CaptureArtifactState {
                    adapter: "runtime_fake".into(),
                    generation: spec.generation,
                    owner_uid: Some(1000),
                    interface_names: vec![format!("tun-{}", spec.generation)],
                    rule_ids: Vec::new(),
                    route_ids: Vec::new(),
                    cgroup_paths: Vec::new(),
                    driver_service: None,
                    extension_bundle_id: None,
                    process_restores: Vec::new(),
                },
            }
        }
    }

    #[async_trait]
    impl CaptureAdapter for LifecycleAdapter {
        fn id(&self) -> &'static str {
            "runtime_fake"
        }

        fn platform(&self) -> CapturePlatform {
            CapturePlatform::current()
        }

        async fn probe(&self) -> AdapterProbe {
            unreachable!()
        }

        async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
            self.calls.lock().unwrap().push("install");
            Ok(Self::handle(spec))
        }

        async fn update(
            &self,
            handle: &CaptureHandle,
            _spec: &CaptureInstallSpec,
        ) -> Result<CaptureHandle, CaptureError> {
            self.calls.lock().unwrap().push("update");
            Ok(handle.clone())
        }

        async fn stop(&self, _handle: &CaptureHandle) -> Result<(), CaptureError> {
            self.calls.lock().unwrap().push("stop");
            Ok(())
        }

        async fn recover(&self, _artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
            unreachable!()
        }

        async fn recover_generation(&self, _generation: u64) -> Result<(), CaptureError> {
            unreachable!()
        }

        async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
            self.calls.lock().unwrap().push("heartbeat");
            Ok(handle.clone())
        }
    }

    fn install_spec() -> CaptureInstallSpec {
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
    async fn full_lifecycle_uses_one_serialized_owner() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let adapter = Arc::new(LifecycleAdapter::default());
        let runtime = CaptureRuntimeOwner::new(Arc::clone(&store), adapter.clone());

        let handle = runtime
            .install(install_spec(), &["global".into()], false)
            .await
            .unwrap();
        let mut active_spec = install_spec();
        active_spec.generation = handle.generation;
        let updated = runtime.update(&handle, &active_spec).await.unwrap();
        let refreshed = runtime.heartbeat(&updated, &active_spec).await.unwrap();
        let journal = runtime.stop(&refreshed).await.unwrap();

        assert_eq!(journal.phase, RecoveryPhase::Clean);
        assert!(!journal.cleanup_required);
        assert_eq!(
            adapter.calls.lock().unwrap().as_slice(),
            &["install", "heartbeat", "update", "heartbeat", "stop"]
        );
    }

    #[tokio::test]
    async fn separate_runtime_owners_share_one_store_operation_lock() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let marker = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "runtime_fake",
            )
            .unwrap();
        let adapter = Arc::new(BlockingRecoveryAdapter::new());
        let first_runtime = Arc::new(CaptureRuntimeOwner::new(
            Arc::clone(&store),
            adapter.clone(),
        ));
        let second_runtime = Arc::new(CaptureRuntimeOwner::new(
            Arc::clone(&store),
            adapter.clone(),
        ));
        let generation = marker.generation;

        let first_owner = Arc::clone(&first_runtime);
        let first = tokio::spawn(async move { first_owner.reconcile_recovery(generation).await });
        adapter.entered.notified().await;
        let second_owner = Arc::clone(&second_runtime);
        let second = tokio::spawn(async move { second_owner.reconcile_recovery(generation).await });
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        assert_eq!(
            adapter.generations.lock().unwrap().as_slice(),
            &[generation]
        );
        adapter.release.notify_one();

        let first_journal = first.await.unwrap().unwrap();
        let second_journal = second.await.unwrap().unwrap();
        assert_eq!(first_journal.phase, RecoveryPhase::Clean);
        assert_eq!(second_journal.phase, RecoveryPhase::Clean);
        assert_eq!(
            adapter.generations.lock().unwrap().as_slice(),
            &[generation]
        );
    }

    #[tokio::test]
    async fn caller_cancellation_does_not_release_transaction_ownership() {
        let store = Arc::new(SockscapStore::open_in_memory().unwrap());
        let marker = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::current(),
                false,
                "runtime_fake",
            )
            .unwrap();
        let adapter = Arc::new(BlockingRecoveryAdapter::new());
        let runtime = Arc::new(CaptureRuntimeOwner::new(
            Arc::clone(&store),
            adapter.clone(),
        ));
        let generation = marker.generation;

        let first_runtime = Arc::clone(&runtime);
        let first = tokio::spawn(async move { first_runtime.reconcile_recovery(generation).await });
        adapter.entered.notified().await;
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());

        let second_runtime = Arc::clone(&runtime);
        let second =
            tokio::spawn(async move { second_runtime.reconcile_recovery(generation).await });
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        assert_eq!(
            adapter.generations.lock().unwrap().as_slice(),
            &[generation]
        );

        adapter.release.notify_one();
        let clean = second.await.unwrap().unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert!(!clean.cleanup_required);
        assert_eq!(
            adapter.generations.lock().unwrap().as_slice(),
            &[generation]
        );
    }
}
