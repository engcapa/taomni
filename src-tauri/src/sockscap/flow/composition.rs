//! Single product composition boundary for the shared packet data plane.
//!
//! This module does not select or implement an IP stack.  A caller must inject
//! one exact [`PacketStackProvider`] pin and platform-owned packet queues.  The
//! factory then performs the only decoded-flow handoff: it starts the packet
//! supervisor, takes its ingress receiver exactly once, hides that receiver
//! behind a runtime-readiness fence, and transfers it to one [`FlowRuntime`].
//! No capability bit is enabled by constructing or starting this composition.

use std::collections::BTreeMap;
use std::fmt;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::stream::FuturesUnordered;
use futures::{FutureExt, StreamExt};
use tokio::sync::oneshot;
use tokio::task::{JoinError, JoinHandle};
use tokio::time::Instant;

use super::ingress::{
    BoundedFlowIngress, BoundedUdpFlowIngress, FlowIngress, IngressError, IngressTcpFlow,
    IngressUdpAssociation, UdpFlowIngress,
};
use super::ip_stack::{IpStackConfig, IpStackError, IpStackProviderPin};
use super::packet_stack::{
    PacketStackError, PacketStackExit, PacketStackHealth, PacketStackIo, PacketStackProvider,
    PacketStackSupervisor, PacketStackSupervisorConfig, ReadyPacketStack, StartingPacketStack,
};
use super::runtime::{
    FlowRuntime, FlowRuntimeConfig, FlowRuntimeError, FlowRuntimeLifecycle, FlowRuntimeOwner,
    FlowRuntimeSnapshot, ProfileRuntime,
};
use crate::sockscap::capture::packet_device::PacketQueueIdentity;
use crate::sockscap::types::CapturePlatform;

const PRODUCT_DATA_PLANE_START_TIMEOUT_CODE: &str = "PRODUCT_DATA_PLANE_START_TIMEOUT";
const PRODUCT_DATA_PLANE_RUNTIME_READY_CHANNEL_CODE: &str =
    "PRODUCT_DATA_PLANE_RUNTIME_READY_CHANNEL_CLOSED";
const PRODUCT_DATA_PLANE_RUNTIME_EXIT_CODE: &str = "PRODUCT_DATA_PLANE_RUNTIME_EXITED_UNEXPECTEDLY";
const PRODUCT_DATA_PLANE_RUNTIME_JOIN_CODE: &str = "PRODUCT_DATA_PLANE_RUNTIME_JOIN_FAILED";
const PRODUCT_DATA_PLANE_RUNTIME_SHUTDOWN_TIMEOUT_CODE: &str =
    "PRODUCT_DATA_PLANE_RUNTIME_SHUTDOWN_TIMEOUT";
const PACKET_STACK_QUIESCE_TIMEOUT_CODE: &str = "PACKET_STACK_QUIESCE_TIMEOUT";
const PACKET_STACK_SHUTDOWN_TIMEOUT_CODE: &str = "PACKET_STACK_SHUTDOWN_TIMEOUT";
const PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE: &str = "PRODUCT_DATA_PLANE_PACKET_STACK_UNHEALTHY";
const PRODUCT_DATA_PLANE_NATIVE_FAILED_CODE: &str = "PRODUCT_DATA_PLANE_NATIVE_FAILED";
const PRODUCT_DATA_PLANE_NATIVE_STOPPED_CODE: &str = "PRODUCT_DATA_PLANE_NATIVE_STOPPED";
const FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED_CODE: &str = "FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED";
const PRODUCT_DATA_PLANE_GENERATION_BUSY_CODE: &str =
    "PRODUCT_DATA_PLANE_GENERATION_ALREADY_RESERVED";
const PRODUCT_DATA_PLANE_RECOVERY_IN_FLIGHT_CODE: &str = "PRODUCT_DATA_PLANE_RECOVERY_IN_FLIGHT";
const PRODUCT_DATA_PLANE_RECOVERY_UNCERTAIN_CODE: &str = "PRODUCT_DATA_PLANE_RECOVERY_UNCERTAIN";
const PRODUCT_DATA_PLANE_START_CHANNEL_CODE: &str = "PRODUCT_DATA_PLANE_START_CHANNEL_CLOSED";
const PRODUCT_DATA_PLANE_START_PANICKED_CODE: &str = "PRODUCT_DATA_PLANE_START_PANICKED";
const PRODUCT_DATA_PLANE_START_CANCELLED_CODE: &str = "PRODUCT_DATA_PLANE_START_CANCELLED";

/// Cross-component configuration consumed by a single-use product factory.
#[derive(Debug, Clone)]
pub struct ProductDataPlaneConfig {
    pub packet_stack: PacketStackSupervisorConfig,
    pub ip_stack: IpStackConfig,
    pub flow_runtime: FlowRuntimeConfig,
}

impl ProductDataPlaneConfig {
    pub fn validate(&self) -> Result<(), ProductDataPlaneError> {
        self.packet_stack
            .validate()
            .map_err(ProductDataPlaneError::PacketStack)?;
        self.ip_stack
            .validate()
            .map_err(ProductDataPlaneError::IpStack)?;

        let identity = &self.packet_stack.identity;
        if identity.generation != self.flow_runtime.generation()
            || identity.config_revision != self.flow_runtime.config_revision()
            || identity.platform != self.flow_runtime.platform()
            || identity.generation != self.ip_stack.generation
            || identity.platform != self.ip_stack.platform
            || identity.provider != self.ip_stack.provider
        {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_IDENTITY_MISMATCH",
                "packet stack, IP stack, and flow runtime use different snapshots",
            ));
        }
        if !self.packet_stack.required_capabilities.ipv4
            && !self.packet_stack.required_capabilities.ipv6
        {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_IP_CAPABILITY_REQUIRED",
                "product composition must explicitly require at least one IP family",
            ));
        }
        if !self.packet_stack.required_capabilities.tcp {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_TCP_CAPABILITY_REQUIRED",
                "decoded-flow composition requires an explicitly required TCP provider",
            ));
        }
        if !self.packet_stack.required_capabilities.udp {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_UDP_CAPABILITY_REQUIRED",
                "dual-transport composition requires an explicitly required UDP provider",
            ));
        }
        if self.flow_runtime.max_active_flows() > self.ip_stack.max_tcp_flows {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_FLOW_LIMIT_MISMATCH",
                "FlowRuntime cannot admit more TCP flows than the packet stack",
            ));
        }
        if self.flow_runtime.max_active_udp_associations() > self.ip_stack.max_udp_associations {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_UDP_LIMIT_MISMATCH",
                "FlowRuntime cannot admit more UDP associations than the packet stack",
            ));
        }
        if self.packet_stack.decoded_tcp_queue_capacity > self.flow_runtime.max_active_flows() {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_TCP_QUEUE_RUNTIME_MISMATCH",
                "decoded TCP flow queue cannot exceed the runtime flow budget",
            ));
        }
        if self.packet_stack.decoded_udp_queue_capacity
            > self.flow_runtime.max_active_udp_associations()
        {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_UDP_QUEUE_RUNTIME_MISMATCH",
                "decoded UDP association queue cannot exceed the runtime association budget",
            ));
        }

        let runtime_udp_idle_timeout = self.flow_runtime.udp_idle_timeout();
        let runtime_udp_idle_timeout_ms = u64::try_from(runtime_udp_idle_timeout.as_millis())
            .map_err(|_| {
                ProductDataPlaneError::invalid(
                    "PRODUCT_DATA_PLANE_UDP_IDLE_TIMEOUT_MISMATCH",
                    "FlowRuntime UDP idle timeout cannot be represented in milliseconds",
                )
            })?;
        if Duration::from_millis(runtime_udp_idle_timeout_ms) != runtime_udp_idle_timeout
            || runtime_udp_idle_timeout_ms != self.ip_stack.udp_idle_timeout_ms
        {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_UDP_IDLE_TIMEOUT_MISMATCH",
                "FlowRuntime and IP-stack UDP idle timeouts must match exactly",
            ));
        }
        Ok(())
    }

    fn cleanup_timeout(&self) -> Duration {
        // Startup and shutdown share no deadline.  A readiness timeout may
        // consume its entire budget, while local owners still require both
        // the packet-driver and FlowRuntime cleanup windows.
        self.packet_stack
            .shutdown_timeout
            .saturating_add(self.flow_runtime.shutdown_grace())
    }
}

/// Runtime receipt that binds the composition to one exact native queue pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductDataPlaneIdentity {
    pub generation: u64,
    pub config_revision: u64,
    pub platform: CapturePlatform,
    pub provider: IpStackProviderPin,
    pub packet_queue: PacketQueueIdentity,
}

impl ProductDataPlaneIdentity {
    pub fn source_id(&self) -> u64 {
        self.packet_queue.source_id()
    }
}

/// Platform-owned packet pump state supplied at each active health fence.
///
/// The shared composition never invents native readiness.  Linux, Windows, or
/// macOS code must map its live pump/provider state into this value immediately
/// before and after privileged capture activation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativePacketPlaneHealth {
    Ready,
    Failed,
    Stopped,
}

/// Privacy-safe component fault codes. No tuple, process, hostname, or path is
/// accepted at this boundary.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProductDataPlaneFaults {
    pub packet_stack: Option<&'static str>,
    pub flow_runtime: Option<&'static str>,
    pub native: Option<&'static str>,
}

impl ProductDataPlaneFaults {
    pub fn is_empty(self) -> bool {
        self.packet_stack.is_none() && self.flow_runtime.is_none() && self.native.is_none()
    }
}

