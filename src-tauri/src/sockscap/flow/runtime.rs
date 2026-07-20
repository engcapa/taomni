//! Owned, bounded runtime for decoded TCP flows and UDP associations.
//!
//! Platform capture code terminates at [`FlowIngress`]. This module performs
//! the one shared profile selection, invokes the per-profile [`FlowEngine`],
//! relays bytes/datagrams with cancellation semantics, and owns every task
//! until shutdown.

use std::collections::{HashMap, HashSet};
use std::num::{NonZeroU64, NonZeroUsize};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::task::{Id as TaskId, JoinError, JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::connectors::AsyncUdpAssociation;
use super::engine::{FlowContext, FlowEngine, copy_bidirectional_counted};
use super::ingress::{
    FlowIngress, FlowTransport, IngressError, IngressTcpControl, IngressTcpFlow,
    IngressUdpAssociation, IngressUdpControl, MAX_INGRESS_QUEUE_CAPACITY,
    MAX_UDP_INGRESS_QUEUE_CAPACITY, ProfileBinding, TcpCloseDisposition, UdpCloseDisposition,
    UdpDatagram, UdpFlowIngress, bounded_udp_flow_ingress,
};
use crate::sockscap::egress::EgressRuntime;
use crate::sockscap::policy::selector::{ProfileSelector, ProfileSelectorError};
use crate::sockscap::types::{CapturePlatform, RouteAction, RoutingProfileDraft};

pub const MAX_ACTIVE_FLOWS: usize = 65_536;
pub const MAX_ACTIVE_UDP_ASSOCIATIONS: usize = 65_536;
pub const MAX_ACTIVE_TRANSPORTS: usize = 65_536;
pub const DEFAULT_MAX_ACTIVE_UDP_ASSOCIATIONS: usize = 128;
/// Every receive reserves one maximum wire-sized datagram before polling the
/// provider. Both directions share the same runtime-wide byte semaphore.
pub const UDP_IN_FLIGHT_RESERVATION_BYTES: usize = u16::MAX as usize;
pub const DEFAULT_UDP_IN_FLIGHT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_UDP_IN_FLIGHT_BYTES: usize = 256 * 1024 * 1024;
const MIN_UDP_IN_FLIGHT_BYTES: usize = UDP_IN_FLIGHT_RESERVATION_BYTES * 2;
const MIN_SHUTDOWN_GRACE: Duration = Duration::from_millis(100);
const MAX_SHUTDOWN_GRACE: Duration = Duration::from_secs(60);
const MIN_UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DEFAULT_UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const CONTROL_CLOSE_TIMEOUT: Duration = Duration::from_millis(500);
const MIN_CONTROL_CLOSE_CONCURRENCY: usize = 16;
const MAX_CONTROL_CLOSE_CONCURRENCY: usize = 512;

/// Validated limits and snapshot identity for one single-use runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowRuntimeConfig {
    platform: CapturePlatform,
    generation: NonZeroU64,
    config_revision: NonZeroU64,
    max_active_flows: NonZeroUsize,
    max_active_udp_associations: usize,
    shutdown_grace: Duration,
    udp_idle_timeout: Duration,
    udp_in_flight_bytes: NonZeroUsize,
}

impl FlowRuntimeConfig {
    pub fn new(
        platform: CapturePlatform,
        generation: u64,
        config_revision: u64,
        max_active_flows: usize,
        shutdown_grace: Duration,
    ) -> Result<Self, FlowRuntimeError> {
        // Preserve the historical TCP ceiling without silently doubling the
        // per-runtime active transport budget when UDP is enabled later. A
        // saturated legacy TCP configuration therefore leaves UDP disabled;
        // product composition must use the explicit transport constructor.
        let max_active_udp_associations = MAX_ACTIVE_TRANSPORTS
            .saturating_sub(max_active_flows)
            .min(max_active_flows)
            .min(DEFAULT_MAX_ACTIVE_UDP_ASSOCIATIONS);
        Self::validated(
            platform,
            generation,
            config_revision,
            max_active_flows,
            max_active_udp_associations,
            shutdown_grace,
            DEFAULT_UDP_IDLE_TIMEOUT,
            DEFAULT_UDP_IN_FLIGHT_BYTES,
            true,
        )
    }

    pub fn new_with_transport_limits(
        platform: CapturePlatform,
        generation: u64,
        config_revision: u64,
        max_active_tcp_flows: usize,
        max_active_udp_associations: usize,
        shutdown_grace: Duration,
        udp_idle_timeout: Duration,
    ) -> Result<Self, FlowRuntimeError> {
        Self::new_with_resource_limits(
            platform,
            generation,
            config_revision,
            max_active_tcp_flows,
            max_active_udp_associations,
            shutdown_grace,
            udp_idle_timeout,
            DEFAULT_UDP_IN_FLIGHT_BYTES,
        )
    }

    /// Build a dual-transport runtime with an explicit per-runtime UDP
    /// in-flight payload ceiling. The byte budget is shared across every
    /// profile, connector, association, and relay direction.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_resource_limits(
        platform: CapturePlatform,
        generation: u64,
        config_revision: u64,
        max_active_tcp_flows: usize,
        max_active_udp_associations: usize,
        shutdown_grace: Duration,
        udp_idle_timeout: Duration,
        udp_in_flight_bytes: usize,
    ) -> Result<Self, FlowRuntimeError> {
        Self::validated(
            platform,
            generation,
            config_revision,
            max_active_tcp_flows,
            max_active_udp_associations,
            shutdown_grace,
            udp_idle_timeout,
            udp_in_flight_bytes,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn validated(
        platform: CapturePlatform,
        generation: u64,
        config_revision: u64,
        max_active_tcp_flows: usize,
        max_active_udp_associations: usize,
        shutdown_grace: Duration,
        udp_idle_timeout: Duration,
        udp_in_flight_bytes: usize,
        allow_zero_udp: bool,
    ) -> Result<Self, FlowRuntimeError> {
        if platform == CapturePlatform::Unknown {
            return Err(FlowRuntimeError::InvalidConfig);
        }
        let generation = NonZeroU64::new(generation).ok_or(FlowRuntimeError::InvalidConfig)?;
        let config_revision =
            NonZeroU64::new(config_revision).ok_or(FlowRuntimeError::InvalidConfig)?;
        let max_active_flows =
            NonZeroUsize::new(max_active_tcp_flows).ok_or(FlowRuntimeError::InvalidConfig)?;
        let udp_in_flight_bytes =
            NonZeroUsize::new(udp_in_flight_bytes).ok_or(FlowRuntimeError::InvalidConfig)?;
        let combined_active = max_active_tcp_flows
            .checked_add(max_active_udp_associations)
            .ok_or(FlowRuntimeError::InvalidConfig)?;
        let required_udp_receive_slots = max_active_udp_associations
            .checked_mul(2)
            .ok_or(FlowRuntimeError::InvalidConfig)?;
        let available_udp_receive_slots =
            udp_in_flight_bytes.get() / UDP_IN_FLIGHT_RESERVATION_BYTES;
        if max_active_flows.get() > MAX_ACTIVE_FLOWS
            || max_active_udp_associations > MAX_ACTIVE_UDP_ASSOCIATIONS
            || (!allow_zero_udp && max_active_udp_associations == 0)
            || combined_active > MAX_ACTIVE_TRANSPORTS
            || shutdown_grace < MIN_SHUTDOWN_GRACE
            || shutdown_grace > MAX_SHUTDOWN_GRACE
            || udp_idle_timeout < MIN_UDP_IDLE_TIMEOUT
            || udp_idle_timeout > MAX_UDP_IDLE_TIMEOUT
            || udp_in_flight_bytes.get() < MIN_UDP_IN_FLIGHT_BYTES
            || udp_in_flight_bytes.get() > MAX_UDP_IN_FLIGHT_BYTES
            || available_udp_receive_slots < required_udp_receive_slots
        {
            return Err(FlowRuntimeError::InvalidConfig);
        }
        Ok(Self {
            platform,
            generation,
            config_revision,
            max_active_flows,
            max_active_udp_associations,
            shutdown_grace,
            udp_idle_timeout,
            udp_in_flight_bytes,
        })
    }

    pub fn platform(self) -> CapturePlatform {
        self.platform
    }

    pub fn generation(self) -> u64 {
        self.generation.get()
    }

    pub fn config_revision(self) -> u64 {
        self.config_revision.get()
    }

    pub fn max_active_flows(self) -> usize {
        self.max_active_flows.get()
    }

    pub fn max_active_udp_associations(self) -> usize {
        self.max_active_udp_associations
    }

    pub fn shutdown_grace(self) -> Duration {
        self.shutdown_grace
    }

    pub fn udp_idle_timeout(self) -> Duration {
        self.udp_idle_timeout
    }

    pub fn udp_in_flight_bytes(self) -> usize {
        self.udp_in_flight_bytes.get()
    }
}

/// Owner retained for as long as its profile engines can open connections.
/// SSH egresses use this hook to close shared control connections after all
/// flow tasks have drained.
#[async_trait]
pub trait FlowRuntimeOwner: Send + Sync {
    /// Stable non-secret saved egress id this owner keeps alive.
    fn binding_id(&self) -> &str;

    /// Complete shutdown of the live resource represented by this owner.
    ///
    /// The runtime never calls this method again after it returns `Ok(())`.
    /// A future cancelled by a bounded deadline, a panic, or an error remains
    /// pending and can be called again, so inconclusive attempts must be
    /// cancellation-safe and retryable.
    async fn shutdown(&self) -> Result<(), FlowRuntimeOwnerError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED: live egress owner did not shut down cleanly")]
pub struct FlowRuntimeOwnerError;

#[async_trait]
impl FlowRuntimeOwner for EgressRuntime {
    fn binding_id(&self) -> &str {
        &self.summary().id
    }

    async fn shutdown(&self) -> Result<(), FlowRuntimeOwnerError> {
        EgressRuntime::shutdown(self).await;
        Ok(())
    }
}

/// One immutable profile, its policy/egress engine, and optional live-resource
/// owner. The owner prevents a connector from outliving its SSH pool/lifecycle.
pub struct ProfileRuntime {
    profile: Arc<RoutingProfileDraft>,
    engine: Arc<FlowEngine>,
    owner: Option<Arc<dyn FlowRuntimeOwner>>,
}

impl ProfileRuntime {
    pub fn new(profile: RoutingProfileDraft, engine: Arc<FlowEngine>) -> Self {
        Self {
            profile: Arc::new(profile),
            engine,
            owner: None,
        }
    }

    pub fn with_owner(
        profile: RoutingProfileDraft,
        engine: Arc<FlowEngine>,
        owner: Arc<dyn FlowRuntimeOwner>,
    ) -> Self {
        Self {
            profile: Arc::new(profile),
            engine,
            owner: Some(owner),
        }
    }

    pub(in crate::sockscap::flow) fn owner(&self) -> Option<Arc<dyn FlowRuntimeOwner>> {
        self.owner.clone()
    }
}

impl std::fmt::Debug for ProfileRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProfileRuntime")
            .field("profile_id", &self.profile.id)
            .field("has_owner", &self.owner.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FlowRuntimeError {
    #[error("FLOW_RUNTIME_CONFIG_INVALID: runtime limits or snapshot identity are invalid")]
    InvalidConfig,
    #[error("FLOW_RUNTIME_PROFILE_DUPLICATE: profile runtimes are not unique")]
    DuplicateProfile,
    #[error("FLOW_RUNTIME_PROFILE_DISABLED: runtime contains a disabled profile")]
    DisabledProfile,
    #[error("FLOW_RUNTIME_ENGINE_PROFILE_MISMATCH: engine does not match its profile")]
    EngineProfileMismatch,
    #[error("FLOW_RUNTIME_ENGINE_SNAPSHOT_MISMATCH: engine was built from another config snapshot")]
    EngineSnapshotMismatch,
    #[error("FLOW_RUNTIME_OWNER_REQUIRED: configured live egress has no lifecycle owner")]
    OwnerRequired,
    #[error("FLOW_RUNTIME_OWNER_BINDING_MISMATCH: lifecycle owner does not match saved egress")]
    OwnerBindingMismatch,
    #[error("FLOW_RUNTIME_PROFILE_SELECTOR_INVALID: {0}")]
    ProfileSelector(ProfileSelectorError),
    #[error("FLOW_RUNTIME_ALREADY_STARTED: runtime instances are single-use")]
    AlreadyStarted,
    #[error("FLOW_RUNTIME_ASYNC_RUNTIME_UNAVAILABLE: no Tokio runtime is available")]
    AsyncRuntimeUnavailable,
    #[error("FLOW_RUNTIME_SUPERVISOR_FAILED: runtime supervisor terminated unexpectedly")]
    SupervisorFailed,
    #[error("FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED: one or more live egress owners failed to stop")]
    OwnerShutdownFailed,
    #[error("FLOW_RUNTIME_INGRESS_FAILED: {code}")]
    Ingress { code: &'static str },
}

/// Start failure that returns both ingress owners to the caller.
///
/// Packet-stack composition transfers the sole decoded receivers before it
/// starts `FlowRuntime`. A naked error would drop those receivers, including
/// every queued flow/control, before the product recovery owner can fence and
/// drain them. Keeping the owners in this value makes every pre-start failure
/// explicit and recoverable.
pub struct FlowRuntimeStartError {
    error: FlowRuntimeError,
    tcp_ingress: Arc<dyn FlowIngress>,
    udp_ingress: Arc<dyn UdpFlowIngress>,
}

impl FlowRuntimeStartError {
    fn new(
        error: FlowRuntimeError,
        tcp_ingress: Arc<dyn FlowIngress>,
        udp_ingress: Arc<dyn UdpFlowIngress>,
    ) -> Self {
        Self {
            error,
            tcp_ingress,
            udp_ingress,
        }
    }

    pub fn error(&self) -> FlowRuntimeError {
        self.error
    }

    pub fn into_parts(
        self,
    ) -> (
        FlowRuntimeError,
        Arc<dyn FlowIngress>,
        Arc<dyn UdpFlowIngress>,
    ) {
        (self.error, self.tcp_ingress, self.udp_ingress)
    }
}

impl std::fmt::Debug for FlowRuntimeStartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FlowRuntimeStartError")
            .field("error", &self.error)
            .field("tcp_ingress", &"retained")
            .field("udp_ingress", &"retained")
            .finish()
    }
}

impl std::fmt::Display for FlowRuntimeStartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for FlowRuntimeStartError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

/// Lock-free lifecycle fence for product composition health checks.
///
/// A join handle only says whether the supervisor has completely returned.
/// Cleanup can remain in progress after packet ingress has already reached
/// EOF, so callers must revoke readiness as soon as the admission loop exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowRuntimeLifecycle {
    NotStarted,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

const RUNTIME_NOT_STARTED: u8 = 0;
const RUNTIME_STARTING: u8 = 1;
const RUNTIME_RUNNING: u8 = 2;
const RUNTIME_STOPPING: u8 = 3;
const RUNTIME_STOPPED: u8 = 4;
const RUNTIME_FAILED: u8 = 5;

/// Privacy-bounded counters; no tuple, hostname, application identity, or
/// payload-derived value enters this structure.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowRuntimeSnapshot {
    pub admitted: u64,
    pub completed: u64,
    pub tcp_admitted: u64,
    pub udp_admitted: u64,
    pub tcp_completed: u64,
    pub udp_completed: u64,
    pub policy_blocked: u64,
    pub rejected_overloaded: u64,
    pub rejected_stale: u64,
    pub rejected_invalid: u64,
    pub rejected_duplicate: u64,
    pub rejected_no_profile: u64,
    pub cancelled: u64,
    pub failed: u64,
    pub task_panics: u64,
    pub control_close_failures: u64,
    pub owner_shutdown_failures: u64,
    pub forced_drops: u64,
    pub invariant_violations: u64,
    pub active: usize,
    pub peak_active: usize,
    pub tcp_active: usize,
    pub udp_active: usize,
    pub tcp_peak_active: usize,
    pub udp_peak_active: usize,
    pub bytes_to_egress: u64,
    pub bytes_to_ingress: u64,
    pub udp_datagrams_to_egress: u64,
    pub udp_datagrams_to_ingress: u64,
    pub udp_bytes_to_egress: u64,
    pub udp_bytes_to_ingress: u64,
}

struct FlowRuntimeMetrics {
    snapshot: Mutex<FlowRuntimeSnapshot>,
}

impl Default for FlowRuntimeMetrics {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(FlowRuntimeSnapshot::default()),
        }
    }
}

impl FlowRuntimeMetrics {
    fn admitted_tcp(&self) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.admitted = snapshot.admitted.saturating_add(1);
        snapshot.tcp_admitted = snapshot.tcp_admitted.saturating_add(1);
        snapshot.active = snapshot.active.saturating_add(1);
        snapshot.tcp_active = snapshot.tcp_active.saturating_add(1);
        snapshot.peak_active = snapshot.peak_active.max(snapshot.active);
        snapshot.tcp_peak_active = snapshot.tcp_peak_active.max(snapshot.tcp_active);
    }

    fn admitted_udp(&self) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.admitted = snapshot.admitted.saturating_add(1);
        snapshot.udp_admitted = snapshot.udp_admitted.saturating_add(1);
        snapshot.active = snapshot.active.saturating_add(1);
        snapshot.udp_active = snapshot.udp_active.saturating_add(1);
        snapshot.peak_active = snapshot.peak_active.max(snapshot.active);
        snapshot.udp_peak_active = snapshot.udp_peak_active.max(snapshot.udp_active);
    }

    fn rejected_tcp(&self, disposition: TcpCloseDisposition) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match disposition {
            TcpCloseDisposition::Overloaded => {
                snapshot.rejected_overloaded = snapshot.rejected_overloaded.saturating_add(1);
            }
            TcpCloseDisposition::StaleGeneration => {
                snapshot.rejected_stale = snapshot.rejected_stale.saturating_add(1);
            }
            TcpCloseDisposition::InvalidDescriptor => {
                snapshot.rejected_invalid = snapshot.rejected_invalid.saturating_add(1);
            }
            TcpCloseDisposition::DuplicateFlow => {
                snapshot.rejected_duplicate = snapshot.rejected_duplicate.saturating_add(1);
            }
            TcpCloseDisposition::NoProfile => {
                snapshot.rejected_no_profile = snapshot.rejected_no_profile.saturating_add(1);
            }
            _ => snapshot.failed = snapshot.failed.saturating_add(1),
        }
    }

    fn rejected_udp(&self, disposition: UdpCloseDisposition) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match disposition {
            UdpCloseDisposition::Overloaded => {
                snapshot.rejected_overloaded = snapshot.rejected_overloaded.saturating_add(1);
            }
            UdpCloseDisposition::StaleGeneration => {
                snapshot.rejected_stale = snapshot.rejected_stale.saturating_add(1);
            }
            UdpCloseDisposition::InvalidDescriptor => {
                snapshot.rejected_invalid = snapshot.rejected_invalid.saturating_add(1);
            }
            UdpCloseDisposition::DuplicateFlow => {
                snapshot.rejected_duplicate = snapshot.rejected_duplicate.saturating_add(1);
            }
            UdpCloseDisposition::NoProfile => {
                snapshot.rejected_no_profile = snapshot.rejected_no_profile.saturating_add(1);
            }
            _ => snapshot.failed = snapshot.failed.saturating_add(1),
        }
    }

    fn completed_tcp(&self, completion: &TaskCompletion) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if snapshot.active == 0 {
            snapshot.invariant_violations = snapshot.invariant_violations.saturating_add(1);
        } else {
            snapshot.active -= 1;
        }
        if snapshot.tcp_active == 0 {
            snapshot.invariant_violations = snapshot.invariant_violations.saturating_add(1);
        } else {
            snapshot.tcp_active -= 1;
        }
        snapshot.bytes_to_egress = snapshot
            .bytes_to_egress
            .saturating_add(completion.bytes_to_egress);
        snapshot.bytes_to_ingress = snapshot
            .bytes_to_ingress
            .saturating_add(completion.bytes_to_ingress);
        match completion.disposition {
            TcpCloseDisposition::Finished => {
                snapshot.completed = snapshot.completed.saturating_add(1);
                snapshot.tcp_completed = snapshot.tcp_completed.saturating_add(1);
            }
            TcpCloseDisposition::PolicyBlocked => {
                snapshot.policy_blocked = snapshot.policy_blocked.saturating_add(1);
            }
            TcpCloseDisposition::Cancelled => {
                snapshot.cancelled = snapshot.cancelled.saturating_add(1);
            }
            _ => {
                snapshot.failed = snapshot.failed.saturating_add(1);
            }
        }
        if completion.panicked {
            snapshot.task_panics = snapshot.task_panics.saturating_add(1);
        }
        if completion.close_failed {
            snapshot.control_close_failures = snapshot.control_close_failures.saturating_add(1);
        }
    }

    fn completed_udp(&self, completion: &UdpTaskCompletion) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if snapshot.active == 0 {
            snapshot.invariant_violations = snapshot.invariant_violations.saturating_add(1);
        } else {
            snapshot.active -= 1;
        }
        if snapshot.udp_active == 0 {
            snapshot.invariant_violations = snapshot.invariant_violations.saturating_add(1);
        } else {
            snapshot.udp_active -= 1;
        }
        snapshot.bytes_to_egress = snapshot
            .bytes_to_egress
            .saturating_add(completion.bytes_to_egress);
        snapshot.bytes_to_ingress = snapshot
            .bytes_to_ingress
            .saturating_add(completion.bytes_to_ingress);
        snapshot.udp_bytes_to_egress = snapshot
            .udp_bytes_to_egress
            .saturating_add(completion.bytes_to_egress);
        snapshot.udp_bytes_to_ingress = snapshot
            .udp_bytes_to_ingress
            .saturating_add(completion.bytes_to_ingress);
        snapshot.udp_datagrams_to_egress = snapshot
            .udp_datagrams_to_egress
            .saturating_add(completion.datagrams_to_egress);
        snapshot.udp_datagrams_to_ingress = snapshot
            .udp_datagrams_to_ingress
            .saturating_add(completion.datagrams_to_ingress);
        match completion.disposition {
            UdpCloseDisposition::Finished | UdpCloseDisposition::IdleTimeout => {
                snapshot.completed = snapshot.completed.saturating_add(1);
                snapshot.udp_completed = snapshot.udp_completed.saturating_add(1);
            }
            UdpCloseDisposition::PolicyBlocked => {
                snapshot.policy_blocked = snapshot.policy_blocked.saturating_add(1);
            }
            UdpCloseDisposition::Cancelled => {
                snapshot.cancelled = snapshot.cancelled.saturating_add(1);
            }
            _ => {
                snapshot.failed = snapshot.failed.saturating_add(1);
            }
        }
        if completion.panicked {
            snapshot.task_panics = snapshot.task_panics.saturating_add(1);
        }
        if completion.close_failed {
            snapshot.control_close_failures = snapshot.control_close_failures.saturating_add(1);
        }
    }

    fn rejected_close(&self, outcome: CloseOutcome) {
        if outcome.failed {
            let mut snapshot = self
                .snapshot
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            snapshot.control_close_failures = snapshot.control_close_failures.saturating_add(1);
            if outcome.panicked {
                snapshot.task_panics = snapshot.task_panics.saturating_add(1);
            }
        }
    }

    fn active_control_close_failure(&self) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.control_close_failures = snapshot.control_close_failures.saturating_add(1);
    }

    fn owner_shutdown_failures(&self, count: usize) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.owner_shutdown_failures = snapshot
            .owner_shutdown_failures
            .saturating_add(u64::try_from(count).unwrap_or(u64::MAX));
    }

    fn forced_drops(&self, count: usize) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.forced_drops = snapshot
            .forced_drops
            .saturating_add(u64::try_from(count).unwrap_or(u64::MAX));
    }

    fn invariant_violation(&self) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.invariant_violations = snapshot.invariant_violations.saturating_add(1);
    }

    fn snapshot(&self) -> FlowRuntimeSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

