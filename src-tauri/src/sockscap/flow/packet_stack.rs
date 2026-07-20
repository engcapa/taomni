//! Owned supervisor contract for a replaceable packet-stack provider.
//!
//! This module deliberately does not register or implement a production TCP,
//! UDP, or fragment-reassembly stack.  It only defines the
//! fail-closed boundary a future pinned provider must satisfy: exact snapshot
//! identity, explicit capabilities, single-owner packet queues, bounded
//! startup/shutdown, cancellation, and a readiness handshake before a native
//! capture adapter is allowed to redirect traffic.
//!
//! [`ReadyPacketStack::take_flow_ingress`] and
//! [`ReadyPacketStack::take_udp_flow_ingress`] transfer the independently
//! bounded decoded TCP and UDP receivers exactly once. A composition layer
//! must start `FlowRuntime` with both receivers and re-check
//! [`ReadyPacketStack::health`] before
//! activating a privileged capture helper.  Readiness from this supervisor
//! alone is not permission to unlock a platform capability.

use std::fmt;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use tokio::sync::{Notify, oneshot};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::ingress::{
    BoundedFlowIngress, BoundedFlowIngressSender, BoundedUdpFlowIngress,
    BoundedUdpFlowIngressSender, MAX_INGRESS_QUEUE_CAPACITY, MAX_UDP_INGRESS_QUEUE_CAPACITY,
    bounded_flow_ingress, bounded_udp_flow_ingress,
};
use super::ip_stack::{IpStackConfig, IpStackError, IpStackProviderPin};
use crate::sockscap::capture::packet_device::{
    PacketEgressSender, PacketIngressReceiver, PacketQueueIdentity,
};
use crate::sockscap::types::CapturePlatform;

pub const MIN_PACKET_STACK_TIMEOUT: Duration = Duration::from_millis(10);
pub const MAX_PACKET_STACK_TIMEOUT: Duration = Duration::from_secs(60);

/// Immutable identity of one packet-stack instance.
///
/// The provider source pin is part of the runtime identity rather than merely
/// diagnostic metadata.  A ready message from another build is therefore
/// rejected even when its generation and platform happen to match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketStackIdentity {
    pub generation: u64,
    pub config_revision: u64,
    pub platform: CapturePlatform,
    pub provider: IpStackProviderPin,
}

impl PacketStackIdentity {
    pub fn validate(&self) -> Result<(), PacketStackError> {
        if self.generation == 0
            || self.config_revision == 0
            || self.platform == CapturePlatform::Unknown
        {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_IDENTITY_INVALID",
                "packet-stack generation, revision, and platform must be explicit",
            ));
        }
        self.provider.validate().map_err(PacketStackError::IpStack)
    }
}

/// Features a provider can prove for one exact source pin.
///
/// A `true` bit is a contract claim that still needs native smoke, performance,
/// long-stability, and release evidence before product capability bits can be
/// enabled.  This type does not make those release decisions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PacketStackCapabilities {
    pub ipv4: bool,
    pub ipv6: bool,
    pub tcp: bool,
    pub udp: bool,
    pub fragment_reassembly: bool,
}

impl PacketStackCapabilities {
    pub fn supports(self, required: Self) -> bool {
        (!required.ipv4 || self.ipv4)
            && (!required.ipv6 || self.ipv6)
            && (!required.tcp || self.tcp)
            && (!required.udp || self.udp)
            && (!required.fragment_reassembly || self.fragment_reassembly)
    }
}

/// Static provider declaration cached and validated by the supervisor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketStackDescriptor {
    pub provider: IpStackProviderPin,
    pub capabilities: PacketStackCapabilities,
}

impl PacketStackDescriptor {
    pub fn validate(&self) -> Result<(), PacketStackError> {
        self.provider.validate().map_err(PacketStackError::IpStack)
    }
}

/// Stack-facing ends of one bounded native packet device.
///
/// This value is intentionally not cloneable.  The supervisor moves it into
/// exactly one driver task; the native adapter retains only the opposite queue
/// ends.  Consuming `into_parts` preserves that single-owner property while
/// allowing a provider to arrange its own audited event loop.
pub struct PacketStackIo {
    identity: PacketQueueIdentity,
    ingress: PacketIngressReceiver,
    egress: PacketEgressSender,
}

impl PacketStackIo {
    pub fn new(
        ingress: PacketIngressReceiver,
        egress: PacketEgressSender,
    ) -> Result<Self, PacketStackError> {
        let identity = ingress.identity();
        if identity != egress.identity() {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_IO_IDENTITY_MISMATCH",
                "packet ingress and egress queues belong to different runtimes",
            ));
        }
        Ok(Self {
            identity,
            ingress,
            egress,
        })
    }

    pub fn identity(&self) -> PacketQueueIdentity {
        self.identity
    }

    pub fn ingress(&self) -> &PacketIngressReceiver {
        &self.ingress
    }

    pub fn egress(&self) -> &PacketEgressSender {
        &self.egress
    }

    pub fn into_parts(self) -> (PacketIngressReceiver, PacketEgressSender) {
        (self.ingress, self.egress)
    }
}

impl fmt::Debug for PacketStackIo {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketStackIo")
            .field("identity", &self.identity)
            .field("ingress", &self.ingress)
            .field("egress", &self.egress)
            .finish()
    }
}

/// Immutable context moved into a driver together with the packet queues.
pub struct PacketStackRunContext {
    identity: PacketStackIdentity,
    config: IpStackConfig,
    io: PacketStackIo,
}

impl PacketStackRunContext {
    fn new(identity: PacketStackIdentity, config: IpStackConfig, io: PacketStackIo) -> Self {
        Self {
            identity,
            config,
            io,
        }
    }

    pub fn identity(&self) -> &PacketStackIdentity {
        &self.identity
    }

    pub fn config(&self) -> &IpStackConfig {
        &self.config
    }

    pub fn io(&self) -> &PacketStackIo {
        &self.io
    }

    pub fn into_io(self) -> PacketStackIo {
        self.io
    }
}

impl fmt::Debug for PacketStackRunContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketStackRunContext")
            .field("identity", &self.identity)
            .field("config", &self.config)
            .field("io", &self.io)
            .finish()
    }
}

/// One-shot provider assertion sent only after its event loop owns all inputs
/// and is ready to accept cancellation and packets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketStackReady {
    pub identity: PacketStackIdentity,
    pub capabilities: PacketStackCapabilities,
}

/// A clean driver return is valid only after supervisor cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketStackExit {
    Cancelled,
}

/// Pinned provider factory. `build` must not spawn detached tasks.  All work
/// that can outlive `build` belongs to the returned driver and is supervised by
/// [`PacketStackSupervisor`].
#[async_trait]
pub trait PacketStackProvider: Send + Sync {
    fn descriptor(&self) -> PacketStackDescriptor;

    async fn build(
        &self,
        config: IpStackConfig,
    ) -> Result<Box<dyn PacketStackDriver>, PacketStackError>;
}

/// Single-use stack driver. A provider that needs child tasks must own and join
/// them before `run` returns; detached provider work violates this contract.
#[async_trait]
pub trait PacketStackDriver: Send {
    fn identity(&self) -> PacketStackIdentity;

    async fn run(
        self: Box<Self>,
        context: PacketStackRunContext,
        readiness: oneshot::Sender<PacketStackReady>,
        control: PacketStackDriverControl,
        tcp_ingress: BoundedFlowIngressSender,
        udp_ingress: BoundedUdpFlowIngressSender,
    ) -> Result<PacketStackExit, PacketStackError>;
}

const ADMISSION_OPEN: u8 = 0;
const ADMISSION_QUIESCE_REQUESTED: u8 = 1;
const ADMISSION_QUIESCED: u8 = 2;

/// Shared one-way admission fence.  Acknowledgement is valid only after the
/// provider has stopped polling and dropped the native packet ingress, closed
/// both decoded-flow senders, and completed every in-flight admission send.
/// The provider's control actor must remain alive until final termination.
struct DriverQuiesceState {
    phase: AtomicU8,
    acknowledged: Notify,
}

impl DriverQuiesceState {
    fn new() -> Self {
        Self {
            phase: AtomicU8::new(ADMISSION_OPEN),
            acknowledged: Notify::new(),
        }
    }

    fn request(&self, quiesce: &CancellationToken) {
        let _ = self.phase.compare_exchange(
            ADMISSION_OPEN,
            ADMISSION_QUIESCE_REQUESTED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        quiesce.cancel();
    }

    fn acknowledge(&self, quiesce: &CancellationToken) -> Result<(), PacketStackError> {
        if !quiesce.is_cancelled() {
            return Err(PacketStackError::QuiesceAcknowledgedBeforeRequest);
        }
        match self.phase.compare_exchange(
            ADMISSION_QUIESCE_REQUESTED,
            ADMISSION_QUIESCED,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => self.acknowledged.notify_waiters(),
            Err(ADMISSION_QUIESCED) => {}
            Err(_) => return Err(PacketStackError::QuiesceAcknowledgedBeforeRequest),
        }
        Ok(())
    }

    fn is_requested(&self) -> bool {
        self.phase.load(Ordering::Acquire) != ADMISSION_OPEN
    }

    fn is_quiesced(&self) -> bool {
        self.phase.load(Ordering::Acquire) == ADMISSION_QUIESCED
    }
}

/// Non-cloneable lifecycle control owned by exactly one packet-stack driver.
///
/// `quiesce_requested` and `termination_requested` are deliberately separate:
/// a ready driver must acknowledge the former while its provider control actor
/// is still serving existing TCP/UDP close requests, then keep running until
/// the latter is observed. Before accepted readiness, the supervisor may issue
/// final termination directly and no quiesce acknowledgement is required.
pub struct PacketStackDriverControl {
    quiesce: CancellationToken,
    termination: CancellationToken,
    quiesce_state: Arc<DriverQuiesceState>,
}

impl PacketStackDriverControl {
    pub async fn quiesce_requested(&self) {
        self.quiesce.cancelled().await;
    }