impl fmt::Display for ProductDataPlaneFaults {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut separator = "";
        for (component, code) in [
            ("packet_stack", self.packet_stack),
            ("flow_runtime", self.flow_runtime),
            ("native", self.native),
        ] {
            if let Some(code) = code {
                write!(formatter, "{separator}{component}={code}")?;
                separator = ",";
            }
        }
        if separator.is_empty() {
            formatter.write_str("none")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProductDataPlaneHealth {
    Ready,
    Stopping,
    Failed(ProductDataPlaneFaults),
    Stopped,
}

#[derive(Debug, thiserror::Error)]
pub enum ProductDataPlaneError {
    #[error("{code}: {message}")]
    Invalid {
        code: &'static str,
        message: &'static str,
    },
    #[error("product packet-stack contract failed: {0}")]
    PacketStack(#[source] PacketStackError),
    #[error("product IP-stack contract failed: {0}")]
    IpStack(#[source] IpStackError),
    #[error("product FlowRuntime contract failed: {0}")]
    FlowRuntime(#[source] FlowRuntimeError),
    #[error("PRODUCT_DATA_PLANE_START_TIMEOUT: combined data plane missed its deadline")]
    StartTimeout,
    #[error("PRODUCT_DATA_PLANE_STARTUP_FAILED: primary={primary}, cleanup={cleanup}")]
    StartupFailed {
        primary: &'static str,
        cleanup: ProductDataPlaneFaults,
        /// Present whenever explicit cleanup proof was not obtained.  Product
        /// lifecycle code must retain and retry this owner; dropping it is
        /// bounded emergency containment, not a clean recovery receipt.
        recovery_owner: Option<Box<ProductDataPlaneRecoveryOwner>>,
    },
    #[error("PRODUCT_DATA_PLANE_UNHEALTHY: {faults}")]
    Unhealthy { faults: ProductDataPlaneFaults },
    #[error("PRODUCT_DATA_PLANE_STOP_FAILED: {faults}")]
    StopFailed { faults: ProductDataPlaneFaults },
}

impl ProductDataPlaneError {
    fn invalid(code: &'static str, message: &'static str) -> Self {
        Self::Invalid { code, message }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid { code, .. } => code,
            Self::PacketStack(error) => error.code(),
            Self::IpStack(error) => error.code(),
            Self::FlowRuntime(error) => flow_runtime_error_code(error),
            Self::StartTimeout => PRODUCT_DATA_PLANE_START_TIMEOUT_CODE,
            Self::StartupFailed { .. } => "PRODUCT_DATA_PLANE_STARTUP_FAILED",
            Self::Unhealthy { .. } => "PRODUCT_DATA_PLANE_UNHEALTHY",
            Self::StopFailed { .. } => "PRODUCT_DATA_PLANE_STOP_FAILED",
        }
    }

    pub fn take_recovery_owner(&mut self) -> Option<ProductDataPlaneRecoveryOwner> {
        match self {
            Self::StartupFailed { recovery_owner, .. } => recovery_owner.take().map(|owner| *owner),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProductDataPlaneRecoveryState {
    Starting,
    Cancelling,
    Retained,
    Uncertain,
}

/// Privacy-bounded receipt for a generation whose startup ownership has not
/// yet been handed to a platform lifecycle or proved clean.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductDataPlaneRecoveryStatus {
    pub identity: ProductDataPlaneIdentity,
    pub state: ProductDataPlaneRecoveryState,
    pub fault_code: Option<&'static str>,
}

enum ProductRecoveryEntry {
    Starting(ProductDataPlaneIdentity),
    Cancelling {
        identity: ProductDataPlaneIdentity,
        fault_code: &'static str,
    },
    Retained {
        identity: ProductDataPlaneIdentity,
        fault_code: &'static str,
        owner: ProductDataPlaneRecoveryOwner,
    },
    Uncertain {
        identity: ProductDataPlaneIdentity,
        fault_code: &'static str,
    },
}

impl ProductRecoveryEntry {
    fn status(&self) -> ProductDataPlaneRecoveryStatus {
        match self {
            Self::Starting(identity) => ProductDataPlaneRecoveryStatus {
                identity: identity.clone(),
                state: ProductDataPlaneRecoveryState::Starting,
                fault_code: None,
            },
            Self::Cancelling {
                identity,
                fault_code,
            } => ProductDataPlaneRecoveryStatus {
                identity: identity.clone(),
                state: ProductDataPlaneRecoveryState::Cancelling,
                fault_code: Some(fault_code),
            },
            Self::Retained {
                identity,
                fault_code,
                ..
            } => ProductDataPlaneRecoveryStatus {
                identity: identity.clone(),
                state: ProductDataPlaneRecoveryState::Retained,
                fault_code: Some(fault_code),
            },
            Self::Uncertain {
                identity,
                fault_code,
            } => ProductDataPlaneRecoveryStatus {
                identity: identity.clone(),
                state: ProductDataPlaneRecoveryState::Uncertain,
                fault_code: Some(fault_code),
            },
        }
    }
}

#[derive(Default)]
struct ProductRecoveryRegistry {
    entries: Mutex<BTreeMap<u64, ProductRecoveryEntry>>,
}

impl ProductRecoveryRegistry {
    fn with_entries<T>(
        &self,
        operation: impl FnOnce(&mut BTreeMap<u64, ProductRecoveryEntry>) -> T,
    ) -> T {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut entries)
    }

    fn reserve(&self, identity: ProductDataPlaneIdentity) -> Result<(), ProductDataPlaneError> {
        self.with_entries(|entries| {
            if entries.contains_key(&identity.generation) {
                return Err(ProductDataPlaneError::invalid(
                    PRODUCT_DATA_PLANE_GENERATION_BUSY_CODE,
                    "the product data-plane generation already has an ownership record",
                ));
            }
            entries.insert(
                identity.generation,
                ProductRecoveryEntry::Starting(identity),
            );
            Ok(())
        })
    }

    fn clear(&self, generation: u64) {
        self.with_entries(|entries| {
            entries.remove(&generation);
        });
    }

    fn retain(
        &self,
        identity: ProductDataPlaneIdentity,
        fault_code: &'static str,
        owner: ProductDataPlaneRecoveryOwner,
    ) {
        self.with_entries(|entries| {
            entries.insert(
                identity.generation,
                ProductRecoveryEntry::Retained {
                    identity,
                    fault_code,
                    owner,
                },
            );
        });
    }

    fn cancelling(&self, identity: ProductDataPlaneIdentity, fault_code: &'static str) {
        self.with_entries(|entries| {
            entries.insert(
                identity.generation,
                ProductRecoveryEntry::Cancelling {
                    identity,
                    fault_code,
                },
            );
        });
    }

    fn uncertain_if_unowned(&self, identity: ProductDataPlaneIdentity, fault_code: &'static str) {
        self.with_entries(|entries| {
            let replace = matches!(
                entries.get(&identity.generation),
                None | Some(ProductRecoveryEntry::Starting(_))
            );
            if replace {
                entries.insert(
                    identity.generation,
                    ProductRecoveryEntry::Uncertain {
                        identity,
                        fault_code,
                    },
                );
            }
        });
    }

    fn status(&self, generation: u64) -> Option<ProductDataPlaneRecoveryStatus> {
        self.with_entries(|entries| entries.get(&generation).map(ProductRecoveryEntry::status))
    }

    fn take_retained(
        &self,
        generation: u64,
    ) -> Result<
        Option<(ProductDataPlaneIdentity, ProductDataPlaneRecoveryOwner)>,
        ProductDataPlaneError,
    > {
        self.with_entries(|entries| {
            let Some(entry) = entries.remove(&generation) else {
                return Ok(None);
            };
            match entry {
                ProductRecoveryEntry::Retained {
                    identity,
                    fault_code,
                    owner,
                } => {
                    entries.insert(
                        generation,
                        ProductRecoveryEntry::Cancelling {
                            identity: identity.clone(),
                            fault_code,
                        },
                    );
                    Ok(Some((identity, owner)))
                }
                ProductRecoveryEntry::Starting(identity) => {
                    entries.insert(generation, ProductRecoveryEntry::Starting(identity));
                    Err(ProductDataPlaneError::invalid(
                        PRODUCT_DATA_PLANE_RECOVERY_IN_FLIGHT_CODE,
                        "product data-plane startup is still in flight",
                    ))
                }
                ProductRecoveryEntry::Cancelling {
                    identity,
                    fault_code,
                } => {
                    entries.insert(
                        generation,
                        ProductRecoveryEntry::Cancelling {
                            identity,
                            fault_code,
                        },
                    );
                    Err(ProductDataPlaneError::invalid(
                        PRODUCT_DATA_PLANE_RECOVERY_IN_FLIGHT_CODE,
                        "product data-plane cleanup is already in flight",
                    ))
                }
                ProductRecoveryEntry::Uncertain {
                    identity,
                    fault_code,
                } => {
                    entries.insert(
                        generation,
                        ProductRecoveryEntry::Uncertain {
                            identity,
                            fault_code,
                        },
                    );
                    Err(ProductDataPlaneError::invalid(
                        PRODUCT_DATA_PLANE_RECOVERY_UNCERTAIN_CODE,
                        "product data-plane ownership is uncertain and cannot be declared clean",
                    ))
                }
            }
        })
    }
}

/// Cancellation-safe public composition boundary. The inner constructor is
/// deliberately private: every platform must pass through this supervisor so
/// a detached worker and generation registry own all startup phases.
#[derive(Clone)]
pub struct ProductDataPlaneSupervisor {
    provider: Arc<dyn PacketStackProvider>,
    recovery: Arc<ProductRecoveryRegistry>,
}

impl ProductDataPlaneSupervisor {
    pub fn new(provider: Arc<dyn PacketStackProvider>) -> Self {
        Self {
            provider,
            recovery: Arc::new(ProductRecoveryRegistry::default()),
        }
    }

    pub fn recovery_status(&self, generation: u64) -> Option<ProductDataPlaneRecoveryStatus> {
        self.recovery.status(generation)
    }

    pub async fn start_until(
        &self,
        identity: ProductDataPlaneIdentity,
        config: ProductDataPlaneConfig,
        profiles: Vec<ProfileRuntime>,
        io: PacketStackIo,
        deadline: Instant,
    ) -> Result<ReadyProductDataPlane, ProductDataPlaneError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| {
            ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_ASYNC_RUNTIME_UNAVAILABLE",
                "product data-plane startup requires a Tokio runtime",
            )
        })?;
        let cleanup_timeout = config.cleanup_timeout().max(Duration::from_millis(100));
        self.recovery.reserve(identity.clone())?;

        let recovery = Arc::clone(&self.recovery);
        let provider = Arc::clone(&self.provider);
        let worker_identity = identity.clone();
        let (sender, receiver) = oneshot::channel();
        runtime.spawn(async move {
            let started = AssertUnwindSafe(async {
                let mut profile_owners =
                    ProductDataPlaneRecoveryOwner::profiles(&profiles, cleanup_timeout);
                if !reserved_identity_matches(&worker_identity, &config, io.identity()) {
                    let cleanup =
                        cleanup_recovery_owner(&mut profile_owners, cleanup_timeout).await;
                    return Err(ProductDataPlaneError::StartupFailed {
                        primary: "PRODUCT_DATA_PLANE_RESERVED_IDENTITY_MISMATCH",
                        cleanup,
                        recovery_owner: (!cleanup.is_empty()).then(|| Box::new(profile_owners)),
                    });
                }
                let factory = match ProductDataPlaneFactory::new(config, profiles, provider) {
                    Ok(factory) => {
                        profile_owners.mark_transferred();
                        factory
                    }
                    Err(error) => {
                        let primary = error.code();
                        let cleanup =
                            cleanup_recovery_owner(&mut profile_owners, cleanup_timeout).await;
                        return if cleanup.is_empty() {
                            Err(error)
                        } else {
                            Err(ProductDataPlaneError::StartupFailed {
                                primary,
                                cleanup,
                                recovery_owner: Some(Box::new(profile_owners)),
                            })
                        };
                    }
                };
                factory.start_until(io, deadline).await
            })
            .catch_unwind()
            .await;

            match started {
                Ok(Ok(plane)) => {
                    if plane.identity() != &worker_identity {
                        let mut owner = ProductDataPlaneRecoveryOwner::from(plane);
                        let cleanup = cleanup_recovery_owner(&mut owner, cleanup_timeout).await;
                        if cleanup.is_empty() {
                            recovery.clear(worker_identity.generation);
                        } else {
                            recovery.retain(
                                worker_identity.clone(),
                                "PRODUCT_DATA_PLANE_HANDOFF_IDENTITY_MISMATCH",
                                owner,
                            );
                        }
                        let _ = sender.send(Err(ProductDataPlaneError::invalid(
                            "PRODUCT_DATA_PLANE_HANDOFF_IDENTITY_MISMATCH",
                            "ready product data plane changed its reserved identity",
                        )));
                        return;
                    }
                    let handoff = ProductStartupHandoff {
                        owner: Some(plane),
                        identity: worker_identity,
                        cleanup_timeout,
                        recovery,
                    };
                    let _ = sender.send(Ok(handoff));
                }
                Ok(Err(mut error)) => {
                    if let Some(owner) = error.take_recovery_owner() {
                        let fault = error.code();
                        recovery.retain(worker_identity, fault, owner);
                    } else {
                        recovery.clear(worker_identity.generation);
                    }
                    let _ = sender.send(Err(error));
                }
                Err(_) => {
                    recovery.uncertain_if_unowned(
                        worker_identity,
                        PRODUCT_DATA_PLANE_START_PANICKED_CODE,
                    );
                    let _ = sender.send(Err(ProductDataPlaneError::invalid(
                        PRODUCT_DATA_PLANE_START_PANICKED_CODE,
                        "product data-plane startup worker panicked",
                    )));
                }
            }
        });

        match receiver.await {
            Ok(Ok(handoff)) => Ok(handoff.into_owner()),
            Ok(Err(error)) => Err(error),
            Err(_) => {
                self.recovery
                    .uncertain_if_unowned(identity, PRODUCT_DATA_PLANE_START_CHANNEL_CODE);
                Err(ProductDataPlaneError::invalid(
                    PRODUCT_DATA_PLANE_START_CHANNEL_CODE,
                    "product data-plane startup worker closed its handoff channel",
                ))
            }
        }
    }

    pub async fn recover_generation_until(
        &self,
        generation: u64,
        deadline: Instant,
    ) -> Result<(), ProductDataPlaneError> {
        if self.recovery.status(generation).is_none() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(ProductDataPlaneError::invalid(
                PRODUCT_DATA_PLANE_START_TIMEOUT_CODE,
                "product data-plane recovery missed its deadline",
            ));
        }
        let Some((identity, owner)) = self.recovery.take_retained(generation)? else {
            return Ok(());
        };
        let mut guard = ProductRecoveryOwnerGuard {
            owner: Some(owner),
            identity,
            fault_code: PRODUCT_DATA_PLANE_START_TIMEOUT_CODE,
            recovery: Arc::clone(&self.recovery),
        };
        guard.owner().request_stop();
        loop {
            match guard.owner_mut().stop_until(deadline).await {
                Ok(_) => {
                    self.recovery.clear(generation);
                    guard.disarm();
                    return Ok(());
                }
                Err(error) => {
                    guard.fault_code = error.code();
                    if Instant::now() >= deadline {
                        return Err(error);
                    }
                    // Individual packet/provider owners retain their own
                    // bounded attempt budget. Recovery owns the larger
                    // lifecycle deadline and must keep retrying until either
                    // cleanup proof arrives or that absolute budget expires.
                    let retry_at = (Instant::now() + Duration::from_millis(1)).min(deadline);
                    tokio::time::sleep_until(retry_at).await;
                }
            }
        }
    }
}

impl fmt::Debug for ProductDataPlaneSupervisor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProductDataPlaneSupervisor")
            .field("provider", &"<injected exact PacketStackProvider>")
            .finish_non_exhaustive()
    }
}