pub struct FlowRuntime {
    config: FlowRuntimeConfig,
    selector: ProfileSelector,
    engines: HashMap<String, Arc<FlowEngine>>,
    owner_count: usize,
    /// Only owners whose shutdown has not returned success remain here.
    pending_owners: tokio::sync::Mutex<Vec<Arc<dyn FlowRuntimeOwner>>>,
    tcp_admission: Arc<Semaphore>,
    udp_admission: Arc<Semaphore>,
    udp_in_flight_budget: Arc<Semaphore>,
    cancellation: CancellationToken,
    metrics: Arc<FlowRuntimeMetrics>,
    /// Join/control owners that outlived the supervisor's first bounded
    /// cleanup attempt. The product recovery owner retries this state; it is
    /// never dropped merely to report a clean stop.
    cleanup_state: tokio::sync::Mutex<Vec<RuntimeState>>,
    /// Set when the supervisor unwound outside its guarded admission-loop
    /// error path. In that case local JoinSet ownership was dropped without an
    /// observable join proof, so no later retry may report a clean runtime.
    cleanup_uncertain: AtomicBool,
    /// Independent from the primary terminal error. It is cleared only after
    /// the internal supervisor is terminal and every local/profile owner has
    /// produced cleanup proof.
    cleanup_pending: AtomicBool,
    supervisor_terminal: tokio::sync::Notify,
    started: AtomicBool,
    /// Set only by `cancel_unstarted_until` after it atomically consumes the
    /// one-shot start right. This distinguishes retryable pre-start owner
    /// cleanup from an ordinary runtime that happens to be stopping.
    unstarted_cleanup_claimed: AtomicBool,
    lifecycle: AtomicU8,
}

impl FlowRuntime {
    pub fn new(
        config: FlowRuntimeConfig,
        profiles: Vec<ProfileRuntime>,
    ) -> Result<Self, FlowRuntimeError> {
        let mut ids = HashSet::new();
        let mut engines = HashMap::new();
        let mut immutable_profiles = Vec::new();
        let mut owners: Vec<Arc<dyn FlowRuntimeOwner>> = Vec::new();

        for runtime in profiles {
            if !ids.insert(runtime.profile.id.clone()) {
                return Err(FlowRuntimeError::DuplicateProfile);
            }
            if !runtime.profile.enabled {
                return Err(FlowRuntimeError::DisabledProfile);
            }
            if runtime.engine.matcher.profile_id != runtime.profile.id {
                return Err(FlowRuntimeError::EngineProfileMismatch);
            }
            if !runtime
                .engine
                .snapshot()
                .matches_profile(config.config_revision(), &runtime.profile)
            {
                return Err(FlowRuntimeError::EngineSnapshotMismatch);
            }
            if runtime.engine.matcher.default_action != runtime.profile.default_action
                || runtime.engine.matcher.unknown_domain_action
                    != runtime.profile.unknown_domain_action
            {
                return Err(FlowRuntimeError::EngineProfileMismatch);
            }
            if runtime.profile.egress_kind.is_some() {
                let expected_binding = runtime
                    .profile
                    .egress_ref_id
                    .as_deref()
                    .ok_or(FlowRuntimeError::OwnerBindingMismatch)?;
                let owner = runtime
                    .owner
                    .as_ref()
                    .ok_or(FlowRuntimeError::OwnerRequired)?;
                if owner.binding_id() != expected_binding {
                    return Err(FlowRuntimeError::OwnerBindingMismatch);
                }
            }
            if let Some(owner) = runtime.owner
                && !owners.iter().any(|current| Arc::ptr_eq(current, &owner))
            {
                owners.push(owner);
            }
            engines.insert(runtime.profile.id.clone(), runtime.engine);
            immutable_profiles.push(runtime.profile);
        }

        let selector = ProfileSelector::from_immutable_profiles(immutable_profiles)
            .map_err(FlowRuntimeError::ProfileSelector)?;
        Ok(Self {
            config,
            selector,
            engines,
            owner_count: owners.len(),
            pending_owners: tokio::sync::Mutex::new(owners),
            tcp_admission: Arc::new(Semaphore::new(config.max_active_flows())),
            udp_admission: Arc::new(Semaphore::new(config.max_active_udp_associations())),
            udp_in_flight_budget: Arc::new(Semaphore::new(config.udp_in_flight_bytes())),
            cancellation: CancellationToken::new(),
            metrics: Arc::new(FlowRuntimeMetrics::default()),
            cleanup_state: tokio::sync::Mutex::new(Vec::new()),
            cleanup_uncertain: AtomicBool::new(false),
            cleanup_pending: AtomicBool::new(false),
            supervisor_terminal: tokio::sync::Notify::new(),
            started: AtomicBool::new(false),
            unstarted_cleanup_claimed: AtomicBool::new(false),
            lifecycle: AtomicU8::new(RUNTIME_NOT_STARTED),
        })
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    /// Irrevocably consume an unstarted runtime and close its transferred
    /// profile owners. Product composition uses this only after packet-stack
    /// startup failed before `start_with_udp` was called.
    ///
    /// The `started` CAS is the ownership proof: if normal start won the race,
    /// this method fails closed and cannot shut down owners that may already be
    /// referenced by transport tasks. Once pre-start cancellation wins, later
    /// calls resume an interrupted owner cleanup and normal start is fenced.
    pub(in crate::sockscap::flow) async fn cancel_unstarted_until(
        &self,
        deadline: Instant,
    ) -> Result<(), FlowRuntimeError> {
        if !self.unstarted_cleanup_claimed.load(Ordering::Acquire) {
            if self.lifecycle() != FlowRuntimeLifecycle::NotStarted
                || self
                    .started
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
            {
                return Err(FlowRuntimeError::SupervisorFailed);
            }
            self.unstarted_cleanup_claimed
                .store(true, Ordering::Release);
            self.cancellation.cancel();
            self.cleanup_pending.store(true, Ordering::Release);
            self.lifecycle.store(RUNTIME_STOPPING, Ordering::Release);
        }

        if !self.unstarted_cleanup_claimed.load(Ordering::Acquire) {
            return Err(FlowRuntimeError::SupervisorFailed);
        }
        if self.lifecycle() == FlowRuntimeLifecycle::Stopped
            && !self.cleanup_pending.load(Ordering::Acquire)
        {
            return Ok(());
        }

        let failures = self.shutdown_owners_until(deadline).await;
        self.metrics.owner_shutdown_failures(failures);
        let clean = failures == 0;
        self.cleanup_pending.store(!clean, Ordering::Release);
        self.lifecycle.store(
            if clean {
                RUNTIME_STOPPED
            } else {
                RUNTIME_STOPPING
            },
            Ordering::Release,
        );
        if clean {
            Ok(())
        } else {
            Err(FlowRuntimeError::OwnerShutdownFailed)
        }
    }

    /// Retry shutdown of live profile owners after the supervisor exhausted
    /// its original cleanup deadline or its join outcome was uncertain. The
    /// owners remain strongly held by `FlowRuntime`, so a timed-out attempt is
    /// never treated as cleanup proof.
    pub async fn retry_cleanup_until(&self, deadline: Instant) -> Result<(), FlowRuntimeError> {
        if self.lifecycle() == FlowRuntimeLifecycle::NotStarted {
            return Err(FlowRuntimeError::SupervisorFailed);
        }
        if !self.wait_for_supervisor_terminal_until(deadline).await {
            self.cleanup_pending.store(true, Ordering::Release);
            return Err(FlowRuntimeError::OwnerShutdownFailed);
        }
        let local_attempt = AssertUnwindSafe(self.retry_local_cleanup_until(deadline))
            .catch_unwind()
            .await;
        let local_clean = match local_attempt {
            Ok(clean) => clean && !self.cleanup_uncertain.load(Ordering::Acquire),
            Err(_) => {
                // retry_local_cleanup_until mutates the state in-place behind
                // cleanup_state; unwinding releases only the mutex guard, not
                // the retained JoinSets/ingress owners.
                self.cleanup_uncertain.store(true, Ordering::Release);
                false
            }
        };
        // A profile owner may back connectors still referenced by an
        // unobserved transport/control task. Never shut it down until local
        // task ownership has produced a complete join/close proof.
        let failures = if local_clean {
            self.shutdown_owners_until(deadline).await
        } else {
            0
        };
        self.metrics.owner_shutdown_failures(failures);
        let clean = local_clean && failures == 0;
        self.cleanup_pending.store(!clean, Ordering::Release);
        if clean {
            Ok(())
        } else {
            Err(FlowRuntimeError::OwnerShutdownFailed)
        }
    }

    /// Whether supervisor completion or child/control/profile-owner cleanup
    /// proof is still outstanding. This does not hide the primary terminal
    /// runtime error returned by the supervisor.
    pub fn has_pending_cleanup(&self) -> bool {
        self.cleanup_pending.load(Ordering::Acquire)
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn snapshot(&self) -> FlowRuntimeSnapshot {
        self.metrics.snapshot()
    }

    pub fn lifecycle(&self) -> FlowRuntimeLifecycle {
        match self.lifecycle.load(Ordering::Acquire) {
            RUNTIME_NOT_STARTED => FlowRuntimeLifecycle::NotStarted,
            RUNTIME_STARTING => FlowRuntimeLifecycle::Starting,
            RUNTIME_RUNNING => FlowRuntimeLifecycle::Running,
            RUNTIME_STOPPING => FlowRuntimeLifecycle::Stopping,
            RUNTIME_STOPPED => FlowRuntimeLifecycle::Stopped,
            _ => FlowRuntimeLifecycle::Failed,
        }
    }

    /// Start an owned supervisor. Dropping the returned handle requests a
    /// bounded shutdown but never aborts the supervisor cleanup task.
    pub fn start(
        self: &Arc<Self>,
        ingress: Arc<dyn FlowIngress>,
    ) -> Result<FlowRuntimeHandle, FlowRuntimeStartError> {
        let (udp_sender, udp_ingress) =
            bounded_udp_flow_ingress(1).expect("fixed disabled UDP ingress capacity is valid");
        drop(udp_sender);
        self.start_with_udp(ingress, Arc::new(udp_ingress))
    }

    /// Start the shared runtime with independent TCP-flow and UDP-association
    /// admission sources. The runtime stops accepting only after both sources
    /// reach orderly EOF (or either source fails).
    pub fn start_with_udp(
        self: &Arc<Self>,
        tcp_ingress: Arc<dyn FlowIngress>,
        udp_ingress: Arc<dyn UdpFlowIngress>,
    ) -> Result<FlowRuntimeHandle, FlowRuntimeStartError> {
        // Capacity is foreign synchronous code. Inspect it once, before the
        // one-shot start CAS, and retain both receivers on every failure.
        let capacities = std::panic::catch_unwind(AssertUnwindSafe(|| {
            (
                tcp_ingress.max_buffered_tcp(),
                udp_ingress.max_buffered_udp(),
            )
        }));
        let (tcp_ingress_capacity, udp_ingress_capacity) = match capacities {
            Ok(capacities) => capacities,
            Err(_) => {
                return Err(FlowRuntimeStartError::new(
                    FlowRuntimeError::InvalidConfig,
                    tcp_ingress,
                    udp_ingress,
                ));
            }
        };
        let udp_limit = self.config.max_active_udp_associations();
        let total_tcp_retained = self
            .config
            .max_active_flows()
            .checked_add(tcp_ingress_capacity)
            // One slot proves a dishonest capacity and one retains the only
            // already-polled admission object if an internal ceiling
            // invariant is ever violated. Neither path may drop a control.
            .and_then(|total| total.checked_add(2));
        let total_udp_retained = udp_limit
            .checked_add(udp_ingress_capacity)
            .and_then(|total| total.checked_add(2));
        if tcp_ingress_capacity == 0
            || tcp_ingress_capacity > MAX_INGRESS_QUEUE_CAPACITY
            || tcp_ingress_capacity > self.config.max_active_flows()
            || udp_ingress_capacity == 0
            || udp_ingress_capacity > MAX_UDP_INGRESS_QUEUE_CAPACITY
            || (udp_limit == 0 && udp_ingress_capacity != 1)
            || (udp_limit > 0 && udp_ingress_capacity > udp_limit)
            || total_tcp_retained.is_none()
            || total_udp_retained.is_none()
        {
            return Err(FlowRuntimeStartError::new(
                FlowRuntimeError::InvalidConfig,
                tcp_ingress,
                udp_ingress,
            ));
        }
        let async_runtime = match tokio::runtime::Handle::try_current() {
            Ok(runtime) => runtime,
            Err(_) => {
                return Err(FlowRuntimeStartError::new(
                    FlowRuntimeError::AsyncRuntimeUnavailable,
                    tcp_ingress,
                    udp_ingress,
                ));
            }
        };
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(FlowRuntimeStartError::new(
                FlowRuntimeError::AlreadyStarted,
                tcp_ingress,
                udp_ingress,
            ));
        }
        self.lifecycle.store(RUNTIME_STARTING, Ordering::Release);
        self.cleanup_pending.store(true, Ordering::Release);

        let runtime = Arc::clone(self);
        let supervisor = async_runtime.spawn(async move {
            let outcome = AssertUnwindSafe(Arc::clone(&runtime).supervise(
                tcp_ingress,
                udp_ingress,
                tcp_ingress_capacity,
                udp_ingress_capacity,
                total_tcp_retained.expect("validated TCP retained ceiling"),
                total_udp_retained.expect("validated UDP retained ceiling"),
            ))
            .catch_unwind()
            .await;
            let result = match outcome {
                Ok(result) => result,
                Err(_) => {
                    runtime.cleanup_uncertain.store(true, Ordering::Release);
                    runtime.cleanup_pending.store(true, Ordering::Release);
                    runtime.lifecycle.store(RUNTIME_FAILED, Ordering::Release);
                    Err(FlowRuntimeError::SupervisorFailed)
                }
            };
            runtime.supervisor_terminal.notify_waiters();
            result
        });
        Ok(FlowRuntimeHandle {
            cancellation: self.cancellation.clone(),
            supervisor: Some(supervisor),
        })
    }

    async fn supervise(
        self: Arc<Self>,
        tcp_ingress: Arc<dyn FlowIngress>,
        udp_ingress: Arc<dyn UdpFlowIngress>,
        tcp_ingress_capacity: usize,
        udp_ingress_capacity: usize,
        max_tcp_retained_rejections: usize,
        max_udp_retained_rejections: usize,
    ) -> Result<FlowRuntimeSnapshot, FlowRuntimeError> {
        self.lifecycle.store(RUNTIME_RUNNING, Ordering::Release);
        let mut state = RuntimeState::new(
            self.config.max_active_flows(),
            self.config.max_active_udp_associations(),
            Arc::clone(&tcp_ingress),
            Arc::clone(&udp_ingress),
            tcp_ingress_capacity,
            udp_ingress_capacity,
            max_tcp_retained_rejections,
            max_udp_retained_rejections,
        );
        let stop_reason =
            match AssertUnwindSafe(self.admission_loop(&tcp_ingress, &udp_ingress, &mut state))
                .catch_unwind()
                .await
            {
                Ok(reason) => reason,
                Err(_) => StopReason::SupervisorPanic,
            };

        // Revoke product readiness before any potentially slow flow/owner
        // cleanup.  A live wrapper JoinHandle is not proof of admission health.
        self.lifecycle.store(RUNTIME_STOPPING, Ordering::Release);
        let cleanup = AssertUnwindSafe(self.cleanup(&mut state, stop_reason))
            .catch_unwind()
            .await;
        let owner_failures = match cleanup {
            Ok(failures) => failures,
            Err(_) => {
                // The state lives outside the caught cleanup future. Preserve
                // every remaining ingress/task/control owner for explicit
                // recovery instead of letting the outer supervisor unwind
                // drop it and merely setting an uncertainty bit.
                self.cleanup_uncertain.store(true, Ordering::Release);
                self.cleanup_pending.store(true, Ordering::Release);
                self.cancellation.cancel();
                self.retain_runtime_state(&mut state).await;
                1
            }
        };
        let result = if owner_failures > 0
            && matches!(stop_reason, StopReason::Eof | StopReason::Cancelled)
        {
            Err(FlowRuntimeError::OwnerShutdownFailed)
        } else {
            match stop_reason {
                StopReason::Ingress(error) => Err(error),
                StopReason::SupervisorPanic => Err(FlowRuntimeError::SupervisorFailed),
                StopReason::ControlCloseFailure => Err(FlowRuntimeError::OwnerShutdownFailed),
                StopReason::Eof | StopReason::Cancelled => Ok(self.metrics.snapshot()),
            }
        };
        let clean_controlled_stop = result.is_ok() && stop_reason == StopReason::Cancelled;
        self.lifecycle.store(
            if clean_controlled_stop {
                RUNTIME_STOPPED
            } else {
                RUNTIME_FAILED
            },
            Ordering::Release,
        );
        result
    }

    async fn retain_runtime_state(&self, state: &mut RuntimeState) {
        let retained = state.take_for_retention();
        self.cleanup_state.lock().await.push(retained);
    }

    async fn wait_for_supervisor_terminal_until(&self, deadline: Instant) -> bool {
        loop {
            match self.lifecycle() {
                FlowRuntimeLifecycle::NotStarted
                | FlowRuntimeLifecycle::Stopped
                | FlowRuntimeLifecycle::Failed => return true,
                FlowRuntimeLifecycle::Starting
                | FlowRuntimeLifecycle::Running
                | FlowRuntimeLifecycle::Stopping => {}
            }
            if Instant::now() >= deadline {
                return false;
            }
            let notified = self.supervisor_terminal.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if matches!(
                self.lifecycle(),
                FlowRuntimeLifecycle::NotStarted
                    | FlowRuntimeLifecycle::Stopped
                    | FlowRuntimeLifecycle::Failed
            ) {
                continue;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return false;
            }
        }
    }

    async fn admission_loop(
        &self,
        tcp_ingress: &Arc<dyn FlowIngress>,
        udp_ingress: &Arc<dyn UdpFlowIngress>,
        state: &mut RuntimeState,
    ) -> StopReason {
        // Keep one accept future per transport alive across unrelated task
        // completions. Tokio's unbiased select supplies fair polling between
        // continuously-ready TCP and UDP queues.
        let mut tcp_eof = false;
        let mut udp_eof = self.config.max_active_udp_associations() == 0;
        let mut accepted_tcp: BoxFuture<'_, Result<Option<IngressTcpFlow>, IngressError>> =
            tcp_ingress.accept_tcp();
        let mut accepted_udp: BoxFuture<'_, Result<Option<IngressUdpAssociation>, IngressError>> =
            udp_ingress.accept_udp();

        loop {
            if self.cancellation.is_cancelled() {
                return StopReason::Cancelled;
            }
            // A failed provider close means the tuple is still owned by this
            // generation. Stop admission and enter bounded reconciliation
            // immediately instead of accumulating unresolved controls over a
            // long-lived runtime.
            if state.has_quarantined_close() {
                return StopReason::ControlCloseFailure;
            }
            self.schedule_rejected_closes(state);
            if tcp_eof && udp_eof {
                return StopReason::Eof;
            }
            // Cancellation is a hard outer fence. The inner select remains
            // unbiased so continuously-ready TCP and UDP sources retain fair
            // admission once the fence is open.
            let event = tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => return StopReason::Cancelled,
                event = async {
                    tokio::select! {
                        completion = state.tcp_tasks.join_next_with_id(), if !state.tcp_tasks.is_empty() => {
                            AdmissionEvent::TcpTask(completion)
                        }
                        completion = state.udp_tasks.join_next_with_id(), if !state.udp_tasks.is_empty() => {
                            AdmissionEvent::UdpTask(completion)
                        }
                        completion = state.tcp_rejected_close_tasks.join_next_with_id(), if !state.tcp_rejected_close_tasks.is_empty() => {
                            AdmissionEvent::TcpRejectedClose(completion)
                        }
                        completion = state.udp_rejected_close_tasks.join_next_with_id(), if !state.udp_rejected_close_tasks.is_empty() => {
                            AdmissionEvent::UdpRejectedClose(completion)
                        }
                        result = &mut accepted_tcp, if !tcp_eof
                            && state.pending_tcp_rejected_closes.is_empty()
                            && state.tcp_rejected_close_count() < state.max_tcp_live_rejections => {
                            AdmissionEvent::TcpAccepted(result)
                        }
                        result = &mut accepted_udp, if !udp_eof
                            && state.pending_udp_rejected_closes.is_empty()
                            && state.udp_rejected_close_count() < state.max_udp_live_rejections => {
                            AdmissionEvent::UdpAccepted(result)
                        }
                    }
                } => event,
            };

            match event {
                AdmissionEvent::TcpTask(Some(result)) => self.finish_tcp_join(result, state),
                AdmissionEvent::UdpTask(Some(result)) => self.finish_udp_join(result, state),
                AdmissionEvent::TcpRejectedClose(Some(result)) => {
                    self.finish_tcp_rejected_close_join(result, state);
                }
                AdmissionEvent::UdpRejectedClose(Some(result)) => {
                    self.finish_udp_rejected_close_join(result, state);
                }
                AdmissionEvent::TcpAccepted(result) => {
                    match result {
                        Ok(Some(flow)) if self.cancellation.is_cancelled() => {
                            self.close_unadmitted_tcp(flow, TcpCloseDisposition::Cancelled, state);
                            return StopReason::Cancelled;
                        }
                        Ok(Some(flow)) => self.admit_tcp(flow, state).await,
                        Ok(None) => tcp_eof = true,
                        Err(error) => {
                            return StopReason::Ingress(FlowRuntimeError::Ingress {
                                code: error.code(),
                            });
                        }
                    }
                    if !tcp_eof {
                        accepted_tcp = tcp_ingress.accept_tcp();
                    }
                }
                AdmissionEvent::UdpAccepted(result) => {
                    match result {
                        Ok(Some(association)) if self.cancellation.is_cancelled() => {
                            self.close_unadmitted_udp(
                                association,
                                UdpCloseDisposition::Cancelled,
                                state,
                            );
                            return StopReason::Cancelled;
                        }
                        Ok(Some(association)) => self.admit_udp(association, state).await,
                        Ok(None) => udp_eof = true,
                        Err(error) => {
                            return StopReason::Ingress(FlowRuntimeError::Ingress {
                                code: error.code(),
                            });
                        }
                    }
                    if !udp_eof {
                        accepted_udp = udp_ingress.accept_udp();
                    }
                }
                AdmissionEvent::TcpTask(None)
                | AdmissionEvent::UdpTask(None)
                | AdmissionEvent::TcpRejectedClose(None)
                | AdmissionEvent::UdpRejectedClose(None) => {
                    self.metrics.invariant_violation();
                }
            }

            if self.cancellation.is_cancelled() {
                return StopReason::Cancelled;
            }
        }
    }