    pub fn is_quiesce_requested(&self) -> bool {
        self.quiesce.is_cancelled()
    }

    /// Acknowledge the admission fence. The provider must call this only after
    /// dropping native packet ingress and both decoded TCP/UDP senders, with no
    /// admission send still in flight, while retaining its live control actor.
    /// Repeating the acknowledgement after that proof is idempotent.
    pub fn acknowledge_quiesced(&self) -> Result<(), PacketStackError> {
        self.quiesce_state.acknowledge(&self.quiesce)
    }

    pub async fn termination_requested(&self) {
        self.termination.cancelled().await;
    }

    pub fn is_termination_requested(&self) -> bool {
        self.termination.is_cancelled()
    }
}

impl fmt::Debug for PacketStackDriverControl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketStackDriverControl")
            .field("quiesce_requested", &self.is_quiesce_requested())
            .field("termination_requested", &self.is_termination_requested())
            .finish_non_exhaustive()
    }
}

/// Validated supervisor limits and exact runtime identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketStackSupervisorConfig {
    pub identity: PacketStackIdentity,
    pub required_capabilities: PacketStackCapabilities,
    pub decoded_tcp_queue_capacity: usize,
    pub decoded_udp_queue_capacity: usize,
    pub startup_timeout: Duration,
    pub shutdown_timeout: Duration,
}

