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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::stream::FuturesUnordered;
use futures::{FutureExt, StreamExt};
use tokio::sync::oneshot;
use tokio::task::{JoinError, JoinHandle};
use tokio::time::Instant;

use super::ingress::{BoundedFlowIngress, FlowIngress, IngressError, IngressTcpFlow};
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
        if !self.packet_stack.required_capabilities.tcp {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_TCP_CAPABILITY_REQUIRED",
                "decoded-flow composition requires an explicitly required TCP provider",
            ));
        }
        if self.flow_runtime.max_active_flows() > self.ip_stack.max_tcp_flows {
            return Err(ProductDataPlaneError::invalid(
                "PRODUCT_DATA_PLANE_FLOW_LIMIT_MISMATCH",
                "FlowRuntime cannot admit more TCP flows than the packet stack",
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
                let had_stack_owner = starting_stack.is_some();
                let owner = ProductDataPlaneRecoveryOwner::starting(
                    starting_stack,
                    Arc::clone(&self.flow_runtime),
                    cleanup_timeout,
                );
                let failure =
                    rollback_recovery_owner_failure(owner, primary, cleanup_timeout).await;
                if !had_stack_owner
                    && matches!(
                        &failure,
                        ProductDataPlaneError::StartupFailed {
                            cleanup,
                            recovery_owner: None,
                            ..
                        } if cleanup.is_empty()
                    )
                {
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
        let (runtime_ready_sender, mut runtime_ready_receiver) = oneshot::channel();
        let runtime_ingress: Arc<dyn FlowIngress> = Arc::new(RuntimeReadyIngress {
            inner: flow_ingress,
            ready: Mutex::new(Some(runtime_ready_sender)),
        });
        let runtime_handle = match self.flow_runtime.start(runtime_ingress) {
            Ok(handle) => handle,
            Err(error) => {
                let primary = flow_runtime_error_code(&error);
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

/// Owned, retryable product data plane. Explicit `stop_until` is required for
/// cleanup proof; Drop only provides bounded emergency containment.
pub struct ReadyProductDataPlane {
    identity: ProductDataPlaneIdentity,
    packet_stack: Option<ReadyPacketStack>,
    flow_runtime: Arc<FlowRuntime>,
    runtime_task: Option<JoinHandle<RuntimeTaskResult>>,
    stopping: AtomicBool,
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

    /// Synchronously revoke readiness and request cancellation of every
    /// shared-plane owner.  Product handoff guards use this before scheduling
    /// asynchronous cleanup, so dropping a pending platform startup future
    /// cannot leave the provider accepting traffic until a cleanup task gets
    /// its first poll.
    pub fn request_stop(&self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(stack) = self.packet_stack.as_ref() {
            stack.cancel();
        }
        self.flow_runtime.cancel();
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
            Some(PacketStackHealth::Stopping) if !stopping => {
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
        self.request_stop();

        let packet_stack = &mut self.packet_stack;
        let runtime_task = &mut self.runtime_task;
        let retry_owner_cleanup = self.owner_cleanup_pending;
        let flow_runtime = Arc::clone(&self.flow_runtime);
        let (stack_result, runtime_result, owner_retry_result) = tokio::join!(
            stop_packet_stack(packet_stack, deadline),
            stop_flow_runtime(runtime_task, deadline),
            retry_flow_runtime_owners(flow_runtime, retry_owner_cleanup, deadline),
        );

        let stack_error = stack_result.err();
        self.faults.packet_stack = merge_terminal_fault(
            self.faults.packet_stack,
            stack_error,
            PACKET_STACK_SHUTDOWN_TIMEOUT_CODE,
        );
        self.cleanup_faults.packet_stack = stack_error;
        let (snapshot, mut runtime_error) = match runtime_result {
            Ok(Some(snapshot)) => (snapshot, None),
            Ok(None) => (self.flow_runtime.snapshot(), None),
            Err(code) => (self.flow_runtime.snapshot(), Some(code)),
        };
        if self.flow_runtime.has_pending_cleanup()
            || runtime_error == Some(PRODUCT_DATA_PLANE_RUNTIME_JOIN_CODE)
        {
            self.owner_cleanup_pending = true;
        }
        if retry_owner_cleanup {
            match owner_retry_result {
                Ok(()) => self.owner_cleanup_pending = false,
                Err(code) => runtime_error = Some(code),
            }
        }
        if self.owner_cleanup_pending && runtime_error.is_none() {
            runtime_error = Some(FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED_CODE);
        }
        self.faults.flow_runtime = match runtime_error {
            Some(FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED_CODE)
            | Some(PRODUCT_DATA_PLANE_RUNTIME_SHUTDOWN_TIMEOUT_CODE) => self.faults.flow_runtime,
            Some(code) => Some(code),
            None => self.faults.flow_runtime,
        };
        self.cleanup_faults.flow_runtime = runtime_error;
        self.cleanup_faults.native = None;
        if !self.cleanup_faults.is_empty() {
            return Err(ProductDataPlaneError::StopFailed {
                faults: self.cleanup_faults,
            });
        }
        self.stopped = true;
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
        self.stopping.store(true, Ordering::Release);
        self.flow_runtime.cancel();
        if let Some(stack) = self.packet_stack.as_ref() {
            stack.cancel();
        }
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
        self.flow_runtime.cancel();
        let (stack_result, owner_result) = tokio::join!(
            stop_starting_packet_stack(&mut self.packet_stack, deadline),
            self.flow_runtime.retry_cleanup_until(deadline),
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

/// Readiness is sent from inside `accept_tcp`, so successful composition start
/// proves the FlowRuntime admission loop actually polled its sole ingress. The
/// wrapper and receiver are never exposed from the factory.
struct RuntimeReadyIngress {
    inner: Arc<BoundedFlowIngress>,
    ready: Mutex<Option<oneshot::Sender<()>>>,
}

#[async_trait]
impl FlowIngress for RuntimeReadyIngress {
    async fn accept_tcp(&self) -> Result<Option<IngressTcpFlow>, IngressError> {
        if let Some(ready) = self
            .ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = ready.send(());
        }
        self.inner.accept_tcp().await
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
        Err(error) => Err(error.code()),
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
        let _ = tokio::join!(
            stop_packet_stack(&mut stack, deadline),
            stop_flow_runtime(&mut runtime_task, deadline),
            retry_flow_runtime_owners(flow_runtime, retry_runtime_cleanup, deadline),
        );
        if let Some(task) = runtime_task {
            task.abort();
            let _ = task.await;
        }
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
            flow_runtime.retry_cleanup_until(deadline),
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

    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::sockscap::capture::packet_device::{
        MIN_PACKET_QUEUE_BYTES, bounded_packet_device_queues,
    };
    use crate::sockscap::flow::attribution::FakeIpMap;
    use crate::sockscap::flow::bypass::HardBypassSet;
    use crate::sockscap::flow::engine::{EgressProvider, FlowEngine, FlowEngineSnapshot};
    use crate::sockscap::flow::packet_stack::{
        PacketStackCapabilities, PacketStackDescriptor, PacketStackDriver, PacketStackIdentity,
        PacketStackReady, PacketStackRunContext,
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

    #[async_trait]
    impl PacketStackDriver for TestDriver {
        fn identity(&self) -> PacketStackIdentity {
            stack_identity()
        }

        async fn run(
            self: Box<Self>,
            _context: PacketStackRunContext,
            readiness: oneshot::Sender<PacketStackReady>,
            cancellation: CancellationToken,
            tcp_ingress: super::super::ingress::BoundedFlowIngressSender,
        ) -> Result<PacketStackExit, PacketStackError> {
            let _ = readiness.send(PacketStackReady {
                identity: stack_identity(),
                capabilities: capabilities(),
            });
            match self.behavior {
                DriverBehavior::Wait => {
                    cancellation.cancelled().await;
                    drop(tcp_ingress);
                    Ok(PacketStackExit::Cancelled)
                }
                DriverBehavior::FailOnCancel => {
                    cancellation.cancelled().await;
                    drop(tcp_ingress);
                    Err(PacketStackError::provider(
                        "TEST_PACKET_STACK_FAILED",
                        "test failure",
                    ))
                }
                DriverBehavior::FailAfter(release) => {
                    release.notified().await;
                    drop(tcp_ingress);
                    Err(PacketStackError::provider(
                        "TEST_PACKET_STACK_FAILED",
                        "test failure",
                    ))
                }
                DriverBehavior::DropIngressThenWait => {
                    drop(tcp_ingress);
                    cancellation.cancelled().await;
                    Ok(PacketStackExit::Cancelled)
                }
                DriverBehavior::DropIngressAndIgnoreCancel(release) => {
                    drop(tcp_ingress);
                    release.notified().await;
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
            _context: PacketStackRunContext,
            readiness: oneshot::Sender<PacketStackReady>,
            cancellation: CancellationToken,
            tcp_ingress: super::super::ingress::BoundedFlowIngressSender,
        ) -> Result<PacketStackExit, PacketStackError> {
            let _ = readiness.send(PacketStackReady {
                identity: stack_identity(),
                capabilities: capabilities(),
            });
            cancellation.cancelled().await;
            drop(tcp_ingress);
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
            virtual_dns: true,
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
        ProductDataPlaneConfig {
            packet_stack: PacketStackSupervisorConfig {
                identity: stack_identity(),
                required_capabilities: PacketStackCapabilities {
                    ipv4: true,
                    tcp: true,
                    ..PacketStackCapabilities::default()
                },
                decoded_tcp_queue_capacity: 8,
                startup_timeout: Duration::from_millis(100),
                shutdown_timeout: Duration::from_millis(100),
            },
            ip_stack: IpStackConfig {
                generation: GENERATION,
                platform: CapturePlatform::Linux,
                provider: provider_pin(),
                max_tcp_flows: 8,
                max_udp_associations: 8,
                max_reassembly_bytes: 1 << 20,
                max_packet_bytes: 1500,
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
            Some(PACKET_STACK_SHUTDOWN_TIMEOUT_CODE)
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