    async fn admit_tcp(&self, flow: IngressTcpFlow, state: &mut RuntimeState) {
        if self.cancellation.is_cancelled() {
            self.close_unadmitted_tcp(flow, TcpCloseDisposition::Cancelled, state);
            return;
        }
        let descriptor = &flow.descriptor;
        if let Err(error) = descriptor.validate_for(self.config.generation()) {
            let disposition = if matches!(error, IngressError::StaleGeneration { .. }) {
                TcpCloseDisposition::StaleGeneration
            } else {
                TcpCloseDisposition::InvalidDescriptor
            };
            self.reject_tcp(flow, disposition, state).await;
            return;
        }
        if descriptor.platform != self.config.platform()
            || descriptor.transport != FlowTransport::Tcp
        {
            self.reject_tcp(flow, TcpCloseDisposition::InvalidDescriptor, state)
                .await;
            return;
        }
        if let ProfileBinding::TrustedQueue {
            config_revision, ..
        } = &descriptor.profile_binding
            && *config_revision != self.config.config_revision()
        {
            self.reject_tcp(flow, TcpCloseDisposition::StaleGeneration, state)
                .await;
            return;
        }
        if state.active_flow_ids.contains(&descriptor.flow_id) {
            self.reject_tcp(flow, TcpCloseDisposition::DuplicateFlow, state)
                .await;
            return;
        }

        let input = descriptor.profile_selection_input();
        let selection = match self.selector.select(&input) {
            Ok(selection) => selection,
            Err(_) => {
                self.reject_tcp(flow, TcpCloseDisposition::NoProfile, state)
                    .await;
                return;
            }
        };
        let Some(engine) = self.engines.get(selection.profile_id()).cloned() else {
            self.reject_tcp(flow, TcpCloseDisposition::NoProfile, state)
                .await;
            return;
        };
        let context = match FlowContext::try_from(descriptor) {
            Ok(context) => context,
            Err(_) => {
                self.reject_tcp(flow, TcpCloseDisposition::InvalidDescriptor, state)
                    .await;
                return;
            }
        };
        let flow_id = descriptor.flow_id;
        let permit = match self.tcp_admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                self.reject_tcp(flow, TcpCloseDisposition::Overloaded, state)
                    .await;
                return;
            }
        };
        if self.cancellation.is_cancelled() {
            drop(permit);
            self.close_unadmitted_tcp(flow, TcpCloseDisposition::Cancelled, state);
            return;
        }

        let close = Arc::new(CloseOnce::new(flow.control.clone()));
        let cancellation = self.cancellation.child_token();
        let panic_close = close.clone();
        let active_close = close.clone();
        let abort_handle = state.tcp_tasks.spawn(async move {
            match AssertUnwindSafe(run_tcp_flow(flow, context, engine, cancellation, close))
                .catch_unwind()
                .await
            {
                Ok(completion) => completion,
                Err(_) => task_completion_from_close(
                    TcpCloseDisposition::RuntimeFailure,
                    0,
                    0,
                    true,
                    panic_close.close(TcpCloseDisposition::RuntimeFailure).await,
                ),
            }
        });
        let task_id = abort_handle.id();
        if !state.active_flow_ids.insert(flow_id)
            || state
                .tcp_active_by_task
                .insert(
                    task_id,
                    ActiveRecord {
                        flow_id,
                        close: active_close,
                        _permit: permit,
                    },
                )
                .is_some()
        {
            self.metrics.invariant_violation();
        }
        self.metrics.admitted_tcp();
    }

    async fn reject_tcp(
        &self,
        flow: IngressTcpFlow,
        disposition: TcpCloseDisposition,
        state: &mut RuntimeState,
    ) {
        self.metrics.rejected_tcp(disposition);
        self.close_unadmitted_tcp(flow, disposition, state);
    }

    fn close_unadmitted_tcp(
        &self,
        flow: IngressTcpFlow,
        disposition: TcpCloseDisposition,
        state: &mut RuntimeState,
    ) {
        let IngressTcpFlow {
            stream, control, ..
        } = flow;
        drop(stream);
        let close = Arc::new(CloseOnce::new(control));
        if state.tcp_rejected_close_count() >= state.max_tcp_retained_rejections {
            // The admission loop fences new accepts before reaching this
            // branch. Hitting it means a caller bypassed that ownership
            // contract. Cancel admission, but still retain this already-owned
            // control: silently dropping a provider tuple is never an
            // admissible response to an internal bound violation. Because
            // there is exactly one accept future per transport, this
            // emergency reserve is bounded to one object beyond the declared
            // rejection ceiling.
            self.metrics.invariant_violation();
            self.cleanup_uncertain.store(true, Ordering::Release);
            self.cancellation.cancel();
        }
        state
            .pending_tcp_rejected_closes
            .push(PendingRejectedTcpClose { close, disposition });
    }

    async fn admit_udp(&self, association: IngressUdpAssociation, state: &mut RuntimeState) {
        if self.cancellation.is_cancelled() {
            self.close_unadmitted_udp(association, UdpCloseDisposition::Cancelled, state);
            return;
        }
        let descriptor = &association.descriptor;
        if let Err(error) = descriptor.validate_for(self.config.generation()) {
            let disposition = if matches!(error, IngressError::StaleGeneration { .. }) {
                UdpCloseDisposition::StaleGeneration
            } else {
                UdpCloseDisposition::InvalidDescriptor
            };
            self.reject_udp(association, disposition, state).await;
            return;
        }
        if descriptor.platform != self.config.platform()
            || descriptor.transport != FlowTransport::Udp
        {
            self.reject_udp(association, UdpCloseDisposition::InvalidDescriptor, state)
                .await;
            return;
        }
        if let ProfileBinding::TrustedQueue {
            config_revision, ..
        } = &descriptor.profile_binding
            && *config_revision != self.config.config_revision()
        {
            self.reject_udp(association, UdpCloseDisposition::StaleGeneration, state)
                .await;
            return;
        }
        if state.active_flow_ids.contains(&descriptor.flow_id) {
            self.reject_udp(association, UdpCloseDisposition::DuplicateFlow, state)
                .await;
            return;
        }

        let input = descriptor.profile_selection_input();
        let selection = match self.selector.select(&input) {
            Ok(selection) => selection,
            Err(_) => {
                self.reject_udp(association, UdpCloseDisposition::NoProfile, state)
                    .await;
                return;
            }
        };
        let Some(engine) = self.engines.get(selection.profile_id()).cloned() else {
            self.reject_udp(association, UdpCloseDisposition::NoProfile, state)
                .await;
            return;
        };
        let context = match FlowContext::try_from(descriptor) {
            Ok(context) => context,
            Err(_) => {
                self.reject_udp(association, UdpCloseDisposition::InvalidDescriptor, state)
                    .await;
                return;
            }
        };
        let flow_id = descriptor.flow_id;
        let permit = match self.udp_admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                self.reject_udp(association, UdpCloseDisposition::Overloaded, state)
                    .await;
                return;
            }
        };
        if self.cancellation.is_cancelled() {
            drop(permit);
            self.close_unadmitted_udp(association, UdpCloseDisposition::Cancelled, state);
            return;
        }

        let close = Arc::new(UdpCloseOnce::new(association.control.clone()));
        let cancellation = self.cancellation.child_token();
        let panic_close = close.clone();
        let active_close = close.clone();
        let idle_timeout = self.config.udp_idle_timeout();
        let in_flight_budget = Arc::clone(&self.udp_in_flight_budget);
        let abort_handle = state.udp_tasks.spawn(async move {
            match AssertUnwindSafe(run_udp_association(
                association,
                context,
                engine,
                cancellation,
                idle_timeout,
                in_flight_budget,
                close,
            ))
            .catch_unwind()
            .await
            {
                Ok(completion) => completion,
                Err(_) => udp_task_completion_from_close(
                    UdpCloseDisposition::RuntimeFailure,
                    UdpRelayCounters::default(),
                    true,
                    panic_close.close(UdpCloseDisposition::RuntimeFailure).await,
                ),
            }
        });
        let task_id = abort_handle.id();
        if !state.active_flow_ids.insert(flow_id)
            || state
                .udp_active_by_task
                .insert(
                    task_id,
                    UdpActiveRecord {
                        flow_id,
                        close: active_close,
                        _permit: permit,
                    },
                )
                .is_some()
        {
            self.metrics.invariant_violation();
        }
        self.metrics.admitted_udp();
    }

    async fn reject_udp(
        &self,
        association: IngressUdpAssociation,
        disposition: UdpCloseDisposition,
        state: &mut RuntimeState,
    ) {
        self.metrics.rejected_udp(disposition);
        self.close_unadmitted_udp(association, disposition, state);
    }

    fn close_unadmitted_udp(
        &self,
        association: IngressUdpAssociation,
        disposition: UdpCloseDisposition,
        state: &mut RuntimeState,
    ) {
        let IngressUdpAssociation { io, control, .. } = association;
        drop(io);
        let close = Arc::new(UdpCloseOnce::new(control));
        if state.udp_rejected_close_count() >= state.max_udp_retained_rejections {
            self.metrics.invariant_violation();
            self.cleanup_uncertain.store(true, Ordering::Release);
            self.cancellation.cancel();
        }
        state
            .pending_udp_rejected_closes
            .push(PendingRejectedUdpClose { close, disposition });
    }

    fn schedule_rejected_closes(&self, state: &mut RuntimeState) {
        while state.tcp_rejected_close_tasks.len() < state.max_tcp_close_tasks {
            let Some(pending) = state.pending_tcp_rejected_closes.pop() else {
                break;
            };
            let close = Arc::clone(&pending.close);
            let disposition = pending.disposition;
            let abort = state
                .tcp_rejected_close_tasks
                .spawn(async move { pending.close.close(pending.disposition).await });
            if state
                .tcp_rejected_close_by_task
                .insert(abort.id(), PendingRejectedTcpClose { close, disposition })
                .is_some()
            {
                self.metrics.invariant_violation();
            }
        }
        while state.udp_rejected_close_tasks.len() < state.max_udp_close_tasks {
            let Some(pending) = state.pending_udp_rejected_closes.pop() else {
                break;
            };
            let close = Arc::clone(&pending.close);
            let disposition = pending.disposition;
            let abort = state
                .udp_rejected_close_tasks
                .spawn(async move { pending.close.close(pending.disposition).await });
            if state
                .udp_rejected_close_by_task
                .insert(abort.id(), PendingRejectedUdpClose { close, disposition })
                .is_some()
            {
                self.metrics.invariant_violation();
            }
        }
    }

    fn finish_tcp_join(
        &self,
        result: Result<(TaskId, TaskCompletion), JoinError>,
        state: &mut RuntimeState,
    ) {
        let (task_id, completion) = match result {
            Ok(value) => value,
            Err(error) => {
                let task_id = error.id();
                let panicked = error.is_panic();
                let Some(active) = self.take_tcp_active(task_id, state) else {
                    self.metrics.invariant_violation();
                    return;
                };
                let disposition = active.close.disposition().unwrap_or(if panicked {
                    TcpCloseDisposition::RuntimeFailure
                } else {
                    TcpCloseDisposition::Cancelled
                });
                let mut completion = TaskCompletion {
                    disposition,
                    bytes_to_egress: 0,
                    bytes_to_ingress: 0,
                    close_failed: true,
                    panicked,
                };
                match active.close.state() {
                    CLOSE_SUCCEEDED => {
                        completion.close_failed = false;
                        self.finalize_tcp_active(active, completion, state);
                    }
                    CLOSE_OPEN => state
                        .pending_tcp_finalization
                        .push(PendingFinalization { active, completion }),
                    CLOSE_FAILED | CLOSE_IN_PROGRESS => {
                        self.metrics.active_control_close_failure();
                        state
                            .quarantined_tcp_finalization
                            .push(PendingFinalization { active, completion });
                    }
                    _ => {
                        self.metrics.invariant_violation();
                        state
                            .quarantined_tcp_finalization
                            .push(PendingFinalization { active, completion });
                    }
                }
                return;
            }
        };
        let Some(active) = self.take_tcp_active(task_id, state) else {
            self.metrics.invariant_violation();
            return;
        };
        if completion.close_failed {
            self.metrics.active_control_close_failure();
            state
                .quarantined_tcp_finalization
                .push(PendingFinalization { active, completion });
        } else {
            if active.close.state() != CLOSE_SUCCEEDED {
                self.metrics.invariant_violation();
            }
            self.finalize_tcp_active(active, completion, state);
        }
    }

    fn finalize_tcp_active(
        &self,
        active: ActiveRecord,
        completion: TaskCompletion,
        state: &mut RuntimeState,
    ) {
        if completion.close_failed || active.close.state() != CLOSE_SUCCEEDED {
            self.metrics.invariant_violation();
            state
                .quarantined_tcp_finalization
                .push(PendingFinalization { active, completion });
            return;
        }
        if !state.active_flow_ids.remove(&active.flow_id) {
            self.metrics.invariant_violation();
        }
        self.metrics.completed_tcp(&completion);
        drop(active);
    }

    fn take_tcp_active(&self, task_id: TaskId, state: &mut RuntimeState) -> Option<ActiveRecord> {
        state.tcp_active_by_task.remove(&task_id)
    }

    fn finish_udp_join(
        &self,
        result: Result<(TaskId, UdpTaskCompletion), JoinError>,
        state: &mut RuntimeState,
    ) {
        let (task_id, completion) = match result {
            Ok(value) => value,
            Err(error) => {
                let task_id = error.id();
                let panicked = error.is_panic();
                let Some(active) = self.take_udp_active(task_id, state) else {
                    self.metrics.invariant_violation();
                    return;
                };
                let disposition = active.close.disposition().unwrap_or(if panicked {
                    UdpCloseDisposition::RuntimeFailure
                } else {
                    UdpCloseDisposition::Cancelled
                });
                let mut completion = UdpTaskCompletion {
                    disposition,
                    datagrams_to_egress: 0,
                    datagrams_to_ingress: 0,
                    bytes_to_egress: 0,
                    bytes_to_ingress: 0,
                    close_failed: true,
                    panicked,
                };
                match active.close.state() {
                    CLOSE_SUCCEEDED => {
                        completion.close_failed = false;
                        self.finalize_udp_active(active, completion, state);
                    }
                    CLOSE_OPEN => state
                        .pending_udp_finalization
                        .push(UdpPendingFinalization { active, completion }),
                    CLOSE_FAILED | CLOSE_IN_PROGRESS => {
                        self.metrics.active_control_close_failure();
                        state
                            .quarantined_udp_finalization
                            .push(UdpPendingFinalization { active, completion });
                    }
                    _ => {
                        self.metrics.invariant_violation();
                        state
                            .quarantined_udp_finalization
                            .push(UdpPendingFinalization { active, completion });
                    }
                }
                return;
            }
        };
        let Some(active) = self.take_udp_active(task_id, state) else {
            self.metrics.invariant_violation();
            return;
        };
        if completion.close_failed {
            self.metrics.active_control_close_failure();
            state
                .quarantined_udp_finalization
                .push(UdpPendingFinalization { active, completion });
        } else {
            if active.close.state() != CLOSE_SUCCEEDED {
                self.metrics.invariant_violation();
            }
            self.finalize_udp_active(active, completion, state);
        }
    }

    fn finalize_udp_active(
        &self,
        active: UdpActiveRecord,
        completion: UdpTaskCompletion,
        state: &mut RuntimeState,
    ) {
        if completion.close_failed || active.close.state() != CLOSE_SUCCEEDED {
            self.metrics.invariant_violation();
            state
                .quarantined_udp_finalization
                .push(UdpPendingFinalization { active, completion });
            return;
        }
        if !state.active_flow_ids.remove(&active.flow_id) {
            self.metrics.invariant_violation();
        }
        self.metrics.completed_udp(&completion);
        drop(active);
    }

    fn take_udp_active(
        &self,
        task_id: TaskId,
        state: &mut RuntimeState,
    ) -> Option<UdpActiveRecord> {
        state.udp_active_by_task.remove(&task_id)
    }

    fn finish_tcp_rejected_close_join(
        &self,
        result: Result<(TaskId, CloseOutcome), JoinError>,
        state: &mut RuntimeState,
    ) {
        let (task_id, outcome) = close_join_outcome(result);
        let Some(pending) = state.tcp_rejected_close_by_task.remove(&task_id) else {
            self.metrics.invariant_violation();
            return;
        };
        if outcome.failed || pending.close.state() != CLOSE_SUCCEEDED {
            let outcome = if outcome.failed {
                outcome
            } else {
                self.metrics.invariant_violation();
                CloseOutcome {
                    failed: true,
                    panicked: false,
                }
            };
            self.metrics.rejected_close(outcome);
            state.quarantined_tcp_rejected_closes.push(pending);
        }
    }

    fn finish_udp_rejected_close_join(
        &self,
        result: Result<(TaskId, CloseOutcome), JoinError>,
        state: &mut RuntimeState,
    ) {
        let (task_id, outcome) = close_join_outcome(result);
        let Some(pending) = state.udp_rejected_close_by_task.remove(&task_id) else {
            self.metrics.invariant_violation();
            return;
        };
        if outcome.failed || pending.close.state() != CLOSE_SUCCEEDED {
            let outcome = if outcome.failed {
                outcome
            } else {
                self.metrics.invariant_violation();
                CloseOutcome {
                    failed: true,
                    panicked: false,
                }
            };
            self.metrics.rejected_close(outcome);
            state.quarantined_udp_rejected_closes.push(pending);
        }
    }

    async fn fence_and_drain_ingress_until(
        &self,
        state: &mut RuntimeState,
        fence_deadline: Instant,
        drain_deadline: Instant,
    ) {
        let tcp = state
            .tcp_ingress
            .as_ref()
            .filter(|cleanup| !cleanup.fenced)
            .map(|cleanup| Arc::clone(&cleanup.ingress));
        let udp = state
            .udp_ingress
            .as_ref()
            .filter(|cleanup| !cleanup.fenced)
            .map(|cleanup| Arc::clone(&cleanup.ingress));
        // Both fences are polled together. A hostile/hung implementation for
        // one transport cannot prevent the other transport from committing
        // its admission close under the same absolute deadline.
        let (tcp_fence, udp_fence) = tokio::join!(
            close_tcp_admission_until(tcp, fence_deadline),
            close_udp_admission_until(udp, fence_deadline),
        );
        match tcp_fence {
            IngressFenceOutcome::Succeeded => {
                if let Some(cleanup) = state.tcp_ingress.as_mut() {
                    cleanup.fenced = true;
                }
            }
            IngressFenceOutcome::Panicked => {
                self.cleanup_uncertain.store(true, Ordering::Release);
                if let Some(cleanup) = state.tcp_ingress.as_mut() {
                    cleanup.contract_violated = true;
                }
            }
            IngressFenceOutcome::NotNeeded
            | IngressFenceOutcome::Failed
            | IngressFenceOutcome::TimedOut => {}
        }
        match udp_fence {
            IngressFenceOutcome::Succeeded => {
                if let Some(cleanup) = state.udp_ingress.as_mut() {
                    cleanup.fenced = true;
                }
            }
            IngressFenceOutcome::Panicked => {
                self.cleanup_uncertain.store(true, Ordering::Release);
                if let Some(cleanup) = state.udp_ingress.as_mut() {
                    cleanup.contract_violated = true;
                }
            }
            IngressFenceOutcome::NotNeeded
            | IngressFenceOutcome::Failed
            | IngressFenceOutcome::TimedOut => {}
        }

        let now = Instant::now();
        let tcp_deadline = now + drain_deadline.saturating_duration_since(now) / 2;
        self.drain_tcp_ingress_until(state, tcp_deadline).await;
        self.drain_udp_ingress_until(state, drain_deadline).await;
    }

    async fn drain_tcp_ingress_until(&self, state: &mut RuntimeState, deadline: Instant) {
        loop {
            if Instant::now() >= deadline {
                return;
            }
            let Some(cleanup) = state.tcp_ingress.as_ref() else {
                return;
            };
            if !cleanup.fenced || cleanup.contract_violated {
                return;
            }
            let ingress = Arc::clone(&cleanup.ingress);
            let disposition = cleanup
                .disposition
                .unwrap_or(TcpCloseDisposition::RuntimeFailure);
            let accepted = tokio::time::timeout_at(
                deadline,
                AssertUnwindSafe(ingress.accept_tcp()).catch_unwind(),
            )
            .await;
            match accepted {
                Ok(Ok(Ok(Some(flow)))) => {
                    let overflow = {
                        let cleanup = state
                            .tcp_ingress
                            .as_mut()
                            .expect("TCP ingress cleanup remains owned");
                        if cleanup.seen >= cleanup.capacity {
                            cleanup.contract_violated = true;
                            true
                        } else {
                            cleanup.seen += 1;
                            false
                        }
                    };
                    self.close_unadmitted_tcp(flow, disposition, state);
                    if overflow {
                        self.metrics.invariant_violation();
                        self.cleanup_uncertain.store(true, Ordering::Release);
                        return;
                    }
                    if state
                        .tcp_ingress
                        .as_ref()
                        .is_some_and(|cleanup| cleanup.seen % 64 == 0)
                    {
                        tokio::task::yield_now().await;
                    }
                }
                Ok(Ok(Ok(None))) => {
                    state.tcp_ingress = None;
                    return;
                }
                Ok(Ok(Err(_))) | Err(_) => return,
                Ok(Err(_)) => {
                    self.cleanup_uncertain.store(true, Ordering::Release);
                    if let Some(cleanup) = state.tcp_ingress.as_mut() {
                        cleanup.contract_violated = true;
                    }
                    return;
                }
            }
        }
    }

    async fn drain_udp_ingress_until(&self, state: &mut RuntimeState, deadline: Instant) {
        loop {
            if Instant::now() >= deadline {
                return;
            }
            let Some(cleanup) = state.udp_ingress.as_ref() else {
                return;
            };
            if !cleanup.fenced || cleanup.contract_violated {
                return;
            }
            let ingress = Arc::clone(&cleanup.ingress);
            let disposition = cleanup
                .disposition
                .unwrap_or(UdpCloseDisposition::RuntimeFailure);
            let accepted = tokio::time::timeout_at(
                deadline,
                AssertUnwindSafe(ingress.accept_udp()).catch_unwind(),
            )
            .await;
            match accepted {
                Ok(Ok(Ok(Some(association)))) => {
                    let overflow = {
                        let cleanup = state
                            .udp_ingress
                            .as_mut()
                            .expect("UDP ingress cleanup remains owned");
                        if cleanup.seen >= cleanup.capacity {
                            cleanup.contract_violated = true;
                            true
                        } else {
                            cleanup.seen += 1;
                            false
                        }
                    };
                    self.close_unadmitted_udp(association, disposition, state);
                    if overflow {
                        self.metrics.invariant_violation();
                        self.cleanup_uncertain.store(true, Ordering::Release);
                        return;
                    }
                    if state
                        .udp_ingress
                        .as_ref()
                        .is_some_and(|cleanup| cleanup.seen % 64 == 0)
                    {
                        tokio::task::yield_now().await;
                    }
                }
                Ok(Ok(Ok(None))) => {
                    state.udp_ingress = None;
                    return;
                }
                Ok(Ok(Err(_))) | Err(_) => return,
                Ok(Err(_)) => {
                    self.cleanup_uncertain.store(true, Ordering::Release);
                    if let Some(cleanup) = state.udp_ingress.as_mut() {
                        cleanup.contract_violated = true;
                    }
                    return;
                }
            }
        }
    }

    async fn cleanup(&self, state: &mut RuntimeState, reason: StopReason) -> usize {
        let started = Instant::now();
        let grace = self.config.shutdown_grace();
        let ingress_fence_deadline = started + grace.mul_f64(0.15);
        let ingress_drain_deadline = started + grace.mul_f64(0.40);
        let graceful_deadline = started + grace.mul_f64(0.50);
        let abort_deadline = started + grace.mul_f64(0.70);
        let close_deadline = started + grace.mul_f64(0.85);
        let total_deadline = started + grace;
        // Each explicit cleanup call grants exactly one retry to controls
        // quarantined by an earlier attempt. Failures produced during this
        // attempt remain quarantined for the caller-owned reconcile retry;
        // permanent failures therefore cannot hot-loop inside one deadline.
        state.begin_cleanup_attempt();
        state.prepare_ingress_cleanup(reason);

        if reason != StopReason::Eof {
            self.cancellation.cancel();
        }
        self.fence_and_drain_ingress_until(state, ingress_fence_deadline, ingress_drain_deadline)
            .await;

        if reason == StopReason::Eof {
            self.drain_transport_tasks_until(state, graceful_deadline)
                .await;
        }
        if state.has_transport_tasks() || reason != StopReason::Eof {
            self.cancellation.cancel();
            self.drain_transport_tasks_until(state, abort_deadline)
                .await;
        }

        if state.has_transport_tasks() {
            state.tcp_tasks.abort_all();
            state.udp_tasks.abort_all();
            while let Some(result) = state.tcp_tasks.try_join_next_with_id() {
                self.finish_tcp_join(result, state);
            }
            while let Some(result) = state.udp_tasks.try_join_next_with_id() {
                self.finish_udp_join(result, state);
            }
            // Aborted Tokio tasks become ready promptly, but keep the absolute
            // deadline authoritative even if a foreign future misbehaves.
            self.drain_transport_tasks_until(state, close_deadline)
                .await;
        }

        // Never detach metadata from a task whose abort completion has not
        // been observed. A retryable cleanup owner retains both JoinSet and
        // active record beyond this first deadline.
        if state.tcp_tasks.is_empty() {
            for (_, active) in state.tcp_active_by_task.drain() {
                let disposition = active
                    .close
                    .disposition()
                    .unwrap_or(TcpCloseDisposition::Cancelled);
                state.pending_tcp_finalization.push(PendingFinalization {
                    active,
                    completion: TaskCompletion {
                        disposition,
                        bytes_to_egress: 0,
                        bytes_to_ingress: 0,
                        close_failed: true,
                        panicked: false,
                    },
                });
            }
        }
        if state.udp_tasks.is_empty() {
            for (_, active) in state.udp_active_by_task.drain() {
                let disposition = active
                    .close
                    .disposition()
                    .unwrap_or(UdpCloseDisposition::Cancelled);
                state.pending_udp_finalization.push(UdpPendingFinalization {
                    active,
                    completion: UdpTaskCompletion {
                        disposition,
                        datagrams_to_egress: 0,
                        datagrams_to_ingress: 0,
                        bytes_to_egress: 0,
                        bytes_to_ingress: 0,
                        close_failed: true,
                        panicked: false,
                    },
                });
            }
        }
        self.finalize_pending_until(state, close_deadline).await;
        self.drain_rejected_closes_until(state, close_deadline)
            .await;
        self.cancellation.cancel();

        let local_incomplete =
            state.has_local_cleanup() || self.cleanup_uncertain.load(Ordering::Acquire);
        if local_incomplete {
            let retained = state.take_for_retention();
            self.cleanup_state.lock().await.push(retained);
        }
        let owner_failures = if local_incomplete {
            0
        } else {
            self.shutdown_owners_until(total_deadline).await
        };
        self.metrics.owner_shutdown_failures(owner_failures);
        self.cleanup_pending
            .store(owner_failures > 0 || local_incomplete, Ordering::Release);
        owner_failures + usize::from(local_incomplete)
    }

    async fn drain_transport_tasks_until(&self, state: &mut RuntimeState, deadline: Instant) {
        while state.has_transport_tasks() && Instant::now() < deadline {
            tokio::select! {
                completion = state.tcp_tasks.join_next_with_id(), if !state.tcp_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_tcp_join(result, state);
                    }
                }
                completion = state.udp_tasks.join_next_with_id(), if !state.udp_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_udp_join(result, state);
                    }
                }
                completion = state.tcp_rejected_close_tasks.join_next_with_id(), if !state.tcp_rejected_close_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_tcp_rejected_close_join(result, state);
                    }
                }
                completion = state.udp_rejected_close_tasks.join_next_with_id(), if !state.udp_rejected_close_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_udp_rejected_close_join(result, state);
                    }
                }
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }
    }

    async fn finalize_pending_until(&self, state: &mut RuntimeState, deadline: Instant) {
        loop {
            self.schedule_finalizations(state);
            while let Some(result) = state.tcp_finalization_tasks.try_join_next_with_id() {
                self.finish_tcp_finalization_join(result, state);
            }
            while let Some(result) = state.udp_finalization_tasks.try_join_next_with_id() {
                self.finish_udp_finalization_join(result, state);
            }
            self.schedule_finalizations(state);

            if state.pending_tcp_finalization.is_empty()
                && state.pending_udp_finalization.is_empty()
                && state.tcp_finalization_tasks.is_empty()
                && state.udp_finalization_tasks.is_empty()
            {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::select! {
                completion = state.tcp_finalization_tasks.join_next_with_id(), if !state.tcp_finalization_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_tcp_finalization_join(result, state);
                    }
                }
                completion = state.udp_finalization_tasks.join_next_with_id(), if !state.udp_finalization_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_udp_finalization_join(result, state);
                    }
                }
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }
    }

    fn schedule_finalizations(&self, state: &mut RuntimeState) {
        while state.tcp_finalization_tasks.len() < state.max_tcp_close_tasks {
            let Some(pending) = state.pending_tcp_finalization.pop() else {
                break;
            };
            let close = Arc::clone(&pending.active.close);
            let disposition = pending.completion.disposition;
            let abort = state
                .tcp_finalization_tasks
                .spawn(async move { close.close(disposition).await });
            if state
                .tcp_finalization_by_task
                .insert(abort.id(), pending)
                .is_some()
            {
                self.metrics.invariant_violation();
            }
        }
        while state.udp_finalization_tasks.len() < state.max_udp_close_tasks {
            let Some(pending) = state.pending_udp_finalization.pop() else {
                break;
            };
            let close = Arc::clone(&pending.active.close);
            let disposition = pending.completion.disposition;
            let abort = state
                .udp_finalization_tasks
                .spawn(async move { close.close(disposition).await });
            if state
                .udp_finalization_by_task
                .insert(abort.id(), pending)
                .is_some()
            {
                self.metrics.invariant_violation();
            }
        }
    }

    fn finish_tcp_finalization_join(
        &self,
        result: Result<(TaskId, CloseOutcome), JoinError>,
        state: &mut RuntimeState,
    ) {
        let (task_id, outcome) = close_join_outcome(result);
        let Some(mut pending) = state.tcp_finalization_by_task.remove(&task_id) else {
            self.metrics.invariant_violation();
            return;
        };
        if outcome.failed {
            self.metrics.active_control_close_failure();
            pending.completion.close_failed = true;
            pending.completion.panicked |= outcome.panicked;
            state.quarantined_tcp_finalization.push(pending);
        } else {
            pending.completion.close_failed = false;
            self.finalize_tcp_active(pending.active, pending.completion, state);
        }
    }

    fn finish_udp_finalization_join(
        &self,
        result: Result<(TaskId, CloseOutcome), JoinError>,
        state: &mut RuntimeState,
    ) {
        let (task_id, outcome) = close_join_outcome(result);
        let Some(mut pending) = state.udp_finalization_by_task.remove(&task_id) else {
            self.metrics.invariant_violation();
            return;
        };
        if outcome.failed {
            self.metrics.active_control_close_failure();
            pending.completion.close_failed = true;
            pending.completion.panicked |= outcome.panicked;
            state.quarantined_udp_finalization.push(pending);
        } else {
            pending.completion.close_failed = false;
            self.finalize_udp_active(pending.active, pending.completion, state);
        }
    }

    async fn drain_rejected_closes_until(&self, state: &mut RuntimeState, deadline: Instant) {
        loop {
            self.schedule_rejected_closes(state);
            while let Some(result) = state.tcp_rejected_close_tasks.try_join_next_with_id() {
                self.finish_tcp_rejected_close_join(result, state);
            }
            while let Some(result) = state.udp_rejected_close_tasks.try_join_next_with_id() {
                self.finish_udp_rejected_close_join(result, state);
            }
            self.schedule_rejected_closes(state);
            if state.pending_tcp_rejected_closes.is_empty()
                && state.pending_udp_rejected_closes.is_empty()
                && state.tcp_rejected_close_tasks.is_empty()
                && state.udp_rejected_close_tasks.is_empty()
            {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::select! {
                completion = state.tcp_rejected_close_tasks.join_next_with_id(), if !state.tcp_rejected_close_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_tcp_rejected_close_join(result, state);
                    }
                }
                completion = state.udp_rejected_close_tasks.join_next_with_id(), if !state.udp_rejected_close_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_udp_rejected_close_join(result, state);
                    }
                }
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }
        while let Some(result) = state.tcp_rejected_close_tasks.try_join_next_with_id() {
            self.finish_tcp_rejected_close_join(result, state);
        }
        while let Some(result) = state.udp_rejected_close_tasks.try_join_next_with_id() {
            self.finish_udp_rejected_close_join(result, state);
        }
        let forced = state
            .tcp_rejected_close_tasks
            .len()
            .saturating_add(state.udp_rejected_close_tasks.len());
        if forced > 0 {
            state.tcp_rejected_close_tasks.abort_all();
            state.udp_rejected_close_tasks.abort_all();
            self.metrics.forced_drops(forced);
        }
    }

    async fn retry_local_cleanup_until(&self, deadline: Instant) -> bool {
        let mut retained = self.cleanup_state.lock().await;
        if retained.is_empty() {
            return true;
        }

        let mut index = 0;
        while index < retained.len() {
            let clean = self
                .retry_one_local_cleanup_until(&mut retained[index], deadline)
                .await;
            if clean {
                retained.remove(index);
            } else {
                index += 1;
            }
        }
        retained.is_empty()
    }

    async fn retry_one_local_cleanup_until(
        &self,
        state: &mut RuntimeState,
        deadline: Instant,
    ) -> bool {
        state.begin_cleanup_attempt();
        let now = Instant::now();
        let remaining = deadline.saturating_duration_since(now);
        let ingress_fence_deadline = now + remaining.mul_f64(0.20);
        let ingress_drain_deadline = now + remaining.mul_f64(0.40);
        self.fence_and_drain_ingress_until(state, ingress_fence_deadline, ingress_drain_deadline)
            .await;
        state.tcp_tasks.abort_all();
        state.udp_tasks.abort_all();
        self.drain_transport_tasks_until(state, deadline).await;
        if state.tcp_tasks.is_empty() {
            for (_, active) in state.tcp_active_by_task.drain() {
                let disposition = active
                    .close
                    .disposition()
                    .unwrap_or(TcpCloseDisposition::Cancelled);
                state.pending_tcp_finalization.push(PendingFinalization {
                    active,
                    completion: TaskCompletion {
                        disposition,
                        bytes_to_egress: 0,
                        bytes_to_ingress: 0,
                        close_failed: true,
                        panicked: false,
                    },
                });
            }
        }
        if state.udp_tasks.is_empty() {
            for (_, active) in state.udp_active_by_task.drain() {
                let disposition = active
                    .close
                    .disposition()
                    .unwrap_or(UdpCloseDisposition::Cancelled);
                state.pending_udp_finalization.push(UdpPendingFinalization {
                    active,
                    completion: UdpTaskCompletion {
                        disposition,
                        datagrams_to_egress: 0,
                        datagrams_to_ingress: 0,
                        bytes_to_egress: 0,
                        bytes_to_ingress: 0,
                        close_failed: true,
                        panicked: false,
                    },
                });
            }
        }
        self.finalize_pending_until(state, deadline).await;
        self.drain_rejected_closes_until(state, deadline).await;
        !state.has_local_cleanup()
    }

    async fn shutdown_owners_until(&self, deadline: Instant) -> usize {
        let mut pending = self.pending_owners.lock().await;
        if pending.is_empty() {
            return 0;
        }
        let mut shutdowns: FuturesUnordered<BoxFuture<'static, (Arc<dyn FlowRuntimeOwner>, bool)>> =
            FuturesUnordered::new();
        for owner in pending.iter() {
            let owner = owner.clone();
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
                    pending.retain(|candidate| !Arc::ptr_eq(candidate, &owner));
                }
                Ok(Some((_owner, false))) => {}
                Ok(None) => break,
                Err(_) => break,
            }
        }
        pending.len()
    }
}