impl PacketStackSupervisorConfig {
    pub fn validate(&self) -> Result<(), PacketStackError> {
        self.identity.validate()?;
        if self.decoded_tcp_queue_capacity == 0
            || self.decoded_tcp_queue_capacity > MAX_INGRESS_QUEUE_CAPACITY
        {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_FLOW_QUEUE_INVALID",
                "decoded TCP queue capacity is outside the bounded ingress range",
            ));
        }
        if self.decoded_udp_queue_capacity == 0
            || self.decoded_udp_queue_capacity > MAX_UDP_INGRESS_QUEUE_CAPACITY
        {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_UDP_QUEUE_INVALID",
                "decoded UDP queue capacity is outside the bounded ingress range",
            ));
        }
        for timeout in [self.startup_timeout, self.shutdown_timeout] {
            if timeout < MIN_PACKET_STACK_TIMEOUT || timeout > MAX_PACKET_STACK_TIMEOUT {
                return Err(PacketStackError::invalid(
                    "PACKET_STACK_TIMEOUT_INVALID",
                    "packet-stack timeout is outside the bounded supervisor range",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketStackHealth {
    Ready,
    Quiescing,
    Quiesced,
    Stopping,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum PacketStackError {
    #[error("{code}: {message}")]
    Invalid {
        code: &'static str,
        message: &'static str,
    },
    #[error("packet/IP-stack contract failed: {0}")]
    IpStack(#[source] IpStackError),
    #[error("{code}: {message}")]
    Provider {
        code: &'static str,
        message: &'static str,
    },
    #[error("PACKET_STACK_ALREADY_STARTED: supervisor instances are single-use")]
    AlreadyStarted,
    #[error("PACKET_STACK_ASYNC_RUNTIME_UNAVAILABLE: no Tokio runtime is available")]
    AsyncRuntimeUnavailable,
    #[error("PACKET_STACK_PROVIDER_BUILD_PANICKED: provider build panicked")]
    ProviderBuildPanicked,
    #[error("PACKET_STACK_PROVIDER_DESCRIPTOR_PANICKED: provider descriptor inspection panicked")]
    ProviderDescriptorPanicked,
    #[error("PACKET_STACK_DRIVER_IDENTITY_PANICKED: driver identity inspection panicked")]
    DriverIdentityPanicked,
    #[error("PACKET_STACK_DRIVER_IDENTITY_MISMATCH: built driver has another identity")]
    DriverIdentityMismatch,
    #[error("PACKET_STACK_START_TIMEOUT: provider did not become ready before the deadline")]
    StartTimeout,
    #[error("PACKET_STACK_READY_CHANNEL_CLOSED: driver ended readiness signaling")]
    ReadyChannelClosed,
    #[error("PACKET_STACK_READY_IDENTITY_MISMATCH: ready identity does not match the supervisor")]
    ReadyIdentityMismatch,
    #[error("PACKET_STACK_READY_CAPABILITIES_MISMATCH: ready capabilities changed after build")]
    ReadyCapabilitiesMismatch,
    #[error("PACKET_STACK_FLOW_INGRESS_ALREADY_TAKEN: decoded TCP ingress was already transferred")]
    FlowIngressAlreadyTaken,
    #[error("PACKET_STACK_UDP_INGRESS_ALREADY_TAKEN: decoded UDP ingress was already transferred")]
    UdpIngressAlreadyTaken,
    #[error("PACKET_STACK_DRIVER_EXITED_BEFORE_READY: driver exited before readiness")]
    DriverExitedBeforeReady,
    #[error("PACKET_STACK_DRIVER_FAILED_BEFORE_READY: {provider_code}")]
    DriverFailedBeforeReady { provider_code: &'static str },
    #[error("PACKET_STACK_DRIVER_PANICKED_BEFORE_READY: driver panicked before readiness")]
    DriverPanickedBeforeReady,
    #[error("PACKET_STACK_DRIVER_ABORTED_BEFORE_READY: driver was aborted before readiness")]
    DriverAbortedBeforeReady,
    #[error("PACKET_STACK_DRIVER_EXITED_UNEXPECTEDLY: ready driver exited without cancellation")]
    DriverExitedUnexpectedly,
    #[error("PACKET_STACK_DRIVER_FAILED: {provider_code}")]
    DriverFailed { provider_code: &'static str },
    #[error("PACKET_STACK_DRIVER_PANICKED: ready driver panicked")]
    DriverPanicked,
    #[error("PACKET_STACK_DRIVER_ABORTED: ready driver was aborted")]
    DriverAborted,
    #[error(
        "PACKET_STACK_QUIESCE_ACK_BEFORE_REQUEST: driver acknowledged admission quiesce before it was requested"
    )]
    QuiesceAcknowledgedBeforeRequest,
    #[error("PACKET_STACK_QUIESCE_TIMEOUT: driver did not quiesce admission before the deadline")]
    QuiesceTimeout,
    #[error(
        "PACKET_STACK_SHUTDOWN_BEFORE_QUIESCE: final termination requires acknowledged admission quiesce"
    )]
    ShutdownBeforeQuiesce,
    #[error("PACKET_STACK_SHUTDOWN_TIMEOUT: driver did not stop before the deadline")]
    ShutdownTimeout,
}

impl PacketStackError {
    fn invalid(code: &'static str, message: &'static str) -> Self {
        Self::Invalid { code, message }
    }

    pub fn provider(code: &'static str, message: &'static str) -> Self {
        Self::Provider { code, message }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid { code, .. } => code,
            Self::IpStack(error) => error.code(),
            Self::Provider { code, .. } => code,
            Self::AlreadyStarted => "PACKET_STACK_ALREADY_STARTED",
            Self::AsyncRuntimeUnavailable => "PACKET_STACK_ASYNC_RUNTIME_UNAVAILABLE",
            Self::ProviderBuildPanicked => "PACKET_STACK_PROVIDER_BUILD_PANICKED",
            Self::ProviderDescriptorPanicked => "PACKET_STACK_PROVIDER_DESCRIPTOR_PANICKED",
            Self::DriverIdentityPanicked => "PACKET_STACK_DRIVER_IDENTITY_PANICKED",
            Self::DriverIdentityMismatch => "PACKET_STACK_DRIVER_IDENTITY_MISMATCH",
            Self::StartTimeout => "PACKET_STACK_START_TIMEOUT",
            Self::ReadyChannelClosed => "PACKET_STACK_READY_CHANNEL_CLOSED",
            Self::ReadyIdentityMismatch => "PACKET_STACK_READY_IDENTITY_MISMATCH",
            Self::ReadyCapabilitiesMismatch => "PACKET_STACK_READY_CAPABILITIES_MISMATCH",
            Self::FlowIngressAlreadyTaken => "PACKET_STACK_FLOW_INGRESS_ALREADY_TAKEN",
            Self::UdpIngressAlreadyTaken => "PACKET_STACK_UDP_INGRESS_ALREADY_TAKEN",
            Self::DriverExitedBeforeReady => "PACKET_STACK_DRIVER_EXITED_BEFORE_READY",
            Self::DriverFailedBeforeReady { .. } => "PACKET_STACK_DRIVER_FAILED_BEFORE_READY",
            Self::DriverPanickedBeforeReady => "PACKET_STACK_DRIVER_PANICKED_BEFORE_READY",
            Self::DriverAbortedBeforeReady => "PACKET_STACK_DRIVER_ABORTED_BEFORE_READY",
            Self::DriverExitedUnexpectedly => "PACKET_STACK_DRIVER_EXITED_UNEXPECTEDLY",
            Self::DriverFailed { .. } => "PACKET_STACK_DRIVER_FAILED",
            Self::DriverPanicked => "PACKET_STACK_DRIVER_PANICKED",
            Self::DriverAborted => "PACKET_STACK_DRIVER_ABORTED",
            Self::QuiesceAcknowledgedBeforeRequest => "PACKET_STACK_QUIESCE_ACK_BEFORE_REQUEST",
            Self::QuiesceTimeout => "PACKET_STACK_QUIESCE_TIMEOUT",
            Self::ShutdownBeforeQuiesce => "PACKET_STACK_SHUTDOWN_BEFORE_QUIESCE",
            Self::ShutdownTimeout => "PACKET_STACK_SHUTDOWN_TIMEOUT",
        }
    }
}

type DriverResult = Result<PacketStackExit, PacketStackError>;

/// Startup error with explicit ownership when a spawned driver has not yet
/// proved termination.  Production callers must retain and retry this owner;
/// the emergency Drop reaper is containment only.
#[derive(Debug, thiserror::Error)]
#[error("packet stack startup failed: {error}")]
pub(in crate::sockscap::flow) struct PacketStackStartupError {
    #[source]
    error: PacketStackError,
    recovery_owner: Option<StartingPacketStack>,
}

impl PacketStackStartupError {
    fn with_owner(error: PacketStackError, recovery_owner: StartingPacketStack) -> Self {
        Self {
            error,
            recovery_owner: Some(recovery_owner),
        }
    }

    pub(in crate::sockscap::flow) fn code(&self) -> &'static str {
        self.error.code()
    }

    pub(in crate::sockscap::flow) fn take_recovery_owner(&mut self) -> Option<StartingPacketStack> {
        self.recovery_owner.take()
    }

    pub(in crate::sockscap::flow) fn into_unowned_error(self) -> PacketStackError {
        assert!(
            self.recovery_owner.is_none(),
            "a packet-stack startup owner must not be discarded"
        );
        self.error
    }
}

impl From<PacketStackError> for PacketStackStartupError {
    fn from(error: PacketStackError) -> Self {
        Self {
            error,
            recovery_owner: None,
        }
    }
}

const FIRST_EVENT_PENDING: u8 = 0;
const FIRST_EVENT_CANCEL_REQUESTED: u8 = 1;
const FIRST_EVENT_DRIVER_TERMINATED: u8 = 2;
const FIRST_EVENT_UNTRACKED_CANCELLATION: u8 = 3;

/// Monotonic record of the first terminal intent observed after readiness.
///
/// The cancellation token alone cannot preserve ordering: once it is
/// cancelled, a driver that had already returned `Cancelled` is
/// indistinguishable from a cooperative return.  The driver task and every
/// public cancellation path therefore race exactly once on this latch.  The
/// winner remains authoritative for health and shutdown classification.
#[derive(Default)]
struct DriverFirstEvent {
    event: AtomicU8,
}

impl DriverFirstEvent {
    fn record_driver_terminated(&self) {
        let _ = self.event.compare_exchange(
            FIRST_EVENT_PENDING,
            FIRST_EVENT_DRIVER_TERMINATED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    fn request_cancellation(&self, cancellation: &CancellationToken) {
        let event = if cancellation.is_cancelled() {
            // Only the driver owns another raw token clone.  Seeing it already
            // cancelled here means the controlled handle was bypassed, so it
            // cannot be accepted later as proof of an orderly shutdown.
            FIRST_EVENT_UNTRACKED_CANCELLATION
        } else {
            FIRST_EVENT_CANCEL_REQUESTED
        };
        let _ = self.event.compare_exchange(
            FIRST_EVENT_PENDING,
            event,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        cancellation.cancel();
    }

    fn record_untracked_cancellation(&self) {
        let _ = self.event.compare_exchange(
            FIRST_EVENT_PENDING,
            FIRST_EVENT_UNTRACKED_CANCELLATION,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    fn event(&self) -> u8 {
        self.event.load(Ordering::Acquire)
    }

    fn driver_terminated_without_controlled_cancel(&self) -> bool {
        matches!(
            self.event(),
            FIRST_EVENT_DRIVER_TERMINATED | FIRST_EVENT_UNTRACKED_CANCELLATION
        )
    }
}

struct DriverTerminationGuard(Arc<DriverFirstEvent>);

impl Drop for DriverTerminationGuard {
    fn drop(&mut self) {
        self.0.record_driver_terminated();
    }
}

/// Cloneable cancellation control that preserves shutdown ordering evidence.
///
/// A raw [`CancellationToken`] is deliberately not exposed by the ready
/// handle.  Callers can still wait for cancellation or request it, but cannot
/// bypass the first-event latch used to classify driver termination.
#[derive(Clone)]
pub struct PacketStackCancellation {
    cancellation: CancellationToken,
    first_event: Arc<DriverFirstEvent>,
}

impl PacketStackCancellation {
    pub fn cancel(&self) {
        self.first_event.request_cancellation(&self.cancellation);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    pub async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }
}

impl fmt::Debug for PacketStackCancellation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketStackCancellation")
            .field("is_cancelled", &self.is_cancelled())
            .finish_non_exhaustive()
    }
}

enum StartupOutcome {
    Driver(Result<DriverResult, JoinError>),
    Ready(Result<PacketStackReady, oneshot::error::RecvError>),
    TimedOut,
}

/// Single-use owner of a provider factory and its validated release-neutral
/// contract. No constructor in this module supplies a product provider.
pub(in crate::sockscap::flow) struct PacketStackSupervisor {
    config: PacketStackSupervisorConfig,
    stack_config: IpStackConfig,
    descriptor: PacketStackDescriptor,
    provider: Arc<dyn PacketStackProvider>,
    started: AtomicBool,
}

impl PacketStackSupervisor {
    pub(in crate::sockscap::flow) fn new(
        config: PacketStackSupervisorConfig,
        stack_config: IpStackConfig,
        provider: Arc<dyn PacketStackProvider>,
    ) -> Result<Self, PacketStackError> {
        config.validate()?;
        stack_config.validate().map_err(PacketStackError::IpStack)?;
        let descriptor = std::panic::catch_unwind(AssertUnwindSafe(|| provider.descriptor()))
            .map_err(|_| PacketStackError::ProviderDescriptorPanicked)?;
        descriptor.validate()?;
        if config.identity.generation != stack_config.generation
            || config.identity.platform != stack_config.platform
            || config.identity.provider != stack_config.provider
        {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_CONFIG_IDENTITY_MISMATCH",
                "supervisor identity does not match the IP-stack configuration",
            ));
        }
        if descriptor.provider != config.identity.provider {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_PROVIDER_PIN_MISMATCH",
                "provider descriptor does not match the exact configured source pin",
            ));
        }
        if !descriptor
            .capabilities
            .supports(config.required_capabilities)
        {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_CAPABILITY_MISSING",
                "provider does not implement every required packet-stack capability",
            ));
        }
        if config.decoded_tcp_queue_capacity > stack_config.max_tcp_flows {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_FLOW_QUEUE_INVALID",
                "decoded TCP queue exceeds the configured TCP flow bound",
            ));
        }
        if config.decoded_udp_queue_capacity > stack_config.max_udp_associations {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_UDP_QUEUE_INVALID",
                "decoded UDP queue exceeds the configured UDP association bound",
            ));
        }
        Ok(Self {
            config,
            stack_config,
            descriptor,
            provider,
            started: AtomicBool::new(false),
        })
    }

    /// Build and start a provider, then wait for its one-shot readiness proof.
    ///
    /// The startup timeout is one absolute budget shared by provider build and
    /// readiness.  If the caller drops this future after the driver is spawned,
    /// [`StartingDriverGuard`] cancels it and transfers its join handle to a
    /// bounded emergency reaper; driver termination also drops its sole
    /// decoded-flow producer.
    #[cfg(test)]
    pub(in crate::sockscap::flow) async fn start(
        &self,
        io: PacketStackIo,
    ) -> Result<ReadyPacketStack, PacketStackStartupError> {
        self.start_until(io, Instant::now() + self.config.startup_timeout)
            .await
    }

    /// Start under one absolute caller deadline. Once a driver task has been
    /// spawned, every ordinary error returns its join handle as an explicit
    /// retryable owner rather than silently relying on the emergency reaper.
    pub(in crate::sockscap::flow) async fn start_until(
        &self,
        io: PacketStackIo,
        caller_deadline: Instant,
    ) -> Result<ReadyPacketStack, PacketStackStartupError> {
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(PacketStackError::AlreadyStarted.into());
        }
        let io_identity = io.identity();
        if io_identity.generation != self.config.identity.generation
            || io_identity.platform != self.config.identity.platform
        {
            return Err(PacketStackError::invalid(
                "PACKET_STACK_IO_IDENTITY_MISMATCH",
                "packet queues do not belong to the configured generation and platform",
            )
            .into());
        }
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| PacketStackError::AsyncRuntimeUnavailable)?;
        let deadline = caller_deadline.min(Instant::now() + self.config.startup_timeout);
        if Instant::now() >= deadline {
            return Err(PacketStackError::StartTimeout.into());
        }
        let build = AssertUnwindSafe(self.provider.build(self.stack_config.clone())).catch_unwind();
        let driver = match tokio::time::timeout_at(deadline, build).await {
            Ok(Ok(Ok(driver))) => driver,
            Ok(Ok(Err(error))) => return Err(error.into()),
            Ok(Err(_)) => return Err(PacketStackError::ProviderBuildPanicked.into()),
            Err(_) => return Err(PacketStackError::StartTimeout.into()),
        };
        let driver_identity = std::panic::catch_unwind(AssertUnwindSafe(|| driver.identity()))
            .map_err(|_| PacketStackError::DriverIdentityPanicked)?;
        if driver_identity != self.config.identity {
            return Err(PacketStackError::DriverIdentityMismatch.into());
        }
        if Instant::now() >= deadline {
            return Err(PacketStackError::StartTimeout.into());
        }

        let (tcp_sender, tcp_ingress) =
            bounded_flow_ingress(self.config.decoded_tcp_queue_capacity).map_err(|_| {
                PacketStackError::invalid(
                    "PACKET_STACK_FLOW_QUEUE_INVALID",
                    "could not create the validated decoded TCP queue",
                )
            })?;
        let tcp_ingress = Arc::new(tcp_ingress);
        let (udp_sender, udp_ingress) =
            bounded_udp_flow_ingress(self.config.decoded_udp_queue_capacity).map_err(|_| {
                PacketStackError::invalid(
                    "PACKET_STACK_UDP_QUEUE_INVALID",
                    "could not create the validated decoded UDP queue",
                )
            })?;
        let udp_ingress = Arc::new(udp_ingress);
        let (ready_sender, mut ready_receiver) = oneshot::channel();
        let quiesce = CancellationToken::new();
        let termination = CancellationToken::new();
        let quiesce_state = Arc::new(DriverQuiesceState::new());
        let first_event = Arc::new(DriverFirstEvent::default());
        let context =
            PacketStackRunContext::new(self.config.identity.clone(), self.stack_config.clone(), io);
        let driver_control = PacketStackDriverControl {
            quiesce: quiesce.clone(),
            termination: termination.clone(),
            quiesce_state: Arc::clone(&quiesce_state),
        };
        let driver_first_event = Arc::clone(&first_event);
        let task = runtime.spawn(async move {
            let _termination_guard = DriverTerminationGuard(driver_first_event);
            driver
                .run(
                    context,
                    ready_sender,
                    driver_control,
                    tcp_sender,
                    udp_sender,
                )
                .await
        });
        let mut guard =
            StartingDriverGuard::new(termination.clone(), task, self.config.shutdown_timeout);

        let startup = {
            let task = guard.task_mut();
            tokio::select! {
                biased;
                result = task => StartupOutcome::Driver(result),
                result = &mut ready_receiver => StartupOutcome::Ready(result),
                _ = tokio::time::sleep_until(deadline) => StartupOutcome::TimedOut,
            }
        };
        let readiness = match startup {
            StartupOutcome::Driver(result) => {
                guard.release_completed();
                return Err(classify_before_ready(result).into());
            }
            StartupOutcome::Ready(Ok(readiness)) => readiness,
            StartupOutcome::Ready(Err(_)) => {
                let owner = guard.into_recovery();
                return Err(PacketStackStartupError::with_owner(
                    PacketStackError::ReadyChannelClosed,
                    owner,
                ));
            }
            StartupOutcome::TimedOut => {
                let owner = guard.into_recovery();
                return Err(PacketStackStartupError::with_owner(
                    PacketStackError::StartTimeout,
                    owner,
                ));
            }
        };
        if readiness.identity != self.config.identity {
            let owner = guard.into_recovery();
            return Err(PacketStackStartupError::with_owner(
                PacketStackError::ReadyIdentityMismatch,
                owner,
            ));
        }
        if readiness.capabilities != self.descriptor.capabilities
            || !readiness
                .capabilities
                .supports(self.config.required_capabilities)
        {
            let owner = guard.into_recovery();
            return Err(PacketStackStartupError::with_owner(
                PacketStackError::ReadyCapabilitiesMismatch,
                owner,
            ));
        }

        // Give an immediately-returning driver a chance to become observable;
        // readiness followed by a synchronous exit must not authorize capture.
        tokio::task::yield_now().await;
        if Instant::now() >= deadline {
            let owner = guard.into_recovery();
            return Err(PacketStackStartupError::with_owner(
                PacketStackError::StartTimeout,
                owner,
            ));
        }
        if guard.is_finished() {
            let result = guard.task_mut().await;
            guard.release_completed();
            return Err(classify_before_ready(result).into());
        }

        let task = guard.disarm();
        Ok(ReadyPacketStack {
            identity: self.config.identity.clone(),
            capabilities: self.descriptor.capabilities,
            flow_ingress: Some(tcp_ingress),
            udp_flow_ingress: Some(udp_ingress),
            quiesce,
            quiesce_state,
            termination,
            first_event,
            driver: Some(task),
            terminal_fault: None,
            shutdown_timeout: self.config.shutdown_timeout,
        })
    }
}

