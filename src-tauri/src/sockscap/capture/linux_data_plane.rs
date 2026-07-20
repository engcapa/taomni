//! Linux adapter for the platform-neutral product data plane.
//!
//! This module is only an ownership and identity bridge.  It does not select
//! an IP stack, manufacture routing profiles, or unlock Linux capture.  A
//! caller must inject an exact [`PacketStackProvider`] and a per-snapshot plan
//! builder.  The bridge consumes the native Linux queue pair exactly once and
//! retains cleanup ownership even when its `start_until` future is cancelled.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::time::Instant;

use super::linux_adapter::{
    LinuxDataPlaneError, LinuxDataPlaneFactory, LinuxDataPlaneIdentity, LinuxDataPlaneRuntime,
    LinuxPacketChannelIdentity, LinuxPacketRuntimeChannels, LinuxRuntimeIdentity,
};
use super::{CaptureInstallSpec, CaptureMode};
use crate::sockscap::flow::composition::{
    NativePacketPlaneHealth, ProductDataPlaneConfig, ProductDataPlaneError,
    ProductDataPlaneIdentity, ProductDataPlaneRecoveryState, ProductDataPlaneSupervisor,
    ReadyProductDataPlane,
};
use crate::sockscap::flow::ip_stack::IpStackProviderPin;
use crate::sockscap::flow::packet_stack::{PacketStackIo, PacketStackProvider};
use crate::sockscap::flow::runtime::ProfileRuntime;
use crate::sockscap::types::CapturePlatform;

const LINUX_PRODUCT_IDENTITY_INVALID: &str = "LINUX_PRODUCT_DATA_PLANE_IDENTITY_INVALID";

/// One exact FlowRuntime/packet-stack snapshot produced for the capture spec.
/// Profiles are deliberately single-owner and therefore this value is not
/// cloneable.
#[derive(Debug)]
pub struct LinuxProductDataPlanePlan {
    pub config: ProductDataPlaneConfig,
    pub profiles: Vec<ProfileRuntime>,
}

/// Builds policy/egress profiles and bounded stack limits for one immutable
/// capture snapshot.  Implementations must not spawn work; all live owners
/// belong to the returned `ProfileRuntime` values.
pub trait LinuxProductDataPlanePlanFactory: Send + Sync {
    fn build(
        &self,
        spec: &CaptureInstallSpec,
    ) -> Result<LinuxProductDataPlanePlan, LinuxDataPlaneError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxProductRecoveryState {
    Starting,
    Cancelling,
    Retained,
    Uncertain,
}

impl From<ProductDataPlaneRecoveryState> for LinuxProductRecoveryState {
    fn from(state: ProductDataPlaneRecoveryState) -> Self {
        match state {
            ProductDataPlaneRecoveryState::Starting => Self::Starting,
            ProductDataPlaneRecoveryState::Cancelling => Self::Cancelling,
            ProductDataPlaneRecoveryState::Retained => Self::Retained,
            ProductDataPlaneRecoveryState::Uncertain => Self::Uncertain,
        }
    }
}

/// Privacy-bounded diagnostic for cancellation/startup cleanup.  The exact
/// provider pin and queue source are already bound by the runtime identity and
/// are intentionally not converted to free-form log text here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxProductRecoveryStatus {
    pub generation: u64,
    pub config_revision: u64,
    pub runtime_pid: u32,
    pub runtime_process_start_time: u64,
    pub packet_source_id: u64,
    pub state: LinuxProductRecoveryState,
    pub fault_code: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
struct LinuxRecoveryMetadata {
    config_revision: u64,
    runtime_pid: u32,
    runtime_process_start_time: u64,
    packet_source_id: u64,
}

/// Exact Linux implementation of `LinuxDataPlaneRuntime` backed by the shared
/// product composition.
pub struct LinuxProductDataPlaneRuntime {
    identity: LinuxDataPlaneIdentity,
    provider: IpStackProviderPin,
    plane: Option<ReadyProductDataPlane>,
}

impl LinuxProductDataPlaneRuntime {
    fn new(
        plane: ReadyProductDataPlane,
        runtime: LinuxRuntimeIdentity,
        expected_provider: IpStackProviderPin,
    ) -> Self {
        let product = plane.identity();
        debug_assert_ne!(product.generation, 0);
        debug_assert_ne!(product.config_revision, 0);
        debug_assert_eq!(product.platform, CapturePlatform::Linux);
        debug_assert_eq!(product.provider, expected_provider);
        debug_assert_eq!(product.packet_queue.generation, product.generation);
        debug_assert_eq!(product.packet_queue.platform, product.platform);
        debug_assert_ne!(product.source_id(), 0);
        Self {
            identity: LinuxDataPlaneIdentity {
                generation: product.generation,
                config_revision: product.config_revision,
                platform: product.platform,
                runtime_pid: runtime.pid,
                runtime_process_start_time: runtime.process_start_time,
                packet_queue: product.packet_queue,
            },
            provider: expected_provider,
            plane: Some(plane),
        }
    }