struct ProductStartupHandoff {
    owner: Option<ReadyProductDataPlane>,
    identity: ProductDataPlaneIdentity,
    cleanup_timeout: Duration,
    recovery: Arc<ProductRecoveryRegistry>,
}

impl ProductStartupHandoff {
    fn into_owner(mut self) -> ReadyProductDataPlane {
        self.recovery.clear(self.identity.generation);
        self.owner
            .take()
            .expect("product startup handoff owns the ready data plane")
    }
}

impl Drop for ProductStartupHandoff {
    fn drop(&mut self) {
        let Some(owner) = self.owner.take() else {
            return;
        };
        schedule_product_cancelled_cleanup(
            owner,
            self.identity.clone(),
            self.cleanup_timeout,
            Arc::clone(&self.recovery),
        );
    }
}

struct ProductRecoveryOwnerGuard {
    owner: Option<ProductDataPlaneRecoveryOwner>,
    identity: ProductDataPlaneIdentity,
    fault_code: &'static str,
    recovery: Arc<ProductRecoveryRegistry>,
}

impl ProductRecoveryOwnerGuard {
    fn owner(&self) -> &ProductDataPlaneRecoveryOwner {
        self.owner
            .as_ref()
            .expect("recovery guard owns product data plane")
    }

    fn owner_mut(&mut self) -> &mut ProductDataPlaneRecoveryOwner {
        self.owner
            .as_mut()
            .expect("recovery guard owns product data plane")
    }

    fn disarm(&mut self) {
        self.owner.take();
    }
}

impl Drop for ProductRecoveryOwnerGuard {
    fn drop(&mut self) {
        let Some(owner) = self.owner.take() else {
            return;
        };
        owner.request_stop();
        self.recovery
            .retain(self.identity.clone(), self.fault_code, owner);
    }
}

/// The only shared constructor that joins a packet provider to FlowRuntime.
///
/// It is deliberately single-use: `start_until` consumes the factory and the
/// non-cloneable [`PacketStackIo`]. There is no built-in or fallback provider.
struct ProductDataPlaneFactory {
    config: ProductDataPlaneConfig,
    packet_stack: PacketStackSupervisor,
    flow_runtime: Arc<FlowRuntime>,
}

impl ProductDataPlaneFactory {
    fn new(
        config: ProductDataPlaneConfig,
        profiles: Vec<ProfileRuntime>,
        provider: Arc<dyn PacketStackProvider>,
    ) -> Result<Self, ProductDataPlaneError> {
        config.validate()?;
        let packet_stack = PacketStackSupervisor::new(
            config.packet_stack.clone(),
            config.ip_stack.clone(),
            provider,
        )
        .map_err(ProductDataPlaneError::PacketStack)?;
        let flow_runtime = Arc::new(
            FlowRuntime::new(config.flow_runtime, profiles)
                .map_err(ProductDataPlaneError::FlowRuntime)?,
        );
        Ok(Self {
            config,
            packet_stack,
            flow_runtime,
        })
    }

    async fn start_until(
        self,
        io: PacketStackIo,
        deadline: Instant,
    ) -> Result<ReadyProductDataPlane, ProductDataPlaneError> {
        let packet_queue = io.identity();
        let cleanup_timeout = self.config.cleanup_timeout();
        let ready_stack = match self.packet_stack.start_until(io, deadline).await {
            Ok(stack) => stack,
            Err(mut error) => {
                let primary = error.code();
                let starting_stack = error.take_recovery_owner();
                let owner = ProductDataPlaneRecoveryOwner::starting(
                    starting_stack,
                    Arc::clone(&self.flow_runtime),
                    cleanup_timeout,
                );
                let failure =
                    rollback_recovery_owner_failure(owner, primary, cleanup_timeout).await;
                if matches!(
                    &failure,
                    ProductDataPlaneError::StartupFailed {
                        cleanup,
                        recovery_owner: None,
                        ..
                    } if cleanup.is_empty()
                ) {
                    return Err(ProductDataPlaneError::PacketStack(
                        error.into_unowned_error(),
                    ));
                }
                return Err(failure);
            }
        };
        let identity = ProductDataPlaneIdentity {
            generation: self.config.packet_stack.identity.generation,
            config_revision: self.config.packet_stack.identity.config_revision,
            platform: self.config.packet_stack.identity.platform,
            provider: self.config.packet_stack.identity.provider.clone(),
            packet_queue,
        };
        if ready_stack.health() != PacketStackHealth::Ready {
            return Err(startup_failure(
                identity,
                ready_stack,
                Arc::clone(&self.flow_runtime),
                None,
                PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE,
                cleanup_timeout,
            )
            .await);
        }

        let mut ready_stack = ready_stack;
        let flow_ingress = match ready_stack.take_flow_ingress() {
            Ok(ingress) => ingress,
            Err(error) => {
                let primary = error.code();
                return Err(startup_failure(
                    identity,
                    ready_stack,
                    Arc::clone(&self.flow_runtime),
                    None,
                    primary,
                    cleanup_timeout,
                )
                .await);
            }
        };
        let udp_flow_ingress = match ready_stack.take_udp_flow_ingress() {
            Ok(ingress) => ingress,
            Err(error) => {
                let primary = error.code();
                return Err(startup_failure(
                    identity,
                    ready_stack,
                    Arc::clone(&self.flow_runtime),
                    None,
                    primary,
                    cleanup_timeout,
                )
                .await);
            }
        };
        let (runtime_ready_sender, mut runtime_ready_receiver) = oneshot::channel();
        let runtime_ingress = Arc::new(RuntimeReadyIngress {
            tcp: flow_ingress,
            udp: udp_flow_ingress,
            ready: Mutex::new(Some(runtime_ready_sender)),
            polled: AtomicU8::new(0),
        });
        let tcp_ingress: Arc<dyn FlowIngress> = runtime_ingress.clone();
        let udp_ingress: Arc<dyn UdpFlowIngress> = runtime_ingress;
        let runtime_handle = match self.flow_runtime.start_with_udp(tcp_ingress, udp_ingress) {
            Ok(handle) => handle,
            Err(error) => {
                let primary = flow_runtime_error_code(&error.error());
                return Err(startup_failure(
                    identity,
                    ready_stack,
                    Arc::clone(&self.flow_runtime),
                    None,
                    primary,
                    cleanup_timeout,
                )
                .await);
            }
        };
        let runtime_task = tokio::spawn(async move { runtime_handle.wait().await });
        let mut plane = ReadyProductDataPlane {
            identity,
            packet_stack: Some(ready_stack),
            flow_runtime: Arc::clone(&self.flow_runtime),
            runtime_task: Some(runtime_task),
            stopping: AtomicBool::new(false),
            stop_phase: AtomicU8::new(PRODUCT_STOP_RUNNING),
            stopped: false,
            faults: ProductDataPlaneFaults::default(),
            cleanup_faults: ProductDataPlaneFaults::default(),
            owner_cleanup_pending: false,
            emergency_timeout: cleanup_timeout,
        };

        enum RuntimeStartup {
            Ready(Result<(), oneshot::error::RecvError>),
            Exited(Result<Result<FlowRuntimeSnapshot, FlowRuntimeError>, JoinError>),
            TimedOut,
        }
        let startup = {
            let runtime_task = plane
                .runtime_task
                .as_mut()
                .expect("runtime task inserted before readiness");
            tokio::select! {
                biased;
                result = runtime_task => RuntimeStartup::Exited(result),
                result = &mut runtime_ready_receiver => RuntimeStartup::Ready(result),
                _ = tokio::time::sleep_until(deadline) => RuntimeStartup::TimedOut,
            }
        };

        let primary = match startup {
            RuntimeStartup::Ready(Ok(())) => {
                tokio::task::yield_now().await;
                if plane
                    .runtime_task
                    .as_ref()
                    .is_none_or(JoinHandle::is_finished)
                    || plane.flow_runtime.lifecycle() != FlowRuntimeLifecycle::Running
                {
                    Some(PRODUCT_DATA_PLANE_RUNTIME_EXIT_CODE)
                } else if plane
                    .packet_stack
                    .as_ref()
                    .is_none_or(|stack| stack.health() != PacketStackHealth::Ready)
                {
                    Some(PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE)
                } else if Instant::now() >= deadline {
                    Some(PRODUCT_DATA_PLANE_START_TIMEOUT_CODE)
                } else {
                    None
                }
            }
            RuntimeStartup::Ready(Err(_)) => Some(PRODUCT_DATA_PLANE_RUNTIME_READY_CHANNEL_CODE),
            RuntimeStartup::Exited(result) => {
                plane.runtime_task.take();
                Some(runtime_startup_result_code(&result))
            }
            RuntimeStartup::TimedOut => Some(PRODUCT_DATA_PLANE_START_TIMEOUT_CODE),
        };
        if let Some(primary) = primary {
            return Err(rollback_startup_failure(plane, primary).await);
        }
        Ok(plane)
    }
}

impl fmt::Debug for ProductDataPlaneFactory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProductDataPlaneFactory")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

type RuntimeTaskResult = Result<FlowRuntimeSnapshot, FlowRuntimeError>;

const PRODUCT_STOP_RUNNING: u8 = 0;
const PRODUCT_STOP_QUIESCING: u8 = 1;
const PRODUCT_STOP_RUNTIME_DRAINING: u8 = 2;
const PRODUCT_STOP_RUNTIME_CLEANUP: u8 = 3;
const PRODUCT_STOP_STACK_STOPPING: u8 = 4;
const PRODUCT_STOP_STOPPED: u8 = 5;

/// Owned, retryable product data plane. Explicit `stop_until` is required for
/// cleanup proof; Drop only provides bounded emergency containment.
pub struct ReadyProductDataPlane {
    identity: ProductDataPlaneIdentity,
    packet_stack: Option<ReadyPacketStack>,
    flow_runtime: Arc<FlowRuntime>,
    runtime_task: Option<JoinHandle<RuntimeTaskResult>>,
    stopping: AtomicBool,
    /// Monotonic explicit-stop phase. A timeout leaves this exact phase and all
    /// owners in place so the next `stop_until` resumes rather than restarting
    /// or prematurely terminating the provider control actor.
    stop_phase: AtomicU8,
    stopped: bool,
    /// First runtime/root-cause faults survive successful cleanup for
    /// diagnostics. They never substitute for the current ownership proof.
    faults: ProductDataPlaneFaults,
    /// Failures from the most recent cleanup attempt only. A later retry may
    /// clear these after every join handle and stack owner is recovered.
    cleanup_faults: ProductDataPlaneFaults,
    /// The supervisor no longer has a join handle, but one or more live
    /// profile owners still require an explicit retryable shutdown attempt.
    owner_cleanup_pending: bool,
    emergency_timeout: Duration,
}

impl ReadyProductDataPlane {
    pub fn identity(&self) -> &ProductDataPlaneIdentity {
        &self.identity
    }

    pub fn snapshot(&self) -> FlowRuntimeSnapshot {
        self.flow_runtime.snapshot()
    }

    /// Runtime root causes retained independently from cleanup success.
    pub fn terminal_faults(&self) -> ProductDataPlaneFaults {
        self.faults
    }