impl fmt::Debug for PacketStackSupervisor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketStackSupervisor")
            .field("config", &self.config)
            .field("descriptor", &self.descriptor)
            .field("started", &self.started.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

/// Type-state proof that the provider has sent a matching readiness message.
///
/// This is only the packet-stack part of data-plane readiness. The caller must
/// start `FlowRuntime` with [`Self::take_flow_ingress`] and combine its health
/// with native packet-pump health before activating privileged capture state.
pub(in crate::sockscap::flow) struct ReadyPacketStack {
    identity: PacketStackIdentity,
    capabilities: PacketStackCapabilities,
    flow_ingress: Option<Arc<BoundedFlowIngress>>,
    udp_flow_ingress: Option<Arc<BoundedUdpFlowIngress>>,
    quiesce: CancellationToken,
    quiesce_state: Arc<DriverQuiesceState>,
    termination: CancellationToken,
    first_event: Arc<DriverFirstEvent>,
    driver: Option<JoinHandle<DriverResult>>,
    terminal_fault: Option<PacketStackError>,
    shutdown_timeout: Duration,
}

impl ReadyPacketStack {
    #[cfg(test)]
    pub fn identity(&self) -> &PacketStackIdentity {
        &self.identity
    }

    #[cfg(test)]
    pub fn capabilities(&self) -> PacketStackCapabilities {
        self.capabilities
    }

    /// Transfer the sole supervisor-owned decoded-flow receiver. Keeping the
    /// receiver out of this handle after transfer ensures `FlowRuntime` is the
    /// only long-lived consumer and lets driver shutdown close that ingress.
    pub fn take_flow_ingress(&mut self) -> Result<Arc<BoundedFlowIngress>, PacketStackError> {
        self.flow_ingress
            .take()
            .ok_or(PacketStackError::FlowIngressAlreadyTaken)
    }

    /// Transfer the sole supervisor-owned decoded UDP receiver. TCP and UDP
    /// use independent queues so a datagram flood cannot consume TCP admission
    /// capacity or hide UDP shutdown from the runtime.
    pub fn take_udp_flow_ingress(
        &mut self,
    ) -> Result<Arc<BoundedUdpFlowIngress>, PacketStackError> {
        self.udp_flow_ingress
            .take()
            .ok_or(PacketStackError::UdpIngressAlreadyTaken)
    }

    #[cfg(test)]
    pub fn cancellation_token(&self) -> PacketStackCancellation {
        PacketStackCancellation {
            cancellation: self.termination.clone(),
            first_event: Arc::clone(&self.first_event),
        }
    }

    /// Synchronously fence new native/decoded-flow admission. Repeated calls
    /// are idempotent and never request final provider termination.
    pub fn request_quiesce(&self) {
        self.quiesce_state.request(&self.quiesce);
    }

    pub fn health(&self) -> PacketStackHealth {
        let Some(task) = self.driver.as_ref() else {
            return if self.terminal_fault.is_some() {
                PacketStackHealth::Failed
            } else {
                PacketStackHealth::Stopped
            };
        };
        if task.is_finished() {
            self.first_event.record_driver_terminated();
        } else if self.termination.is_cancelled() && self.first_event.event() == FIRST_EVENT_PENDING
        {
            self.first_event.record_untracked_cancellation();
        }
        match self.first_event.event() {
            FIRST_EVENT_DRIVER_TERMINATED | FIRST_EVENT_UNTRACKED_CANCELLATION => {
                PacketStackHealth::Failed
            }
            FIRST_EVENT_CANCEL_REQUESTED => PacketStackHealth::Stopping,
            _ if self.quiesce_state.is_quiesced() => PacketStackHealth::Quiesced,
            _ if self.quiesce_state.is_requested() => PacketStackHealth::Quiescing,
            _ => PacketStackHealth::Ready,
        }
    }

    #[cfg(test)]
    pub async fn shutdown(&mut self) -> Result<PacketStackExit, PacketStackError> {
        let deadline = Instant::now() + self.shutdown_timeout;
        if !self.quiesce_state.is_quiesced() {
            self.request_quiesce();
            self.quiesce_until(deadline).await?;
        }
        self.shutdown_until(deadline).await
    }

    /// Wait for the provider's explicit admission-fence acknowledgement while
    /// retaining the exact driver owner on timeout. Driver termination before
    /// acknowledgement is cached as the root cause and is never reclassified
    /// by a later final-shutdown request.
    pub async fn quiesce_until(
        &mut self,
        caller_deadline: Instant,
    ) -> Result<(), PacketStackError> {
        self.request_quiesce();
        let deadline = caller_deadline.min(Instant::now() + self.shutdown_timeout);
        loop {
            if self.quiesce_state.is_quiesced() {
                tokio::task::yield_now().await;
                if self.driver.as_ref().is_some_and(JoinHandle::is_finished) {
                    let result = self
                        .driver
                        .as_mut()
                        .expect("finished packet-stack driver remains owned")
                        .await;
                    self.driver.take();
                    let error = classify_after_ready(result);
                    self.terminal_fault = Some(error.clone());
                    return Err(error);
                }
                if self.driver.is_some() {
                    return Ok(());
                }
                return Err(self
                    .terminal_fault
                    .clone()
                    .unwrap_or(PacketStackError::DriverExitedUnexpectedly));
            }
            if self.driver.is_none() {
                return Err(self
                    .terminal_fault
                    .clone()
                    .unwrap_or(PacketStackError::DriverExitedUnexpectedly));
            }
            if self.driver.as_ref().is_some_and(JoinHandle::is_finished) {
                let result = self
                    .driver
                    .as_mut()
                    .expect("finished packet-stack driver remains owned")
                    .await;
                self.driver.take();
                let error = classify_after_ready(result);
                self.terminal_fault = Some(error.clone());
                return Err(error);
            }
            if Instant::now() >= deadline {
                return Err(PacketStackError::QuiesceTimeout);
            }

            let quiesce_state = Arc::clone(&self.quiesce_state);
            let acknowledgement = quiesce_state.acknowledged.notified();
            tokio::pin!(acknowledgement);
            if quiesce_state.is_quiesced() {
                continue;
            }

            enum QuiesceWait {
                Acknowledged,
                Driver(Result<DriverResult, JoinError>),
                TimedOut,
            }
            let outcome = {
                let driver = self
                    .driver
                    .as_mut()
                    .expect("packet-stack driver checked before quiesce wait");
                tokio::select! {
                    biased;
                    result = driver => QuiesceWait::Driver(result),
                    _ = &mut acknowledgement => QuiesceWait::Acknowledged,
                    _ = tokio::time::sleep_until(deadline) => QuiesceWait::TimedOut,
                }
            };
            match outcome {
                QuiesceWait::Acknowledged => {}
                QuiesceWait::Driver(result) => {
                    self.driver.take();
                    let error = classify_after_ready(result);
                    self.terminal_fault = Some(error.clone());
                    return Err(error);
                }
                QuiesceWait::TimedOut => return Err(PacketStackError::QuiesceTimeout),
            }
        }
    }

    /// Request final provider termination after admission quiesce has been
    /// acknowledged. The exact join handle is retained when the absolute
    /// deadline expires so composition can retry without losing ownership.
    pub async fn shutdown_until(
        &mut self,
        caller_deadline: Instant,
    ) -> Result<PacketStackExit, PacketStackError> {
        let Some(task) = self.driver.as_mut() else {
            return Ok(PacketStackExit::Cancelled);
        };
        if task.is_finished() {
            self.first_event.record_driver_terminated();
        }
        if !self.quiesce_state.is_quiesced() && !task.is_finished() {
            return Err(PacketStackError::ShutdownBeforeQuiesce);
        }
        self.first_event.request_cancellation(&self.termination);
        let local_deadline = Instant::now() + self.shutdown_timeout;
        let deadline = caller_deadline.min(local_deadline);
        match tokio::time::timeout_at(deadline, &mut *task).await {
            Ok(result) => {
                self.driver.take();
                if self
                    .first_event
                    .driver_terminated_without_controlled_cancel()
                {
                    let error = classify_after_ready(result);
                    self.terminal_fault = Some(error.clone());
                    return Err(error);
                }
                let result = classify_shutdown(result);
                if let Err(error) = &result {
                    self.terminal_fault = Some(error.clone());
                }
                result
            }
            Err(_) => Err(PacketStackError::ShutdownTimeout),
        }
    }
}

impl Drop for ReadyPacketStack {
    fn drop(&mut self) {
        // Emergency containment only: dropping a live handle cannot report
        // whether admission quiesce/control cleanup ran. This direct final
        // termination and detached bounded reaper remain a production blocker;
        // explicit product lifecycles must use `quiesce_until`, then runtime
        // cleanup, then `shutdown_until`, retaining this owner on timeout.
        self.quiesce_state.request(&self.quiesce);
        self.first_event.request_cancellation(&self.termination);
        if let Some(task) = self.driver.take() {
            spawn_emergency_reaper(task, self.shutdown_timeout);
        }
    }
}

impl fmt::Debug for ReadyPacketStack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReadyPacketStack")
            .field("identity", &self.identity)
            .field("capabilities", &self.capabilities)
            .field("health", &self.health())
            .field("flow_ingress_available", &self.flow_ingress.is_some())
            .finish()
    }
}