    pub fn provider(&self) -> &IpStackProviderPin {
        &self.provider
    }
}

impl fmt::Debug for LinuxProductDataPlaneRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinuxProductDataPlaneRuntime")
            .field("identity", &self.identity)
            .field("provider", &self.provider)
            .field("plane_owned", &self.plane.is_some())
            .finish()
    }
}

#[async_trait]
impl LinuxDataPlaneRuntime for LinuxProductDataPlaneRuntime {
    fn identity(&self) -> LinuxDataPlaneIdentity {
        self.identity
    }

    fn ensure_healthy(&self) -> Result<(), LinuxDataPlaneError> {
        let plane = self
            .plane
            .as_ref()
            .ok_or_else(|| LinuxDataPlaneError::runtime(LINUX_PRODUCT_IDENTITY_INVALID))?;
        let product = plane.identity();
        if product.generation != self.identity.generation
            || product.config_revision != self.identity.config_revision
            || product.platform != self.identity.platform
            || product.provider != self.provider
            || product.packet_queue != self.identity.packet_queue
        {
            return Err(LinuxDataPlaneError::runtime(LINUX_PRODUCT_IDENTITY_INVALID));
        }
        plane
            .ensure_healthy(NativePacketPlaneHealth::Ready)
            .map_err(|error| LinuxDataPlaneError::runtime(error.code()))
    }

    async fn stop_until(&mut self, deadline: Instant) -> Result<(), LinuxDataPlaneError> {
        let plane = self
            .plane
            .as_mut()
            .ok_or_else(|| LinuxDataPlaneError::runtime(LINUX_PRODUCT_IDENTITY_INVALID))?;
        plane
            .stop_until(deadline)
            .await
            .map(|_| ())
            .map_err(|error| LinuxDataPlaneError::runtime(error.code()))
    }
}

/// Cancellation-safe product factory.  The provider is mandatory and exact;
/// there is no default/no-op implementation.
pub struct LinuxProductDataPlaneFactory {
    plans: Arc<dyn LinuxProductDataPlanePlanFactory>,
    supervisor: ProductDataPlaneSupervisor,
    recovery_metadata: Mutex<BTreeMap<u64, LinuxRecoveryMetadata>>,
}