    /// Synchronously revoke product readiness and fence packet admission.
    /// FlowRuntime and final provider termination are deliberately deferred
    /// until the asynchronous quiesce acknowledgement proves the control actor
    /// is still alive and no new TCP/UDP admission can arrive.
    pub fn request_stop(&self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.stop_phase.compare_exchange(
            PRODUCT_STOP_RUNNING,
            PRODUCT_STOP_QUIESCING,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        if let Some(stack) = self.packet_stack.as_ref() {
            stack.request_quiesce();
        }
    }

    pub fn health(&self, native: NativePacketPlaneHealth) -> ProductDataPlaneHealth {
        if self.stopped {
            return ProductDataPlaneHealth::Stopped;
        }
        let stopping = self.stopping.load(Ordering::Acquire);
        let mut faults = self.faults;
        match self.packet_stack.as_ref().map(ReadyPacketStack::health) {
            Some(PacketStackHealth::Failed) => {
                faults.packet_stack = Some(PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE);
            }
            Some(
                PacketStackHealth::Quiescing
                | PacketStackHealth::Quiesced
                | PacketStackHealth::Stopping,
            ) if !stopping => {
                faults.packet_stack = Some(PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE);
            }
            Some(PacketStackHealth::Stopped) if !stopping => {
                faults.packet_stack = Some(PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE);
            }
            None if !stopping => {
                faults.packet_stack = Some(PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE);
            }
            _ => {}
        }
        if !stopping
            && (self
                .runtime_task
                .as_ref()
                .is_none_or(JoinHandle::is_finished)
                || self.flow_runtime.lifecycle() != FlowRuntimeLifecycle::Running)
        {
            faults.flow_runtime = Some(PRODUCT_DATA_PLANE_RUNTIME_EXIT_CODE);
        }
        match native {
            NativePacketPlaneHealth::Ready => {}
            NativePacketPlaneHealth::Failed => {
                faults.native = Some(PRODUCT_DATA_PLANE_NATIVE_FAILED_CODE);
            }
            NativePacketPlaneHealth::Stopped if !stopping => {
                faults.native = Some(PRODUCT_DATA_PLANE_NATIVE_STOPPED_CODE);
            }
            NativePacketPlaneHealth::Stopped => {}
        }
        if !faults.is_empty() {
            ProductDataPlaneHealth::Failed(faults)
        } else if stopping {
            ProductDataPlaneHealth::Stopping
        } else {
            ProductDataPlaneHealth::Ready
        }
    }

    pub fn ensure_healthy(
        &self,
        native: NativePacketPlaneHealth,
    ) -> Result<(), ProductDataPlaneError> {
        match self.health(native) {
            ProductDataPlaneHealth::Ready => Ok(()),
            ProductDataPlaneHealth::Failed(faults) => {
                Err(ProductDataPlaneError::Unhealthy { faults })
            }
            ProductDataPlaneHealth::Stopping | ProductDataPlaneHealth::Stopped => {
                Err(ProductDataPlaneError::Unhealthy {
                    faults: ProductDataPlaneFaults {
                        packet_stack: Some(PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE),
                        flow_runtime: Some(PRODUCT_DATA_PLANE_RUNTIME_EXIT_CODE),
                        native: Some(PRODUCT_DATA_PLANE_NATIVE_STOPPED_CODE),
                    },
                })
            }
        }
    }

    pub async fn stop_until(
        &mut self,
        deadline: Instant,
    ) -> Result<FlowRuntimeSnapshot, ProductDataPlaneError> {
        if self.stopped {
            return Ok(self.flow_runtime.snapshot());
        }
        self.request_stop();
        self.cleanup_faults = ProductDataPlaneFaults::default();
        let mut snapshot = self.flow_runtime.snapshot();

        if self.stop_phase.load(Ordering::Acquire) <= PRODUCT_STOP_QUIESCING {
            match quiesce_packet_stack(&mut self.packet_stack, deadline).await {
                Ok(()) => {
                    self.stop_phase
                        .store(PRODUCT_STOP_RUNTIME_DRAINING, Ordering::Release);
                }
                Err(code) => {
                    self.cleanup_faults.packet_stack = Some(code);
                    self.faults.packet_stack = merge_terminal_fault(
                        self.faults.packet_stack,
                        Some(code),
                        PACKET_STACK_QUIESCE_TIMEOUT_CODE,
                    );
                    if code == PACKET_STACK_QUIESCE_TIMEOUT_CODE {
                        return Err(ProductDataPlaneError::StopFailed {
                            faults: self.cleanup_faults,
                        });
                    }
                    // A terminal driver failure has already ended its actor and
                    // closed ingress. Continue runtime cleanup while retaining
                    // the first stack root cause; there is no live final token
                    // to send in this branch.
                    self.stop_phase
                        .store(PRODUCT_STOP_RUNTIME_DRAINING, Ordering::Release);
                }
            }
        }

        if self.stop_phase.load(Ordering::Acquire) == PRODUCT_STOP_RUNTIME_DRAINING {
            let runtime_error = match stop_flow_runtime(&mut self.runtime_task, deadline).await {
                Ok(Some(completed)) => {
                    snapshot = completed;
                    None
                }
                Ok(None) => None,
                Err(code) => Some(code),
            };
            if runtime_error == Some(PRODUCT_DATA_PLANE_RUNTIME_SHUTDOWN_TIMEOUT_CODE) {
                self.cleanup_faults.flow_runtime = runtime_error;
                return Err(ProductDataPlaneError::StopFailed {
                    faults: self.cleanup_faults,
                });
            }
            if self.flow_runtime.has_pending_cleanup()
                || runtime_error == Some(PRODUCT_DATA_PLANE_RUNTIME_JOIN_CODE)
            {
                self.owner_cleanup_pending = true;
            }
            self.faults.flow_runtime = match runtime_error {
                Some(FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED_CODE) => self.faults.flow_runtime,
                Some(code) => Some(code),
                None => self.faults.flow_runtime,
            };
            self.cleanup_faults.flow_runtime = runtime_error;
            self.stop_phase
                .store(PRODUCT_STOP_RUNTIME_CLEANUP, Ordering::Release);
        }

        if self.stop_phase.load(Ordering::Acquire) == PRODUCT_STOP_RUNTIME_CLEANUP {
            let cleanup_required =
                self.owner_cleanup_pending || self.flow_runtime.has_pending_cleanup();
            if cleanup_required {
                match retry_flow_runtime_owners(Arc::clone(&self.flow_runtime), true, deadline)
                    .await
                {
                    Ok(()) => self.owner_cleanup_pending = false,
                    Err(code) => {
                        self.owner_cleanup_pending = true;
                        self.cleanup_faults.flow_runtime = Some(code);
                        return Err(ProductDataPlaneError::StopFailed {
                            faults: self.cleanup_faults,
                        });
                    }
                }
            } else {
                self.owner_cleanup_pending = false;
            }
            self.stop_phase
                .store(PRODUCT_STOP_STACK_STOPPING, Ordering::Release);
        }

        if self.stop_phase.load(Ordering::Acquire) == PRODUCT_STOP_STACK_STOPPING {
            let stack_error = stop_packet_stack(&mut self.packet_stack, deadline)
                .await
                .err();
            self.faults.packet_stack = merge_terminal_fault(
                self.faults.packet_stack,
                stack_error,
                PACKET_STACK_SHUTDOWN_TIMEOUT_CODE,
            );
            if let Some(code) = stack_error {
                self.cleanup_faults.packet_stack = Some(code);
            }
        }

        if !self.cleanup_faults.is_empty() {
            return Err(ProductDataPlaneError::StopFailed {
                faults: self.cleanup_faults,
            });
        }
        self.stopped = true;
        self.stop_phase
            .store(PRODUCT_STOP_STOPPED, Ordering::Release);
        Ok(snapshot)
    }

    async fn rollback_until(&mut self, deadline: Instant) -> ProductDataPlaneFaults {
        match self.stop_until(deadline).await {
            Ok(_) => ProductDataPlaneFaults::default(),
            Err(ProductDataPlaneError::StopFailed { faults }) => faults,
            Err(_) => ProductDataPlaneFaults {
                packet_stack: Some(PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE),
                flow_runtime: Some(PRODUCT_DATA_PLANE_RUNTIME_JOIN_CODE),
                native: None,
            },
        }
    }
}

impl fmt::Debug for ReadyProductDataPlane {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReadyProductDataPlane")
            .field("identity", &self.identity)
            .field("health", &self.health(NativePacketPlaneHealth::Ready))
            .finish_non_exhaustive()
    }
}

impl Drop for ReadyProductDataPlane {
    fn drop(&mut self) {
        if self.stopped
            || (self.packet_stack.is_none()
                && self.runtime_task.is_none()
                && !self.owner_cleanup_pending
                && !self.flow_runtime.has_pending_cleanup())
        {
            return;
        }
        self.request_stop();
        // Emergency containment cannot provide the ordered ownership proof of
        // explicit `stop_until`: this direct runtime cancellation and the
        // detached bounded task below remain a production blocker. The normal
        // path never reaches final stack termination before runtime cleanup.
        self.flow_runtime.cancel();
        spawn_emergency_cleanup(
            self.packet_stack.take(),
            self.runtime_task.take(),
            Arc::clone(&self.flow_runtime),
            self.owner_cleanup_pending || self.flow_runtime.has_pending_cleanup(),
            self.emergency_timeout,
        );
    }
}

/// Retryable owner returned by every product startup path that spawned work
/// without obtaining cleanup proof. It covers both a pre-ready packet driver
/// and the fully composed packet/flow plane behind one type.
pub struct ProductDataPlaneRecoveryOwner {
    inner: ProductRecoveryInner,
}

enum ProductRecoveryInner {
    Profiles(ProfileOwnerRecovery),
    Starting(StartingProductDataPlane),
    Ready(ReadyProductDataPlane),
}

struct ProfileOwnerRecovery {
    owners: Vec<Arc<dyn FlowRuntimeOwner>>,
    stopped: bool,
    emergency_timeout: Duration,
}

struct StartingProductDataPlane {
    packet_stack: Option<StartingPacketStack>,
    flow_runtime: Arc<FlowRuntime>,
    faults: ProductDataPlaneFaults,
    cleanup_faults: ProductDataPlaneFaults,
    stopped: bool,
    emergency_timeout: Duration,
}

impl ProductDataPlaneRecoveryOwner {
    fn profiles(profiles: &[ProfileRuntime], emergency_timeout: Duration) -> Self {
        let mut owners: Vec<Arc<dyn FlowRuntimeOwner>> = Vec::new();
        for owner in profiles.iter().filter_map(ProfileRuntime::owner) {
            if !owners
                .iter()
                .any(|candidate| Arc::ptr_eq(candidate, &owner))
            {
                owners.push(owner);
            }
        }
        Self {
            inner: ProductRecoveryInner::Profiles(ProfileOwnerRecovery {
                owners,
                stopped: false,
                emergency_timeout,
            }),
        }
    }

    fn mark_transferred(&mut self) {
        if let ProductRecoveryInner::Profiles(owner) = &mut self.inner {
            owner.stopped = true;
            owner.owners.clear();
        }
    }

    fn starting(
        packet_stack: Option<StartingPacketStack>,
        flow_runtime: Arc<FlowRuntime>,
        emergency_timeout: Duration,
    ) -> Self {
        Self {
            inner: ProductRecoveryInner::Starting(StartingProductDataPlane {
                packet_stack,
                flow_runtime,
                faults: ProductDataPlaneFaults::default(),
                cleanup_faults: ProductDataPlaneFaults::default(),
                stopped: false,
                emergency_timeout,
            }),
        }
    }

    pub fn request_stop(&self) {
        match &self.inner {
            ProductRecoveryInner::Profiles(_) => {}
            ProductRecoveryInner::Starting(owner) => {
                if let Some(stack) = owner.packet_stack.as_ref() {
                    stack.request_stop();
                }
                owner.flow_runtime.cancel();
            }
            ProductRecoveryInner::Ready(owner) => owner.request_stop(),
        }
    }

    pub fn terminal_faults(&self) -> ProductDataPlaneFaults {
        match &self.inner {
            ProductRecoveryInner::Profiles(_) => ProductDataPlaneFaults::default(),
            ProductRecoveryInner::Starting(owner) => owner.faults,
            ProductRecoveryInner::Ready(owner) => owner.terminal_faults(),
        }
    }

    pub async fn stop_until(
        &mut self,
        deadline: Instant,
    ) -> Result<FlowRuntimeSnapshot, ProductDataPlaneError> {
        match &mut self.inner {
            ProductRecoveryInner::Profiles(owner) => owner.stop_until(deadline).await,
            ProductRecoveryInner::Starting(owner) => owner.stop_until(deadline).await,
            ProductRecoveryInner::Ready(owner) => owner.stop_until(deadline).await,
        }
    }
}