/// Explicit owner for a driver that was spawned but never reached accepted
/// readiness. Cleanup can be retried under successive absolute deadlines.
pub(in crate::sockscap::flow) struct StartingPacketStack {
    cancellation: CancellationToken,
    task: Option<JoinHandle<DriverResult>>,
    shutdown_timeout: Duration,
}

impl StartingPacketStack {
    pub fn request_stop(&self) {
        self.cancellation.cancel();
    }

    pub async fn shutdown_until(
        &mut self,
        caller_deadline: Instant,
    ) -> Result<(), PacketStackError> {
        let Some(task) = self.task.as_mut() else {
            return Ok(());
        };
        self.cancellation.cancel();
        let deadline = caller_deadline.min(Instant::now() + self.shutdown_timeout);
        let result = match tokio::time::timeout_at(deadline, &mut *task).await {
            Ok(result) => result,
            Err(_) => return Err(PacketStackError::ShutdownTimeout),
        };
        self.task.take();
        match result {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(PacketStackError::DriverFailedBeforeReady {
                provider_code: error.code(),
            }),
            Err(error) if error.is_panic() => Err(PacketStackError::DriverPanickedBeforeReady),
            Err(_) => Err(PacketStackError::DriverAbortedBeforeReady),
        }
    }
}

impl fmt::Debug for StartingPacketStack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StartingPacketStack")
            .field("cancelled", &self.cancellation.is_cancelled())
            .field("task_owned", &self.task.is_some())
            .finish()
    }
}

impl Drop for StartingPacketStack {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(task) = self.task.take() {
            spawn_emergency_reaper(task, self.shutdown_timeout);
        }
    }
}

/// RAII fence for cancellation of the public `start` future.  Once armed, no
/// return path or caller cancellation can leave an uncancelled driver behind.
struct StartingDriverGuard {
    cancellation: CancellationToken,
    task: Option<JoinHandle<DriverResult>>,
    reaper_timeout: Duration,
    armed: bool,
}

impl StartingDriverGuard {
    fn new(
        cancellation: CancellationToken,
        task: JoinHandle<DriverResult>,
        reaper_timeout: Duration,
    ) -> Self {
        Self {
            cancellation,
            task: Some(task),
            reaper_timeout,
            armed: true,
        }
    }

    fn task_mut(&mut self) -> &mut JoinHandle<DriverResult> {
        self.task.as_mut().expect("starting driver task is owned")
    }

    fn is_finished(&self) -> bool {
        self.task.as_ref().is_none_or(JoinHandle::is_finished)
    }

    fn release_completed(&mut self) {
        self.armed = false;
        self.task.take();
    }

    fn disarm(mut self) -> JoinHandle<DriverResult> {
        self.armed = false;
        self.task.take().expect("starting driver task is owned")
    }

    fn into_recovery(mut self) -> StartingPacketStack {
        self.cancellation.cancel();
        self.armed = false;
        StartingPacketStack {
            cancellation: self.cancellation.clone(),
            task: self.task.take(),
            shutdown_timeout: self.reaper_timeout,
        }
    }
}

impl Drop for StartingDriverGuard {
    fn drop(&mut self) {
        if self.armed {
            // Emergency containment for a cancelled `start` future. This path
            // runs before native capture may be activated, but provider-local
            // cleanup is still uncertain. Cancel first, then transfer the join
            // handle to a bounded reaper so the decoded-flow producer remains
            // owned while graceful provider cleanup gets one final chance.
            self.cancellation.cancel();
            if let Some(task) = self.task.take() {
                spawn_emergency_reaper(task, self.reaper_timeout);
            }
        }
    }
}

/// Best-effort owner used only when a public future/handle is dropped instead
/// of explicitly shut down. It first permits cooperative cancellation, then
/// requests abort and observes that abort within a second bounded interval.
/// Failure to observe termination remains state-uncertain; this mechanism is
/// containment, not cleanup evidence for a platform adapter.
fn spawn_emergency_reaper(mut task: JoinHandle<DriverResult>, timeout: Duration) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        task.abort();
        return;
    };
    runtime.spawn(async move {
        if tokio::time::timeout(timeout, &mut task).await.is_err() {
            task.abort();
            let _ = tokio::time::timeout(timeout, &mut task).await;
        }
    });
}

fn classify_before_ready(result: Result<DriverResult, JoinError>) -> PacketStackError {
    match result {
        Ok(Ok(_)) => PacketStackError::DriverExitedBeforeReady,
        Ok(Err(error)) => PacketStackError::DriverFailedBeforeReady {
            provider_code: error.code(),
        },
        Err(error) if error.is_panic() => PacketStackError::DriverPanickedBeforeReady,
        Err(_) => PacketStackError::DriverAbortedBeforeReady,
    }
}

fn classify_after_ready(result: Result<DriverResult, JoinError>) -> PacketStackError {
    match result {
        Ok(Ok(_)) => PacketStackError::DriverExitedUnexpectedly,
        Ok(Err(error)) => PacketStackError::DriverFailed {
            provider_code: error.code(),
        },
        Err(error) if error.is_panic() => PacketStackError::DriverPanicked,
        Err(_) => PacketStackError::DriverAborted,
    }
}