impl LinuxProductDataPlaneFactory {
    pub fn new(
        plans: Arc<dyn LinuxProductDataPlanePlanFactory>,
        provider: Arc<dyn PacketStackProvider>,
    ) -> Self {
        Self {
            plans,
            supervisor: ProductDataPlaneSupervisor::new(provider),
            recovery_metadata: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn recovery_status(&self, generation: u64) -> Option<LinuxProductRecoveryStatus> {
        let Some(status) = self.supervisor.recovery_status(generation) else {
            self.clear_recovery_metadata(generation);
            return None;
        };
        let metadata = self.with_recovery_metadata(|entries| entries.get(&generation).copied())?;
        debug_assert_eq!(metadata.config_revision, status.identity.config_revision);
        debug_assert_eq!(metadata.packet_source_id, status.identity.source_id());
        Some(LinuxProductRecoveryStatus {
            generation: status.identity.generation,
            config_revision: metadata.config_revision,
            runtime_pid: metadata.runtime_pid,
            runtime_process_start_time: metadata.runtime_process_start_time,
            packet_source_id: metadata.packet_source_id,
            state: status.state.into(),
            fault_code: status.fault_code,
        })
    }

    /// Retry a retained startup/cancellation owner.  A timeout keeps the exact
    /// owner in the registry for another recovery attempt.
    pub async fn recover_generation_until(
        &self,
        generation: u64,
        deadline: Instant,
    ) -> Result<(), LinuxDataPlaneError> {
        if generation == 0 {
            return Err(LinuxDataPlaneError::runtime(LINUX_PRODUCT_IDENTITY_INVALID));
        }
        match self
            .supervisor
            .recover_generation_until(generation, deadline)
            .await
        {
            Ok(()) => {
                if self.supervisor.recovery_status(generation).is_none() {
                    self.clear_recovery_metadata(generation);
                }
                Ok(())
            }
            Err(error) => Err(LinuxDataPlaneError::runtime(error.code())),
        }
    }

    fn with_recovery_metadata<T>(
        &self,
        operation: impl FnOnce(&mut BTreeMap<u64, LinuxRecoveryMetadata>) -> T,
    ) -> T {
        let mut entries = self
            .recovery_metadata
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut entries)
    }

    fn reserve_recovery_metadata(
        &self,
        generation: u64,
        metadata: LinuxRecoveryMetadata,
    ) -> Result<(), LinuxDataPlaneError> {
        if self.supervisor.recovery_status(generation).is_none() {
            self.clear_recovery_metadata(generation);
        }
        self.with_recovery_metadata(|entries| {
            if entries.contains_key(&generation) {
                return Err(LinuxDataPlaneError::runtime(
                    "PRODUCT_DATA_PLANE_GENERATION_ALREADY_RESERVED",
                ));
            }
            entries.insert(generation, metadata);
            Ok(())
        })
    }

    fn clear_recovery_metadata(&self, generation: u64) {
        self.with_recovery_metadata(|entries| {
            entries.remove(&generation);
        });
    }
}

impl fmt::Debug for LinuxProductDataPlaneFactory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinuxProductDataPlaneFactory")
            .field("supervisor", &self.supervisor)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl LinuxDataPlaneFactory for LinuxProductDataPlaneFactory {
    async fn start_until(
        &self,
        spec: &CaptureInstallSpec,
        runtime: LinuxRuntimeIdentity,
        channels: LinuxPacketRuntimeChannels,
        deadline: Instant,
    ) -> Result<Box<dyn LinuxDataPlaneRuntime>, LinuxDataPlaneError> {
        let channel_identity = channels.identity();
        validate_linux_inputs(spec, runtime, channel_identity)?;
        let packet_io = PacketStackIo::new(channels.ingress, channels.egress)
            .map_err(|error| LinuxDataPlaneError::runtime(error.code()))?;
        let plan = self.plans.build(spec)?;
        let expected_provider = plan.config.packet_stack.identity.provider.clone();
        let identity = ProductDataPlaneIdentity {
            generation: spec.generation,
            config_revision: spec.config_revision,
            platform: CapturePlatform::Linux,
            provider: expected_provider.clone(),
            packet_queue: channel_identity.packet_queue,
        };
        self.reserve_recovery_metadata(
            spec.generation,
            LinuxRecoveryMetadata {
                config_revision: spec.config_revision,
                runtime_pid: runtime.pid,
                runtime_process_start_time: runtime.process_start_time,
                packet_source_id: channel_identity.source_id(),
            },
        )?;
        let started = self
            .supervisor
            .start_until(identity, plan.config, plan.profiles, packet_io, deadline)
            .await;
        match started {
            Ok(plane) => {
                self.clear_recovery_metadata(spec.generation);
                Ok(Box::new(LinuxProductDataPlaneRuntime::new(
                    plane,
                    runtime,
                    expected_provider,
                )))
            }
            Err(error) => {
                if self.supervisor.recovery_status(spec.generation).is_none() {
                    self.clear_recovery_metadata(spec.generation);
                }
                let code = match &error {
                    ProductDataPlaneError::StartupFailed {
                        primary: "PRODUCT_DATA_PLANE_RESERVED_IDENTITY_MISMATCH",
                        ..
                    } => LINUX_PRODUCT_IDENTITY_INVALID,
                    _ => error.code(),
                };
                Err(LinuxDataPlaneError::runtime(code))
            }
        }
    }

    async fn recover_generation_until(
        &self,
        generation: u64,
        deadline: Instant,
    ) -> Result<(), LinuxDataPlaneError> {
        LinuxProductDataPlaneFactory::recover_generation_until(self, generation, deadline).await
    }
}

fn validate_linux_inputs(
    spec: &CaptureInstallSpec,
    runtime: LinuxRuntimeIdentity,
    channels: LinuxPacketChannelIdentity,
) -> Result<(), LinuxDataPlaneError> {
    if spec.generation == 0
        || spec.config_revision == 0
        || spec.platform != CapturePlatform::Linux
        || spec.mode != CaptureMode::Global
        || runtime.validate_for(spec.generation).is_err()
        || channels.generation != spec.generation
        || channels.platform != CapturePlatform::Linux
        || channels.packet_queue.generation != spec.generation
        || channels.packet_queue.platform != CapturePlatform::Linux
        || channels.source_id() == 0
    {
        return Err(LinuxDataPlaneError::runtime(LINUX_PRODUCT_IDENTITY_INVALID));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::time::Duration;

    use tokio::sync::{Notify, oneshot};

    use super::*;
    use crate::sockscap::capture::linux::LINUX_ADAPTER_ID;
    use crate::sockscap::capture::linux_adapter::{
        LinuxCaptureLifecycle, LinuxHelperControl, LinuxPacketRuntime, LinuxPacketRuntimeBundle,
        LinuxPacketRuntimeError, LinuxPacketRuntimeFactory,
    };
    use crate::sockscap::capture::packet_device::{
        MIN_PACKET_QUEUE_BYTES, NativePacketDeviceQueues, bounded_packet_device_queues,
    };
    use crate::sockscap::capture::{
        AdapterProbe, CaptureArtifactState, CaptureError, CaptureHandle,
    };
    use crate::sockscap::flow::attribution::FakeIpMap;
    use crate::sockscap::flow::bypass::HardBypassSet;
    use crate::sockscap::flow::engine::{EgressProvider, FlowEngine, FlowEngineSnapshot};
    use crate::sockscap::flow::ip_stack::{
        ChecksumPolicy, FragmentationPolicy, IcmpBehavior, IpStackConfig,
        IpStackProviderCapabilities, IpStackProviderResources, Ipv6ExtensionHeaderPolicy,
        TcpBridgeBudget, TcpLifecycleDeadlines, UdpAssociationQueueBudgets, UdpQueueBudget,
        UdpWildcardBindingBudgets,
    };
    use crate::sockscap::flow::packet_stack::{
        PacketStackCapabilities, PacketStackDescriptor, PacketStackDriver,
        PacketStackDriverControl, PacketStackExit, PacketStackIdentity, PacketStackReady,
        PacketStackRunContext, PacketStackSupervisorConfig,
    };
    use crate::sockscap::flow::runtime::FlowRuntimeConfig;
    use crate::sockscap::policy::matcher::ProfileMatcher;
    use crate::sockscap::types::{
        EgressFailureAction, LocalNetworkPolicy, ProfileScope, RouteAction, RoutingProfileDraft,
        UdpPolicy,
    };

    const GENERATION: u64 = 41;
    const REVISION: u64 = 9;

    #[derive(Clone)]
    enum DriverBehavior {
        Wait {
            stopped: Arc<Notify>,
        },
        IgnoreCancellation {
            cancellation_seen: Arc<Notify>,
            release: Arc<Notify>,
        },
        DropIngressAndIgnoreCancellation {
            release: Arc<Notify>,
        },
    }

    struct TestProvider {
        behavior: DriverBehavior,
        build_entered: Option<Arc<Notify>>,
        build_release: Option<Arc<Notify>>,
    }

    struct TestDriver {
        behavior: DriverBehavior,
    }

    #[async_trait]
    impl PacketStackProvider for TestProvider {
        fn descriptor(&self) -> PacketStackDescriptor {
            PacketStackDescriptor {
                provider: provider_pin(),
                capabilities: capabilities(),
            }
        }

        async fn build(
            &self,
            _config: IpStackConfig,
        ) -> Result<Box<dyn PacketStackDriver>, crate::sockscap::flow::packet_stack::PacketStackError>
        {
            if let Some(entered) = &self.build_entered {
                entered.notify_one();
            }
            if let Some(release) = &self.build_release {
                release.notified().await;
            }
            Ok(Box::new(TestDriver {
                behavior: self.behavior.clone(),
            }))
        }
    }

    #[async_trait]
    impl PacketStackDriver for TestDriver {
        fn identity(&self) -> PacketStackIdentity {
            stack_identity(REVISION)
        }

        async fn run(
            self: Box<Self>,
            context: PacketStackRunContext,
            readiness: oneshot::Sender<PacketStackReady>,
            control: PacketStackDriverControl,
            tcp_ingress: crate::sockscap::flow::ingress::BoundedFlowIngressSender,
            udp_ingress: crate::sockscap::flow::ingress::BoundedUdpFlowIngressSender,
        ) -> Result<PacketStackExit, crate::sockscap::flow::packet_stack::PacketStackError>
        {
            let _ = readiness.send(PacketStackReady {
                identity: stack_identity(REVISION),
                capabilities: capabilities(),
            });
            match self.behavior {
                DriverBehavior::Wait { stopped } => {
                    control.quiesce_requested().await;
                    let (native_ingress, native_egress) = context.into_io().into_parts();
                    drop(native_ingress);
                    drop(tcp_ingress);
                    drop(udp_ingress);
                    control.acknowledge_quiesced()?;
                    control.termination_requested().await;
                    drop(native_egress);
                    stopped.notify_one();
                    Ok(PacketStackExit::Cancelled)
                }
                DriverBehavior::IgnoreCancellation {
                    cancellation_seen,
                    release,
                } => {
                    control.quiesce_requested().await;
                    let (native_ingress, native_egress) = context.into_io().into_parts();
                    drop(native_ingress);
                    drop(tcp_ingress);
                    drop(udp_ingress);
                    control.acknowledge_quiesced()?;
                    control.termination_requested().await;
                    cancellation_seen.notify_one();
                    release.notified().await;
                    drop(native_egress);
                    Ok(PacketStackExit::Cancelled)
                }
                DriverBehavior::DropIngressAndIgnoreCancellation { release } => {
                    drop(tcp_ingress);
                    drop(udp_ingress);
                    control.quiesce_requested().await;
                    release.notified().await;
                    let (native_ingress, native_egress) = context.into_io().into_parts();
                    drop(native_ingress);
                    control.acknowledge_quiesced()?;
                    control.termination_requested().await;
                    drop(native_egress);
                    Ok(PacketStackExit::Cancelled)
                }
            }
        }
    }

    struct TestPlanFactory {
        revision: u64,
    }

    #[derive(Debug)]
    struct LifecyclePacketRuntime {
        identity: LinuxRuntimeIdentity,
        started: bool,
    }

    #[async_trait]
    impl LinuxPacketRuntime for LifecyclePacketRuntime {
        fn identity(&self) -> LinuxRuntimeIdentity {
            self.identity
        }

        async fn start_pump_until(
            &mut self,
            _deadline: Instant,
        ) -> Result<(), LinuxPacketRuntimeError> {
            self.started = true;
            Ok(())
        }

        fn ensure_pump_healthy(&self) -> Result<(), LinuxPacketRuntimeError> {
            if self.started {
                Ok(())
            } else {
                Err(LinuxPacketRuntimeError::PumpNotStarted)
            }
        }

        async fn close_until(&mut self, _deadline: Instant) -> Result<(), LinuxPacketRuntimeError> {
            Ok(())
        }
    }

    struct LifecyclePacketRuntimeFactory;

    #[async_trait]
    impl LinuxPacketRuntimeFactory for LifecyclePacketRuntimeFactory {
        async fn open(
            &self,
            spec: &CaptureInstallSpec,
            _handle: &CaptureHandle,
        ) -> Result<LinuxPacketRuntimeBundle, LinuxPacketRuntimeError> {
            let (_native, channels) = packet_channels(spec.generation);
            // The lifecycle test only exercises ownership ordering. Its fake
            // native ends may close after startup; activation is never reached.
            Ok(LinuxPacketRuntimeBundle::new(
                Box::new(LifecyclePacketRuntime {
                    identity: runtime_identity(),
                    started: false,
                }),
                channels,
            ))
        }
    }

    struct LifecycleHelper;

    #[async_trait]
    impl LinuxHelperControl for LifecycleHelper {
        async fn probe(&self) -> Result<AdapterProbe, CaptureError> {
            Ok(AdapterProbe {
                adapter: LINUX_ADAPTER_ID.into(),
                platform: CapturePlatform::Linux,
                installed: true,
                privileged_helper_ready: true,
                signature_verified: true,
                global_available: true,
                application_group_available: false,
                runtime_pid_available: false,
                detail: "test helper".into(),
            })
        }

        async fn prepare(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
            Ok(test_handle(spec))
        }

        async fn activate(
            &self,
            spec: &CaptureInstallSpec,
            _runtime_pid: u32,
            _runtime_start_token: u64,
        ) -> Result<CaptureHandle, CaptureError> {
            Ok(test_handle(spec))
        }

        async fn update(
            &self,
            handle: &CaptureHandle,
            _spec: &CaptureInstallSpec,
        ) -> Result<CaptureHandle, CaptureError> {
            Ok(handle.clone())
        }

        async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
            Ok(handle.clone())
        }

        async fn stop(&self, _handle: &CaptureHandle) -> Result<(), CaptureError> {
            Ok(())
        }

        async fn recover(&self, _artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
            Ok(())
        }

        async fn recover_generation(&self, _generation: u64) -> Result<(), CaptureError> {
            Ok(())
        }

        async fn shutdown(&self) -> Result<(), CaptureError> {
            Ok(())
        }
    }

    impl LinuxProductDataPlanePlanFactory for TestPlanFactory {
        fn build(
            &self,
            _spec: &CaptureInstallSpec,
        ) -> Result<LinuxProductDataPlanePlan, LinuxDataPlaneError> {
            Ok(LinuxProductDataPlanePlan {
                config: product_config(self.revision),
                profiles: profiles(self.revision),
            })
        }
    }

    fn provider_pin() -> IpStackProviderPin {
        IpStackProviderPin {
            name: "taomni-linux-bridge-test-stack".into(),
            version: "0.0.0-test".into(),
            source_sha256: "b".repeat(64),
        }
    }

    fn capabilities() -> PacketStackCapabilities {
        PacketStackCapabilities {
            ipv4: true,
            ipv6: true,
            tcp: true,
            udp: true,
            fragment_reassembly: true,
        }
    }

    fn stack_identity(revision: u64) -> PacketStackIdentity {
        PacketStackIdentity {
            generation: GENERATION,
            config_revision: revision,
            platform: CapturePlatform::Linux,
            provider: provider_pin(),
        }
    }

    fn product_config(revision: u64) -> ProductDataPlaneConfig {
        let udp_queue = UdpQueueBudget {
            datagrams: 2,
            payload_bytes: 2_400,
            metadata_bytes: 128,
        };
        ProductDataPlaneConfig {
            packet_stack: PacketStackSupervisorConfig {
                identity: stack_identity(revision),
                required_capabilities: PacketStackCapabilities {
                    ipv4: true,
                    tcp: true,
                    udp: true,
                    ..PacketStackCapabilities::default()
                },
                decoded_tcp_queue_capacity: 8,
                decoded_udp_queue_capacity: 8,
                startup_timeout: Duration::from_millis(250),
                shutdown_timeout: Duration::from_millis(20),
            },
            ip_stack: IpStackConfig {
                generation: GENERATION,
                platform: CapturePlatform::Linux,
                provider: provider_pin(),
                max_tcp_flows: 8,
                max_udp_associations: 8,
                max_reassembly_bytes: 0,
                max_packet_bytes: 1500,
                mtu_bytes: 1500,
                tcp_rx_bytes_per_flow: 8 * 1024,
                tcp_tx_bytes_per_flow: 8 * 1024,
                total_socket_bytes: 512 * 1024,
                udp_datagram_bytes: 1200,
                provider_resources: IpStackProviderResources {
                    tcp_lifecycle: TcpLifecycleDeadlines {
                        handshake_ms: 30_000,
                        graceful_close_ms: 10_000,
                        reset_ms: 1_000,
                    },
                    tcp_bridge: TcpBridgeBudget {
                        rx_bytes_per_flow: 4 * 1024,
                        tx_bytes_per_flow: 4 * 1024,
                    },
                    udp_association_queues: UdpAssociationQueueBudgets {
                        stack_to_egress: udp_queue,
                        egress_to_stack: udp_queue,
                    },
                    udp_wildcard_bindings: UdpWildcardBindingBudgets {
                        max_bindings: 8,
                        rx: udp_queue,
                        tx: udp_queue,
                    },
                    capabilities: IpStackProviderCapabilities {
                        bounded_fragment_reassembly: false,
                        validated_ipv6_extension_headers: false,
                    },
                    fragmentation_policy: FragmentationPolicy::RejectAll,
                    ipv6_extension_header_policy: Ipv6ExtensionHeaderPolicy::RejectAll,
                },
                udp_idle_timeout_ms: 30_000,
                max_fragments: 0,
                fragment_timeout_ms: 0,
                packet_work_per_wake: 64,
                socket_work_per_wake: 64,
                tx_staging_packets: 8,
                tx_staging_bytes: 12_000,
                tx_backpressure_deadline_ms: 100,
                checksum_policy: ChecksumPolicy::VerifyInboundAndComputeOutbound,
                icmp_behavior: IcmpBehavior::ErrorsOnly,
            },
            flow_runtime: FlowRuntimeConfig::new(
                CapturePlatform::Linux,
                GENERATION,
                revision,
                8,
                Duration::from_millis(100),
            )
            .unwrap(),
        }
    }

    fn profiles(revision: u64) -> Vec<ProfileRuntime> {
        let profile = RoutingProfileDraft {
            id: "profile-linux-bridge".into(),
            name: "Linux bridge".into(),
            enabled: true,
            scope: ProfileScope::Global,
            default_action: RouteAction::Block,
            unknown_domain_action: RouteAction::Block,
            ..RoutingProfileDraft::default()
        };
        let matcher = Arc::new(ProfileMatcher::from_parts(
            profile.id.clone(),
            profile.default_action,
            profile.unknown_domain_action,
            Vec::new(),
            &[],
            &[],
        ));
        let engine = Arc::new(FlowEngine::new(
            FlowEngineSnapshot::from_profile(revision, &profile).unwrap(),
            matcher,
            HardBypassSet::default(),
            FakeIpMap::default(),
            EgressProvider::unavailable("unused by Linux bridge tests"),
            UdpPolicy::Block,
            EgressFailureAction::FailClosed,
            LocalNetworkPolicy::default(),
        ));
        vec![ProfileRuntime::new(profile, engine)]
    }

    fn spec() -> CaptureInstallSpec {
        CaptureInstallSpec {
            generation: GENERATION,
            config_revision: REVISION,
            platform: CapturePlatform::Linux,
            mode: CaptureMode::Global,
            gateway: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 28080),
            route_ipv6: true,
            selectors: Vec::new(),
            bypass_ips: Vec::new(),
            taomni_pid: std::process::id(),
            helper_pid: None,
        }
    }