/// Joinable owner of the internal supervisor. There is intentionally no
/// public abort handle: all stop paths signal cancellation and let the owned
/// supervisor execute flow/control/egress cleanup.
pub struct FlowRuntimeHandle {
    cancellation: CancellationToken,
    supervisor: Option<JoinHandle<Result<FlowRuntimeSnapshot, FlowRuntimeError>>>,
}

impl FlowRuntimeHandle {
    pub async fn stop(self) -> Result<FlowRuntimeSnapshot, FlowRuntimeError> {
        self.cancellation.cancel();
        self.wait().await
    }

    pub async fn wait(mut self) -> Result<FlowRuntimeSnapshot, FlowRuntimeError> {
        let supervisor = self
            .supervisor
            .take()
            .ok_or(FlowRuntimeError::SupervisorFailed)?;
        let mut guard = WaitCancellationGuard {
            cancellation: self.cancellation.clone(),
            armed: true,
        };
        let result = supervisor
            .await
            .map_err(|_| FlowRuntimeError::SupervisorFailed)?;
        guard.armed = false;
        result
    }
}

impl Drop for FlowRuntimeHandle {
    fn drop(&mut self) {
        if self.supervisor.is_some() {
            self.cancellation.cancel();
        }
    }
}

impl std::fmt::Debug for FlowRuntimeHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FlowRuntimeHandle")
            .field("cancelled", &self.cancellation.is_cancelled())
            .field("supervisor_owned", &self.supervisor.is_some())
            .finish()
    }
}

struct WaitCancellationGuard {
    cancellation: CancellationToken,
    armed: bool,
}

impl Drop for WaitCancellationGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IngressFenceOutcome {
    NotNeeded,
    Succeeded,
    Failed,
    Panicked,
    TimedOut,
}

async fn close_tcp_admission_until(
    ingress: Option<Arc<dyn FlowIngress>>,
    deadline: Instant,
) -> IngressFenceOutcome {
    let Some(ingress) = ingress else {
        return IngressFenceOutcome::NotNeeded;
    };
    match tokio::time::timeout_at(
        deadline,
        AssertUnwindSafe(ingress.close_tcp_admission()).catch_unwind(),
    )
    .await
    {
        Ok(Ok(Ok(()))) => IngressFenceOutcome::Succeeded,
        Ok(Ok(Err(_))) => IngressFenceOutcome::Failed,
        Ok(Err(_)) => IngressFenceOutcome::Panicked,
        Err(_) => IngressFenceOutcome::TimedOut,
    }
}

async fn close_udp_admission_until(
    ingress: Option<Arc<dyn UdpFlowIngress>>,
    deadline: Instant,
) -> IngressFenceOutcome {
    let Some(ingress) = ingress else {
        return IngressFenceOutcome::NotNeeded;
    };
    match tokio::time::timeout_at(
        deadline,
        AssertUnwindSafe(ingress.close_udp_admission()).catch_unwind(),
    )
    .await
    {
        Ok(Ok(Ok(()))) => IngressFenceOutcome::Succeeded,
        Ok(Ok(Err(_))) => IngressFenceOutcome::Failed,
        Ok(Err(_)) => IngressFenceOutcome::Panicked,
        Err(_) => IngressFenceOutcome::TimedOut,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopReason {
    Eof,
    Cancelled,
    ControlCloseFailure,
    Ingress(FlowRuntimeError),
    SupervisorPanic,
}

enum AdmissionEvent {
    TcpTask(Option<Result<(TaskId, TaskCompletion), JoinError>>),
    UdpTask(Option<Result<(TaskId, UdpTaskCompletion), JoinError>>),
    TcpRejectedClose(Option<Result<(TaskId, CloseOutcome), JoinError>>),
    UdpRejectedClose(Option<Result<(TaskId, CloseOutcome), JoinError>>),
    TcpAccepted(Result<Option<IngressTcpFlow>, IngressError>),
    UdpAccepted(Result<Option<IngressUdpAssociation>, IngressError>),
}

struct RuntimeState {
    tcp_ingress: Option<TcpIngressCleanupState>,
    udp_ingress: Option<UdpIngressCleanupState>,
    tcp_tasks: JoinSet<TaskCompletion>,
    udp_tasks: JoinSet<UdpTaskCompletion>,
    tcp_active_by_task: HashMap<TaskId, ActiveRecord>,
    udp_active_by_task: HashMap<TaskId, UdpActiveRecord>,
    active_flow_ids: HashSet<u64>,
    pending_tcp_finalization: Vec<PendingFinalization>,
    pending_udp_finalization: Vec<UdpPendingFinalization>,
    quarantined_tcp_finalization: Vec<PendingFinalization>,
    quarantined_udp_finalization: Vec<UdpPendingFinalization>,
    tcp_finalization_tasks: JoinSet<CloseOutcome>,
    udp_finalization_tasks: JoinSet<CloseOutcome>,
    tcp_finalization_by_task: HashMap<TaskId, PendingFinalization>,
    udp_finalization_by_task: HashMap<TaskId, UdpPendingFinalization>,
    pending_tcp_rejected_closes: Vec<PendingRejectedTcpClose>,
    pending_udp_rejected_closes: Vec<PendingRejectedUdpClose>,
    quarantined_tcp_rejected_closes: Vec<PendingRejectedTcpClose>,
    quarantined_udp_rejected_closes: Vec<PendingRejectedUdpClose>,
    tcp_rejected_close_tasks: JoinSet<CloseOutcome>,
    udp_rejected_close_tasks: JoinSet<CloseOutcome>,
    tcp_rejected_close_by_task: HashMap<TaskId, PendingRejectedTcpClose>,
    udp_rejected_close_by_task: HashMap<TaskId, PendingRejectedUdpClose>,
    max_tcp_close_tasks: usize,
    max_udp_close_tasks: usize,
    max_tcp_live_rejections: usize,
    max_udp_live_rejections: usize,
    max_tcp_retained_rejections: usize,
    max_udp_retained_rejections: usize,
}

impl RuntimeState {
    #[allow(clippy::too_many_arguments)]
    fn new(
        max_active_tcp_flows: usize,
        max_active_udp_associations: usize,
        tcp_ingress: Arc<dyn FlowIngress>,
        udp_ingress: Arc<dyn UdpFlowIngress>,
        tcp_ingress_capacity: usize,
        udp_ingress_capacity: usize,
        max_tcp_retained_rejections: usize,
        max_udp_retained_rejections: usize,
    ) -> Self {
        Self {
            tcp_ingress: Some(TcpIngressCleanupState::new(
                tcp_ingress,
                tcp_ingress_capacity,
            )),
            udp_ingress: Some(UdpIngressCleanupState::new(
                udp_ingress,
                udp_ingress_capacity,
            )),
            tcp_tasks: JoinSet::new(),
            udp_tasks: JoinSet::new(),
            tcp_active_by_task: HashMap::new(),
            udp_active_by_task: HashMap::new(),
            active_flow_ids: HashSet::new(),
            pending_tcp_finalization: Vec::new(),
            pending_udp_finalization: Vec::new(),
            quarantined_tcp_finalization: Vec::new(),
            quarantined_udp_finalization: Vec::new(),
            tcp_finalization_tasks: JoinSet::new(),
            udp_finalization_tasks: JoinSet::new(),
            tcp_finalization_by_task: HashMap::new(),
            udp_finalization_by_task: HashMap::new(),
            pending_tcp_rejected_closes: Vec::new(),
            pending_udp_rejected_closes: Vec::new(),
            quarantined_tcp_rejected_closes: Vec::new(),
            quarantined_udp_rejected_closes: Vec::new(),
            tcp_rejected_close_tasks: JoinSet::new(),
            udp_rejected_close_tasks: JoinSet::new(),
            tcp_rejected_close_by_task: HashMap::new(),
            udp_rejected_close_by_task: HashMap::new(),
            max_tcp_close_tasks: max_active_tcp_flows
                .clamp(MIN_CONTROL_CLOSE_CONCURRENCY, MAX_CONTROL_CLOSE_CONCURRENCY),
            max_udp_close_tasks: max_active_udp_associations
                .clamp(MIN_CONTROL_CLOSE_CONCURRENCY, MAX_CONTROL_CLOSE_CONCURRENCY),
            max_tcp_live_rejections: max_active_tcp_flows,
            max_udp_live_rejections: max_active_udp_associations,
            max_tcp_retained_rejections,
            max_udp_retained_rejections,
        }
    }

    fn empty(
        max_tcp_close_tasks: usize,
        max_udp_close_tasks: usize,
        max_tcp_live_rejections: usize,
        max_udp_live_rejections: usize,
        max_tcp_retained_rejections: usize,
        max_udp_retained_rejections: usize,
    ) -> Self {
        Self {
            tcp_ingress: None,
            udp_ingress: None,
            tcp_tasks: JoinSet::new(),
            udp_tasks: JoinSet::new(),
            tcp_active_by_task: HashMap::new(),
            udp_active_by_task: HashMap::new(),
            active_flow_ids: HashSet::new(),
            pending_tcp_finalization: Vec::new(),
            pending_udp_finalization: Vec::new(),
            quarantined_tcp_finalization: Vec::new(),
            quarantined_udp_finalization: Vec::new(),
            tcp_finalization_tasks: JoinSet::new(),
            udp_finalization_tasks: JoinSet::new(),
            tcp_finalization_by_task: HashMap::new(),
            udp_finalization_by_task: HashMap::new(),
            pending_tcp_rejected_closes: Vec::new(),
            pending_udp_rejected_closes: Vec::new(),
            quarantined_tcp_rejected_closes: Vec::new(),
            quarantined_udp_rejected_closes: Vec::new(),
            tcp_rejected_close_tasks: JoinSet::new(),
            udp_rejected_close_tasks: JoinSet::new(),
            tcp_rejected_close_by_task: HashMap::new(),
            udp_rejected_close_by_task: HashMap::new(),
            max_tcp_close_tasks,
            max_udp_close_tasks,
            max_tcp_live_rejections,
            max_udp_live_rejections,
            max_tcp_retained_rejections,
            max_udp_retained_rejections,
        }
    }

    fn take_for_retention(&mut self) -> Self {
        let replacement = Self::empty(
            self.max_tcp_close_tasks,
            self.max_udp_close_tasks,
            self.max_tcp_live_rejections,
            self.max_udp_live_rejections,
            self.max_tcp_retained_rejections,
            self.max_udp_retained_rejections,
        );
        std::mem::replace(self, replacement)
    }

    fn begin_cleanup_attempt(&mut self) {
        self.pending_tcp_finalization
            .append(&mut self.quarantined_tcp_finalization);
        self.pending_udp_finalization
            .append(&mut self.quarantined_udp_finalization);
        self.pending_tcp_rejected_closes
            .append(&mut self.quarantined_tcp_rejected_closes);
        self.pending_udp_rejected_closes
            .append(&mut self.quarantined_udp_rejected_closes);
    }

    fn prepare_ingress_cleanup(&mut self, reason: StopReason) {
        let tcp_disposition = if reason == StopReason::Cancelled {
            TcpCloseDisposition::Cancelled
        } else {
            TcpCloseDisposition::RuntimeFailure
        };
        let udp_disposition = if reason == StopReason::Cancelled {
            UdpCloseDisposition::Cancelled
        } else {
            UdpCloseDisposition::RuntimeFailure
        };
        if let Some(cleanup) = self.tcp_ingress.as_mut() {
            match cleanup.disposition {
                Some(current) if current != tcp_disposition => cleanup.contract_violated = true,
                Some(_) => {}
                None => cleanup.disposition = Some(tcp_disposition),
            }
        }
        if let Some(cleanup) = self.udp_ingress.as_mut() {
            match cleanup.disposition {
                Some(current) if current != udp_disposition => cleanup.contract_violated = true,
                Some(_) => {}
                None => cleanup.disposition = Some(udp_disposition),
            }
        }
    }

    fn has_quarantined_close(&self) -> bool {
        !self.quarantined_tcp_finalization.is_empty()
            || !self.quarantined_udp_finalization.is_empty()
            || !self.quarantined_tcp_rejected_closes.is_empty()
            || !self.quarantined_udp_rejected_closes.is_empty()
    }

    fn tcp_rejected_close_count(&self) -> usize {
        self.pending_tcp_rejected_closes
            .len()
            .saturating_add(self.quarantined_tcp_rejected_closes.len())
            .saturating_add(self.tcp_rejected_close_by_task.len())
    }

    fn udp_rejected_close_count(&self) -> usize {
        self.pending_udp_rejected_closes
            .len()
            .saturating_add(self.quarantined_udp_rejected_closes.len())
            .saturating_add(self.udp_rejected_close_by_task.len())
    }

    fn has_transport_tasks(&self) -> bool {
        !self.tcp_tasks.is_empty() || !self.udp_tasks.is_empty()
    }

    fn has_local_cleanup(&self) -> bool {
        self.tcp_ingress.is_some()
            || self.udp_ingress.is_some()
            || self.has_transport_tasks()
            || !self.tcp_rejected_close_tasks.is_empty()
            || !self.udp_rejected_close_tasks.is_empty()
            || !self.pending_tcp_rejected_closes.is_empty()
            || !self.pending_udp_rejected_closes.is_empty()
            || !self.pending_tcp_finalization.is_empty()
            || !self.pending_udp_finalization.is_empty()
            || !self.quarantined_tcp_finalization.is_empty()
            || !self.quarantined_udp_finalization.is_empty()
            || !self.tcp_finalization_tasks.is_empty()
            || !self.udp_finalization_tasks.is_empty()
            || !self.tcp_finalization_by_task.is_empty()
            || !self.udp_finalization_by_task.is_empty()
            || !self.quarantined_tcp_rejected_closes.is_empty()
            || !self.quarantined_udp_rejected_closes.is_empty()
            || !self.tcp_rejected_close_by_task.is_empty()
            || !self.udp_rejected_close_by_task.is_empty()
            || !self.tcp_active_by_task.is_empty()
            || !self.udp_active_by_task.is_empty()
            || !self.active_flow_ids.is_empty()
    }
}

struct TcpIngressCleanupState {
    ingress: Arc<dyn FlowIngress>,
    capacity: usize,
    seen: usize,
    fenced: bool,
    contract_violated: bool,
    disposition: Option<TcpCloseDisposition>,
}

impl TcpIngressCleanupState {
    fn new(ingress: Arc<dyn FlowIngress>, capacity: usize) -> Self {
        Self {
            ingress,
            capacity,
            seen: 0,
            fenced: false,
            contract_violated: false,
            disposition: None,
        }
    }
}

struct UdpIngressCleanupState {
    ingress: Arc<dyn UdpFlowIngress>,
    capacity: usize,
    seen: usize,
    fenced: bool,
    contract_violated: bool,
    disposition: Option<UdpCloseDisposition>,
}

impl UdpIngressCleanupState {
    fn new(ingress: Arc<dyn UdpFlowIngress>, capacity: usize) -> Self {
        Self {
            ingress,
            capacity,
            seen: 0,
            fenced: false,
            contract_violated: false,
            disposition: None,
        }
    }
}

struct ActiveRecord {
    flow_id: u64,
    close: Arc<CloseOnce>,
    _permit: OwnedSemaphorePermit,
}

struct PendingFinalization {
    active: ActiveRecord,
    completion: TaskCompletion,
}

struct UdpActiveRecord {
    flow_id: u64,
    close: Arc<UdpCloseOnce>,
    _permit: OwnedSemaphorePermit,
}

struct UdpPendingFinalization {
    active: UdpActiveRecord,
    completion: UdpTaskCompletion,
}

struct PendingRejectedTcpClose {
    close: Arc<CloseOnce>,
    disposition: TcpCloseDisposition,
}

struct PendingRejectedUdpClose {
    close: Arc<UdpCloseOnce>,
    disposition: UdpCloseDisposition,
}

impl std::fmt::Debug for FlowRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FlowRuntime")
            .field("config", &self.config)
            .field("profile_count", &self.engines.len())
            .field("owner_count", &self.owner_count)
            .field("cleanup_pending", &self.has_pending_cleanup())
            .field("cancelled", &self.cancellation.is_cancelled())
            .field("lifecycle", &self.lifecycle())
            .field("snapshot", &self.snapshot())
            .finish()
    }
}