fn classify_shutdown(
    result: Result<DriverResult, JoinError>,
) -> Result<PacketStackExit, PacketStackError> {
    match result {
        Ok(Ok(PacketStackExit::Cancelled)) => Ok(PacketStackExit::Cancelled),
        Ok(Err(error)) => Err(PacketStackError::DriverFailed {
            provider_code: error.code(),
        }),
        Err(error) if error.is_panic() => Err(PacketStackError::DriverPanicked),
        Err(_) => Err(PacketStackError::DriverAborted),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::sockscap::capture::packet_device::{
        MIN_PACKET_QUEUE_BYTES, bounded_packet_device_queues,
    };
    use crate::sockscap::flow::ingress::{FlowIngress, UdpFlowIngress};
    use crate::sockscap::flow::ip_stack::{
        ChecksumPolicy, FragmentationPolicy, IcmpBehavior, IpStackProviderCapabilities,
        IpStackProviderResources, Ipv6ExtensionHeaderPolicy, TcpBridgeBudget,
        TcpLifecycleDeadlines, UdpAssociationQueueBudgets, UdpQueueBudget,
        UdpWildcardBindingBudgets,
    };
    const GENERATION: u64 = 7;
    const REVISION: u64 = 3;

    fn provider_pin() -> IpStackProviderPin {
        IpStackProviderPin {
            name: "taomni-test-stack".into(),
            version: "0.0.0-test".into(),
            source_sha256: "a".repeat(64),
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

    fn identity() -> PacketStackIdentity {
        PacketStackIdentity {
            generation: GENERATION,
            config_revision: REVISION,
            platform: CapturePlatform::Linux,
            provider: provider_pin(),
        }
    }

    fn stack_config() -> IpStackConfig {
        let udp_queue = UdpQueueBudget {
            datagrams: 2,
            payload_bytes: 2_400,
            metadata_bytes: 128,
        };
        IpStackConfig {
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
        }
    }

    fn supervisor_config() -> PacketStackSupervisorConfig {
        PacketStackSupervisorConfig {
            identity: identity(),
            required_capabilities: PacketStackCapabilities {
                ipv4: true,
                tcp: true,
                ..PacketStackCapabilities::default()
            },
            decoded_tcp_queue_capacity: 8,
            decoded_udp_queue_capacity: 8,
            startup_timeout: Duration::from_millis(100),
            shutdown_timeout: Duration::from_millis(100),
        }
    }

    fn packet_io_for(generation: u64, platform: CapturePlatform) -> PacketStackIo {
        let (_native, stack) =
            bounded_packet_device_queues(MIN_PACKET_QUEUE_BYTES, generation, platform).unwrap();
        PacketStackIo::new(stack.ingress, stack.egress).unwrap()
    }

    fn packet_io() -> PacketStackIo {
        packet_io_for(GENERATION, CapturePlatform::Linux)
    }

    #[derive(Clone)]
    enum RunBehavior {
        ReadyAndWait,
        NeverReady,
        NeverReadyUntilRelease(Arc<tokio::sync::Notify>),
        EarlyExit,
        EarlyError,
        Panic,
        ReadyIdentity(PacketStackIdentity),
        ReadyCapabilities(PacketStackCapabilities),
        ReadyThenRelease(Arc<tokio::sync::Notify>),
        ReadyThenError(Arc<tokio::sync::Notify>),
        ReadyThenPanic(Arc<tokio::sync::Notify>),
        ReadyAfterBlockingDelay(Duration),
        QuiesceUntilRelease(Arc<tokio::sync::Notify>),
        QuiesceThenIgnoreTermination(Arc<tokio::sync::Notify>),
    }

    #[derive(Default)]
    struct DriverObservation {
        entered: AtomicBool,
        dropped: AtomicBool,
        quiesce_requested: AtomicBool,
        quiesced: AtomicBool,
        termination_requested: AtomicBool,
    }

    struct DriverDropGuard(Arc<DriverObservation>);

    impl Drop for DriverDropGuard {
        fn drop(&mut self) {
            self.0.dropped.store(true, Ordering::Release);
        }
    }

    struct FakeDriver {
        identity: PacketStackIdentity,
        ready_capabilities: PacketStackCapabilities,
        behavior: RunBehavior,
        observation: Arc<DriverObservation>,
    }

    async fn serve_ready_driver(
        context: PacketStackRunContext,
        control: PacketStackDriverControl,
        tcp_ingress: BoundedFlowIngressSender,
        udp_ingress: BoundedUdpFlowIngressSender,
        observation: &DriverObservation,
        quiesce_release: Option<Arc<tokio::sync::Notify>>,
        termination_release: Option<Arc<tokio::sync::Notify>>,
    ) -> Result<PacketStackExit, PacketStackError> {
        control.quiesce_requested().await;
        observation.quiesce_requested.store(true, Ordering::Release);
        if let Some(release) = quiesce_release {
            release.notified().await;
        }
        let (native_ingress, native_egress) = context.into_io().into_parts();
        drop(native_ingress);
        drop(tcp_ingress);
        drop(udp_ingress);
        control.acknowledge_quiesced()?;
        observation.quiesced.store(true, Ordering::Release);
        control.termination_requested().await;
        observation
            .termination_requested
            .store(true, Ordering::Release);
        if let Some(release) = termination_release {
            release.notified().await;
        }
        drop(native_egress);
        Ok(PacketStackExit::Cancelled)
    }

    #[async_trait]
    impl PacketStackDriver for FakeDriver {
        fn identity(&self) -> PacketStackIdentity {
            self.identity.clone()
        }

        async fn run(
            self: Box<Self>,
            context: PacketStackRunContext,
            readiness: oneshot::Sender<PacketStackReady>,
            control: PacketStackDriverControl,
            tcp_ingress: BoundedFlowIngressSender,
            udp_ingress: BoundedUdpFlowIngressSender,
        ) -> Result<PacketStackExit, PacketStackError> {
            assert_eq!(context.identity(), &self.identity);
            assert_eq!(context.config().generation, GENERATION);
            let _drop_guard = DriverDropGuard(Arc::clone(&self.observation));
            self.observation.entered.store(true, Ordering::Release);
            match self.behavior {
                RunBehavior::ReadyAndWait => {
                    let _ = readiness.send(PacketStackReady {
                        identity: self.identity,
                        capabilities: self.ready_capabilities,
                    });
                    serve_ready_driver(
                        context,
                        control,
                        tcp_ingress,
                        udp_ingress,
                        &self.observation,
                        None,
                        None,
                    )
                    .await
                }
                RunBehavior::NeverReady => {
                    control.termination_requested().await;
                    self.observation
                        .termination_requested
                        .store(true, Ordering::Release);
                    Ok(PacketStackExit::Cancelled)
                }
                RunBehavior::NeverReadyUntilRelease(release) => {
                    release.notified().await;
                    self.observation
                        .termination_requested
                        .store(control.is_termination_requested(), Ordering::Release);
                    Ok(PacketStackExit::Cancelled)
                }
                RunBehavior::EarlyExit => Ok(PacketStackExit::Cancelled),
                RunBehavior::EarlyError => Err(PacketStackError::provider(
                    "FAKE_DRIVER_FAILED",
                    "fake driver failed",
                )),
                RunBehavior::Panic => panic!("fake packet-stack panic"),
                RunBehavior::ReadyIdentity(ready_identity) => {
                    let _ = readiness.send(PacketStackReady {
                        identity: ready_identity,
                        capabilities: self.ready_capabilities,
                    });
                    control.termination_requested().await;
                    self.observation
                        .termination_requested
                        .store(true, Ordering::Release);
                    Ok(PacketStackExit::Cancelled)
                }
                RunBehavior::ReadyCapabilities(ready_capabilities) => {
                    let _ = readiness.send(PacketStackReady {
                        identity: self.identity,
                        capabilities: ready_capabilities,
                    });
                    control.termination_requested().await;
                    self.observation
                        .termination_requested
                        .store(true, Ordering::Release);
                    Ok(PacketStackExit::Cancelled)
                }
                RunBehavior::ReadyThenRelease(release) => {
                    let _ = readiness.send(PacketStackReady {
                        identity: self.identity,
                        capabilities: self.ready_capabilities,
                    });
                    release.notified().await;
                    Ok(PacketStackExit::Cancelled)
                }
                RunBehavior::ReadyThenError(release) => {
                    let _ = readiness.send(PacketStackReady {
                        identity: self.identity,
                        capabilities: self.ready_capabilities,
                    });
                    release.notified().await;
                    Err(PacketStackError::provider(
                        "FAKE_DRIVER_FAILED",
                        "fake driver failed after readiness",
                    ))
                }
                RunBehavior::ReadyThenPanic(release) => {
                    let _ = readiness.send(PacketStackReady {
                        identity: self.identity,
                        capabilities: self.ready_capabilities,
                    });
                    release.notified().await;
                    panic!("fake packet-stack panic after readiness")
                }
                RunBehavior::ReadyAfterBlockingDelay(delay) => {
                    let _ = readiness.send(PacketStackReady {
                        identity: self.identity,
                        capabilities: self.ready_capabilities,
                    });
                    std::thread::sleep(delay);
                    serve_ready_driver(
                        context,
                        control,
                        tcp_ingress,
                        udp_ingress,
                        &self.observation,
                        None,
                        None,
                    )
                    .await
                }
                RunBehavior::QuiesceUntilRelease(release) => {
                    let _ = readiness.send(PacketStackReady {
                        identity: self.identity,
                        capabilities: self.ready_capabilities,
                    });
                    serve_ready_driver(
                        context,
                        control,
                        tcp_ingress,
                        udp_ingress,
                        &self.observation,
                        Some(release),
                        None,
                    )
                    .await
                }
                RunBehavior::QuiesceThenIgnoreTermination(release) => {
                    let _ = readiness.send(PacketStackReady {
                        identity: self.identity,
                        capabilities: self.ready_capabilities,
                    });
                    serve_ready_driver(
                        context,
                        control,
                        tcp_ingress,
                        udp_ingress,
                        &self.observation,
                        None,
                        Some(release),
                    )
                    .await
                }
            }
        }
    }

    struct FakeProvider {
        descriptor: PacketStackDescriptor,
        driver_identity: PacketStackIdentity,
        behavior: RunBehavior,
        observation: Arc<DriverObservation>,
    }

    #[async_trait]
    impl PacketStackProvider for FakeProvider {
        fn descriptor(&self) -> PacketStackDescriptor {
            self.descriptor.clone()
        }

        async fn build(
            &self,
            config: IpStackConfig,
        ) -> Result<Box<dyn PacketStackDriver>, PacketStackError> {
            assert_eq!(config, stack_config());
            Ok(Box::new(FakeDriver {
                identity: self.driver_identity.clone(),
                ready_capabilities: self.descriptor.capabilities,
                behavior: self.behavior.clone(),
                observation: Arc::clone(&self.observation),
            }))
        }
    }

    fn provider(behavior: RunBehavior) -> (Arc<dyn PacketStackProvider>, Arc<DriverObservation>) {
        let observation = Arc::new(DriverObservation::default());
        (
            Arc::new(FakeProvider {
                descriptor: PacketStackDescriptor {
                    provider: provider_pin(),
                    capabilities: capabilities(),
                },
                driver_identity: identity(),
                behavior,
                observation: Arc::clone(&observation),
            }),
            observation,
        )
    }

    fn make_supervisor(behavior: RunBehavior) -> (PacketStackSupervisor, Arc<DriverObservation>) {
        let (provider, observation) = provider(behavior);
        (
            PacketStackSupervisor::new(supervisor_config(), stack_config(), provider).unwrap(),
            observation,
        )
    }

    async fn wait_for(predicate: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !predicate() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition reached");
    }

    #[test]
    fn configuration_identity_pin_capabilities_and_limits_fail_closed() {
        let (provider, _) = provider(RunBehavior::ReadyAndWait);
        let mut config = supervisor_config();
        config.identity.config_revision = 0;
        assert_eq!(
            PacketStackSupervisor::new(config, stack_config(), Arc::clone(&provider))
                .unwrap_err()
                .code(),
            "PACKET_STACK_IDENTITY_INVALID"
        );

        let mut config = supervisor_config();
        config.startup_timeout = Duration::from_millis(1);
        assert_eq!(
            PacketStackSupervisor::new(config, stack_config(), Arc::clone(&provider))
                .unwrap_err()
                .code(),
            "PACKET_STACK_TIMEOUT_INVALID"
        );

        let missing_provider: Arc<dyn PacketStackProvider> = Arc::new(FakeProvider {
            descriptor: PacketStackDescriptor {
                provider: provider_pin(),
                capabilities: PacketStackCapabilities::default(),
            },
            driver_identity: identity(),
            behavior: RunBehavior::ReadyAndWait,
            observation: Arc::new(DriverObservation::default()),
        });
        let config = supervisor_config();
        assert_eq!(
            PacketStackSupervisor::new(config, stack_config(), missing_provider)
                .unwrap_err()
                .code(),
            "PACKET_STACK_CAPABILITY_MISSING"
        );

        let mut config = supervisor_config();
        config.identity.provider.version = "foreign".into();
        assert_eq!(
            PacketStackSupervisor::new(config, stack_config(), provider)
                .unwrap_err()
                .code(),
            "PACKET_STACK_CONFIG_IDENTITY_MISMATCH"
        );
    }

    #[tokio::test]
    async fn ready_handle_is_single_use_exposes_ingress_and_stops_cleanly() {
        let (supervisor, observation) = make_supervisor(RunBehavior::ReadyAndWait);
        let mut ready = supervisor.start(packet_io()).await.unwrap();
        assert_eq!(ready.identity(), &identity());
        assert_eq!(ready.capabilities(), capabilities());
        assert_eq!(ready.health(), PacketStackHealth::Ready);
        let ingress = ready.take_flow_ingress().unwrap();
        let udp_ingress = ready.take_udp_flow_ingress().unwrap();
        assert_eq!(
            ready.take_flow_ingress().unwrap_err().code(),
            "PACKET_STACK_FLOW_INGRESS_ALREADY_TAKEN"
        );
        assert_eq!(
            ready.take_udp_flow_ingress().unwrap_err().code(),
            "PACKET_STACK_UDP_INGRESS_ALREADY_TAKEN"
        );

        assert_eq!(
            supervisor.start(packet_io()).await.unwrap_err().code(),
            "PACKET_STACK_ALREADY_STARTED"
        );
        assert_eq!(ready.shutdown().await.unwrap(), PacketStackExit::Cancelled);
        assert_eq!(ready.health(), PacketStackHealth::Stopped);
        assert!(observation.dropped.load(Ordering::Acquire));
        assert!(ingress.accept_tcp().await.unwrap().is_none());
        assert!(udp_ingress.accept_udp().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn packet_io_and_supervisor_reject_mixed_or_stale_queue_identity() {
        let (_native_a, stack_a) = bounded_packet_device_queues(
            MIN_PACKET_QUEUE_BYTES,
            GENERATION,
            CapturePlatform::Linux,
        )
        .unwrap();
        let (_native_b, stack_b) = bounded_packet_device_queues(
            MIN_PACKET_QUEUE_BYTES,
            GENERATION,
            CapturePlatform::Linux,
        )
        .unwrap();
        assert_eq!(
            PacketStackIo::new(stack_a.ingress, stack_b.egress)
                .unwrap_err()
                .code(),
            "PACKET_STACK_IO_IDENTITY_MISMATCH"
        );

        let (supervisor, observation) = make_supervisor(RunBehavior::ReadyAndWait);
        assert_eq!(
            supervisor
                .start(packet_io_for(GENERATION + 1, CapturePlatform::Linux))
                .await
                .unwrap_err()
                .code(),
            "PACKET_STACK_IO_IDENTITY_MISMATCH"
        );
        assert!(!observation.entered.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn readiness_timeout_returns_retryable_pre_ready_owner() {
        let (mut config, stack) = (supervisor_config(), stack_config());
        config.startup_timeout = Duration::from_millis(20);
        config.shutdown_timeout = Duration::from_millis(20);
        let release = Arc::new(tokio::sync::Notify::new());
        let (provider, observation) =
            provider(RunBehavior::NeverReadyUntilRelease(Arc::clone(&release)));
        let supervisor = PacketStackSupervisor::new(config, stack, provider).unwrap();
        let mut error = supervisor.start(packet_io()).await.unwrap_err();
        assert_eq!(error.code(), "PACKET_STACK_START_TIMEOUT");
        let mut owner = error
            .take_recovery_owner()
            .expect("a spawned pre-ready driver must remain explicitly owned");
        assert_eq!(
            owner
                .shutdown_until(Instant::now() + Duration::from_millis(20))
                .await
                .unwrap_err()
                .code(),
            "PACKET_STACK_SHUTDOWN_TIMEOUT"
        );
        assert!(!observation.dropped.load(Ordering::Acquire));
        release.notify_one();
        owner
            .shutdown_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        wait_for(|| observation.dropped.load(Ordering::Acquire)).await;
        assert!(observation.termination_requested.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn ready_identity_and_capability_changes_are_rejected() {
        let mut foreign = identity();
        foreign.generation += 1;
        let (supervisor, observation) = make_supervisor(RunBehavior::ReadyIdentity(foreign));
        assert_eq!(
            supervisor.start(packet_io()).await.unwrap_err().code(),
            "PACKET_STACK_READY_IDENTITY_MISMATCH"
        );
        wait_for(|| observation.dropped.load(Ordering::Acquire)).await;

        let mut reduced = capabilities();
        reduced.tcp = false;
        let (supervisor, observation) = make_supervisor(RunBehavior::ReadyCapabilities(reduced));
        assert_eq!(
            supervisor.start(packet_io()).await.unwrap_err().code(),
            "PACKET_STACK_READY_CAPABILITIES_MISMATCH"
        );
        wait_for(|| observation.dropped.load(Ordering::Acquire)).await;
    }

    #[tokio::test]
    async fn built_driver_identity_mismatch_is_rejected_before_spawn() {
        let observation = Arc::new(DriverObservation::default());
        let mut foreign = identity();
        foreign.config_revision += 1;
        let provider: Arc<dyn PacketStackProvider> = Arc::new(FakeProvider {
            descriptor: PacketStackDescriptor {
                provider: provider_pin(),
                capabilities: capabilities(),
            },
            driver_identity: foreign,
            behavior: RunBehavior::ReadyAndWait,
            observation: Arc::clone(&observation),
        });
        let supervisor =
            PacketStackSupervisor::new(supervisor_config(), stack_config(), provider).unwrap();
        assert_eq!(
            supervisor.start(packet_io()).await.unwrap_err().code(),
            "PACKET_STACK_DRIVER_IDENTITY_MISMATCH"
        );
        assert!(!observation.entered.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn readiness_cannot_escape_the_absolute_startup_deadline() {
        let mut config = supervisor_config();
        config.startup_timeout = Duration::from_millis(20);
        let (provider, observation) = provider(RunBehavior::ReadyAfterBlockingDelay(
            Duration::from_millis(30),
        ));
        let supervisor = PacketStackSupervisor::new(config, stack_config(), provider).unwrap();
        assert_eq!(
            supervisor.start(packet_io()).await.unwrap_err().code(),
            "PACKET_STACK_START_TIMEOUT"
        );
        wait_for(|| observation.dropped.load(Ordering::Acquire)).await;
    }

    #[tokio::test]
    async fn driver_early_exit_error_and_panic_are_fail_closed() {
        for (behavior, expected) in [
            (
                RunBehavior::EarlyExit,
                "PACKET_STACK_DRIVER_EXITED_BEFORE_READY",
            ),
            (
                RunBehavior::EarlyError,
                "PACKET_STACK_DRIVER_FAILED_BEFORE_READY",
            ),
            (
                RunBehavior::Panic,
                "PACKET_STACK_DRIVER_PANICKED_BEFORE_READY",
            ),
        ] {
            let (supervisor, observation) = make_supervisor(behavior);
            assert_eq!(
                supervisor.start(packet_io()).await.unwrap_err().code(),
                expected
            );
            wait_for(|| observation.dropped.load(Ordering::Acquire)).await;
        }
    }

    #[tokio::test]
    async fn health_detects_exit_after_readiness() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (supervisor, _) = make_supervisor(RunBehavior::ReadyThenRelease(Arc::clone(&release)));
        let mut ready = supervisor.start(packet_io()).await.unwrap();
        release.notify_one();
        wait_for(|| ready.health() == PacketStackHealth::Failed).await;
        assert_eq!(
            ready.shutdown().await.unwrap_err().code(),
            "PACKET_STACK_DRIVER_EXITED_UNEXPECTEDLY"
        );
    }

    #[tokio::test]
    async fn driver_failure_during_quiesce_is_cached_as_the_terminal_root_cause() {
        for (behavior, release, expected) in {
            let error_release = Arc::new(tokio::sync::Notify::new());
            let panic_release = Arc::new(tokio::sync::Notify::new());
            [
                (
                    RunBehavior::ReadyThenError(Arc::clone(&error_release)),
                    error_release,
                    "PACKET_STACK_DRIVER_FAILED",
                ),
                (
                    RunBehavior::ReadyThenPanic(Arc::clone(&panic_release)),
                    panic_release,
                    "PACKET_STACK_DRIVER_PANICKED",
                ),
            ]
        } {
            let (supervisor, _) = make_supervisor(behavior);
            let mut ready = supervisor.start(packet_io()).await.unwrap();
            ready.request_quiesce();
            release.notify_one();
            assert_eq!(
                ready
                    .quiesce_until(Instant::now() + Duration::from_secs(1))
                    .await
                    .unwrap_err()
                    .code(),
                expected
            );
            assert_eq!(ready.health(), PacketStackHealth::Failed);
            assert_eq!(
                ready
                    .terminal_fault
                    .as_ref()
                    .expect("terminal driver fault is retained")
                    .code(),
                expected
            );
            assert_eq!(
                ready
                    .shutdown_until(Instant::now() + Duration::from_secs(1))
                    .await
                    .unwrap(),
                PacketStackExit::Cancelled
            );
        }
    }

    #[tokio::test]
    async fn completed_driver_cannot_be_reclassified_by_later_cancel() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (supervisor, _) = make_supervisor(RunBehavior::ReadyThenRelease(Arc::clone(&release)));
        let mut ready = supervisor.start(packet_io()).await.unwrap();
        release.notify_one();
        wait_for(|| ready.driver.as_ref().unwrap().is_finished()).await;

        ready.request_quiesce();
        assert_eq!(ready.health(), PacketStackHealth::Failed);
        assert_eq!(
            ready.shutdown().await.unwrap_err().code(),
            "PACKET_STACK_DRIVER_EXITED_UNEXPECTEDLY"
        );
    }

    #[tokio::test]
    async fn controlled_cancel_handle_latches_before_cooperative_exit() {
        let (supervisor, observation) = make_supervisor(RunBehavior::ReadyAndWait);
        let mut ready = supervisor.start(packet_io()).await.unwrap();
        ready.request_quiesce();
        ready
            .quiesce_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        let cancellation = ready.cancellation_token();

        cancellation.cancel();
        cancellation.cancelled().await;
        assert!(cancellation.is_cancelled());
        assert_eq!(ready.health(), PacketStackHealth::Stopping);
        assert_eq!(
            ready
                .shutdown_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap(),
            PacketStackExit::Cancelled
        );
        assert!(observation.dropped.load(Ordering::Acquire));
    }

    #[test]
    fn driver_cannot_acknowledge_quiesce_before_request() {
        let quiesce = CancellationToken::new();
        let quiesce_state = Arc::new(DriverQuiesceState::new());
        let control = PacketStackDriverControl {
            quiesce,
            termination: CancellationToken::new(),
            quiesce_state,
        };
        assert_eq!(
            control.acknowledge_quiesced().unwrap_err().code(),
            "PACKET_STACK_QUIESCE_ACK_BEFORE_REQUEST"
        );
    }

    #[tokio::test]
    async fn controlled_final_termination_does_not_hide_abort() {
        let (supervisor, _) = make_supervisor(RunBehavior::ReadyAndWait);
        let mut ready = supervisor.start(packet_io()).await.unwrap();
        ready.request_quiesce();
        ready
            .quiesce_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        ready.cancellation_token().cancel();
        ready.driver.as_ref().unwrap().abort();
        assert_eq!(
            ready
                .shutdown_until(Instant::now() + Duration::from_secs(1))
                .await
                .unwrap_err()
                .code(),
            "PACKET_STACK_DRIVER_ABORTED"
        );
    }

    #[tokio::test]
    async fn cancelling_start_future_cancels_driver_and_drops_its_producer() {
        let (supervisor, observation) = make_supervisor(RunBehavior::NeverReady);
        let supervisor = Arc::new(supervisor);
        let start_task = {
            let supervisor = Arc::clone(&supervisor);
            tokio::spawn(async move { supervisor.start(packet_io()).await })
        };
        wait_for(|| observation.entered.load(Ordering::Acquire)).await;
        start_task.abort();
        let _ = start_task.await;
        wait_for(|| observation.dropped.load(Ordering::Acquire)).await;
        assert!(observation.termination_requested.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn quiesce_ack_closes_native_and_both_decoded_ingresses_before_final_stop() {
        let (supervisor, observation) = make_supervisor(RunBehavior::ReadyAndWait);
        let (native, stack) = bounded_packet_device_queues(
            MIN_PACKET_QUEUE_BYTES,
            GENERATION,
            CapturePlatform::Linux,
        )
        .unwrap();
        let mut ready = supervisor
            .start(PacketStackIo::new(stack.ingress, stack.egress).unwrap())
            .await
            .unwrap();
        let tcp_ingress = ready.take_flow_ingress().unwrap();
        let udp_ingress = ready.take_udp_flow_ingress().unwrap();

        ready.request_quiesce();
        assert_eq!(ready.health(), PacketStackHealth::Quiescing);
        ready
            .quiesce_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(ready.health(), PacketStackHealth::Quiesced);
        assert!(native.capture.is_closed());
        assert!(tcp_ingress.accept_tcp().await.unwrap().is_none());
        assert!(udp_ingress.accept_udp().await.unwrap().is_none());
        assert!(observation.quiesced.load(Ordering::Acquire));
        assert!(!observation.termination_requested.load(Ordering::Acquire));
        assert!(!observation.dropped.load(Ordering::Acquire));

        ready
            .shutdown_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert!(observation.termination_requested.load(Ordering::Acquire));
        assert!(observation.dropped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn quiesce_timeout_retains_live_actor_and_retries_same_owner() {
        let mut config = supervisor_config();
        config.shutdown_timeout = Duration::from_millis(20);
        let release = Arc::new(tokio::sync::Notify::new());
        let (provider, observation) =
            provider(RunBehavior::QuiesceUntilRelease(Arc::clone(&release)));
        let supervisor = PacketStackSupervisor::new(config, stack_config(), provider).unwrap();
        let mut ready = supervisor.start(packet_io()).await.unwrap();

        ready.request_quiesce();
        assert_eq!(
            ready
                .quiesce_until(Instant::now() + Duration::from_millis(20))
                .await
                .unwrap_err()
                .code(),
            "PACKET_STACK_QUIESCE_TIMEOUT"
        );
        assert_eq!(ready.health(), PacketStackHealth::Quiescing);
        assert!(!observation.termination_requested.load(Ordering::Acquire));
        assert!(!observation.dropped.load(Ordering::Acquire));

        release.notify_one();
        ready
            .quiesce_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(ready.health(), PacketStackHealth::Quiesced);
        ready
            .shutdown_until(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn shutdown_timeout_is_bounded_and_retains_abort_result_for_recovery() {
        let mut config = supervisor_config();
        config.shutdown_timeout = Duration::from_millis(20);
        let release = Arc::new(tokio::sync::Notify::new());
        let (provider, observation) = provider(RunBehavior::QuiesceThenIgnoreTermination(
            Arc::clone(&release),
        ));
        let supervisor = PacketStackSupervisor::new(config, stack_config(), provider).unwrap();
        let mut ready = supervisor.start(packet_io()).await.unwrap();
        let started = Instant::now();
        assert_eq!(
            ready.shutdown().await.unwrap_err().code(),
            "PACKET_STACK_SHUTDOWN_TIMEOUT"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(ready.health(), PacketStackHealth::Stopping);
        assert!(!observation.dropped.load(Ordering::Acquire));
        release.notify_one();
        assert_eq!(ready.shutdown().await.unwrap(), PacketStackExit::Cancelled);
        assert!(observation.dropped.load(Ordering::Acquire));
        assert_eq!(ready.health(), PacketStackHealth::Stopped);
    }

    struct PanickingDescriptorProvider;

    #[async_trait]
    impl PacketStackProvider for PanickingDescriptorProvider {
        fn descriptor(&self) -> PacketStackDescriptor {
            panic!("fake descriptor panic")
        }

        async fn build(
            &self,
            _config: IpStackConfig,
        ) -> Result<Box<dyn PacketStackDriver>, PacketStackError> {
            unreachable!("descriptor validation must fail before build")
        }
    }

    #[test]
    fn provider_descriptor_panic_is_contained() {
        assert_eq!(
            PacketStackSupervisor::new(
                supervisor_config(),
                stack_config(),
                Arc::new(PanickingDescriptorProvider),
            )
            .unwrap_err()
            .code(),
            "PACKET_STACK_PROVIDER_DESCRIPTOR_PANICKED"
        );
    }

    #[test]
    fn packet_stack_io_is_send_and_identity_keeps_provider_pin() {
        fn assert_send<T: Send>() {}
        assert_send::<PacketStackIo>();
        assert_eq!(identity().provider, provider_pin());
    }
}