impl From<ReadyProductDataPlane> for ProductDataPlaneRecoveryOwner {
    fn from(owner: ReadyProductDataPlane) -> Self {
        Self {
            inner: ProductRecoveryInner::Ready(owner),
        }
    }
}

impl fmt::Debug for ProductDataPlaneRecoveryOwner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.inner {
            ProductRecoveryInner::Profiles(owner) => formatter
                .debug_struct("ProductDataPlaneRecoveryOwner")
                .field("phase", &"profile_owners")
                .field("pending_owner_count", &owner.owners.len())
                .finish(),
            ProductRecoveryInner::Starting(owner) => formatter
                .debug_struct("ProductDataPlaneRecoveryOwner")
                .field("phase", &"packet_stack_starting")
                .field("faults", &owner.faults)
                .finish(),
            ProductRecoveryInner::Ready(owner) => formatter
                .debug_tuple("ProductDataPlaneRecoveryOwner")
                .field(owner)
                .finish(),
        }
    }
}

impl ProfileOwnerRecovery {
    async fn stop_until(
        &mut self,
        deadline: Instant,
    ) -> Result<FlowRuntimeSnapshot, ProductDataPlaneError> {
        if self.stopped {
            return Ok(FlowRuntimeSnapshot::default());
        }
        let mut shutdowns: FuturesUnordered<BoxFuture<'static, (Arc<dyn FlowRuntimeOwner>, bool)>> =
            FuturesUnordered::new();
        for owner in &self.owners {
            let owner = Arc::clone(owner);
            shutdowns.push(
                async move {
                    let succeeded = AssertUnwindSafe(owner.shutdown())
                        .catch_unwind()
                        .await
                        .is_ok_and(|result| result.is_ok());
                    (owner, succeeded)
                }
                .boxed(),
            );
        }
        while !shutdowns.is_empty() && Instant::now() < deadline {
            match tokio::time::timeout_at(deadline, shutdowns.next()).await {
                Ok(Some((owner, true))) => {
                    self.owners
                        .retain(|candidate| !Arc::ptr_eq(candidate, &owner));
                }
                Ok(Some((_owner, false))) => {}
                Ok(None) | Err(_) => break,
            }
        }
        if self.owners.is_empty() {
            self.stopped = true;
            Ok(FlowRuntimeSnapshot::default())
        } else {
            Err(ProductDataPlaneError::StopFailed {
                faults: ProductDataPlaneFaults {
                    packet_stack: None,
                    flow_runtime: Some(FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED_CODE),
                    native: None,
                },
            })
        }
    }
}

impl Drop for ProfileOwnerRecovery {
    fn drop(&mut self) {
        if self.stopped || self.owners.is_empty() {
            return;
        }
        let owners = std::mem::take(&mut self.owners);
        spawn_profile_owner_emergency_cleanup(owners, self.emergency_timeout);
    }
}

impl StartingProductDataPlane {
    async fn stop_until(
        &mut self,
        deadline: Instant,
    ) -> Result<FlowRuntimeSnapshot, ProductDataPlaneError> {
        if self.stopped {
            return Ok(self.flow_runtime.snapshot());
        }
        if let Some(stack) = self.packet_stack.as_ref() {
            stack.request_stop();
        }
        let (stack_result, owner_result) = tokio::join!(
            stop_starting_packet_stack(&mut self.packet_stack, deadline),
            self.flow_runtime.cancel_unstarted_until(deadline),
        );
        let stack_error = stack_result.err();
        self.cleanup_faults.packet_stack = stack_error;
        self.faults.packet_stack = merge_terminal_fault(
            self.faults.packet_stack,
            stack_error,
            PACKET_STACK_SHUTDOWN_TIMEOUT_CODE,
        );
        let owner_error = owner_result
            .err()
            .map(|_| FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED_CODE);
        self.cleanup_faults.flow_runtime = owner_error;
        self.faults.flow_runtime = merge_terminal_fault(
            self.faults.flow_runtime,
            owner_error,
            FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED_CODE,
        );
        if !self.cleanup_faults.is_empty() {
            return Err(ProductDataPlaneError::StopFailed {
                faults: self.cleanup_faults,
            });
        }
        self.stopped = true;
        Ok(self.flow_runtime.snapshot())
    }
}

impl Drop for StartingProductDataPlane {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        if let Some(stack) = self.packet_stack.as_ref() {
            stack.request_stop();
        }
        self.flow_runtime.cancel();
        spawn_starting_emergency_cleanup(
            self.packet_stack.take(),
            Arc::clone(&self.flow_runtime),
            self.emergency_timeout,
        );
    }
}

/// Readiness is sent only after the runtime polls both transport admissions, so
/// successful composition start proves neither independently bounded queue is
/// orphaned. The wrapper and receivers are never exposed from the factory.
struct RuntimeReadyIngress {
    tcp: Arc<BoundedFlowIngress>,
    udp: Arc<BoundedUdpFlowIngress>,
    ready: Mutex<Option<oneshot::Sender<()>>>,
    polled: AtomicU8,
}

impl RuntimeReadyIngress {
    fn mark_polled(&self, bit: u8) {
        let previous = self.polled.fetch_or(bit, Ordering::AcqRel);
        if previous | bit != 0b11 {
            return;
        }
        if let Some(ready) = self
            .ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = ready.send(());
        }
    }
}

#[async_trait]
impl FlowIngress for RuntimeReadyIngress {
    fn max_buffered_tcp(&self) -> usize {
        self.tcp.max_buffered_tcp()
    }

    async fn close_tcp_admission(&self) -> Result<(), IngressError> {
        self.tcp.close_tcp_admission().await
    }

    async fn accept_tcp(&self) -> Result<Option<IngressTcpFlow>, IngressError> {
        self.mark_polled(0b01);
        self.tcp.accept_tcp().await
    }
}

#[async_trait]
impl UdpFlowIngress for RuntimeReadyIngress {
    fn max_buffered_udp(&self) -> usize {
        self.udp.max_buffered_udp()
    }

    async fn close_udp_admission(&self) -> Result<(), IngressError> {
        self.udp.close_udp_admission().await
    }

    async fn accept_udp(&self) -> Result<Option<IngressUdpAssociation>, IngressError> {
        self.mark_polled(0b10);
        self.udp.accept_udp().await
    }
}

async fn startup_failure(
    identity: ProductDataPlaneIdentity,
    stack: ReadyPacketStack,
    runtime: Arc<FlowRuntime>,
    runtime_task: Option<JoinHandle<RuntimeTaskResult>>,
    primary: &'static str,
    cleanup_timeout: Duration,
) -> ProductDataPlaneError {
    let plane = ReadyProductDataPlane {
        identity,
        packet_stack: Some(stack),
        flow_runtime: runtime,
        runtime_task,
        stopping: AtomicBool::new(false),
        stop_phase: AtomicU8::new(PRODUCT_STOP_RUNNING),
        stopped: false,
        faults: ProductDataPlaneFaults::default(),
        cleanup_faults: ProductDataPlaneFaults::default(),
        owner_cleanup_pending: true,
        emergency_timeout: cleanup_timeout,
    };
    rollback_startup_failure(plane, primary).await
}

async fn rollback_startup_failure(
    mut plane: ReadyProductDataPlane,
    primary: &'static str,
) -> ProductDataPlaneError {
    let cleanup_deadline = Instant::now() + plane.emergency_timeout;
    let cleanup = plane.rollback_until(cleanup_deadline).await;
    let recovery_owner = if cleanup.is_empty() {
        None
    } else {
        Some(Box::new(ProductDataPlaneRecoveryOwner::from(plane)))
    };
    ProductDataPlaneError::StartupFailed {
        primary,
        cleanup,
        recovery_owner,
    }
}

async fn rollback_recovery_owner_failure(
    mut owner: ProductDataPlaneRecoveryOwner,
    primary: &'static str,
    cleanup_timeout: Duration,
) -> ProductDataPlaneError {
    let cleanup_deadline = Instant::now() + cleanup_timeout;
    let cleanup = match owner.stop_until(cleanup_deadline).await {
        Ok(_) => ProductDataPlaneFaults::default(),
        Err(ProductDataPlaneError::StopFailed { faults }) => faults,
        Err(_) => ProductDataPlaneFaults {
            packet_stack: Some(PACKET_STACK_SHUTDOWN_TIMEOUT_CODE),
            flow_runtime: None,
            native: None,
        },
    };
    ProductDataPlaneError::StartupFailed {
        primary,
        cleanup,
        recovery_owner: (!cleanup.is_empty()).then(|| Box::new(owner)),
    }
}

async fn cleanup_recovery_owner(
    owner: &mut ProductDataPlaneRecoveryOwner,
    cleanup_timeout: Duration,
) -> ProductDataPlaneFaults {
    let cleanup_deadline = Instant::now() + cleanup_timeout;
    match owner.stop_until(cleanup_deadline).await {
        Ok(_) => ProductDataPlaneFaults::default(),
        Err(ProductDataPlaneError::StopFailed { faults }) => faults,
        Err(_) => ProductDataPlaneFaults {
            packet_stack: Some(PACKET_STACK_SHUTDOWN_TIMEOUT_CODE),
            flow_runtime: Some(FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED_CODE),
            native: None,
        },
    }
}

fn reserved_identity_matches(
    expected: &ProductDataPlaneIdentity,
    config: &ProductDataPlaneConfig,
    packet_queue: PacketQueueIdentity,
) -> bool {
    expected.generation != 0
        && expected.config_revision != 0
        && expected.platform != CapturePlatform::Unknown
        && expected.packet_queue == packet_queue
        && expected.packet_queue.generation == expected.generation
        && expected.packet_queue.platform == expected.platform
        && expected.source_id() != 0
        && config.packet_stack.identity.generation == expected.generation
        && config.packet_stack.identity.config_revision == expected.config_revision
        && config.packet_stack.identity.platform == expected.platform
        && config.packet_stack.identity.provider == expected.provider
        && config.ip_stack.generation == expected.generation
        && config.ip_stack.platform == expected.platform
        && config.ip_stack.provider == expected.provider
        && config.flow_runtime.generation() == expected.generation
        && config.flow_runtime.config_revision() == expected.config_revision
        && config.flow_runtime.platform() == expected.platform
}

fn merge_terminal_fault(
    previous: Option<&'static str>,
    current: Option<&'static str>,
    retryable: &'static str,
) -> Option<&'static str> {
    match current {
        Some(code) if code != retryable => Some(code),
        _ => previous,
    }
}

async fn quiesce_packet_stack(
    stack: &mut Option<ReadyPacketStack>,
    deadline: Instant,
) -> Result<(), &'static str> {
    let Some(owner) = stack.as_mut() else {
        return Ok(());
    };
    owner.request_quiesce();
    owner
        .quiesce_until(deadline)
        .await
        .map_err(|error| error.code())
}

async fn stop_packet_stack(
    stack: &mut Option<ReadyPacketStack>,
    deadline: Instant,
) -> Result<(), &'static str> {
    let Some(owner) = stack.as_mut() else {
        return Ok(());
    };
    match owner.shutdown_until(deadline).await {
        Ok(PacketStackExit::Cancelled) => {
            stack.take();
            Ok(())
        }
        Err(error) => {
            let code = error.code();
            if !matches!(
                error,
                PacketStackError::ShutdownTimeout | PacketStackError::ShutdownBeforeQuiesce
            ) {
                // A non-timeout final result consumed the driver's JoinHandle.
                // Drop only the now-terminal type-state owner; its root cause
                // is copied into the product terminal-fault record by caller.
                stack.take();
            }
            Err(code)
        }
    }
}

async fn stop_starting_packet_stack(
    stack: &mut Option<StartingPacketStack>,
    deadline: Instant,
) -> Result<(), &'static str> {
    let Some(owner) = stack.as_mut() else {
        return Ok(());
    };
    match owner.shutdown_until(deadline).await {
        Ok(()) => {
            stack.take();
            Ok(())
        }
        Err(error) => Err(error.code()),
    }
}