struct TaskCompletion {
    disposition: TcpCloseDisposition,
    bytes_to_egress: u64,
    bytes_to_ingress: u64,
    close_failed: bool,
    panicked: bool,
}

struct UdpTaskCompletion {
    disposition: UdpCloseDisposition,
    datagrams_to_egress: u64,
    datagrams_to_ingress: u64,
    bytes_to_egress: u64,
    bytes_to_ingress: u64,
    close_failed: bool,
    panicked: bool,
}

#[derive(Debug, Default, Clone, Copy)]
struct UdpRelayCounters {
    datagrams_to_egress: u64,
    datagrams_to_ingress: u64,
    bytes_to_egress: u64,
    bytes_to_ingress: u64,
}

async fn run_tcp_flow(
    flow: IngressTcpFlow,
    context: FlowContext,
    engine: Arc<FlowEngine>,
    cancellation: CancellationToken,
    close: Arc<CloseOnce>,
) -> TaskCompletion {
    let IngressTcpFlow { mut stream, .. } = flow;

    let outcome = engine.handle_tcp_with_cancel(&context, &cancellation).await;
    let (disposition, bytes_to_egress, bytes_to_ingress) = match outcome {
        Ok(outcome) if outcome.result.effective_action == RouteAction::Block => {
            (TcpCloseDisposition::PolicyBlocked, 0, 0)
        }
        Ok(mut outcome) => match outcome.stream.as_mut() {
            Some(egress) => {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => (TcpCloseDisposition::Cancelled, 0, 0),
                    copied = copy_bidirectional_counted(&mut stream, &mut egress.stream) => {
                        match copied {
                            Ok((upstream, downstream)) => {
                                (TcpCloseDisposition::Finished, upstream, downstream)
                            }
                            Err(error) => (
                                TcpCloseDisposition::RuntimeFailure,
                                error.bytes_a_to_b(),
                                error.bytes_b_to_a(),
                            ),
                        }
                    }
                }
            }
            None => (TcpCloseDisposition::RuntimeFailure, 0, 0),
        },
        Err(_) if cancellation.is_cancelled() => (TcpCloseDisposition::Cancelled, 0, 0),
        Err(_) => (TcpCloseDisposition::RuntimeFailure, 0, 0),
    };

    let close_outcome = close.close(disposition).await;
    task_completion_from_close(
        disposition,
        bytes_to_egress,
        bytes_to_ingress,
        false,
        close_outcome,
    )
}

async fn run_udp_association(
    association: IngressUdpAssociation,
    context: FlowContext,
    engine: Arc<FlowEngine>,
    cancellation: CancellationToken,
    idle_timeout: Duration,
    in_flight_budget: Arc<Semaphore>,
    close: Arc<UdpCloseOnce>,
) -> UdpTaskCompletion {
    let IngressUdpAssociation { io, .. } = association;

    let opened = engine.open_udp_with_cancel(&context, &cancellation).await;
    let (disposition, counters) = match opened {
        Ok(mut opened) if opened.result.effective_action == RouteAction::Block => {
            // A policy block must not retain a provider association even if a
            // buggy engine returned one. Closing here keeps the runtime's
            // exactly-once egress ownership invariant fail-closed.
            if let Some(egress) = opened.association.take() {
                let mut egress = EgressUdpCloseGuard::new(egress.association);
                egress.close_once();
            }
            (
                UdpCloseDisposition::PolicyBlocked,
                UdpRelayCounters::default(),
            )
        }
        Ok(mut opened) => match opened.association.take() {
            Some(egress) => {
                let mut egress = EgressUdpCloseGuard::new(egress.association);
                let relay = relay_udp_bidirectional(
                    io.as_ref(),
                    egress.association(),
                    &cancellation,
                    idle_timeout,
                    &in_flight_budget,
                )
                .await;
                egress.close_once();
                relay
            }
            None => (
                UdpCloseDisposition::RuntimeFailure,
                UdpRelayCounters::default(),
            ),
        },
        Err(_) if cancellation.is_cancelled() => {
            (UdpCloseDisposition::Cancelled, UdpRelayCounters::default())
        }
        Err(_) => (
            UdpCloseDisposition::RuntimeFailure,
            UdpRelayCounters::default(),
        ),
    };

    let close_outcome = close.close(disposition).await;
    udp_task_completion_from_close(disposition, counters, false, close_outcome)
}

#[derive(Debug, Clone, Copy)]
enum UdpRelayDirection {
    ToEgress,
    ToIngress,
}

#[derive(Debug, Default)]
struct UdpRelayAtomicCounters {
    datagrams_to_egress: AtomicU64,
    datagrams_to_ingress: AtomicU64,
    bytes_to_egress: AtomicU64,
    bytes_to_ingress: AtomicU64,
}

impl UdpRelayAtomicCounters {
    fn record(&self, direction: UdpRelayDirection, bytes: usize) {
        let (datagrams, payload_bytes) = match direction {
            UdpRelayDirection::ToEgress => (&self.datagrams_to_egress, &self.bytes_to_egress),
            UdpRelayDirection::ToIngress => (&self.datagrams_to_ingress, &self.bytes_to_ingress),
        };
        saturating_atomic_add(datagrams, 1);
        saturating_atomic_add(payload_bytes, bytes as u64);
    }

    fn snapshot(&self) -> UdpRelayCounters {
        UdpRelayCounters {
            datagrams_to_egress: self.datagrams_to_egress.load(Ordering::Acquire),
            datagrams_to_ingress: self.datagrams_to_ingress.load(Ordering::Acquire),
            bytes_to_egress: self.bytes_to_egress.load(Ordering::Acquire),
            bytes_to_ingress: self.bytes_to_ingress.load(Ordering::Acquire),
        }
    }
}

fn saturating_atomic_add(value: &AtomicU64, amount: u64) {
    let _ = value.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
        Some(current.saturating_add(amount))
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UdpRelayTermination {
    IngressEof,
    Failure,
}

async fn relay_udp_to_egress(
    ingress: &dyn super::ingress::IngressUdpIo,
    egress: &dyn AsyncUdpAssociation,
    activity: mpsc::Sender<()>,
    counters: &UdpRelayAtomicCounters,
    in_flight_budget: &Arc<Semaphore>,
) -> UdpRelayTermination {
    loop {
        let in_flight = match reserve_udp_datagram(in_flight_budget).await {
            Ok(permit) => permit,
            Err(()) => return UdpRelayTermination::Failure,
        };
        let datagram = match ingress.receive().await {
            Ok(Some(datagram)) => datagram,
            Ok(None) => return UdpRelayTermination::IngressEof,
            Err(_) => return UdpRelayTermination::Failure,
        };
        let bytes = datagram.len();
        if egress.send(datagram.into_bytes()).await.is_err() {
            return UdpRelayTermination::Failure;
        }
        drop(in_flight);
        counters.record(UdpRelayDirection::ToEgress, bytes);
        if report_udp_activity(&activity).is_err() {
            return UdpRelayTermination::Failure;
        }
    }
}

async fn relay_udp_to_ingress(
    ingress: &dyn super::ingress::IngressUdpIo,
    egress: &dyn AsyncUdpAssociation,
    activity: mpsc::Sender<()>,
    counters: &UdpRelayAtomicCounters,
    in_flight_budget: &Arc<Semaphore>,
) -> UdpRelayTermination {
    loop {
        let in_flight = match reserve_udp_datagram(in_flight_budget).await {
            Ok(permit) => permit,
            Err(()) => return UdpRelayTermination::Failure,
        };
        let payload = match egress.receive().await {
            Ok(payload) => payload,
            Err(_) => return UdpRelayTermination::Failure,
        };
        let datagram = match UdpDatagram::new(payload) {
            Ok(datagram) => datagram,
            Err(_) => return UdpRelayTermination::Failure,
        };
        let bytes = datagram.len();
        if ingress.send(datagram).await.is_err() {
            return UdpRelayTermination::Failure;
        }
        drop(in_flight);
        counters.record(UdpRelayDirection::ToIngress, bytes);
        if report_udp_activity(&activity).is_err() {
            return UdpRelayTermination::Failure;
        }
    }
}

async fn reserve_udp_datagram(
    in_flight_budget: &Arc<Semaphore>,
) -> Result<OwnedSemaphorePermit, ()> {
    Arc::clone(in_flight_budget)
        .acquire_many_owned(UDP_IN_FLIGHT_RESERVATION_BYTES as u32)
        .await
        .map_err(|_| ())
}

fn report_udp_activity(activity: &mpsc::Sender<()>) -> Result<(), ()> {
    match activity.try_send(()) {
        Ok(()) | Err(mpsc::error::TrySendError::Full(())) => Ok(()),
        Err(mpsc::error::TrySendError::Closed(())) => Err(()),
    }
}

async fn relay_udp_bidirectional(
    ingress: &dyn super::ingress::IngressUdpIo,
    egress: &dyn AsyncUdpAssociation,
    cancellation: &CancellationToken,
    idle_timeout: Duration,
    in_flight_budget: &Arc<Semaphore>,
) -> (UdpCloseDisposition, UdpRelayCounters) {
    let (activity_sender, mut activity) = mpsc::channel(8);
    let counters = UdpRelayAtomicCounters::default();
    let to_egress = relay_udp_to_egress(
        ingress,
        egress,
        activity_sender.clone(),
        &counters,
        in_flight_budget,
    );
    let to_ingress = relay_udp_to_ingress(
        ingress,
        egress,
        activity_sender,
        &counters,
        in_flight_budget,
    );
    tokio::pin!(to_egress);
    tokio::pin!(to_ingress);
    let idle = tokio::time::sleep(idle_timeout);
    tokio::pin!(idle);

    let disposition = loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => break UdpCloseDisposition::Cancelled,
            termination = &mut to_egress => {
                break match termination {
                    UdpRelayTermination::IngressEof => UdpCloseDisposition::Finished,
                    UdpRelayTermination::Failure => UdpCloseDisposition::RuntimeFailure,
                };
            }
            _termination = &mut to_ingress => {
                break UdpCloseDisposition::RuntimeFailure;
            }
            observed = activity.recv() => {
                let Some(()) = observed else {
                    break UdpCloseDisposition::RuntimeFailure;
                };
                idle.as_mut().reset(Instant::now() + idle_timeout);
            }
            _ = &mut idle => break UdpCloseDisposition::IdleTimeout,
        }
    };

    (disposition, counters.snapshot())
}

struct EgressUdpCloseGuard {
    association: Box<dyn AsyncUdpAssociation>,
    closed: bool,
}

impl EgressUdpCloseGuard {
    fn new(association: Box<dyn AsyncUdpAssociation>) -> Self {
        Self {
            association,
            closed: false,
        }
    }

    fn association(&self) -> &dyn AsyncUdpAssociation {
        self.association.as_ref()
    }

    fn close_once(&mut self) {
        if !self.closed {
            // Set the fence before calling foreign code so unwind cannot make
            // Drop invoke the close hook a second time.
            self.closed = true;
            self.association.close();
        }
    }
}

impl Drop for EgressUdpCloseGuard {
    fn drop(&mut self) {
        // Drop can run while another provider callback is already unwinding.
        // Never permit a second panic from foreign `close` code to abort the
        // whole process; the explicit close path remains observable by the
        // task-level catch_unwind and this fallback remains exactly-once.
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| self.close_once()));
    }
}

fn task_completion_from_close(
    disposition: TcpCloseDisposition,
    bytes_to_egress: u64,
    bytes_to_ingress: u64,
    panicked: bool,
    close: CloseOutcome,
) -> TaskCompletion {
    TaskCompletion {
        disposition,
        bytes_to_egress,
        bytes_to_ingress,
        close_failed: close.failed,
        panicked: panicked || close.panicked,
    }
}

fn udp_task_completion_from_close(
    disposition: UdpCloseDisposition,
    counters: UdpRelayCounters,
    panicked: bool,
    close: CloseOutcome,
) -> UdpTaskCompletion {
    UdpTaskCompletion {
        disposition,
        datagrams_to_egress: counters.datagrams_to_egress,
        datagrams_to_ingress: counters.datagrams_to_ingress,
        bytes_to_egress: counters.bytes_to_egress,
        bytes_to_ingress: counters.bytes_to_ingress,
        close_failed: close.failed,
        panicked: panicked || close.panicked,
    }
}

const CLOSE_OPEN: u8 = 0;
const CLOSE_IN_PROGRESS: u8 = 1;
const CLOSE_SUCCEEDED: u8 = 2;
const CLOSE_FAILED: u8 = 3;

struct CloseOnce {
    state: AtomicU8,
    disposition: Mutex<Option<TcpCloseDisposition>>,
    attempt: tokio::sync::Mutex<()>,
    control: Arc<dyn IngressTcpControl>,
}

impl CloseOnce {
    fn new(control: Arc<dyn IngressTcpControl>) -> Self {
        Self {
            state: AtomicU8::new(CLOSE_OPEN),
            disposition: Mutex::new(None),
            attempt: tokio::sync::Mutex::new(()),
            control,
        }
    }

    fn state(&self) -> u8 {
        self.state.load(Ordering::Acquire)
    }

    fn disposition(&self) -> Option<TcpCloseDisposition> {
        *self
            .disposition
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn commit_disposition(&self, disposition: TcpCloseDisposition) -> bool {
        let mut committed = self
            .disposition
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match *committed {
            Some(current) => current == disposition,
            None => {
                *committed = Some(disposition);
                true
            }
        }
    }

    async fn close(&self, disposition: TcpCloseDisposition) -> CloseOutcome {
        // The provider tuple's first terminal disposition is immutable. A
        // cleanup cancellation may retry that same close, but may never
        // rewrite Finished/PolicyBlocked into Cancelled/RuntimeFailure.
        if !self.commit_disposition(disposition) {
            return CloseOutcome {
                failed: true,
                panicked: false,
            };
        }
        let _attempt = self.attempt.lock().await;
        if self.state() == CLOSE_SUCCEEDED {
            return CloseOutcome {
                failed: false,
                panicked: false,
            };
        }
        if !matches!(self.state(), CLOSE_OPEN | CLOSE_FAILED) {
            return CloseOutcome {
                failed: true,
                panicked: false,
            };
        }
        self.state.store(CLOSE_IN_PROGRESS, Ordering::Release);

        let mut attempt = CloseAttemptGuard {
            state: &self.state,
            armed: true,
        };
        let result = tokio::time::timeout(
            CONTROL_CLOSE_TIMEOUT,
            AssertUnwindSafe(async { self.control.close(disposition).await }).catch_unwind(),
        )
        .await;
        let outcome = match result {
            Ok(Ok(Ok(()))) => CloseOutcome {
                failed: false,
                panicked: false,
            },
            Ok(Ok(Err(_))) | Err(_) => CloseOutcome {
                failed: true,
                panicked: false,
            },
            Ok(Err(_)) => CloseOutcome {
                failed: true,
                panicked: true,
            },
        };
        self.state.store(
            if outcome.failed {
                CLOSE_FAILED
            } else {
                CLOSE_SUCCEEDED
            },
            Ordering::Release,
        );
        attempt.armed = false;
        outcome
    }
}

struct UdpCloseOnce {
    state: AtomicU8,
    disposition: Mutex<Option<UdpCloseDisposition>>,
    attempt: tokio::sync::Mutex<()>,
    control: Arc<dyn IngressUdpControl>,
}

impl UdpCloseOnce {
    fn new(control: Arc<dyn IngressUdpControl>) -> Self {
        Self {
            state: AtomicU8::new(CLOSE_OPEN),
            disposition: Mutex::new(None),
            attempt: tokio::sync::Mutex::new(()),
            control,
        }
    }

    fn state(&self) -> u8 {
        self.state.load(Ordering::Acquire)
    }