    fn runtime_identity() -> LinuxRuntimeIdentity {
        LinuxRuntimeIdentity {
            generation: GENERATION,
            pid: std::process::id(),
            process_start_time: 12345,
        }
    }

    fn test_handle(spec: &CaptureInstallSpec) -> CaptureHandle {
        CaptureHandle {
            generation: spec.generation,
            config_revision: spec.config_revision,
            helper_pid: 4321,
            artifact: CaptureArtifactState {
                adapter: LINUX_ADAPTER_ID.into(),
                generation: spec.generation,
                owner_uid: Some(1000),
                interface_names: vec!["tmn41".into()],
                rule_ids: Vec::new(),
                route_ids: Vec::new(),
                cgroup_paths: Vec::new(),
                driver_service: None,
                extension_bundle_id: None,
                process_restores: Vec::new(),
            },
        }
    }

    fn packet_channels(generation: u64) -> (NativePacketDeviceQueues, LinuxPacketRuntimeChannels) {
        let (native, stack) = bounded_packet_device_queues(
            MIN_PACKET_QUEUE_BYTES,
            generation,
            CapturePlatform::Linux,
        )
        .unwrap();
        let channels =
            LinuxPacketRuntimeChannels::from_packet_queues(stack.ingress, stack.egress).unwrap();
        (native, channels)
    }