async fn stop_flow_runtime(
    task: &mut Option<JoinHandle<RuntimeTaskResult>>,
    deadline: Instant,
) -> Result<Option<FlowRuntimeSnapshot>, &'static str> {
    let Some(owner) = task.as_mut() else {
        return Ok(None);
    };
    let result = match tokio::time::timeout_at(deadline, &mut *owner).await {
        Ok(result) => result,
        Err(_) => return Err(PRODUCT_DATA_PLANE_RUNTIME_SHUTDOWN_TIMEOUT_CODE),
    };
    task.take();
    match result {
        Ok(Ok(snapshot)) => Ok(Some(snapshot)),
        Ok(Err(error)) => Err(flow_runtime_error_code(&error)),
        Err(_) => Err(PRODUCT_DATA_PLANE_RUNTIME_JOIN_CODE),
    }
}

async fn retry_flow_runtime_owners(
    runtime: Arc<FlowRuntime>,
    required: bool,
    deadline: Instant,
) -> Result<(), &'static str> {
    if !required {
        return Ok(());
    }
    runtime
        .retry_cleanup_until(deadline)
        .await
        .map_err(|_| FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED_CODE)
}

fn spawn_emergency_cleanup(
    mut stack: Option<ReadyPacketStack>,
    mut runtime_task: Option<JoinHandle<RuntimeTaskResult>>,
    flow_runtime: Arc<FlowRuntime>,
    retry_runtime_cleanup: bool,
    timeout: Duration,
) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        if let Some(task) = runtime_task {
            task.abort();
        }
        drop(stack);
        return;
    };
    runtime.spawn(async move {
        let deadline = Instant::now() + timeout;
        let quiesced = quiesce_packet_stack(&mut stack, deadline).await.is_ok();
        let _ = stop_flow_runtime(&mut runtime_task, deadline).await;
        let cleanup_required = retry_runtime_cleanup || flow_runtime.has_pending_cleanup();
        let runtime_clean =
            retry_flow_runtime_owners(Arc::clone(&flow_runtime), cleanup_required, deadline)
                .await
                .is_ok();
        if quiesced && runtime_task.is_none() && runtime_clean {
            let _ = stop_packet_stack(&mut stack, deadline).await;
        }
        if let Some(task) = runtime_task {
            task.abort();
            let _ = task.await;
        }
        // If the absolute emergency budget expired, dropping a live stack
        // invokes its direct final-termination reaper. That task is detached
        // containment, not production cleanup proof; explicit stop/recovery
        // must retain the owner instead.
        drop(stack);
    });
}

fn schedule_product_cancelled_cleanup(
    mut owner: ReadyProductDataPlane,
    identity: ProductDataPlaneIdentity,
    timeout: Duration,
    recovery: Arc<ProductRecoveryRegistry>,
) {
    owner.request_stop();
    recovery.cancelling(identity.clone(), PRODUCT_DATA_PLANE_START_CANCELLED_CODE);
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        recovery.retain(
            identity,
            "PRODUCT_DATA_PLANE_ASYNC_RUNTIME_UNAVAILABLE",
            owner.into(),
        );
        return;
    };
    runtime.spawn(async move {
        let deadline = Instant::now() + timeout;
        match owner.stop_until(deadline).await {
            Ok(_) => recovery.clear(identity.generation),
            Err(error) => recovery.retain(identity, error.code(), owner.into()),
        }
    });
}

fn spawn_profile_owner_emergency_cleanup(
    owners: Vec<Arc<dyn FlowRuntimeOwner>>,
    timeout: Duration,
) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        drop(owners);
        return;
    };
    runtime.spawn(async move {
        let deadline = Instant::now() + timeout;
        let mut owner = ProfileOwnerRecovery {
            owners,
            stopped: false,
            emergency_timeout: timeout,
        };
        let _ = owner.stop_until(deadline).await;
        // Do not recursively schedule another emergency attempt from this
        // bounded containment task.
        owner.stopped = true;
    });
}

fn spawn_starting_emergency_cleanup(
    mut stack: Option<StartingPacketStack>,
    flow_runtime: Arc<FlowRuntime>,
    timeout: Duration,
) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        drop(stack);
        return;
    };
    runtime.spawn(async move {
        let deadline = Instant::now() + timeout;
        let _ = tokio::join!(
            stop_starting_packet_stack(&mut stack, deadline),
            flow_runtime.cancel_unstarted_until(deadline),
        );
        drop(stack);
    });
}

fn runtime_startup_result_code(
    result: &Result<Result<FlowRuntimeSnapshot, FlowRuntimeError>, JoinError>,
) -> &'static str {
    match result {
        Ok(Ok(_)) => PRODUCT_DATA_PLANE_RUNTIME_EXIT_CODE,
        Ok(Err(error)) => flow_runtime_error_code(error),
        Err(_) => PRODUCT_DATA_PLANE_RUNTIME_JOIN_CODE,
    }
}

