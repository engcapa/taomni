//! Product ownership boundary for the Linux capture lifecycle.
//!
//! The low-level lifecycle owns helper, TUN-pump and data-plane resources for
//! one generation.  This module keeps that lifecycle alive across coordinator
//! calls (and caller cancellation), rejects cross-generation reuse, and lets a
//! crash-recovery call reconstruct exactly the generation named by the durable
//! journal.  Merely constructing this adapter never launches `pkexec` or opens
//! `/dev/net/tun`.
//!
//! The default application runtime does not install this adapter yet.  A
//! concrete controlled data-plane factory and the native release gates are
//! still required before any capture capability may be enabled.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

use super::linux::LINUX_ADAPTER_ID;
use super::linux_adapter::{
    LinuxCaptureLifecycle, LinuxDataPlaneFactory, LinuxPacketRuntimeFactory,
    LinuxTunPacketRuntimeFactory,
};
use super::linux_client::{
    LinuxHelperClient, LinuxHelperLaunchConfig, LinuxHelperSessionFactory,
    RealLinuxHelperSessionFactory,
};
use super::{
    AdapterProbe, CaptureAdapter, CaptureArtifactState, CaptureError, CaptureHandle,
    CaptureInstallSpec,
};
use crate::sockscap::types::CapturePlatform;

/// Generation-scoped lifecycle contract used by the product owner.  The real
/// implementation is [`LinuxCaptureLifecycle`]; the trait keeps ownership and
/// coordinator tests entirely unprivileged.
#[async_trait]
pub trait LinuxGenerationLifecycle: Send + Sync {
    async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError>;

    async fn update(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError>;

    async fn heartbeat(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError>;

    async fn stop(&self, handle: &CaptureHandle) -> Result<(), CaptureError>;

    async fn recover(&self, artifact: &CaptureArtifactState) -> Result<(), CaptureError>;

    async fn recover_generation(&self, generation: u64) -> Result<(), CaptureError>;
}

#[async_trait]
impl LinuxGenerationLifecycle for LinuxCaptureLifecycle {
    async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
        LinuxCaptureLifecycle::install(self, spec).await
    }

    async fn update(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        LinuxCaptureLifecycle::update(self, handle, spec).await
    }

    async fn heartbeat(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        LinuxCaptureLifecycle::heartbeat(self, handle, spec).await
    }

    async fn stop(&self, handle: &CaptureHandle) -> Result<(), CaptureError> {
        LinuxCaptureLifecycle::stop(self, handle).await
    }

    async fn recover(&self, artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
        LinuxCaptureLifecycle::recover(self, artifact).await
    }

    async fn recover_generation(&self, generation: u64) -> Result<(), CaptureError> {
        LinuxCaptureLifecycle::recover_generation(self, generation).await
    }
}

/// Builds one lifecycle for one durable coordinator generation.
pub trait LinuxCaptureLifecycleFactory: Send + Sync {
    fn build(&self, generation: u64) -> Result<Arc<dyn LinuxGenerationLifecycle>, CaptureError>;
}

/// Concrete composition boundary for the fixed-path helper client, native TUN
/// runtime and a caller-supplied controlled data plane.  `installed` pins the
/// real helper/TUN factories but still performs no privileged I/O.
pub struct LinuxCaptureCompositionFactory {
    helper_sessions: Arc<dyn LinuxHelperSessionFactory>,
    packet_runtime: Arc<dyn LinuxPacketRuntimeFactory>,
    data_plane: Arc<dyn LinuxDataPlaneFactory>,
}

impl LinuxCaptureCompositionFactory {
    pub fn new(
        helper_sessions: Arc<dyn LinuxHelperSessionFactory>,
        packet_runtime: Arc<dyn LinuxPacketRuntimeFactory>,
        data_plane: Arc<dyn LinuxDataPlaneFactory>,
    ) -> Self {
        Self {
            helper_sessions,
            packet_runtime,
            data_plane,
        }
    }