    fn test_factory(provider: TestProvider) -> Arc<LinuxProductDataPlaneFactory> {
        Arc::new(LinuxProductDataPlaneFactory::new(
            Arc::new(TestPlanFactory { revision: REVISION }),
            Arc::new(provider),
        ))
    }

    async fn wait_for_state(
        factory: &LinuxProductDataPlaneFactory,
        expected: LinuxProductRecoveryState,
    ) -> LinuxProductRecoveryStatus {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(status) = factory.recovery_status(GENERATION)
                    && status.state == expected
                {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("recovery state must become observable")
    }

    #[tokio::test]
    async fn ready_runtime_binds_linux_identity_provider_and_stops() {
        let stopped = Arc::new(Notify::new());
        let factory = test_factory(TestProvider {
            behavior: DriverBehavior::Wait {
                stopped: Arc::clone(&stopped),
            },
            build_entered: None,
            build_release: None,
        });
        let (native, channels) = packet_channels(GENERATION);
        let mut runtime = factory
            .start_until(
                &spec(),
                runtime_identity(),
                channels,
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .unwrap();
        let identity = runtime.identity();
        assert_eq!(identity.generation, GENERATION);
        assert_eq!(identity.config_revision, REVISION);
        assert_eq!(identity.runtime_pid, std::process::id());
        assert_ne!(identity.source_id(), 0);
        runtime.ensure_healthy().unwrap();
        runtime
            .stop_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        stopped.notified().await;
        assert!(native.capture.is_closed());
        assert!(factory.recovery_status(GENERATION).is_none());
    }

    #[tokio::test]
    async fn rejects_cross_revision_and_cross_generation_before_provider_start() {
        let provider = Arc::new(TestProvider {
            behavior: DriverBehavior::Wait {
                stopped: Arc::new(Notify::new()),
            },
            build_entered: None,
            build_release: None,
        });
        let factory = LinuxProductDataPlaneFactory::new(
            Arc::new(TestPlanFactory {
                revision: REVISION + 1,
            }),
            provider,
        );
        let (_native, channels) = packet_channels(GENERATION);
        let error = factory
            .start_until(
                &spec(),
                runtime_identity(),
                channels,
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), LINUX_PRODUCT_IDENTITY_INVALID);

        let factory = test_factory(TestProvider {
            behavior: DriverBehavior::Wait {
                stopped: Arc::new(Notify::new()),
            },
            build_entered: None,
            build_release: None,
        });
        let (_native, channels) = packet_channels(GENERATION + 1);
        let error = factory
            .start_until(
                &spec(),
                runtime_identity(),
                channels,
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), LINUX_PRODUCT_IDENTITY_INVALID);
    }