fn flow_runtime_error_code(error: &FlowRuntimeError) -> &'static str {
    match error {
        FlowRuntimeError::InvalidConfig => "FLOW_RUNTIME_CONFIG_INVALID",
        FlowRuntimeError::DuplicateProfile => "FLOW_RUNTIME_PROFILE_DUPLICATE",
        FlowRuntimeError::DisabledProfile => "FLOW_RUNTIME_PROFILE_DISABLED",
        FlowRuntimeError::EngineProfileMismatch => "FLOW_RUNTIME_ENGINE_PROFILE_MISMATCH",
        FlowRuntimeError::EngineSnapshotMismatch => "FLOW_RUNTIME_ENGINE_SNAPSHOT_MISMATCH",
        FlowRuntimeError::OwnerRequired => "FLOW_RUNTIME_OWNER_REQUIRED",
        FlowRuntimeError::OwnerBindingMismatch => "FLOW_RUNTIME_OWNER_BINDING_MISMATCH",
        FlowRuntimeError::ProfileSelector(_) => "FLOW_RUNTIME_PROFILE_SELECTOR_INVALID",
        FlowRuntimeError::AlreadyStarted => "FLOW_RUNTIME_ALREADY_STARTED",
        FlowRuntimeError::AsyncRuntimeUnavailable => "FLOW_RUNTIME_ASYNC_RUNTIME_UNAVAILABLE",
        FlowRuntimeError::SupervisorFailed => "FLOW_RUNTIME_SUPERVISOR_FAILED",
        FlowRuntimeError::OwnerShutdownFailed => "FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED",
        FlowRuntimeError::Ingress { .. } => "FLOW_RUNTIME_INGRESS_FAILED",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    use tokio::sync::Notify;

    use super::*;
    use crate::sockscap::capture::packet_device::{
        MIN_PACKET_QUEUE_BYTES, bounded_packet_device_queues,
    };
    use crate::sockscap::flow::attribution::FakeIpMap;
    use crate::sockscap::flow::bypass::HardBypassSet;
    use crate::sockscap::flow::engine::{EgressProvider, FlowEngine, FlowEngineSnapshot};
    use crate::sockscap::flow::ip_stack::{
        ChecksumPolicy, FragmentationPolicy, IcmpBehavior, IpStackProviderCapabilities,
        IpStackProviderResources, Ipv6ExtensionHeaderPolicy, TcpBridgeBudget,
        TcpLifecycleDeadlines, UdpAssociationQueueBudgets, UdpQueueBudget,
        UdpWildcardBindingBudgets,
    };
    use crate::sockscap::flow::packet_stack::{
        PacketStackCapabilities, PacketStackDescriptor, PacketStackDriver,
        PacketStackDriverControl, PacketStackIdentity, PacketStackReady, PacketStackRunContext,
    };
    use crate::sockscap::flow::runtime::{FlowRuntimeOwner, FlowRuntimeOwnerError};
    use crate::sockscap::policy::matcher::ProfileMatcher;
    use crate::sockscap::types::{
        EgressFailureAction, LocalNetworkPolicy, ProfileScope, RouteAction, RoutingProfileDraft,
        UdpPolicy,
    };

    const GENERATION: u64 = 7;
    const REVISION: u64 = 3;

    #[derive(Clone)]
    enum DriverBehavior {
        Wait,
        ObservedWait(Arc<CompositionDriverObservation>),
        DelayQuiesce {
            release: Arc<Notify>,
            observation: Arc<CompositionDriverObservation>,
        },
        FailOnCancel,
        FailAfter(Arc<Notify>),
        DropIngressThenWait,
        DropIngressAndIgnoreCancel(Arc<Notify>),
    }

    struct TestProvider {
        behavior: DriverBehavior,
    }

    struct TestDriver {
        behavior: DriverBehavior,
    }

    struct GatedProvider {
        build_entered: Arc<Notify>,
        build_release: Arc<Notify>,
        stopped: Arc<Notify>,
    }

    struct GatedDriver {
        stopped: Arc<Notify>,
    }

    #[derive(Default)]
    struct CompositionDriverObservation {
        quiesce_requested: AtomicBool,
        quiesced: AtomicBool,
        termination_requested: AtomicBool,
        dropped: AtomicBool,
    }

    struct CompositionDriverDropGuard(Arc<CompositionDriverObservation>);

    impl Drop for CompositionDriverDropGuard {
        fn drop(&mut self) {
            self.0.dropped.store(true, AtomicOrdering::Release);
        }
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
        ) -> Result<Box<dyn PacketStackDriver>, PacketStackError> {
            Ok(Box::new(TestDriver {
                behavior: self.behavior.clone(),
            }))
        }
    }

    #[async_trait]
    impl PacketStackProvider for GatedProvider {
        fn descriptor(&self) -> PacketStackDescriptor {
            PacketStackDescriptor {
                provider: provider_pin(),
                capabilities: capabilities(),
            }
        }

        async fn build(
            &self,
            _config: IpStackConfig,
        ) -> Result<Box<dyn PacketStackDriver>, PacketStackError> {
            self.build_entered.notify_one();
            self.build_release.notified().await;
            Ok(Box::new(GatedDriver {
                stopped: Arc::clone(&self.stopped),
            }))
        }
    }

    async fn quiesce_and_terminate_driver(
        context: PacketStackRunContext,
        control: PacketStackDriverControl,
        tcp_ingress: super::super::ingress::BoundedFlowIngressSender,
        udp_ingress: super::super::ingress::BoundedUdpFlowIngressSender,
        quiesce_release: Option<Arc<Notify>>,
        observation: Option<Arc<CompositionDriverObservation>>,
    ) -> Result<(), PacketStackError> {
        let _drop_guard = observation
            .as_ref()
            .map(|observation| CompositionDriverDropGuard(Arc::clone(observation)));
        control.quiesce_requested().await;
        if let Some(observation) = &observation {
            observation
                .quiesce_requested
                .store(true, AtomicOrdering::Release);
        }
        if let Some(release) = quiesce_release {
            release.notified().await;
        }
        let (native_ingress, native_egress) = context.into_io().into_parts();
        drop(native_ingress);
        drop(tcp_ingress);
        drop(udp_ingress);
        control.acknowledge_quiesced()?;
        if let Some(observation) = &observation {
            observation.quiesced.store(true, AtomicOrdering::Release);
        }
        control.termination_requested().await;
        if let Some(observation) = &observation {
            observation
                .termination_requested
                .store(true, AtomicOrdering::Release);
        }
        drop(native_egress);
        Ok(())
    }

    #[async_trait]
    impl PacketStackDriver for TestDriver {
        fn identity(&self) -> PacketStackIdentity {
            stack_identity()
        }

        async fn run(
            self: Box<Self>,
            context: PacketStackRunContext,
            readiness: oneshot::Sender<PacketStackReady>,
            control: PacketStackDriverControl,
            tcp_ingress: super::super::ingress::BoundedFlowIngressSender,
            udp_ingress: super::super::ingress::BoundedUdpFlowIngressSender,
        ) -> Result<PacketStackExit, PacketStackError> {
            let _ = readiness.send(PacketStackReady {
                identity: stack_identity(),
                capabilities: capabilities(),
            });
            match self.behavior {
                DriverBehavior::Wait => {
                    quiesce_and_terminate_driver(
                        context,
                        control,
                        tcp_ingress,
                        udp_ingress,
                        None,
                        None,
                    )
                    .await?;
                    Ok(PacketStackExit::Cancelled)
                }
                DriverBehavior::ObservedWait(observation) => {
                    quiesce_and_terminate_driver(
                        context,
                        control,
                        tcp_ingress,
                        udp_ingress,
                        None,
                        Some(observation),
                    )
                    .await?;
                    Ok(PacketStackExit::Cancelled)
                }
                DriverBehavior::DelayQuiesce {
                    release,
                    observation,
                } => {
                    quiesce_and_terminate_driver(
                        context,
                        control,
                        tcp_ingress,
                        udp_ingress,
                        Some(release),
                        Some(observation),
                    )
                    .await?;
                    Ok(PacketStackExit::Cancelled)
                }
                DriverBehavior::FailOnCancel => {
                    quiesce_and_terminate_driver(
                        context,
                        control,
                        tcp_ingress,
                        udp_ingress,
                        None,
                        None,
                    )
                    .await?;
                    Err(PacketStackError::provider(
                        "TEST_PACKET_STACK_FAILED",
                        "test failure",
                    ))
                }
                DriverBehavior::FailAfter(release) => {
                    release.notified().await;
                    drop(tcp_ingress);
                    drop(udp_ingress);
                    Err(PacketStackError::provider(
                        "TEST_PACKET_STACK_FAILED",
                        "test failure",
                    ))
                }
                DriverBehavior::DropIngressThenWait => {
                    drop(tcp_ingress);
                    drop(udp_ingress);
                    control.quiesce_requested().await;
                    let (native_ingress, native_egress) = context.into_io().into_parts();
                    drop(native_ingress);
                    control.acknowledge_quiesced()?;
                    control.termination_requested().await;
                    drop(native_egress);
                    Ok(PacketStackExit::Cancelled)
                }
                DriverBehavior::DropIngressAndIgnoreCancel(release) => {
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

    #[async_trait]
    impl PacketStackDriver for GatedDriver {
        fn identity(&self) -> PacketStackIdentity {
            stack_identity()
        }

        async fn run(
            self: Box<Self>,
            context: PacketStackRunContext,
            readiness: oneshot::Sender<PacketStackReady>,
            control: PacketStackDriverControl,
            tcp_ingress: super::super::ingress::BoundedFlowIngressSender,
            udp_ingress: super::super::ingress::BoundedUdpFlowIngressSender,
        ) -> Result<PacketStackExit, PacketStackError> {
            let _ = readiness.send(PacketStackReady {
                identity: stack_identity(),
                capabilities: capabilities(),
            });
            quiesce_and_terminate_driver(context, control, tcp_ingress, udp_ingress, None, None)
                .await?;
            self.stopped.notify_one();
            Ok(PacketStackExit::Cancelled)
        }
    }

    struct BlockingOwner {
        release: Arc<Notify>,
    }

    struct RecordingProductOwner {
        shutdowns: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl FlowRuntimeOwner for BlockingOwner {
        fn binding_id(&self) -> &str {
            "blocking-owner"
        }

        async fn shutdown(&self) -> Result<(), FlowRuntimeOwnerError> {
            self.release.notified().await;
            Ok(())
        }
    }

    #[async_trait]
    impl FlowRuntimeOwner for RecordingProductOwner {
        fn binding_id(&self) -> &str {
            "recording-product-owner"
        }

        async fn shutdown(&self) -> Result<(), FlowRuntimeOwnerError> {
            self.shutdowns
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    fn provider_pin() -> IpStackProviderPin {
        IpStackProviderPin {
            name: "taomni-composition-test-stack".into(),
            version: "0.0.0-test".into(),
            source_sha256: "a".repeat(64),
        }
    }

    fn capabilities() -> super::super::packet_stack::PacketStackCapabilities {
        super::super::packet_stack::PacketStackCapabilities {
            ipv4: true,
            ipv6: true,
            tcp: true,
            udp: true,
            fragment_reassembly: true,
        }
    }

    fn stack_identity() -> PacketStackIdentity {
        PacketStackIdentity {
            generation: GENERATION,
            config_revision: REVISION,
            platform: CapturePlatform::Linux,
            provider: provider_pin(),
        }
    }

    fn product_config() -> ProductDataPlaneConfig {
        let udp_queue = UdpQueueBudget {
            datagrams: 2,
            payload_bytes: 2_400,
            metadata_bytes: 128,
        };
        ProductDataPlaneConfig {
            packet_stack: PacketStackSupervisorConfig {
                identity: stack_identity(),
                required_capabilities: PacketStackCapabilities {
                    ipv4: true,
                    tcp: true,
                    udp: true,
                    ..PacketStackCapabilities::default()
                },
                decoded_tcp_queue_capacity: 8,
                decoded_udp_queue_capacity: 8,
                startup_timeout: Duration::from_millis(100),
                shutdown_timeout: Duration::from_millis(100),
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
                REVISION,
                8,
                Duration::from_millis(100),
            )
            .unwrap(),
        }
    }

    fn profile_parts() -> (RoutingProfileDraft, Arc<FlowEngine>) {
        let profile = RoutingProfileDraft {
            id: "profile-1".into(),
            name: "Profile 1".into(),
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
            FlowEngineSnapshot::from_profile(REVISION, &profile).unwrap(),
            matcher,
            HardBypassSet::default(),
            FakeIpMap::default(),
            EgressProvider::unavailable("unused by composition tests"),
            UdpPolicy::Block,
            EgressFailureAction::FailClosed,
            LocalNetworkPolicy::default(),
        ));
        (profile, engine)
    }

    fn profiles() -> Vec<ProfileRuntime> {
        let (profile, engine) = profile_parts();
        vec![ProfileRuntime::new(profile, engine)]
    }

    fn profiles_with_blocking_owner(release: Arc<Notify>) -> Vec<ProfileRuntime> {
        let (profile, engine) = profile_parts();
        vec![ProfileRuntime::with_owner(
            profile,
            engine,
            Arc::new(BlockingOwner { release }),
        )]
    }

    fn packet_io() -> (
        crate::sockscap::capture::packet_device::NativePacketDeviceQueues,
        PacketStackIo,
    ) {
        let (native, stack) = bounded_packet_device_queues(
            MIN_PACKET_QUEUE_BYTES,
            GENERATION,
            CapturePlatform::Linux,
        )
        .unwrap();
        (
            native,
            PacketStackIo::new(stack.ingress, stack.egress).unwrap(),
        )
    }

    fn product_identity(io: &PacketStackIo) -> ProductDataPlaneIdentity {
        ProductDataPlaneIdentity {
            generation: GENERATION,
            config_revision: REVISION,
            platform: CapturePlatform::Linux,
            provider: provider_pin(),
            packet_queue: io.identity(),
        }
    }

    async fn wait_for_recovery_state(
        supervisor: &ProductDataPlaneSupervisor,
        expected: ProductDataPlaneRecoveryState,
    ) -> ProductDataPlaneRecoveryStatus {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(status) = supervisor.recovery_status(GENERATION)
                    && status.state == expected
                {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("shared recovery state must become observable")
    }

    async fn start_plane(
        behavior: DriverBehavior,
    ) -> (
        ReadyProductDataPlane,
        crate::sockscap::capture::packet_device::NativePacketDeviceQueues,
    ) {
        let factory = ProductDataPlaneFactory::new(
            product_config(),
            profiles(),
            Arc::new(TestProvider { behavior }),
        )
        .unwrap();
        let (native, io) = packet_io();
        let plane = factory
            .start_until(io, Instant::now() + Duration::from_millis(500))
            .await
            .unwrap();
        (plane, native)
    }

    #[test]
    fn factory_rejects_cross_snapshot_composition() {
        let mut config = product_config();
        config.flow_runtime = FlowRuntimeConfig::new(
            CapturePlatform::Linux,
            GENERATION,
            REVISION + 1,
            8,
            Duration::from_millis(100),
        )
        .unwrap();
        let error = ProductDataPlaneFactory::new(
            config,
            profiles(),
            Arc::new(TestProvider {
                behavior: DriverBehavior::Wait,
            }),
        )
        .unwrap_err();
        assert_eq!(error.code(), "PRODUCT_DATA_PLANE_IDENTITY_MISMATCH");
    }

    #[test]
    fn product_config_requires_an_ip_family_and_both_transports() {
        assert!(product_config().validate().is_ok());

        let mut no_ip_family = product_config();
        no_ip_family.packet_stack.required_capabilities.ipv4 = false;
        no_ip_family.packet_stack.required_capabilities.ipv6 = false;
        assert_eq!(
            no_ip_family.validate().unwrap_err().code(),
            "PRODUCT_DATA_PLANE_IP_CAPABILITY_REQUIRED"
        );

        let mut ipv6_only = product_config();
        ipv6_only.packet_stack.required_capabilities.ipv4 = false;
        ipv6_only.packet_stack.required_capabilities.ipv6 = true;
        assert!(ipv6_only.validate().is_ok());

        let mut no_udp = product_config();
        no_udp.packet_stack.required_capabilities.udp = false;
        assert_eq!(
            no_udp.validate().unwrap_err().code(),
            "PRODUCT_DATA_PLANE_UDP_CAPABILITY_REQUIRED"
        );
    }

    #[test]
    fn product_config_bounds_runtime_and_decoded_queues() {
        let mut tcp_queue_at_limit = product_config();
        tcp_queue_at_limit.packet_stack.decoded_tcp_queue_capacity =
            tcp_queue_at_limit.flow_runtime.max_active_flows();
        assert!(tcp_queue_at_limit.validate().is_ok());

        let mut excessive_tcp_queue = product_config();
        excessive_tcp_queue.ip_stack.max_tcp_flows = 16;
        excessive_tcp_queue.packet_stack.decoded_tcp_queue_capacity = 9;
        assert_eq!(
            excessive_tcp_queue.validate().unwrap_err().code(),
            "PRODUCT_DATA_PLANE_TCP_QUEUE_RUNTIME_MISMATCH"
        );

        let mut excessive_runtime = product_config();
        excessive_runtime.flow_runtime = FlowRuntimeConfig::new_with_transport_limits(
            CapturePlatform::Linux,
            GENERATION,
            REVISION,
            8,
            9,
            Duration::from_millis(100),
            Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(
            excessive_runtime.validate().unwrap_err().code(),
            "PRODUCT_DATA_PLANE_UDP_LIMIT_MISMATCH"
        );

        let mut udp_queue_at_limit = product_config();
        udp_queue_at_limit.packet_stack.decoded_udp_queue_capacity = udp_queue_at_limit
            .flow_runtime
            .max_active_udp_associations();
        assert!(udp_queue_at_limit.validate().is_ok());

        let mut excessive_queue = product_config();
        excessive_queue.ip_stack.max_udp_associations = 16;
        excessive_queue.packet_stack.decoded_udp_queue_capacity = 9;
        assert_eq!(
            excessive_queue.validate().unwrap_err().code(),
            "PRODUCT_DATA_PLANE_UDP_QUEUE_RUNTIME_MISMATCH"
        );
    }

    #[test]
    fn product_config_requires_exact_millisecond_udp_idle_timeout() {
        let mut mismatch = product_config();
        mismatch.flow_runtime = FlowRuntimeConfig::new_with_transport_limits(
            CapturePlatform::Linux,
            GENERATION,
            REVISION,
            8,
            8,
            Duration::from_millis(100),
            Duration::from_secs(31),
        )
        .unwrap();
        assert_eq!(
            mismatch.validate().unwrap_err().code(),
            "PRODUCT_DATA_PLANE_UDP_IDLE_TIMEOUT_MISMATCH"
        );

        let mut sub_millisecond = product_config();
        sub_millisecond.flow_runtime = FlowRuntimeConfig::new_with_transport_limits(
            CapturePlatform::Linux,
            GENERATION,
            REVISION,
            8,
            8,
            Duration::from_millis(100),
            Duration::from_secs(30) + Duration::from_nanos(1),
        )
        .unwrap();
        assert_eq!(
            sub_millisecond.validate().unwrap_err().code(),
            "PRODUCT_DATA_PLANE_UDP_IDLE_TIMEOUT_MISMATCH"
        );
    }

    #[tokio::test]
    async fn start_binds_queue_and_runtime_then_stops_both() {
        let (mut plane, _native) = start_plane(DriverBehavior::Wait).await;
        assert_eq!(plane.identity().generation, GENERATION);
        assert_eq!(plane.identity().config_revision, REVISION);
        assert_eq!(plane.identity().platform, CapturePlatform::Linux);
        assert_ne!(plane.identity().source_id(), 0);
        assert_eq!(
            plane.health(NativePacketPlaneHealth::Ready),
            ProductDataPlaneHealth::Ready
        );
        plane
            .stop_until(Instant::now() + Duration::from_millis(500))
            .await
            .unwrap();
        assert_eq!(
            plane.health(NativePacketPlaneHealth::Stopped),
            ProductDataPlaneHealth::Stopped
        );
    }

    #[tokio::test]
    async fn quiesce_timeout_keeps_runtime_and_control_actor_owned_for_retry() {
        let release = Arc::new(Notify::new());
        let observation = Arc::new(CompositionDriverObservation::default());
        let factory = ProductDataPlaneFactory::new(
            product_config(),
            profiles(),
            Arc::new(TestProvider {
                behavior: DriverBehavior::DelayQuiesce {
                    release: Arc::clone(&release),
                    observation: Arc::clone(&observation),
                },
            }),
        )
        .unwrap();
        let (native, io) = packet_io();
        let mut plane = factory
            .start_until(io, Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();

        let error = plane
            .stop_until(Instant::now() + Duration::from_millis(20))
            .await
            .unwrap_err();
        let ProductDataPlaneError::StopFailed { faults } = error else {
            panic!("quiesce timeout must retain the product owner");
        };
        assert_eq!(faults.packet_stack, Some(PACKET_STACK_QUIESCE_TIMEOUT_CODE));
        assert!(observation.quiesce_requested.load(AtomicOrdering::Acquire));
        assert!(!observation.quiesced.load(AtomicOrdering::Acquire));
        assert!(
            !observation
                .termination_requested
                .load(AtomicOrdering::Acquire)
        );
        assert!(!observation.dropped.load(AtomicOrdering::Acquire));
        assert!(!native.capture.is_closed());

        release.notify_one();
        plane
            .stop_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert!(observation.quiesced.load(AtomicOrdering::Acquire));
        assert!(
            observation
                .termination_requested
                .load(AtomicOrdering::Acquire)
        );
        assert!(observation.dropped.load(AtomicOrdering::Acquire));
        assert!(native.capture.is_closed());
    }

    #[tokio::test]
    async fn runtime_drain_timeout_keeps_quiesced_control_actor_alive() {
        let owner_release = Arc::new(Notify::new());
        let observation = Arc::new(CompositionDriverObservation::default());
        let factory = ProductDataPlaneFactory::new(
            product_config(),
            profiles_with_blocking_owner(Arc::clone(&owner_release)),
            Arc::new(TestProvider {
                behavior: DriverBehavior::ObservedWait(Arc::clone(&observation)),
            }),
        )
        .unwrap();
        let (_native, io) = packet_io();
        let mut plane = factory
            .start_until(io, Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();

        let error = plane
            .stop_until(Instant::now() + Duration::from_millis(20))
            .await
            .unwrap_err();
        let ProductDataPlaneError::StopFailed { faults } = error else {
            panic!("runtime drain timeout must retain every owner");
        };
        assert_eq!(
            faults.flow_runtime,
            Some(PRODUCT_DATA_PLANE_RUNTIME_SHUTDOWN_TIMEOUT_CODE)
        );
        assert!(observation.quiesced.load(AtomicOrdering::Acquire));
        assert!(
            !observation
                .termination_requested
                .load(AtomicOrdering::Acquire)
        );
        assert!(!observation.dropped.load(AtomicOrdering::Acquire));

        owner_release.notify_one();
        plane
            .stop_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert!(
            observation
                .termination_requested
                .load(AtomicOrdering::Acquire)
        );
        assert!(observation.dropped.load(AtomicOrdering::Acquire));
    }

    #[tokio::test]
    async fn health_aggregates_stack_runtime_and_native_faults() {
        let release = Arc::new(Notify::new());
        let (mut plane, _native) =
            start_plane(DriverBehavior::FailAfter(Arc::clone(&release))).await;
        release.notify_one();
        for _ in 0..100 {
            if matches!(
                plane.health(NativePacketPlaneHealth::Failed),
                ProductDataPlaneHealth::Failed(ProductDataPlaneFaults {
                    packet_stack: Some(_),
                    flow_runtime: Some(_),
                    native: Some(_),
                })
            ) {
                break;
            }
            tokio::task::yield_now().await;
        }
        let ProductDataPlaneHealth::Failed(faults) = plane.health(NativePacketPlaneHealth::Failed)
        else {
            panic!("combined health must fail");
        };
        assert_eq!(
            faults.packet_stack,
            Some(PRODUCT_DATA_PLANE_STACK_UNHEALTHY_CODE)
        );
        assert_eq!(
            faults.flow_runtime,
            Some(PRODUCT_DATA_PLANE_RUNTIME_EXIT_CODE)
        );
        assert_eq!(faults.native, Some(PRODUCT_DATA_PLANE_NATIVE_FAILED_CODE));
        let error = plane
            .stop_until(Instant::now() + Duration::from_millis(500))
            .await
            .unwrap_err();
        assert_eq!(error.code(), "PRODUCT_DATA_PLANE_STOP_FAILED");
        assert_eq!(
            plane.terminal_faults().packet_stack,
            Some("PACKET_STACK_DRIVER_FAILED")
        );
        plane
            .stop_until(Instant::now() + Duration::from_millis(500))
            .await
            .unwrap();
        assert_eq!(
            plane.terminal_faults().packet_stack,
            Some("PACKET_STACK_DRIVER_FAILED")
        );
    }

    #[tokio::test]
    async fn stop_reports_provider_failure_without_losing_runtime_cleanup() {
        let (mut plane, _native) = start_plane(DriverBehavior::FailOnCancel).await;
        let error = plane
            .stop_until(Instant::now() + Duration::from_millis(500))
            .await
            .unwrap_err();
        let ProductDataPlaneError::StopFailed { faults } = error else {
            panic!("expected aggregate stop failure");
        };
        assert_eq!(faults.packet_stack, Some("PACKET_STACK_DRIVER_FAILED"));
        assert_eq!(faults.flow_runtime, None);

        plane
            .stop_until(Instant::now() + Duration::from_millis(500))
            .await
            .unwrap();
        assert_eq!(
            plane.terminal_faults().packet_stack,
            Some("PACKET_STACK_DRIVER_FAILED")
        );
    }

    #[tokio::test]
    async fn runtime_join_failure_is_retained_after_cleanup_retry_succeeds() {
        let (mut plane, _native) = start_plane(DriverBehavior::Wait).await;
        plane.runtime_task.as_ref().expect("runtime task").abort();
        tokio::task::yield_now().await;

        let error = plane
            .stop_until(Instant::now() + Duration::from_millis(500))
            .await
            .unwrap_err();
        let ProductDataPlaneError::StopFailed { faults } = error else {
            panic!("first join attempt must report the terminal runtime failure");
        };
        assert_eq!(
            faults.flow_runtime,
            Some(PRODUCT_DATA_PLANE_RUNTIME_JOIN_CODE)
        );
        plane
            .stop_until(Instant::now() + Duration::from_millis(500))
            .await
            .unwrap();
        assert_eq!(
            plane.terminal_faults().flow_runtime,
            Some(PRODUCT_DATA_PLANE_RUNTIME_JOIN_CODE)
        );
    }

    #[tokio::test]
    async fn ingress_eof_revokes_readiness_before_blocking_owner_cleanup() {
        let owner_release = Arc::new(Notify::new());
        let factory = ProductDataPlaneFactory::new(
            product_config(),
            profiles_with_blocking_owner(Arc::clone(&owner_release)),
            Arc::new(TestProvider {
                behavior: DriverBehavior::DropIngressThenWait,
            }),
        )
        .unwrap();
        let (_native, io) = packet_io();
        let release = Arc::clone(&owner_release);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            release.notify_one();
        });

        let error = factory
            .start_until(io, Instant::now() + Duration::from_millis(500))
            .await
            .unwrap_err();
        let ProductDataPlaneError::StartupFailed {
            primary, cleanup, ..
        } = error
        else {
            panic!("ingress EOF must revoke readiness during owner cleanup");
        };
        assert_eq!(primary, PRODUCT_DATA_PLANE_RUNTIME_EXIT_CODE);
        assert!(cleanup.is_empty());
    }

    #[tokio::test]
    async fn startup_timeout_returns_explicit_retryable_cleanup_owner() {
        let driver_release = Arc::new(Notify::new());
        let factory = ProductDataPlaneFactory::new(
            product_config(),
            profiles(),
            Arc::new(TestProvider {
                behavior: DriverBehavior::DropIngressAndIgnoreCancel(Arc::clone(&driver_release)),
            }),
        )
        .unwrap();
        let (_native, io) = packet_io();
        let mut error = factory
            .start_until(io, Instant::now() + Duration::from_millis(500))
            .await
            .unwrap_err();
        let ProductDataPlaneError::StartupFailed { cleanup, .. } = &error else {
            panic!("expected startup cleanup failure");
        };
        assert_eq!(
            cleanup.packet_stack,
            Some(PACKET_STACK_QUIESCE_TIMEOUT_CODE)
        );
        let mut recovery = error
            .take_recovery_owner()
            .expect("timed-out owner must be explicitly recoverable");
        driver_release.notify_one();
        recovery
            .stop_until(Instant::now() + Duration::from_millis(500))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn shared_supervisor_owns_start_after_calling_future_is_cancelled() {
        let build_entered = Arc::new(Notify::new());
        let build_release = Arc::new(Notify::new());
        let stopped = Arc::new(Notify::new());
        let supervisor = Arc::new(ProductDataPlaneSupervisor::new(Arc::new(GatedProvider {
            build_entered: Arc::clone(&build_entered),
            build_release: Arc::clone(&build_release),
            stopped: Arc::clone(&stopped),
        })));
        let (_native, io) = packet_io();
        let identity = product_identity(&io);
        let task_supervisor = Arc::clone(&supervisor);
        let task = tokio::spawn(async move {
            task_supervisor
                .start_until(
                    identity,
                    product_config(),
                    profiles(),
                    io,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
        });

        build_entered.notified().await;
        task.abort();
        let _ = task.await;
        assert_eq!(
            supervisor
                .recovery_status(GENERATION)
                .expect("detached startup remains registered")
                .state,
            ProductDataPlaneRecoveryState::Starting
        );
        build_release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), stopped.notified())
            .await
            .expect("cancelled handoff must stop the ready provider");
        tokio::time::timeout(Duration::from_secs(2), async {
            while supervisor.recovery_status(GENERATION).is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("clean cancelled startup must discharge shared ownership");
    }

    #[tokio::test]
    async fn cancelled_shared_recovery_reinserts_exact_owner_for_retry() {
        let driver_release = Arc::new(Notify::new());
        let supervisor = Arc::new(ProductDataPlaneSupervisor::new(Arc::new(TestProvider {
            behavior: DriverBehavior::DropIngressAndIgnoreCancel(Arc::clone(&driver_release)),
        })));
        let (_native, io) = packet_io();
        let identity = product_identity(&io);
        let error = supervisor
            .start_until(
                identity,
                product_config(),
                profiles(),
                io,
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), "PRODUCT_DATA_PLANE_STARTUP_FAILED");
        wait_for_recovery_state(&supervisor, ProductDataPlaneRecoveryState::Retained).await;

        let recovery_supervisor = Arc::clone(&supervisor);
        let recovery = tokio::spawn(async move {
            recovery_supervisor
                .recover_generation_until(GENERATION, Instant::now() + Duration::from_secs(1))
                .await
        });
        wait_for_recovery_state(&supervisor, ProductDataPlaneRecoveryState::Cancelling).await;
        recovery.abort();
        let _ = recovery.await;
        wait_for_recovery_state(&supervisor, ProductDataPlaneRecoveryState::Retained).await;

        driver_release.notify_one();
        supervisor
            .recover_generation_until(GENERATION, Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert!(supervisor.recovery_status(GENERATION).is_none());
    }

    #[tokio::test]
    async fn expired_shared_start_still_shuts_down_transferred_profile_owner() {
        let owner = Arc::new(RecordingProductOwner {
            shutdowns: std::sync::atomic::AtomicUsize::new(0),
        });
        let (profile, engine) = profile_parts();
        let supervisor = ProductDataPlaneSupervisor::new(Arc::new(TestProvider {
            behavior: DriverBehavior::Wait,
        }));
        let (_native, io) = packet_io();
        let identity = product_identity(&io);
        let error = supervisor
            .start_until(
                identity,
                product_config(),
                vec![ProfileRuntime::with_owner(profile, engine, owner.clone())],
                io,
                Instant::now(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), "PACKET_STACK_START_TIMEOUT");
        assert_eq!(owner.shutdowns.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(supervisor.recovery_status(GENERATION).is_none());
    }
}