    /// Construct the installed-path composition.  The data-plane factory is
    /// intentionally mandatory: there is no no-op/fake production provider.
    pub fn installed(data_plane: Arc<dyn LinuxDataPlaneFactory>) -> Result<Self, CaptureError> {
        let helper_sessions =
            RealLinuxHelperSessionFactory::new(LinuxHelperLaunchConfig::default())
                .map_err(|error| error.into_capture_error())?;
        Ok(Self::new(
            Arc::new(helper_sessions),
            Arc::new(LinuxTunPacketRuntimeFactory::default()),
            data_plane,
        ))
    }
}

impl LinuxCaptureLifecycleFactory for LinuxCaptureCompositionFactory {
    fn build(&self, generation: u64) -> Result<Arc<dyn LinuxGenerationLifecycle>, CaptureError> {
        let helper = LinuxHelperClient::new(generation, Arc::clone(&self.helper_sessions))
            .map_err(|error| error.into_capture_error())?;
        Ok(Arc::new(LinuxCaptureLifecycle::new(
            Arc::new(helper),
            Arc::clone(&self.packet_runtime),
            Arc::clone(&self.data_plane),
        )))
    }
}

struct LinuxLifecycleOwner {
    generation: u64,
    /// Present only for a generation installed in this process.  Recovery
    /// reconstructed after restart deliberately has no active specification.
    spec: Option<CaptureInstallSpec>,
    lifecycle: Arc<dyn LinuxGenerationLifecycle>,
}

/// Product-facing Linux adapter.  One serialized owner is retained until the
/// coordinator obtains cleanup proof.  In particular, an aborted install
/// future cannot drop the only handle to in-flight local resources.
pub struct LinuxCaptureAdapter {
    factory: Arc<dyn LinuxCaptureLifecycleFactory>,
    operation: Mutex<()>,
    owner: Mutex<Option<LinuxLifecycleOwner>>,
}

impl LinuxCaptureAdapter {
    pub fn new(factory: Arc<dyn LinuxCaptureLifecycleFactory>) -> Self {
        Self {
            factory,
            operation: Mutex::new(()),
            owner: Mutex::new(None),
        }
    }

    pub async fn owned_generation(&self) -> Option<u64> {
        self.owner
            .lock()
            .await
            .as_ref()
            .map(|owner| owner.generation)
    }

    async fn claim_install(
        &self,
        spec: &CaptureInstallSpec,
    ) -> Result<Arc<dyn LinuxGenerationLifecycle>, CaptureError> {
        let mut owner = self.owner.lock().await;
        if let Some(current) = owner.as_ref() {
            return Err(CaptureError::recovery(
                "LINUX_CAPTURE_GENERATION_OWNED",
                format!(
                    "Linux capture generation {} remains owned; generation {} cannot start",
                    current.generation, spec.generation
                ),
            ));
        }
        let lifecycle = self.factory.build(spec.generation)?;
        *owner = Some(LinuxLifecycleOwner {
            generation: spec.generation,
            spec: Some(spec.clone()),
            lifecycle: Arc::clone(&lifecycle),
        });
        Ok(lifecycle)
    }

    async fn existing(
        &self,
        generation: u64,
        artifact: Option<&CaptureArtifactState>,
    ) -> Result<
        (
            Arc<dyn LinuxGenerationLifecycle>,
            Option<CaptureInstallSpec>,
        ),
        CaptureError,
    > {
        let owner = self.owner.lock().await;
        let Some(owner) = owner.as_ref() else {
            return Err(owner_error(
                "LINUX_CAPTURE_OWNER_MISSING",
                "the in-process Linux lifecycle owner is missing",
                artifact,
            ));
        };
        if owner.generation != generation {
            return Err(owner_error(
                "LINUX_CAPTURE_GENERATION_MISMATCH",
                "the requested generation does not match the owned Linux lifecycle",
                artifact,
            ));
        }
        Ok((Arc::clone(&owner.lifecycle), owner.spec.clone()))
    }

    async fn claim_recovery(
        &self,
        generation: u64,
        artifact: Option<&CaptureArtifactState>,
    ) -> Result<Arc<dyn LinuxGenerationLifecycle>, CaptureError> {
        let mut owner = self.owner.lock().await;
        if let Some(current) = owner.as_ref() {
            if current.generation != generation {
                return Err(owner_error(
                    "LINUX_CAPTURE_GENERATION_MISMATCH",
                    "recovery generation does not match the owned Linux lifecycle",
                    artifact,
                ));
            }
            return Ok(Arc::clone(&current.lifecycle));
        }
        let lifecycle = self.factory.build(generation)?;
        *owner = Some(LinuxLifecycleOwner {
            generation,
            spec: None,
            lifecycle: Arc::clone(&lifecycle),
        });
        Ok(lifecycle)
    }

    async fn update_owned_spec(&self, spec: &CaptureInstallSpec) {
        let mut owner = self.owner.lock().await;
        if let Some(owner) = owner.as_mut()
            && owner.generation == spec.generation
        {
            owner.spec = Some(spec.clone());
        }
    }