    #[tokio::test]
    async fn cancelled_start_continues_owned_cleanup() {
        let build_entered = Arc::new(Notify::new());
        let build_release = Arc::new(Notify::new());
        let stopped = Arc::new(Notify::new());
        let factory = test_factory(TestProvider {
            behavior: DriverBehavior::Wait {
                stopped: Arc::clone(&stopped),
            },
            build_entered: Some(Arc::clone(&build_entered)),
            build_release: Some(Arc::clone(&build_release)),
        });
        let (_native, channels) = packet_channels(GENERATION);
        let task_factory = Arc::clone(&factory);
        let task = tokio::spawn(async move {
            task_factory
                .start_until(
                    &spec(),
                    runtime_identity(),
                    channels,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
        });
        build_entered.notified().await;
        task.abort();
        let _ = task.await;
        build_release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), stopped.notified())
            .await
            .expect("cancelled handoff must stop its provider");
        tokio::time::timeout(Duration::from_secs(2), async {
            while factory.recovery_status(GENERATION).is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("clean cancellation must discharge the registry");
    }

    #[tokio::test]
    async fn cancelled_start_retains_cleanup_timeout_for_explicit_retry() {
        let build_entered = Arc::new(Notify::new());
        let build_release = Arc::new(Notify::new());
        let cancellation_seen = Arc::new(Notify::new());
        let driver_release = Arc::new(Notify::new());
        let factory = test_factory(TestProvider {
            behavior: DriverBehavior::IgnoreCancellation {
                cancellation_seen: Arc::clone(&cancellation_seen),
                release: Arc::clone(&driver_release),
            },
            build_entered: Some(Arc::clone(&build_entered)),
            build_release: Some(Arc::clone(&build_release)),
        });
        let (_native, channels) = packet_channels(GENERATION);
        let task_factory = Arc::clone(&factory);
        let task = tokio::spawn(async move {
            task_factory
                .start_until(
                    &spec(),
                    runtime_identity(),
                    channels,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
        });
        build_entered.notified().await;
        task.abort();
        let _ = task.await;
        build_release.notify_one();
        cancellation_seen.notified().await;
        let retained = wait_for_state(&factory, LinuxProductRecoveryState::Retained).await;
        assert_eq!(retained.fault_code, Some("PRODUCT_DATA_PLANE_STOP_FAILED"));
        driver_release.notify_one();
        factory
            .recover_generation_until(GENERATION, Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert!(factory.recovery_status(GENERATION).is_none());
    }

    #[tokio::test]
    async fn startup_failed_recovery_owner_is_retained_and_retryable() {
        let driver_release = Arc::new(Notify::new());
        let factory = test_factory(TestProvider {
            behavior: DriverBehavior::DropIngressAndIgnoreCancellation {
                release: Arc::clone(&driver_release),
            },
            build_entered: None,
            build_release: None,
        });
        let (_native, channels) = packet_channels(GENERATION);
        let error = factory
            .start_until(
                &spec(),
                runtime_identity(),
                channels,
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), "PRODUCT_DATA_PLANE_STARTUP_FAILED");
        let retained = wait_for_state(&factory, LinuxProductRecoveryState::Retained).await;
        assert!(retained.fault_code.is_some());
        driver_release.notify_one();
        factory
            .recover_generation_until(GENERATION, Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert!(factory.recovery_status(GENERATION).is_none());
    }

    #[tokio::test]
    async fn lifecycle_rollback_waits_for_bridge_recovery_before_idle() {
        let driver_release = Arc::new(Notify::new());
        let factory = test_factory(TestProvider {
            behavior: DriverBehavior::DropIngressAndIgnoreCancellation {
                release: Arc::clone(&driver_release),
            },
            build_entered: None,
            build_release: None,
        });
        let lifecycle = LinuxCaptureLifecycle::new(
            Arc::new(LifecycleHelper),
            Arc::new(LifecyclePacketRuntimeFactory),
            factory.clone(),
        );
        let release = Arc::clone(&driver_release);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            release.notify_one();
        });

        let error = lifecycle.install(&spec()).await.unwrap_err();
        assert_eq!(
            error.code, "PRODUCT_DATA_PLANE_STARTUP_FAILED",
            "unexpected rollback result: {error:?}"
        );
        assert_eq!(
            lifecycle.state().await,
            crate::sockscap::capture::linux_adapter::LinuxCaptureState::Idle
        );
        assert!(factory.recovery_status(GENERATION).is_none());
    }
}