    fn disposition(&self) -> Option<UdpCloseDisposition> {
        *self
            .disposition
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn commit_disposition(&self, disposition: UdpCloseDisposition) -> bool {
        let mut committed = self
            .disposition
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match *committed {
            Some(current) => current == disposition,
            None => {
                *committed = Some(disposition);
                true
            }
        }
    }

    async fn close(&self, disposition: UdpCloseDisposition) -> CloseOutcome {
        if !self.commit_disposition(disposition) {
            return CloseOutcome {
                failed: true,
                panicked: false,
            };
        }
        let _attempt = self.attempt.lock().await;
        if self.state() == CLOSE_SUCCEEDED {
            return CloseOutcome {
                failed: false,
                panicked: false,
            };
        }
        if !matches!(self.state(), CLOSE_OPEN | CLOSE_FAILED) {
            return CloseOutcome {
                failed: true,
                panicked: false,
            };
        }
        self.state.store(CLOSE_IN_PROGRESS, Ordering::Release);

        let mut attempt = CloseAttemptGuard {
            state: &self.state,
            armed: true,
        };
        let result = tokio::time::timeout(
            CONTROL_CLOSE_TIMEOUT,
            AssertUnwindSafe(async { self.control.close(disposition).await }).catch_unwind(),
        )
        .await;
        let outcome = match result {
            Ok(Ok(Ok(()))) => CloseOutcome {
                failed: false,
                panicked: false,
            },
            Ok(Ok(Err(_))) | Err(_) => CloseOutcome {
                failed: true,
                panicked: false,
            },
            Ok(Err(_)) => CloseOutcome {
                failed: true,
                panicked: true,
            },
        };
        self.state.store(
            if outcome.failed {
                CLOSE_FAILED
            } else {
                CLOSE_SUCCEEDED
            },
            Ordering::Release,
        );
        attempt.armed = false;
        outcome
    }
}

struct CloseAttemptGuard<'a> {
    state: &'a AtomicU8,
    armed: bool,
}

impl Drop for CloseAttemptGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.state.store(CLOSE_FAILED, Ordering::Release);
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct CloseOutcome {
    failed: bool,
    panicked: bool,
}

fn close_join_outcome(result: Result<(TaskId, CloseOutcome), JoinError>) -> (TaskId, CloseOutcome) {
    match result {
        Ok(value) => value,
        Err(error) => (
            error.id(),
            CloseOutcome {
                failed: true,
                panicked: error.is_panic(),
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};

    use super::*;
    use crate::sockscap::flow::attribution::{AttributionHints, FakeIpMap};
    use crate::sockscap::flow::bypass::HardBypassSet;
    use crate::sockscap::flow::connectors::{
        AsyncUdpAssociation, EgressConnector, EgressError, EgressMetadata, EgressStream,
        EgressTarget, EgressUdpAssociation, UdpEgressCapability,
    };
    use crate::sockscap::flow::engine::{EgressProvider, FlowEngineSnapshot};
    use crate::sockscap::flow::ingress::{
        BoxedIngressStream, CaptureIntent, FlowDescriptor, IngressUdpIo, bounded_flow_ingress,
        bounded_udp_flow_ingress,
    };
    use crate::sockscap::policy::matcher::ProfileMatcher;
    use crate::sockscap::types::{
        AppSelectorKind, CapturePlatform, EgressFailureAction, LocalNetworkPolicy, ProfileScope,
        UdpPolicy,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    #[derive(Default)]
    struct RecordingControl {
        dispositions: Mutex<Vec<TcpCloseDisposition>>,
    }

    #[derive(Default)]
    struct RecordingUdpControl {
        dispositions: Mutex<Vec<UdpCloseDisposition>>,
    }

    struct CancelOnTcpAccept {
        cancellation: CancellationToken,
        admission_closed: CancellationToken,
        flow: Mutex<Option<IngressTcpFlow>>,
    }

    #[async_trait]
    impl FlowIngress for CancelOnTcpAccept {
        fn max_buffered_tcp(&self) -> usize {
            1
        }

        async fn close_tcp_admission(&self) -> Result<(), IngressError> {
            self.admission_closed.cancel();
            Ok(())
        }

        async fn accept_tcp(&self) -> Result<Option<IngressTcpFlow>, IngressError> {
            let flow = self.flow.lock().unwrap().take();
            if flow.is_some() {
                self.cancellation.cancel();
                Ok(flow)
            } else {
                self.admission_closed.cancelled().await;
                Ok(None)
            }
        }
    }

    struct CancelOnUdpAccept {
        cancellation: CancellationToken,
        admission_closed: CancellationToken,
        association: Mutex<Option<IngressUdpAssociation>>,
    }

    #[async_trait]
    impl UdpFlowIngress for CancelOnUdpAccept {
        fn max_buffered_udp(&self) -> usize {
            1
        }

        async fn close_udp_admission(&self) -> Result<(), IngressError> {
            self.admission_closed.cancel();
            Ok(())
        }

        async fn accept_udp(&self) -> Result<Option<IngressUdpAssociation>, IngressError> {
            let association = self.association.lock().unwrap().take();
            if association.is_some() {
                self.cancellation.cancel();
                Ok(association)
            } else {
                self.admission_closed.cancelled().await;
                Ok(None)
            }
        }
    }

    struct NeverTcpIngress {
        admission_closed: CancellationToken,
    }

    #[async_trait]
    impl FlowIngress for NeverTcpIngress {
        fn max_buffered_tcp(&self) -> usize {
            1
        }

        async fn close_tcp_admission(&self) -> Result<(), IngressError> {
            self.admission_closed.cancel();
            Ok(())
        }

        async fn accept_tcp(&self) -> Result<Option<IngressTcpFlow>, IngressError> {
            self.admission_closed.cancelled().await;
            Ok(None)
        }
    }

    struct NeverUdpIngress {
        admission_closed: CancellationToken,
    }

    #[async_trait]
    impl UdpFlowIngress for NeverUdpIngress {
        fn max_buffered_udp(&self) -> usize {
            1
        }

        async fn close_udp_admission(&self) -> Result<(), IngressError> {
            self.admission_closed.cancel();
            Ok(())
        }

        async fn accept_udp(&self) -> Result<Option<IngressUdpAssociation>, IngressError> {
            self.admission_closed.cancelled().await;
            Ok(None)
        }
    }

    #[async_trait]
    impl IngressUdpControl for RecordingUdpControl {
        async fn close(&self, disposition: UdpCloseDisposition) -> Result<(), IngressError> {
            self.dispositions.lock().unwrap().push(disposition);
            Ok(())
        }
    }

    impl RecordingUdpControl {
        fn dispositions(&self) -> Vec<UdpCloseDisposition> {
            self.dispositions.lock().unwrap().clone()
        }
    }

    struct ChannelIngressUdpIo {
        incoming: tokio::sync::Mutex<mpsc::Receiver<UdpDatagram>>,
        outgoing: mpsc::Sender<UdpDatagram>,
    }

    #[async_trait]
    impl IngressUdpIo for ChannelIngressUdpIo {
        async fn receive(&self) -> Result<Option<UdpDatagram>, IngressError> {
            Ok(self.incoming.lock().await.recv().await)
        }

        async fn send(&self, datagram: UdpDatagram) -> Result<(), IngressError> {
            self.outgoing
                .send(datagram)
                .await
                .map_err(|_| IngressError::Closed)
        }
    }

    struct ChannelEgressUdpAssociation {
        incoming: tokio::sync::Mutex<mpsc::Receiver<Vec<u8>>>,
        outgoing: mpsc::Sender<Vec<u8>>,
        closed: AtomicBool,
        close_calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl AsyncUdpAssociation for ChannelEgressUdpAssociation {
        async fn send(&self, datagram: Vec<u8>) -> Result<(), EgressError> {
            self.outgoing
                .send(datagram)
                .await
                .map_err(|_| EgressError::Unavailable("test UDP peer closed".into()))
        }

        async fn receive(&self) -> Result<Vec<u8>, EgressError> {
            self.incoming
                .lock()
                .await
                .recv()
                .await
                .ok_or_else(|| EgressError::Unavailable("test UDP peer closed".into()))
        }

        fn close(&self) {
            self.close_calls.fetch_add(1, AtomicOrdering::SeqCst);
            self.closed.store(true, AtomicOrdering::SeqCst);
        }

        fn is_closed(&self) -> bool {
            self.closed.load(AtomicOrdering::SeqCst)
        }
    }

    struct PendingOperationGuard {
        dropped: Arc<AtomicUsize>,
    }

    impl Drop for PendingOperationGuard {
        fn drop(&mut self) {
            self.dropped.fetch_add(1, AtomicOrdering::SeqCst);
        }
    }

    struct PendingReceiveIngress {
        started: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl IngressUdpIo for PendingReceiveIngress {
        async fn receive(&self) -> Result<Option<UdpDatagram>, IngressError> {
            self.started.fetch_add(1, AtomicOrdering::SeqCst);
            let _guard = PendingOperationGuard {
                dropped: Arc::clone(&self.dropped),
            };
            pending().await
        }

        async fn send(&self, _datagram: UdpDatagram) -> Result<(), IngressError> {
            Ok(())
        }
    }

    struct PendingReceiveEgress {
        started: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl AsyncUdpAssociation for PendingReceiveEgress {
        async fn send(&self, _datagram: Vec<u8>) -> Result<(), EgressError> {
            Ok(())
        }

        async fn receive(&self) -> Result<Vec<u8>, EgressError> {
            self.started.fetch_add(1, AtomicOrdering::SeqCst);
            let _guard = PendingOperationGuard {
                dropped: Arc::clone(&self.dropped),
            };
            pending().await
        }

        fn close(&self) {}

        fn is_closed(&self) -> bool {
            false
        }
    }

    struct PendingSendIngress {
        received: AtomicBool,
        send_started: Arc<AtomicUsize>,
        send_dropped: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl IngressUdpIo for PendingSendIngress {
        async fn receive(&self) -> Result<Option<UdpDatagram>, IngressError> {
            if !self.received.swap(true, AtomicOrdering::SeqCst) {
                Ok(Some(UdpDatagram::new(vec![1]).unwrap()))
            } else {
                pending().await
            }
        }

        async fn send(&self, _datagram: UdpDatagram) -> Result<(), IngressError> {
            self.send_started.fetch_add(1, AtomicOrdering::SeqCst);
            let _guard = PendingOperationGuard {
                dropped: Arc::clone(&self.send_dropped),
            };
            pending().await
        }
    }

    struct PendingSendEgress {
        received: AtomicBool,
        send_started: Arc<AtomicUsize>,
        send_dropped: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl AsyncUdpAssociation for PendingSendEgress {
        async fn send(&self, _datagram: Vec<u8>) -> Result<(), EgressError> {
            self.send_started.fetch_add(1, AtomicOrdering::SeqCst);
            let _guard = PendingOperationGuard {
                dropped: Arc::clone(&self.send_dropped),
            };
            pending().await
        }

        async fn receive(&self) -> Result<Vec<u8>, EgressError> {
            if !self.received.swap(true, AtomicOrdering::SeqCst) {
                Ok(vec![2])
            } else {
                pending().await
            }
        }

        fn close(&self) {}

        fn is_closed(&self) -> bool {
            false
        }
    }

    struct PanicCloseUdpAssociation {
        close_calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl AsyncUdpAssociation for PanicCloseUdpAssociation {
        async fn send(&self, _datagram: Vec<u8>) -> Result<(), EgressError> {
            pending().await
        }

        async fn receive(&self) -> Result<Vec<u8>, EgressError> {
            pending().await
        }

        fn close(&self) {
            self.close_calls.fetch_add(1, AtomicOrdering::SeqCst);
            panic!("test UDP close panic")
        }

        fn is_closed(&self) -> bool {
            false
        }
    }

    struct UdpMemoryConnector {
        association: Mutex<Option<EgressUdpAssociation>>,
    }

    #[async_trait]
    impl EgressConnector for UdpMemoryConnector {
        fn name(&self) -> &'static str {
            "udp-memory"
        }

        fn udp_capability(&self) -> UdpEgressCapability {
            UdpEgressCapability::Supported
        }

        async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
            pending().await
        }

        async fn connect_udp(
            &self,
            _target: &EgressTarget,
        ) -> Result<EgressUdpAssociation, EgressError> {
            self.association
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| EgressError::Unavailable("test UDP association used".into()))
        }
    }

    #[async_trait]
    impl IngressTcpControl for RecordingControl {
        async fn close(&self, disposition: TcpCloseDisposition) -> Result<(), IngressError> {
            self.dispositions.lock().unwrap().push(disposition);
            Ok(())
        }
    }

    impl RecordingControl {
        fn dispositions(&self) -> Vec<TcpCloseDisposition> {
            self.dispositions.lock().unwrap().clone()
        }
    }

    struct PanicControl {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl IngressTcpControl for PanicControl {
        async fn close(&self, _disposition: TcpCloseDisposition) -> Result<(), IngressError> {
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            panic!("test close panic")
        }
    }

    struct HangingControl {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl IngressTcpControl for HangingControl {
        async fn close(&self, _disposition: TcpCloseDisposition) -> Result<(), IngressError> {
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            pending().await
        }
    }

    struct RetryingControl {
        failures_remaining: AtomicUsize,
        calls: AtomicUsize,
        dispositions: Mutex<Vec<TcpCloseDisposition>>,
    }

    impl RetryingControl {
        fn new(failures: usize) -> Self {
            Self {
                failures_remaining: AtomicUsize::new(failures),
                calls: AtomicUsize::new(0),
                dispositions: Mutex::new(Vec::new()),
            }
        }

        fn dispositions(&self) -> Vec<TcpCloseDisposition> {
            self.dispositions.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl IngressTcpControl for RetryingControl {
        async fn close(&self, disposition: TcpCloseDisposition) -> Result<(), IngressError> {
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            self.dispositions.lock().unwrap().push(disposition);
            let failed = self
                .failures_remaining
                .fetch_update(
                    AtomicOrdering::SeqCst,
                    AtomicOrdering::SeqCst,
                    |remaining| remaining.checked_sub(1),
                )
                .is_ok();
            if failed {
                Err(IngressError::Control {
                    code: "TEST_RETRYABLE_CLOSE".into(),
                })
            } else {
                Ok(())
            }
        }
    }

    struct FirstHangingControl {
        calls: AtomicUsize,
        dispositions: Mutex<Vec<TcpCloseDisposition>>,
    }

    #[async_trait]
    impl IngressTcpControl for FirstHangingControl {
        async fn close(&self, disposition: TcpCloseDisposition) -> Result<(), IngressError> {
            let attempt = self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            self.dispositions.lock().unwrap().push(disposition);
            if attempt == 0 {
                pending().await
            } else {
                Ok(())
            }
        }
    }

    struct FirstHangingUdpControl {
        calls: AtomicUsize,
        dispositions: Mutex<Vec<UdpCloseDisposition>>,
    }

    #[async_trait]
    impl IngressUdpControl for FirstHangingUdpControl {
        async fn close(&self, disposition: UdpCloseDisposition) -> Result<(), IngressError> {
            let attempt = self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            self.dispositions.lock().unwrap().push(disposition);
            if attempt == 0 {
                pending().await
            } else {
                Ok(())
            }
        }
    }

    struct RetryingUdpControl {
        failures_remaining: AtomicUsize,
        calls: AtomicUsize,
        dispositions: Mutex<Vec<UdpCloseDisposition>>,
    }

    impl RetryingUdpControl {
        fn new(failures: usize) -> Self {
            Self {
                failures_remaining: AtomicUsize::new(failures),
                calls: AtomicUsize::new(0),
                dispositions: Mutex::new(Vec::new()),
            }
        }

        fn dispositions(&self) -> Vec<UdpCloseDisposition> {
            self.dispositions.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl IngressUdpControl for RetryingUdpControl {
        async fn close(&self, disposition: UdpCloseDisposition) -> Result<(), IngressError> {
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            self.dispositions.lock().unwrap().push(disposition);
            let failed = self
                .failures_remaining
                .fetch_update(
                    AtomicOrdering::SeqCst,
                    AtomicOrdering::SeqCst,
                    |remaining| remaining.checked_sub(1),
                )
                .is_ok();
            if failed {
                Err(IngressError::Control {
                    code: "TEST_RETRYABLE_UDP_CLOSE".into(),
                })
            } else {
                Ok(())
            }
        }
    }

    struct RecordingOwner {
        binding_id: String,
        shutdowns: AtomicUsize,
    }

    struct BlockingRetryOwner {
        attempts: AtomicUsize,
        release: tokio::sync::Notify,
    }

    #[async_trait]
    impl FlowRuntimeOwner for RecordingOwner {
        fn binding_id(&self) -> &str {
            &self.binding_id
        }

        async fn shutdown(&self) -> Result<(), FlowRuntimeOwnerError> {
            self.shutdowns.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(())
        }
    }

    #[async_trait]
    impl FlowRuntimeOwner for BlockingRetryOwner {
        fn binding_id(&self) -> &str {
            "blocking-retry-owner"
        }

        async fn shutdown(&self) -> Result<(), FlowRuntimeOwnerError> {
            self.attempts.fetch_add(1, AtomicOrdering::SeqCst);
            self.release.notified().await;
            Ok(())
        }
    }

    struct DuplexConnector {
        stream: Mutex<Option<DuplexStream>>,
    }

    #[async_trait]
    impl EgressConnector for DuplexConnector {
        fn name(&self) -> &'static str {
            "memory"
        }

        async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
            let stream = self
                .stream
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| EgressError::Unavailable("test stream already used".into()))?;
            Ok(EgressStream {
                stream: Box::new(stream),
                meta: EgressMetadata {
                    connector: "memory".into(),
                    remote_dns: false,
                    tcp_only: true,
                    detail: "in-memory test transport".into(),
                },
            })
        }
    }

    struct PendingConnector;

    #[async_trait]
    impl EgressConnector for PendingConnector {
        fn name(&self) -> &'static str {
            "pending"
        }

        async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
            pending().await
        }
    }

    fn profile(action: RouteAction) -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: "profile-1".into(),
            name: "Profile 1".into(),
            enabled: true,
            scope: ProfileScope::Global,
            default_action: action,
            unknown_domain_action: action,
            ..Default::default()
        }
    }

    fn engine(action: RouteAction, direct: Option<Arc<dyn EgressConnector>>) -> Arc<FlowEngine> {
        let profile = profile(action);
        engine_for_profile(&profile, 3, direct)
    }

    fn engine_for_profile(
        profile: &RoutingProfileDraft,
        config_revision: u64,
        direct: Option<Arc<dyn EgressConnector>>,
    ) -> Arc<FlowEngine> {
        let matcher = Arc::new(ProfileMatcher::from_parts(
            profile.id.clone(),
            profile.default_action,
            profile.unknown_domain_action,
            Vec::new(),
            &[],
            &[],
        ));
        let mut engine = FlowEngine::new(
            FlowEngineSnapshot::from_profile(config_revision, profile).unwrap(),
            matcher,
            HardBypassSet::default(),
            FakeIpMap::default(),
            EgressProvider::unavailable("unused in direct/block tests"),
            UdpPolicy::Block,
            EgressFailureAction::FailClosed,
            LocalNetworkPolicy::default(),
        );
        if let Some(direct) = direct {
            engine = engine.with_direct_connector(direct);
        }
        Arc::new(engine)
    }

    fn runtime(
        action: RouteAction,
        direct: Option<Arc<dyn EgressConnector>>,
        max_active: usize,
    ) -> Arc<FlowRuntime> {
        Arc::new(
            FlowRuntime::new(
                FlowRuntimeConfig::new(
                    CapturePlatform::Linux,
                    7,
                    3,
                    max_active,
                    Duration::from_millis(250),
                )
                .unwrap(),
                vec![ProfileRuntime::new(profile(action), engine(action, direct))],
            )
            .unwrap(),
        )
    }

    fn runtime_with_transport_limits(
        action: RouteAction,
        direct: Option<Arc<dyn EgressConnector>>,
        max_active_tcp: usize,
        max_active_udp: usize,
        udp_idle_timeout: Duration,
    ) -> Arc<FlowRuntime> {
        Arc::new(
            FlowRuntime::new(
                FlowRuntimeConfig::new_with_transport_limits(
                    CapturePlatform::Linux,
                    7,
                    3,
                    max_active_tcp,
                    max_active_udp,
                    Duration::from_millis(250),
                    udp_idle_timeout,
                )
                .unwrap(),
                vec![ProfileRuntime::new(profile(action), engine(action, direct))],
            )
            .unwrap(),
        )
    }

    fn udp_memory_connector() -> (
        Arc<dyn EgressConnector>,
        mpsc::Sender<Vec<u8>>,
        mpsc::Receiver<Vec<u8>>,
        Arc<AtomicUsize>,
    ) {
        let (peer_sender, runtime_receiver) = mpsc::channel(8);
        let (runtime_sender, peer_receiver) = mpsc::channel(8);
        let close_calls = Arc::new(AtomicUsize::new(0));
        let association = EgressUdpAssociation {
            association: Box::new(ChannelEgressUdpAssociation {
                incoming: tokio::sync::Mutex::new(runtime_receiver),
                outgoing: runtime_sender,
                closed: AtomicBool::new(false),
                close_calls: close_calls.clone(),
            }),
            meta: EgressMetadata {
                connector: "udp-memory".into(),
                remote_dns: false,
                tcp_only: false,
                detail: "in-memory UDP test transport".into(),
            },
        };
        (
            Arc::new(UdpMemoryConnector {
                association: Mutex::new(Some(association)),
            }),
            peer_sender,
            peer_receiver,
            close_calls,
        )
    }

    fn descriptor(flow_id: u64, generation: u64) -> FlowDescriptor {
        FlowDescriptor {
            generation,
            flow_id,
            platform: CapturePlatform::Linux,
            transport: FlowTransport::Tcp,
            source: SocketAddr::from((Ipv4Addr::new(192, 0, 2, 4), 40_000)),
            destination: SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
            attribution: AttributionHints::default(),
            pid: None,
            process_start_time: None,
            app_kind: None,
            app_identity: None,
            capture_intent: CaptureIntent::AllowGlobalFallback,
            profile_binding: ProfileBinding::AutoSelect,
        }
    }

    fn ingress_flow(
        flow_id: u64,
        generation: u64,
        stream: BoxedIngressStream,
        control: Arc<dyn IngressTcpControl>,
    ) -> IngressTcpFlow {
        IngressTcpFlow {
            descriptor: descriptor(flow_id, generation),
            stream,
            control,
        }
    }

    fn udp_ingress_association(
        flow_id: u64,
        generation: u64,
    ) -> (
        IngressUdpAssociation,
        mpsc::Sender<UdpDatagram>,
        mpsc::Receiver<UdpDatagram>,
        Arc<RecordingUdpControl>,
    ) {
        let control = Arc::new(RecordingUdpControl::default());
        let (association, source_sender, source_receiver) =
            udp_ingress_association_with_control(flow_id, generation, control.clone());
        (association, source_sender, source_receiver, control)
    }

    fn udp_ingress_association_with_control(
        flow_id: u64,
        generation: u64,
        control: Arc<dyn IngressUdpControl>,
    ) -> (
        IngressUdpAssociation,
        mpsc::Sender<UdpDatagram>,
        mpsc::Receiver<UdpDatagram>,
    ) {
        let (source_sender, runtime_receiver) = mpsc::channel(8);
        let (runtime_sender, source_receiver) = mpsc::channel(8);
        let mut descriptor = descriptor(flow_id, generation);
        descriptor.transport = FlowTransport::Udp;
        descriptor.destination = SocketAddr::from((Ipv4Addr::new(203, 0, 113, 53), 53));
        (
            IngressUdpAssociation {
                descriptor,
                io: Arc::new(ChannelIngressUdpIo {
                    incoming: tokio::sync::Mutex::new(runtime_receiver),
                    outgoing: runtime_sender,
                }),
                control,
            },
            source_sender,
            source_receiver,
        )
    }

    fn assert_terminal_invariant(snapshot: &FlowRuntimeSnapshot) {
        assert_eq!(snapshot.active, 0);
        assert_eq!(snapshot.active, snapshot.tcp_active + snapshot.udp_active);
        assert_eq!(
            snapshot.admitted,
            snapshot.tcp_admitted + snapshot.udp_admitted
        );
        assert_eq!(
            snapshot.completed,
            snapshot.tcp_completed + snapshot.udp_completed
        );
        assert_eq!(
            snapshot.admitted,
            snapshot.completed + snapshot.policy_blocked + snapshot.cancelled + snapshot.failed
        );
        assert_eq!(snapshot.invariant_violations, 0);
    }

    #[test]
    fn config_rejects_zero_and_unbounded_values() {
        assert!(matches!(
            FlowRuntimeConfig::new(CapturePlatform::Linux, 0, 1, 1, Duration::from_secs(1)),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new(
                CapturePlatform::Linux,
                1,
                1,
                MAX_ACTIVE_FLOWS + 1,
                Duration::from_secs(1)
            ),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new(CapturePlatform::Linux, 1, 1, 1, Duration::ZERO),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new(CapturePlatform::Linux, 1, 1, 1, Duration::from_millis(99)),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new(CapturePlatform::Unknown, 1, 1, 1, Duration::from_secs(1)),
            Err(FlowRuntimeError::InvalidConfig)
        ));

        let transport = FlowRuntimeConfig::new_with_transport_limits(
            CapturePlatform::Linux,
            1,
            1,
            2,
            3,
            Duration::from_secs(1),
            Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(transport.max_active_flows(), 2);
        assert_eq!(transport.max_active_udp_associations(), 3);
        assert_eq!(transport.udp_idle_timeout(), Duration::from_secs(30));
        assert_eq!(transport.udp_in_flight_bytes(), DEFAULT_UDP_IN_FLIGHT_BYTES);

        let legacy =
            FlowRuntimeConfig::new(CapturePlatform::Linux, 1, 1, 8, Duration::from_secs(1))
                .unwrap();
        assert_eq!(legacy.max_active_flows(), 8);
        assert_eq!(legacy.max_active_udp_associations(), 8);
        let default_capped =
            FlowRuntimeConfig::new(CapturePlatform::Linux, 1, 1, 1_000, Duration::from_secs(1))
                .unwrap();
        assert_eq!(
            default_capped.max_active_udp_associations(),
            DEFAULT_MAX_ACTIVE_UDP_ASSOCIATIONS
        );
        assert_eq!(
            default_capped.udp_in_flight_bytes() / UDP_IN_FLIGHT_RESERVATION_BYTES,
            2 * DEFAULT_MAX_ACTIVE_UDP_ASSOCIATIONS
        );
        let saturated_legacy = FlowRuntimeConfig::new(
            CapturePlatform::Linux,
            1,
            1,
            MAX_ACTIVE_TRANSPORTS,
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(saturated_legacy.max_active_udp_associations(), 0);

        let resources = FlowRuntimeConfig::new_with_resource_limits(
            CapturePlatform::Linux,
            1,
            1,
            2,
            1,
            Duration::from_secs(1),
            Duration::from_secs(30),
            MIN_UDP_IN_FLIGHT_BYTES,
        )
        .unwrap();
        assert_eq!(resources.udp_in_flight_bytes(), MIN_UDP_IN_FLIGHT_BYTES);
        assert!(matches!(
            FlowRuntimeConfig::new_with_resource_limits(
                CapturePlatform::Linux,
                1,
                1,
                1,
                2,
                Duration::from_secs(1),
                Duration::from_secs(30),
                UDP_IN_FLIGHT_RESERVATION_BYTES * 3,
            ),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new_with_transport_limits(
                CapturePlatform::Linux,
                1,
                1,
                1,
                0,
                Duration::from_secs(1),
                Duration::from_secs(30),
            ),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new_with_resource_limits(
                CapturePlatform::Linux,
                1,
                1,
                MAX_ACTIVE_TRANSPORTS,
                1,
                Duration::from_secs(1),
                Duration::from_secs(30),
                DEFAULT_UDP_IN_FLIGHT_BYTES,
            ),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new_with_resource_limits(
                CapturePlatform::Linux,
                1,
                1,
                1,
                1,
                Duration::from_secs(1),
                Duration::from_secs(30),
                MIN_UDP_IN_FLIGHT_BYTES - 1,
            ),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new_with_transport_limits(
                CapturePlatform::Linux,
                1,
                1,
                1,
                1,
                Duration::from_secs(1),
                Duration::from_millis(999),
            ),
            Err(FlowRuntimeError::InvalidConfig)
        ));
    }

    #[test]
    fn runtime_metrics_saturate_instead_of_wrapping() {
        let metrics = FlowRuntimeMetrics::default();
        {
            let mut snapshot = metrics.snapshot.lock().unwrap();
            snapshot.admitted = u64::MAX;
            snapshot.tcp_admitted = u64::MAX;
            snapshot.active = usize::MAX;
            snapshot.tcp_active = usize::MAX;
            snapshot.rejected_overloaded = u64::MAX;
        }
        metrics.admitted_tcp();
        metrics.rejected_tcp(TcpCloseDisposition::Overloaded);
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.admitted, u64::MAX);
        assert_eq!(snapshot.tcp_admitted, u64::MAX);
        assert_eq!(snapshot.active, usize::MAX);
        assert_eq!(snapshot.tcp_active, usize::MAX);
        assert_eq!(snapshot.rejected_overloaded, u64::MAX);

        {
            let mut snapshot = metrics.snapshot.lock().unwrap();
            snapshot.active = 1;
            snapshot.tcp_active = 1;
            snapshot.completed = u64::MAX;
            snapshot.tcp_completed = u64::MAX;
            snapshot.bytes_to_egress = u64::MAX;
            snapshot.bytes_to_ingress = u64::MAX;
            snapshot.task_panics = u64::MAX;
            snapshot.control_close_failures = u64::MAX;
        }
        metrics.completed_tcp(&TaskCompletion {
            disposition: TcpCloseDisposition::Finished,
            bytes_to_egress: u64::MAX,
            bytes_to_ingress: u64::MAX,
            close_failed: true,
            panicked: true,
        });
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.completed, u64::MAX);
        assert_eq!(snapshot.tcp_completed, u64::MAX);
        assert_eq!(snapshot.bytes_to_egress, u64::MAX);
        assert_eq!(snapshot.bytes_to_ingress, u64::MAX);
        assert_eq!(snapshot.task_panics, u64::MAX);
        assert_eq!(snapshot.control_close_failures, u64::MAX);
    }

    #[tokio::test]
    async fn cancellation_latch_rejects_tcp_value_taken_in_the_same_poll() {
        let runtime = runtime(RouteAction::Block, None, 1);
        let cancellation = runtime.cancellation_token();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RecordingControl::default());
        let ingress = CancelOnTcpAccept {
            cancellation,
            admission_closed: CancellationToken::new(),
            flow: Mutex::new(Some(ingress_flow(70, 7, Box::new(stream), control.clone()))),
        };

        let snapshot = runtime
            .start_with_udp(
                Arc::new(ingress),
                Arc::new(NeverUdpIngress {
                    admission_closed: CancellationToken::new(),
                }),
            )
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.admitted, 0);
        assert_eq!(snapshot.failed, 0);
        assert_eq!(control.dispositions(), vec![TcpCloseDisposition::Cancelled]);
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn cancellation_latch_rejects_udp_value_taken_in_the_same_poll() {
        let runtime = runtime(RouteAction::Block, None, 1);
        let cancellation = runtime.cancellation_token();
        let (association, _source, _responses, control) = udp_ingress_association(71, 7);
        let ingress = CancelOnUdpAccept {
            cancellation,
            admission_closed: CancellationToken::new(),
            association: Mutex::new(Some(association)),
        };

        let snapshot = runtime
            .start_with_udp(
                Arc::new(NeverTcpIngress {
                    admission_closed: CancellationToken::new(),
                }),
                Arc::new(ingress),
            )
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.admitted, 0);
        assert_eq!(snapshot.failed, 0);
        assert_eq!(control.dispositions(), vec![UdpCloseDisposition::Cancelled]);
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn udp_in_flight_budget_is_shared_before_both_receive_directions() {
        let budget = Arc::new(Semaphore::new(MIN_UDP_IN_FLIGHT_BYTES));
        let first_ingress_started = Arc::new(AtomicUsize::new(0));
        let first_ingress_dropped = Arc::new(AtomicUsize::new(0));
        let first_egress_started = Arc::new(AtomicUsize::new(0));
        let first_egress_dropped = Arc::new(AtomicUsize::new(0));
        let first_ingress = Arc::new(PendingReceiveIngress {
            started: Arc::clone(&first_ingress_started),
            dropped: Arc::clone(&first_ingress_dropped),
        });
        let first_egress = Arc::new(PendingReceiveEgress {
            started: Arc::clone(&first_egress_started),
            dropped: Arc::clone(&first_egress_dropped),
        });
        let first_cancel = CancellationToken::new();
        let first_signal = first_cancel.clone();
        let first_budget = Arc::clone(&budget);
        let first = tokio::spawn(async move {
            relay_udp_bidirectional(
                first_ingress.as_ref(),
                first_egress.as_ref(),
                &first_cancel,
                Duration::from_secs(5),
                &first_budget,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while first_ingress_started.load(AtomicOrdering::SeqCst) != 1
                || first_egress_started.load(AtomicOrdering::SeqCst) != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(budget.available_permits(), 0);

        let second_ingress_started = Arc::new(AtomicUsize::new(0));
        let second_egress_started = Arc::new(AtomicUsize::new(0));
        let second_ingress = Arc::new(PendingReceiveIngress {
            started: Arc::clone(&second_ingress_started),
            dropped: Arc::new(AtomicUsize::new(0)),
        });
        let second_egress = Arc::new(PendingReceiveEgress {
            started: Arc::clone(&second_egress_started),
            dropped: Arc::new(AtomicUsize::new(0)),
        });
        let second_cancel = CancellationToken::new();
        let second_signal = second_cancel.clone();
        let second_budget = Arc::clone(&budget);
        let second = tokio::spawn(async move {
            relay_udp_bidirectional(
                second_ingress.as_ref(),
                second_egress.as_ref(),
                &second_cancel,
                Duration::from_secs(5),
                &second_budget,
            )
            .await
        });
        tokio::task::yield_now().await;
        assert_eq!(second_ingress_started.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(second_egress_started.load(AtomicOrdering::SeqCst), 0);

        first_signal.cancel();
        assert_eq!(first.await.unwrap().0, UdpCloseDisposition::Cancelled);
        assert_eq!(first_ingress_dropped.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(first_egress_dropped.load(AtomicOrdering::SeqCst), 1);
        tokio::time::timeout(Duration::from_secs(1), async {
            while second_ingress_started.load(AtomicOrdering::SeqCst) != 1
                || second_egress_started.load(AtomicOrdering::SeqCst) != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        second_signal.cancel();
        assert_eq!(second.await.unwrap().0, UdpCloseDisposition::Cancelled);
        assert_eq!(budget.available_permits(), MIN_UDP_IN_FLIGHT_BYTES);
    }

    #[tokio::test]
    async fn cancelling_udp_relay_drops_both_pending_send_futures_and_budget() {
        let ingress_send_started = Arc::new(AtomicUsize::new(0));
        let ingress_send_dropped = Arc::new(AtomicUsize::new(0));
        let egress_send_started = Arc::new(AtomicUsize::new(0));
        let egress_send_dropped = Arc::new(AtomicUsize::new(0));
        let ingress = Arc::new(PendingSendIngress {
            received: AtomicBool::new(false),
            send_started: Arc::clone(&ingress_send_started),
            send_dropped: Arc::clone(&ingress_send_dropped),
        });
        let egress = Arc::new(PendingSendEgress {
            received: AtomicBool::new(false),
            send_started: Arc::clone(&egress_send_started),
            send_dropped: Arc::clone(&egress_send_dropped),
        });
        let budget = Arc::new(Semaphore::new(MIN_UDP_IN_FLIGHT_BYTES));
        let task_budget = Arc::clone(&budget);
        let cancellation = CancellationToken::new();
        let signal = cancellation.clone();
        let relay = tokio::spawn(async move {
            relay_udp_bidirectional(
                ingress.as_ref(),
                egress.as_ref(),
                &cancellation,
                Duration::from_secs(5),
                &task_budget,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while ingress_send_started.load(AtomicOrdering::SeqCst) != 1
                || egress_send_started.load(AtomicOrdering::SeqCst) != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(budget.available_permits(), 0);
        signal.cancel();
        assert_eq!(relay.await.unwrap().0, UdpCloseDisposition::Cancelled);
        assert_eq!(ingress_send_dropped.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(egress_send_dropped.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(budget.available_permits(), MIN_UDP_IN_FLIGHT_BYTES);
    }

    #[test]
    fn udp_close_guard_catches_foreign_close_panic_during_unwind() {
        let close_calls = Arc::new(AtomicUsize::new(0));
        let result = std::panic::catch_unwind(AssertUnwindSafe({
            let close_calls = Arc::clone(&close_calls);
            move || {
                let _guard =
                    EgressUdpCloseGuard::new(Box::new(PanicCloseUdpAssociation { close_calls }));
                panic!("primary test panic");
            }
        }));
        assert!(result.is_err());
        assert_eq!(close_calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn relays_bidirectionally_and_counts_bytes() {
        let (egress_runtime, mut egress_peer) = tokio::io::duplex(128);
        let connector: Arc<dyn EgressConnector> = Arc::new(DuplexConnector {
            stream: Mutex::new(Some(egress_runtime)),
        });
        let runtime = runtime(RouteAction::Direct, Some(connector), 4);
        let (sender, ingress) = bounded_flow_ingress(4).unwrap();
        let (ingress_runtime, mut client) = tokio::io::duplex(128);
        let control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(
                1,
                7,
                Box::new(ingress_runtime),
                control.clone(),
            ))
            .unwrap();
        let run = runtime.start(Arc::new(ingress)).unwrap();
        // Orderly producer EOF must stop admission without cancelling this
        // already-admitted half-close exchange.
        drop(sender);

        client.write_all(b"ping").await.unwrap();
        client.shutdown().await.unwrap();
        let mut request = Vec::new();
        egress_peer.read_to_end(&mut request).await.unwrap();
        assert_eq!(&request, b"ping");
        egress_peer.write_all(b"pong").await.unwrap();
        egress_peer.shutdown().await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert_eq!(&response, b"pong");

        let snapshot = run.wait().await.unwrap();
        assert_eq!(snapshot.completed, 1);
        assert_eq!(snapshot.active, 0);
        assert_eq!(snapshot.bytes_to_egress, 4);
        assert_eq!(snapshot.bytes_to_ingress, 4);
        assert_eq!(control.dispositions(), vec![TcpCloseDisposition::Finished]);
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn udp_direct_relay_preserves_datagrams_counts_payload_and_closes_once() {
        let (connector, egress_sender, mut egress_receiver, close_calls) = udp_memory_connector();
        let runtime = runtime_with_transport_limits(
            RouteAction::Direct,
            Some(connector),
            2,
            2,
            Duration::from_secs(5),
        );
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        drop(tcp_sender);
        let (udp_sender, udp_ingress) = bounded_udp_flow_ingress(2).unwrap();
        let (association, ingress_sender, mut ingress_receiver, control) =
            udp_ingress_association(10, 7);
        udp_sender.try_send(association).unwrap();
        drop(udp_sender);

        let run = runtime
            .start_with_udp(Arc::new(tcp_ingress), Arc::new(udp_ingress))
            .unwrap();
        ingress_sender
            .send(UdpDatagram::new(b"ping".to_vec()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), egress_receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            b"ping"
        );
        egress_sender.send(b"pong".to_vec()).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), ingress_receiver.recv())
                .await
                .unwrap()
                .unwrap()
                .as_slice(),
            b"pong"
        );
        drop(ingress_sender);

        let snapshot = tokio::time::timeout(Duration::from_secs(2), run.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.udp_admitted, 1);
        assert_eq!(snapshot.udp_completed, 1);
        assert_eq!(snapshot.tcp_admitted, 0);
        assert_eq!(snapshot.udp_datagrams_to_egress, 1);
        assert_eq!(snapshot.udp_datagrams_to_ingress, 1);
        assert_eq!(snapshot.udp_bytes_to_egress, 4);
        assert_eq!(snapshot.udp_bytes_to_ingress, 4);
        assert_eq!(snapshot.bytes_to_egress, 4);
        assert_eq!(snapshot.bytes_to_ingress, 4);
        assert_eq!(control.dispositions(), vec![UdpCloseDisposition::Finished]);
        assert_eq!(close_calls.load(AtomicOrdering::SeqCst), 1);
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn udp_policy_block_closes_ingress_without_opening_egress() {
        let runtime =
            runtime_with_transport_limits(RouteAction::Block, None, 1, 1, Duration::from_secs(5));
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        drop(tcp_sender);
        let (udp_sender, udp_ingress) = bounded_udp_flow_ingress(1).unwrap();
        let (association, _source_sender, _source_receiver, control) =
            udp_ingress_association(11, 7);
        udp_sender.try_send(association).unwrap();
        drop(udp_sender);

        let snapshot = runtime
            .start_with_udp(Arc::new(tcp_ingress), Arc::new(udp_ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.udp_admitted, 1);
        assert_eq!(snapshot.policy_blocked, 1);
        assert_eq!(snapshot.udp_completed, 0);
        assert_eq!(
            control.dispositions(),
            vec![UdpCloseDisposition::PolicyBlocked]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn udp_idle_timeout_retires_association_and_closes_both_sides_once() {
        let (connector, _egress_sender, _egress_receiver, close_calls) = udp_memory_connector();
        let runtime = runtime_with_transport_limits(
            RouteAction::Direct,
            Some(connector),
            1,
            1,
            MIN_UDP_IDLE_TIMEOUT,
        );
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        let (udp_sender, udp_ingress) = bounded_udp_flow_ingress(1).unwrap();
        let (association, _source_sender, _source_receiver, control) =
            udp_ingress_association(12, 7);
        udp_sender.try_send(association).unwrap();
        drop(udp_sender);

        let run = runtime
            .start_with_udp(Arc::new(tcp_ingress), Arc::new(udp_ingress))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while runtime.snapshot().udp_completed == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(tcp_sender);
        let snapshot = run.wait().await.unwrap();
        assert_eq!(snapshot.udp_completed, 1);
        assert_eq!(
            control.dispositions(),
            vec![UdpCloseDisposition::IdleTimeout]
        );
        assert_eq!(close_calls.load(AtomicOrdering::SeqCst), 1);
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn policy_block_never_opens_a_connector() {
        let runtime = runtime(RouteAction::Block, None, 2);
        let (sender, ingress) = bounded_flow_ingress(2).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(1, 7, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        let snapshot = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.policy_blocked, 1);
        assert_eq!(snapshot.failed, 0);
        assert_eq!(
            control.dispositions(),
            vec![TcpCloseDisposition::PolicyBlocked]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn stale_generation_is_rejected_before_admission() {
        let runtime = runtime(RouteAction::Direct, None, 2);
        let (sender, ingress) = bounded_flow_ingress(2).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(1, 6, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        let snapshot = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.admitted, 0);
        assert_eq!(snapshot.rejected_stale, 1);
        assert_eq!(
            control.dispositions(),
            vec![TcpCloseDisposition::StaleGeneration]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn overload_and_duplicate_are_immediate_and_bounded() {
        let pending: Arc<dyn EgressConnector> = Arc::new(PendingConnector);
        let runtime = runtime(RouteAction::Direct, Some(pending), 4);
        let _reserved_capacity = Arc::clone(&runtime.tcp_admission)
            .acquire_many_owned(3)
            .await
            .unwrap();
        let (sender, ingress) = bounded_flow_ingress(4).unwrap();
        let (first, _first_peer) = tokio::io::duplex(32);
        let (duplicate, _duplicate_peer) = tokio::io::duplex(32);
        let (overloaded, _overloaded_peer) = tokio::io::duplex(32);
        let first_control = Arc::new(RecordingControl::default());
        let duplicate_control = Arc::new(RecordingControl::default());
        let overload_control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(1, 7, Box::new(first), first_control.clone()))
            .unwrap();
        sender
            .try_send(ingress_flow(
                1,
                7,
                Box::new(duplicate),
                duplicate_control.clone(),
            ))
            .unwrap();
        sender
            .try_send(ingress_flow(
                2,
                7,
                Box::new(overloaded),
                overload_control.clone(),
            ))
            .unwrap();
        drop(sender);

        let snapshot = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.admitted, 1);
        assert_eq!(snapshot.rejected_duplicate, 1);
        assert_eq!(snapshot.rejected_overloaded, 1);
        assert_eq!(snapshot.active, 0);
        assert_eq!(
            duplicate_control.dispositions(),
            vec![TcpCloseDisposition::DuplicateFlow]
        );
        assert_eq!(
            overload_control.dispositions(),
            vec![TcpCloseDisposition::Overloaded]
        );
        assert_eq!(
            first_control.dispositions(),
            vec![TcpCloseDisposition::Cancelled]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn tcp_and_udp_limits_are_isolated_and_udp_overload_is_bounded() {
        let (connector, _egress_sender, _egress_receiver, close_calls) = udp_memory_connector();
        let runtime = runtime_with_transport_limits(
            RouteAction::Direct,
            Some(connector),
            1,
            2,
            Duration::from_secs(5),
        );
        let _reserved_udp_capacity = Arc::clone(&runtime.udp_admission)
            .acquire_owned()
            .await
            .unwrap();
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        let (tcp_stream, _tcp_peer) = tokio::io::duplex(32);
        let tcp_control = Arc::new(RecordingControl::default());
        tcp_sender
            .try_send(ingress_flow(
                30,
                7,
                Box::new(tcp_stream),
                tcp_control.clone(),
            ))
            .unwrap();
        drop(tcp_sender);

        let (udp_sender, udp_ingress) = bounded_udp_flow_ingress(2).unwrap();
        let (first, _first_source, _first_responses, first_control) =
            udp_ingress_association(31, 7);
        let (second, _second_source, _second_responses, second_control) =
            udp_ingress_association(32, 7);
        udp_sender.try_send(first).unwrap();
        udp_sender.try_send(second).unwrap();
        drop(udp_sender);

        let snapshot = runtime
            .start_with_udp(Arc::new(tcp_ingress), Arc::new(udp_ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.tcp_admitted, 1);
        assert_eq!(snapshot.udp_admitted, 1);
        assert_eq!(snapshot.rejected_overloaded, 1);
        assert_eq!(
            tcp_control.dispositions(),
            vec![TcpCloseDisposition::Cancelled]
        );
        assert_eq!(
            first_control.dispositions(),
            vec![UdpCloseDisposition::Cancelled]
        );
        assert_eq!(
            second_control.dispositions(),
            vec![UdpCloseDisposition::Overloaded]
        );
        assert_eq!(close_calls.load(AtomicOrdering::SeqCst), 1);
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn transport_mismatch_fails_closed_before_admission() {
        let runtime =
            runtime_with_transport_limits(RouteAction::Block, None, 2, 2, Duration::from_secs(5));
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        let (tcp_stream, _tcp_peer) = tokio::io::duplex(32);
        let tcp_control = Arc::new(RecordingControl::default());
        let mut wrong_tcp = ingress_flow(40, 7, Box::new(tcp_stream), tcp_control.clone());
        wrong_tcp.descriptor.transport = FlowTransport::Udp;
        tcp_sender.try_send(wrong_tcp).unwrap();
        drop(tcp_sender);

        let (udp_sender, udp_ingress) = bounded_udp_flow_ingress(1).unwrap();
        let (mut wrong_udp, _source, _responses, udp_control) = udp_ingress_association(41, 7);
        wrong_udp.descriptor.transport = FlowTransport::Tcp;
        udp_sender.try_send(wrong_udp).unwrap();
        drop(udp_sender);

        let snapshot = runtime
            .start_with_udp(Arc::new(tcp_ingress), Arc::new(udp_ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.admitted, 0);
        assert_eq!(snapshot.rejected_invalid, 2);
        assert_eq!(
            tcp_control.dispositions(),
            vec![TcpCloseDisposition::InvalidDescriptor]
        );
        assert_eq!(
            udp_control.dispositions(),
            vec![UdpCloseDisposition::InvalidDescriptor]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn flow_ids_are_unique_across_tcp_and_udp_while_active() {
        let (connector, _egress_sender, _egress_receiver, _close_calls) = udp_memory_connector();
        let runtime = runtime_with_transport_limits(
            RouteAction::Direct,
            Some(connector),
            1,
            1,
            Duration::from_secs(5),
        );
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        let (tcp_stream, _tcp_peer) = tokio::io::duplex(32);
        let tcp_control = Arc::new(RecordingControl::default());
        tcp_sender
            .try_send(ingress_flow(
                50,
                7,
                Box::new(tcp_stream),
                tcp_control.clone(),
            ))
            .unwrap();
        drop(tcp_sender);

        let (udp_sender, udp_ingress) = bounded_udp_flow_ingress(1).unwrap();
        let (udp, _source, _responses, udp_control) = udp_ingress_association(50, 7);
        udp_sender.try_send(udp).unwrap();
        drop(udp_sender);

        let snapshot = runtime
            .start_with_udp(Arc::new(tcp_ingress), Arc::new(udp_ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.admitted, 1);
        assert_eq!(snapshot.rejected_duplicate, 1);
        let tcp_duplicate = tcp_control.dispositions() == vec![TcpCloseDisposition::DuplicateFlow];
        let udp_duplicate = udp_control.dispositions() == vec![UdpCloseDisposition::DuplicateFlow];
        assert_ne!(tcp_duplicate, udp_duplicate);
        assert_terminal_invariant(&snapshot);
    }

    #[test]
    fn stale_engine_snapshot_and_missing_live_owner_are_rejected() {
        let draft = profile(RouteAction::Direct);
        let stale_engine = engine_for_profile(&draft, 2, None);
        let config =
            FlowRuntimeConfig::new(CapturePlatform::Linux, 7, 3, 2, Duration::from_millis(250))
                .unwrap();
        assert!(matches!(
            FlowRuntime::new(
                config,
                vec![ProfileRuntime::new(draft.clone(), stale_engine)]
            ),
            Err(FlowRuntimeError::EngineSnapshotMismatch)
        ));

        let mut configured = draft;
        configured.egress_kind = Some(crate::sockscap::types::EgressKind::ProxySession);
        configured.egress_ref_id = Some("saved-proxy".into());
        let configured_engine = engine_for_profile(&configured, 3, None);
        assert!(matches!(
            FlowRuntime::new(
                config,
                vec![ProfileRuntime::new(configured, configured_engine)]
            ),
            Err(FlowRuntimeError::OwnerRequired)
        ));
    }

    #[tokio::test]
    async fn tcp_close_retry_preserves_disposition_after_timeout() {
        let control = Arc::new(FirstHangingControl {
            calls: AtomicUsize::new(0),
            dispositions: Mutex::new(Vec::new()),
        });
        let close = CloseOnce::new(control.clone());

        let timed_out = close.close(TcpCloseDisposition::Finished).await;
        assert!(timed_out.failed);
        assert!(!timed_out.panicked);
        assert_eq!(close.state(), CLOSE_FAILED);
        assert_eq!(close.disposition(), Some(TcpCloseDisposition::Finished));

        let mismatch = close.close(TcpCloseDisposition::Cancelled).await;
        assert!(mismatch.failed);
        assert_eq!(control.calls.load(AtomicOrdering::SeqCst), 1);

        let retried = close.close(TcpCloseDisposition::Finished).await;
        assert!(!retried.failed);
        let duplicate = close.close(TcpCloseDisposition::Finished).await;
        assert!(!duplicate.failed);
        assert_eq!(control.calls.load(AtomicOrdering::SeqCst), 2);
        assert_eq!(
            *control.dispositions.lock().unwrap(),
            vec![TcpCloseDisposition::Finished, TcpCloseDisposition::Finished]
        );
    }

    #[tokio::test]
    async fn udp_close_retry_survives_cancelled_attempt_and_is_exact_after_success() {
        let control = Arc::new(FirstHangingUdpControl {
            calls: AtomicUsize::new(0),
            dispositions: Mutex::new(Vec::new()),
        });
        let close = Arc::new(UdpCloseOnce::new(control.clone()));
        let attempt = {
            let close = Arc::clone(&close);
            tokio::spawn(async move { close.close(UdpCloseDisposition::IdleTimeout).await })
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            while control.calls.load(AtomicOrdering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        attempt.abort();
        assert!(attempt.await.unwrap_err().is_cancelled());
        assert_eq!(close.state(), CLOSE_FAILED);
        assert_eq!(close.disposition(), Some(UdpCloseDisposition::IdleTimeout));

        let retried = close.close(UdpCloseDisposition::IdleTimeout).await;
        assert!(!retried.failed);
        let duplicate = close.close(UdpCloseDisposition::IdleTimeout).await;
        assert!(!duplicate.failed);
        assert_eq!(control.calls.load(AtomicOrdering::SeqCst), 2);
        assert_eq!(
            *control.dispositions.lock().unwrap(),
            vec![
                UdpCloseDisposition::IdleTimeout,
                UdpCloseDisposition::IdleTimeout
            ]
        );
    }

    #[tokio::test]
    async fn tcp_active_close_failure_retains_id_and_permit_until_reconciled() {
        let runtime = runtime(RouteAction::Block, None, 1);
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RetryingControl::new(usize::MAX));
        sender
            .try_send(ingress_flow(71, 7, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        assert_eq!(
            runtime
                .start(Arc::new(ingress))
                .unwrap()
                .wait()
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(runtime.has_pending_cleanup());
        assert_eq!(runtime.snapshot().active, 1);
        assert_eq!(runtime.snapshot().policy_blocked, 0);
        assert_eq!(runtime.tcp_admission.available_permits(), 0);
        {
            let retained = runtime.cleanup_state.lock().await;
            assert_eq!(retained.len(), 1);
            let state = retained.first().expect("close quarantine is retained");
            assert!(state.active_flow_ids.contains(&71));
            assert_eq!(state.quarantined_tcp_finalization.len(), 1);
        }

        assert_eq!(
            runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(runtime.has_pending_cleanup());
        assert_eq!(runtime.snapshot().active, 1);
        assert_eq!(runtime.tcp_admission.available_permits(), 0);
        assert!(control.calls.load(AtomicOrdering::SeqCst) >= 2);
        assert!(
            control
                .dispositions()
                .iter()
                .all(|value| *value == TcpCloseDisposition::PolicyBlocked)
        );
    }

    #[tokio::test]
    async fn udp_active_close_failure_retains_id_and_permit_until_reconciled() {
        let runtime =
            runtime_with_transport_limits(RouteAction::Block, None, 1, 1, Duration::from_secs(5));
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        drop(tcp_sender);
        let (udp_sender, udp_ingress) = bounded_udp_flow_ingress(1).unwrap();
        let control = Arc::new(RetryingUdpControl::new(usize::MAX));
        let (association, _source, _responses) =
            udp_ingress_association_with_control(75, 7, control.clone());
        udp_sender.try_send(association).unwrap();
        drop(udp_sender);

        assert_eq!(
            runtime
                .start_with_udp(Arc::new(tcp_ingress), Arc::new(udp_ingress))
                .unwrap()
                .wait()
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(runtime.has_pending_cleanup());
        assert_eq!(runtime.snapshot().active, 1);
        assert_eq!(runtime.snapshot().policy_blocked, 0);
        assert_eq!(runtime.udp_admission.available_permits(), 0);
        {
            let retained = runtime.cleanup_state.lock().await;
            assert_eq!(retained.len(), 1);
            let state = retained.first().expect("UDP close quarantine is retained");
            assert!(state.active_flow_ids.contains(&75));
            assert_eq!(state.quarantined_udp_finalization.len(), 1);
        }
        assert_eq!(
            runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(runtime.has_pending_cleanup());
        assert_eq!(runtime.snapshot().active, 1);
        assert_eq!(runtime.udp_admission.available_permits(), 0);
        assert!(
            control
                .dispositions()
                .iter()
                .all(|value| *value == UdpCloseDisposition::PolicyBlocked)
        );
    }

    #[tokio::test]
    async fn tcp_and_udp_active_close_failures_reconcile_before_terminal_accounting() {
        let tcp_runtime = runtime(RouteAction::Block, None, 1);
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let tcp_control = Arc::new(RetryingControl::new(1));
        tcp_sender
            .try_send(ingress_flow(72, 7, Box::new(stream), tcp_control.clone()))
            .unwrap();
        drop(tcp_sender);
        let _ = tcp_runtime
            .start(Arc::new(tcp_ingress))
            .unwrap()
            .wait()
            .await;
        if tcp_runtime.has_pending_cleanup() {
            tcp_runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap();
        }
        assert_eq!(tcp_runtime.snapshot().active, 0);
        assert_eq!(tcp_runtime.snapshot().policy_blocked, 1);
        assert_eq!(tcp_runtime.tcp_admission.available_permits(), 1);
        assert_eq!(
            tcp_control.dispositions(),
            vec![
                TcpCloseDisposition::PolicyBlocked,
                TcpCloseDisposition::PolicyBlocked
            ]
        );

        let udp_runtime =
            runtime_with_transport_limits(RouteAction::Block, None, 1, 1, Duration::from_secs(5));
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        drop(tcp_sender);
        let (udp_sender, udp_ingress) = bounded_udp_flow_ingress(1).unwrap();
        let udp_control = Arc::new(RetryingUdpControl::new(1));
        let (association, _source, _responses) =
            udp_ingress_association_with_control(73, 7, udp_control.clone());
        udp_sender.try_send(association).unwrap();
        drop(udp_sender);
        let _ = udp_runtime
            .start_with_udp(Arc::new(tcp_ingress), Arc::new(udp_ingress))
            .unwrap()
            .wait()
            .await;
        if udp_runtime.has_pending_cleanup() {
            udp_runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap();
        }
        assert_eq!(udp_runtime.snapshot().active, 0);
        assert_eq!(udp_runtime.snapshot().policy_blocked, 1);
        assert_eq!(udp_runtime.udp_admission.available_permits(), 1);
        assert_eq!(
            udp_control.dispositions(),
            vec![
                UdpCloseDisposition::PolicyBlocked,
                UdpCloseDisposition::PolicyBlocked
            ]
        );
    }

    #[tokio::test]
    async fn rejected_close_failure_is_bounded_and_retryable_cleanup_owned() {
        let runtime = runtime(RouteAction::Direct, None, 1);
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RetryingControl::new(usize::MAX));
        sender
            .try_send(ingress_flow(74, 6, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        assert_eq!(
            runtime
                .start(Arc::new(ingress))
                .unwrap()
                .wait()
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(runtime.has_pending_cleanup());
        {
            let retained = runtime.cleanup_state.lock().await;
            assert_eq!(retained.len(), 1);
            let state = retained.first().expect("rejected close is retained");
            assert_eq!(state.tcp_rejected_close_count(), 1);
            assert!(state.tcp_rejected_close_count() <= state.max_tcp_retained_rejections);
        }
        assert_eq!(
            runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(runtime.has_pending_cleanup());
        assert_eq!(runtime.snapshot().rejected_stale, 1);
        assert!(control.calls.load(AtomicOrdering::SeqCst) >= 2);
        assert!(
            control
                .dispositions()
                .iter()
                .all(|value| *value == TcpCloseDisposition::StaleGeneration)
        );
    }

    #[tokio::test]
    async fn rejection_bound_invariant_never_drops_an_already_owned_control() {
        let runtime =
            runtime_with_transport_limits(RouteAction::Block, None, 1, 1, Duration::from_secs(5));
        let (_tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        let (_udp_sender, udp_ingress) = bounded_udp_flow_ingress(1).unwrap();
        let mut state = RuntimeState::new(
            1,
            1,
            Arc::new(tcp_ingress),
            Arc::new(udp_ingress),
            1,
            1,
            1,
            1,
        );
        let first_tcp = Arc::new(RecordingControl::default());
        let second_tcp = Arc::new(RecordingControl::default());
        for (flow_id, control) in [(80, first_tcp.clone()), (81, second_tcp.clone())] {
            let (stream, _peer) = tokio::io::duplex(8);
            runtime.close_unadmitted_tcp(
                ingress_flow(flow_id, 7, Box::new(stream), control),
                TcpCloseDisposition::Cancelled,
                &mut state,
            );
        }
        let first_udp = Arc::new(RecordingUdpControl::default());
        let second_udp = Arc::new(RecordingUdpControl::default());
        for (flow_id, control) in [(82, first_udp.clone()), (83, second_udp.clone())] {
            let (association, _source, _responses) =
                udp_ingress_association_with_control(flow_id, 7, control);
            runtime.close_unadmitted_udp(association, UdpCloseDisposition::Cancelled, &mut state);
        }

        assert!(runtime.cancellation.is_cancelled());
        assert_eq!(state.tcp_rejected_close_count(), 2);
        assert_eq!(state.udp_rejected_close_count(), 2);
        assert_eq!(
            state.tcp_rejected_close_count(),
            state.max_tcp_retained_rejections + 1
        );
        assert_eq!(
            state.udp_rejected_close_count(),
            state.max_udp_retained_rejections + 1
        );
        runtime
            .drain_rejected_closes_until(&mut state, Instant::now() + Duration::from_secs(1))
            .await;
        assert_eq!(state.tcp_rejected_close_count(), 0);
        assert_eq!(state.udp_rejected_close_count(), 0);
        assert_eq!(
            first_tcp.dispositions(),
            vec![TcpCloseDisposition::Cancelled]
        );
        assert_eq!(
            second_tcp.dispositions(),
            vec![TcpCloseDisposition::Cancelled]
        );
        assert_eq!(
            first_udp.dispositions(),
            vec![UdpCloseDisposition::Cancelled]
        );
        assert_eq!(
            second_udp.dispositions(),
            vec![UdpCloseDisposition::Cancelled]
        );
    }

    #[tokio::test]
    async fn close_panic_is_caught_and_quarantined_for_retry() {
        let runtime = runtime(RouteAction::Block, None, 2);
        let (sender, ingress) = bounded_flow_ingress(2).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(PanicControl {
            calls: AtomicUsize::new(0),
        });
        sender
            .try_send(ingress_flow(1, 7, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        assert_eq!(
            runtime
                .start(Arc::new(ingress))
                .unwrap()
                .wait()
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(control.calls.load(AtomicOrdering::SeqCst) >= 1);
        assert!(runtime.has_pending_cleanup());
        assert_eq!(runtime.snapshot().active, 1);
        assert_eq!(runtime.snapshot().policy_blocked, 0);
        assert!(runtime.snapshot().control_close_failures >= 1);
        assert_eq!(
            runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(runtime.has_pending_cleanup());
    }

    #[tokio::test]
    async fn hanging_active_close_is_retained_across_bounded_retries() {
        let pending_connector: Arc<dyn EgressConnector> = Arc::new(PendingConnector);
        let runtime = runtime(RouteAction::Direct, Some(pending_connector), 1);
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(HangingControl {
            calls: AtomicUsize::new(0),
        });
        sender
            .try_send(ingress_flow(1, 7, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        let started = Instant::now();
        let error = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap_err();
        assert_eq!(error, FlowRuntimeError::OwnerShutdownFailed);
        assert!(started.elapsed() < Duration::from_millis(600));
        assert_eq!(control.calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(runtime.snapshot().active, 1);
        assert_eq!(runtime.snapshot().cancelled, 0);
        assert!(runtime.has_pending_cleanup());
        assert_eq!(
            runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(control.calls.load(AtomicOrdering::SeqCst) >= 2);
        assert!(runtime.has_pending_cleanup());
    }

    #[tokio::test]
    async fn rejected_hanging_closes_require_observed_abort_retry() {
        let runtime = runtime(RouteAction::Direct, None, 1);
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(HangingControl {
            calls: AtomicUsize::new(0),
        });
        sender
            .try_send(ingress_flow(1, 6, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        let started = Instant::now();
        let error = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap_err();
        assert_eq!(error, FlowRuntimeError::OwnerShutdownFailed);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(runtime.has_pending_cleanup());
        assert_eq!(
            runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap_err(),
            FlowRuntimeError::OwnerShutdownFailed
        );
        assert!(runtime.has_pending_cleanup());
        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.rejected_stale, 1);
        assert!(snapshot.control_close_failures >= 1);
        assert!(control.calls.load(AtomicOrdering::SeqCst) >= 1);
    }

    #[tokio::test]
    async fn aborting_waiter_still_closes_flow_and_shuts_down_owner() {
        let pending_connector: Arc<dyn EgressConnector> = Arc::new(PendingConnector);
        let owner = Arc::new(RecordingOwner {
            binding_id: "test-owner".into(),
            shutdowns: AtomicUsize::new(0),
        });
        let runtime = Arc::new(
            FlowRuntime::new(
                FlowRuntimeConfig::new(CapturePlatform::Linux, 7, 3, 1, Duration::from_millis(250))
                    .unwrap(),
                vec![ProfileRuntime::with_owner(
                    profile(RouteAction::Direct),
                    engine(RouteAction::Direct, Some(pending_connector)),
                    owner.clone(),
                )],
            )
            .unwrap(),
        );
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(1, 7, Box::new(stream), control.clone()))
            .unwrap();
        let handle = runtime.start(Arc::new(ingress)).unwrap();
        let waiter = tokio::spawn(handle.wait());

        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.snapshot().admitted == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        drop(sender);

        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.snapshot().active != 0
                || owner.shutdowns.load(AtomicOrdering::SeqCst) != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(control.dispositions(), vec![TcpCloseDisposition::Cancelled]);
        assert_terminal_invariant(&runtime.snapshot());
    }

    #[tokio::test]
    async fn retry_cleanup_before_start_does_not_shutdown_owner() {
        let owner = Arc::new(RecordingOwner {
            binding_id: "not-started-owner".into(),
            shutdowns: AtomicUsize::new(0),
        });
        let runtime = Arc::new(
            FlowRuntime::new(
                FlowRuntimeConfig::new(CapturePlatform::Linux, 7, 3, 1, Duration::from_millis(250))
                    .unwrap(),
                vec![ProfileRuntime::with_owner(
                    profile(RouteAction::Block),
                    engine(RouteAction::Block, None),
                    owner.clone(),
                )],
            )
            .unwrap(),
        );

        assert_eq!(
            runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap_err(),
            FlowRuntimeError::SupervisorFailed
        );
        assert_eq!(owner.shutdowns.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(runtime.lifecycle(), FlowRuntimeLifecycle::NotStarted);

        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        drop(sender);
        runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(owner.shutdowns.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancelled_unstarted_runtime_shuts_owner_and_fences_normal_start() {
        let owner = Arc::new(RecordingOwner {
            binding_id: "cancelled-unstarted-owner".into(),
            shutdowns: AtomicUsize::new(0),
        });
        let runtime = Arc::new(
            FlowRuntime::new(
                FlowRuntimeConfig::new(CapturePlatform::Linux, 7, 3, 1, Duration::from_millis(250))
                    .unwrap(),
                vec![ProfileRuntime::with_owner(
                    profile(RouteAction::Block),
                    engine(RouteAction::Block, None),
                    owner.clone(),
                )],
            )
            .unwrap(),
        );

        runtime
            .cancel_unstarted_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(owner.shutdowns.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(runtime.lifecycle(), FlowRuntimeLifecycle::Stopped);
        assert!(!runtime.has_pending_cleanup());

        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        drop(sender);
        assert!(matches!(
            runtime.start(Arc::new(ingress)),
            Err(error) if error.error() == FlowRuntimeError::AlreadyStarted
        ));
        runtime
            .cancel_unstarted_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(owner.shutdowns.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn normal_start_and_unstarted_cancellation_have_one_atomic_winner() {
        let owner = Arc::new(RecordingOwner {
            binding_id: "start-cancel-race-owner".into(),
            shutdowns: AtomicUsize::new(0),
        });
        let runtime = Arc::new(
            FlowRuntime::new(
                FlowRuntimeConfig::new(CapturePlatform::Linux, 7, 3, 1, Duration::from_millis(250))
                    .unwrap(),
                vec![ProfileRuntime::with_owner(
                    profile(RouteAction::Block),
                    engine(RouteAction::Block, None),
                    owner.clone(),
                )],
            )
            .unwrap(),
        );
        let (tcp_sender, tcp_ingress) = bounded_flow_ingress(1).unwrap();
        let (udp_sender, udp_ingress) = bounded_udp_flow_ingress(1).unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(3));

        let start_runtime = Arc::clone(&runtime);
        let start_barrier = Arc::clone(&barrier);
        let start = tokio::spawn(async move {
            start_barrier.wait().await;
            start_runtime.start_with_udp(Arc::new(tcp_ingress), Arc::new(udp_ingress))
        });
        let cancel_runtime = Arc::clone(&runtime);
        let cancel_barrier = Arc::clone(&barrier);
        let cancel = tokio::spawn(async move {
            cancel_barrier.wait().await;
            cancel_runtime
                .cancel_unstarted_until(Instant::now() + Duration::from_secs(1))
                .await
        });
        barrier.wait().await;

        let start_result = start.await.unwrap();
        let cancel_result = cancel.await.unwrap();
        match (start_result, cancel_result) {
            (Ok(handle), Err(FlowRuntimeError::SupervisorFailed)) => {
                handle.stop().await.unwrap();
            }
            (Err(error), Ok(())) if error.error() == FlowRuntimeError::AlreadyStarted => {}
            _ => panic!("normal start and unstarted cancellation did not have one winner"),
        }
        drop(tcp_sender);
        drop(udp_sender);
        assert_eq!(owner.shutdowns.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(runtime.lifecycle(), FlowRuntimeLifecycle::Stopped);
        assert!(!runtime.has_pending_cleanup());
    }

    #[tokio::test]
    async fn cancelled_owner_cleanup_retry_keeps_owner_for_next_attempt() {
        let owner = Arc::new(BlockingRetryOwner {
            attempts: AtomicUsize::new(0),
            release: tokio::sync::Notify::new(),
        });
        let runtime = Arc::new(
            FlowRuntime::new(
                FlowRuntimeConfig::new(CapturePlatform::Linux, 7, 3, 1, Duration::from_millis(100))
                    .unwrap(),
                vec![ProfileRuntime::with_owner(
                    profile(RouteAction::Block),
                    engine(RouteAction::Block, None),
                    owner.clone(),
                )],
            )
            .unwrap(),
        );
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        drop(sender);
        let error = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap_err();
        assert_eq!(error, FlowRuntimeError::OwnerShutdownFailed);
        assert!(runtime.has_pending_cleanup());
        assert_eq!(owner.attempts.load(AtomicOrdering::SeqCst), 1);

        let retry_runtime = Arc::clone(&runtime);
        let retry = tokio::spawn(async move {
            retry_runtime
                .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while owner.attempts.load(AtomicOrdering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        retry.abort();
        assert!(retry.await.unwrap_err().is_cancelled());
        assert!(runtime.has_pending_cleanup());

        owner.release.notify_one();
        runtime
            .retry_cleanup_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(owner.attempts.load(AtomicOrdering::SeqCst), 3);
        assert!(!runtime.has_pending_cleanup());
    }

    #[tokio::test]
    async fn runtime_is_single_use_and_platform_mismatch_fails_closed() {
        let first_runtime = runtime(RouteAction::Direct, None, 1);
        let (_sender, ingress) = bounded_flow_ingress(1).unwrap();
        let handle = first_runtime.start(Arc::new(ingress)).unwrap();
        let (_second_sender, second_ingress) = bounded_flow_ingress(1).unwrap();
        assert!(matches!(
            first_runtime.start(Arc::new(second_ingress)),
            Err(error) if error.error() == FlowRuntimeError::AlreadyStarted
        ));
        handle.stop().await.unwrap();

        let platform_runtime = runtime(RouteAction::Direct, None, 1);
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RecordingControl::default());
        let mut flow = ingress_flow(1, 7, Box::new(stream), control.clone());
        flow.descriptor.platform = CapturePlatform::Windows;
        sender.try_send(flow).unwrap();
        drop(sender);
        let snapshot = platform_runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.rejected_invalid, 1);
        assert_eq!(
            control.dispositions(),
            vec![TcpCloseDisposition::InvalidDescriptor]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[test]
    fn descriptor_debug_redacts_external_identity() {
        let mut descriptor = descriptor(1, 7);
        descriptor.app_kind = Some(AppSelectorKind::ExecutablePath);
        descriptor.app_identity = Some("/secret/application/path".into());
        descriptor.attribution.tls_sni = Some("private.example".into());
        let debug = format!("{descriptor:?}");
        assert!(!debug.contains("/secret/application/path"));
        assert!(!debug.contains("private.example"));
        assert!(!debug.contains("203.0.113.8"));
    }
}