    async fn release(&self, generation: u64) {
        let mut owner = self.owner.lock().await;
        if owner.as_ref().map(|owner| owner.generation) == Some(generation) {
            *owner = None;
        }
    }
}

#[async_trait]
impl CaptureAdapter for LinuxCaptureAdapter {
    fn id(&self) -> &'static str {
        LINUX_ADAPTER_ID
    }

    fn platform(&self) -> CapturePlatform {
        CapturePlatform::Linux
    }

    async fn probe(&self) -> AdapterProbe {
        // Probing the product wrapper must never launch pkexec merely because
        // a capability screen is opened. Installed-policy/package attestation
        // will replace this conservative report when the native gate exists.
        AdapterProbe {
            adapter: LINUX_ADAPTER_ID.into(),
            platform: CapturePlatform::Linux,
            installed: false,
            privileged_helper_ready: false,
            signature_verified: false,
            global_available: false,
            application_group_available: false,
            runtime_pid_available: false,
            detail: "Linux product composition is compiled but its installed data-plane and native release gates are locked"
                .into(),
        }
    }

    async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
        let _operation = self.operation.lock().await;
        let lifecycle = self.claim_install(spec).await?;
        let result = lifecycle.install(spec).await;
        if result
            .as_ref()
            .is_err_and(|error| !error.recovery_required && error.artifact.is_none())
        {
            self.release(spec.generation).await;
        }
        result
    }

    async fn update(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        let _operation = self.operation.lock().await;
        let (lifecycle, _) = self
            .existing(handle.generation, Some(&handle.artifact))
            .await?;
        let updated = lifecycle.update(handle, spec).await?;
        self.update_owned_spec(spec).await;
        Ok(updated)
    }

    async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
        let _operation = self.operation.lock().await;
        let (lifecycle, spec) = self
            .existing(handle.generation, Some(&handle.artifact))
            .await?;
        let spec = spec.ok_or_else(|| {
            CaptureError::recovery_with_artifact(
                "LINUX_CAPTURE_SPEC_MISSING",
                "an active heartbeat cannot be reconstructed without the installed specification",
                handle.artifact.clone(),
            )
        })?;
        lifecycle.heartbeat(handle, &spec).await
    }

    async fn stop(&self, handle: &CaptureHandle) -> Result<(), CaptureError> {
        let _operation = self.operation.lock().await;
        let (lifecycle, _) = self
            .existing(handle.generation, Some(&handle.artifact))
            .await?;
        lifecycle.stop(handle).await?;
        self.release(handle.generation).await;
        Ok(())
    }

    async fn recover(&self, artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
        artifact.validate()?;
        if artifact.adapter != LINUX_ADAPTER_ID {
            return Err(CaptureError::recovery_with_artifact(
                "LINUX_CAPTURE_ARTIFACT_ADAPTER_MISMATCH",
                "recovery artifact does not belong to the Linux product adapter",
                artifact.clone(),
            ));
        }
        let _operation = self.operation.lock().await;
        let lifecycle = self
            .claim_recovery(artifact.generation, Some(artifact))
            .await?;
        lifecycle.recover(artifact).await?;
        self.release(artifact.generation).await;
        Ok(())
    }

    async fn recover_generation(&self, generation: u64) -> Result<(), CaptureError> {
        if generation == 0 {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_GENERATION_INVALID",
                "recovery generation must be non-zero",
            ));
        }
        let _operation = self.operation.lock().await;
        let lifecycle = self.claim_recovery(generation, None).await?;
        lifecycle.recover_generation(generation).await?;
        self.release(generation).await;
        Ok(())
    }
}

fn owner_error(
    code: &'static str,
    message: &'static str,
    artifact: Option<&CaptureArtifactState>,
) -> CaptureError {
    match artifact {
        Some(artifact) => CaptureError::recovery_with_artifact(code, message, artifact.clone()),
        None => CaptureError::recovery(code, message),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::sync::Notify;

    use super::*;
    use crate::sockscap::capture::CaptureMode;

    #[derive(Default)]
    struct FakeBehavior {
        block_install: AtomicBool,
        fail_install: AtomicBool,
        install_entered: Notify,
        release_install: Notify,
    }

    struct FakeLifecycle {
        generation: u64,
        behavior: Arc<FakeBehavior>,
        calls: Arc<StdMutex<Vec<(&'static str, u64)>>>,
    }

    impl FakeLifecycle {
        fn handle(&self, spec: &CaptureInstallSpec) -> CaptureHandle {
            CaptureHandle {
                generation: self.generation,
                config_revision: spec.config_revision,
                helper_pid: 77,
                artifact: artifact(self.generation),
            }
        }
    }

    #[async_trait]
    impl LinuxGenerationLifecycle for FakeLifecycle {
        async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
            self.calls
                .lock()
                .unwrap()
                .push(("install", self.generation));
            self.behavior.install_entered.notify_one();
            if self.behavior.block_install.load(Ordering::Acquire) {
                self.behavior.release_install.notified().await;
            }
            if self.behavior.fail_install.load(Ordering::Acquire) {
                return Err(CaptureError::invalid(
                    "FAKE_INSTALL_FAILED",
                    "fake install failed before mutation",
                ));
            }
            Ok(self.handle(spec))
        }

        async fn update(
            &self,
            handle: &CaptureHandle,
            _spec: &CaptureInstallSpec,
        ) -> Result<CaptureHandle, CaptureError> {
            self.calls.lock().unwrap().push(("update", self.generation));
            Ok(handle.clone())
        }

        async fn heartbeat(
            &self,
            handle: &CaptureHandle,
            _spec: &CaptureInstallSpec,
        ) -> Result<CaptureHandle, CaptureError> {
            self.calls
                .lock()
                .unwrap()
                .push(("heartbeat", self.generation));
            Ok(handle.clone())
        }

        async fn stop(&self, _handle: &CaptureHandle) -> Result<(), CaptureError> {
            self.calls.lock().unwrap().push(("stop", self.generation));
            Ok(())
        }

        async fn recover(&self, artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
            self.calls
                .lock()
                .unwrap()
                .push(("recover", artifact.generation));
            Ok(())
        }

        async fn recover_generation(&self, generation: u64) -> Result<(), CaptureError> {
            self.calls
                .lock()
                .unwrap()
                .push(("recover_generation", generation));
            Ok(())
        }
    }

    struct FakeFactory {
        behavior: Arc<FakeBehavior>,
        builds: StdMutex<Vec<u64>>,
        calls: Arc<StdMutex<Vec<(&'static str, u64)>>>,
    }

    impl FakeFactory {
        fn new(behavior: Arc<FakeBehavior>) -> Self {
            Self {
                behavior,
                builds: StdMutex::new(Vec::new()),
                calls: Arc::new(StdMutex::new(Vec::new())),
            }
        }

        fn builds(&self) -> Vec<u64> {
            self.builds.lock().unwrap().clone()
        }

        fn calls(&self) -> Vec<(&'static str, u64)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl LinuxCaptureLifecycleFactory for FakeFactory {
        fn build(
            &self,
            generation: u64,
        ) -> Result<Arc<dyn LinuxGenerationLifecycle>, CaptureError> {
            self.builds.lock().unwrap().push(generation);
            Ok(Arc::new(FakeLifecycle {
                generation,
                behavior: Arc::clone(&self.behavior),
                calls: Arc::clone(&self.calls),
            }))
        }
    }

    fn spec(generation: u64) -> CaptureInstallSpec {
        CaptureInstallSpec {
            generation,
            config_revision: 9,
            platform: CapturePlatform::Linux,
            mode: CaptureMode::Global,
            gateway: "127.0.0.1:32100".parse().unwrap(),
            route_ipv6: false,
            selectors: Vec::new(),
            bypass_ips: vec!["192.0.2.1".parse().unwrap()],
            taomni_pid: 42,
            helper_pid: None,
        }
    }

    fn artifact(generation: u64) -> CaptureArtifactState {
        CaptureArtifactState {
            adapter: LINUX_ADAPTER_ID.into(),
            generation,
            owner_uid: Some(1000),
            interface_names: vec![format!("taomni-sc-{generation}")],
            rule_ids: Vec::new(),
            route_ids: Vec::new(),
            cgroup_paths: Vec::new(),
            driver_service: None,
            extension_bundle_id: None,
            process_restores: Vec::new(),
        }
    }

    fn adapter(behavior: Arc<FakeBehavior>) -> (Arc<LinuxCaptureAdapter>, Arc<FakeFactory>) {
        let factory = Arc::new(FakeFactory::new(behavior));
        let adapter = Arc::new(LinuxCaptureAdapter::new(factory.clone()));
        (adapter, factory)
    }

    #[tokio::test]
    async fn conservative_probe_does_not_construct_or_launch_a_generation() {
        let (adapter, factory) = adapter(Arc::new(FakeBehavior::default()));
        let report = adapter.probe().await;
        assert!(!report.installed);
        assert!(!report.global_available);
        assert!(factory.builds().is_empty());
        assert_eq!(adapter.owned_generation().await, None);
    }

    #[tokio::test]
    async fn active_calls_reuse_one_owner_and_successful_stop_releases_it() {
        let (adapter, factory) = adapter(Arc::new(FakeBehavior::default()));
        let spec = spec(7);
        let handle = adapter.install(&spec).await.unwrap();
        adapter.heartbeat(&handle).await.unwrap();
        adapter.update(&handle, &spec).await.unwrap();
        adapter.stop(&handle).await.unwrap();

        assert_eq!(factory.builds(), vec![7]);
        assert_eq!(
            factory.calls(),
            vec![("install", 7), ("heartbeat", 7), ("update", 7), ("stop", 7)]
        );
        assert_eq!(adapter.owned_generation().await, None);
    }

    #[tokio::test]
    async fn owned_generation_rejects_cross_generation_install_without_building_it() {
        let (adapter, factory) = adapter(Arc::new(FakeBehavior::default()));
        adapter.install(&spec(7)).await.unwrap();
        let error = adapter.install(&spec(8)).await.unwrap_err();
        assert_eq!(error.code, "LINUX_CAPTURE_GENERATION_OWNED");
        assert!(error.recovery_required);
        assert_eq!(factory.builds(), vec![7]);
        assert_eq!(adapter.owned_generation().await, Some(7));

        let recovery_error = adapter.recover_generation(8).await.unwrap_err();
        assert_eq!(recovery_error.code, "LINUX_CAPTURE_GENERATION_MISMATCH");
        assert_eq!(factory.builds(), vec![7]);
        assert_eq!(factory.calls(), vec![("install", 7)]);
        assert_eq!(adapter.owned_generation().await, Some(7));
    }

    #[tokio::test]
    async fn cancelled_install_retains_owner_for_exact_generation_recovery() {
        let behavior = Arc::new(FakeBehavior::default());
        behavior.block_install.store(true, Ordering::Release);
        let (adapter, factory) = adapter(Arc::clone(&behavior));
        let task_adapter = Arc::clone(&adapter);
        let task = tokio::spawn(async move { task_adapter.install(&spec(7)).await });
        behavior.install_entered.notified().await;
        task.abort();
        let _ = task.await;

        assert_eq!(adapter.owned_generation().await, Some(7));
        adapter.recover_generation(7).await.unwrap();
        assert_eq!(factory.builds(), vec![7]);
        assert_eq!(
            factory.calls(),
            vec![("install", 7), ("recover_generation", 7)]
        );
        assert_eq!(adapter.owned_generation().await, None);
    }

    #[tokio::test]
    async fn non_mutating_install_failure_releases_owner_for_next_generation() {
        let behavior = Arc::new(FakeBehavior::default());
        behavior.fail_install.store(true, Ordering::Release);
        let (adapter, factory) = adapter(Arc::clone(&behavior));
        let error = adapter.install(&spec(7)).await.unwrap_err();
        assert_eq!(error.code, "FAKE_INSTALL_FAILED");
        assert_eq!(adapter.owned_generation().await, None);

        behavior.fail_install.store(false, Ordering::Release);
        adapter.install(&spec(8)).await.unwrap();
        assert_eq!(factory.builds(), vec![7, 8]);
        assert_eq!(adapter.owned_generation().await, Some(8));
    }

    #[tokio::test]
    async fn recovery_reconstructs_only_the_artifact_generation_and_releases_on_proof() {
        let (adapter, factory) = adapter(Arc::new(FakeBehavior::default()));
        adapter.recover(&artifact(11)).await.unwrap();
        assert_eq!(factory.builds(), vec![11]);
        assert_eq!(factory.calls(), vec![("recover", 11)]);
        assert_eq!(adapter.owned_generation().await, None);

        let mut foreign = artifact(12);
        foreign.adapter = "foreign_adapter".into();
        let error = adapter.recover(&foreign).await.unwrap_err();
        assert_eq!(error.code, "LINUX_CAPTURE_ARTIFACT_ADAPTER_MISMATCH");
        assert_eq!(factory.builds(), vec![11]);
    }
}
