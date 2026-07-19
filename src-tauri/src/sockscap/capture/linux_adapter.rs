//! Linux capture lifecycle and packet-device scaffold.
//!
//! This module is intentionally *not* the product `CaptureAdapter`.  It gives
//! the eventual adapter a typed, injectable call-order boundary while the
//! complete TCP/UDP implementation and the trusted application/PID side
//! channel are still unfinished.  No route, nftables rule, cgroup, or TUN is
//! created by the lifecycle itself.  The only concrete device below opens a
//! helper-created TUN and moves validated L3 packets through bounded queues.
//!
//! The production orchestrator must keep the capability bits locked until a
//! complete stack provider, packet pump, package/polkit evidence, and native
//! smoke gate are available.  In particular, this scaffold accepts only
//! global capture; application/PID modes fail closed rather than losing their
//! attribution and silently falling back to global capture.

use std::fmt;
use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use super::linux::{LINUX_ADAPTER_ID, TUN_MTU};
use super::linux_client::LinuxHelperClient;
use super::linux_tun::{LinuxGlobalTunReader, LinuxTunConfig, LinuxTunDevice, LinuxTunError};
use super::packet_device::{
    MIN_PACKET_QUEUE_BYTES, PacketDeviceError, PacketEgressFrame, PacketEgressReceiver,
    PacketEgressSender, PacketFrame, PacketIngressReceiver, PacketIngressSender,
    PacketQueueIdentity, PacketTrySendError, bounded_packet_device_queues,
};
use super::{
    AdapterProbe, CaptureArtifactState, CaptureError, CaptureHandle, CaptureInstallSpec,
    CaptureMode,
};
use crate::sockscap::types::CapturePlatform;

const LINUX_DATA_PLANE_START_GRACE: Duration = Duration::from_secs(15);
const LINUX_DATA_PLANE_SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
#[cfg(not(test))]
const LINUX_DATA_PLANE_HEALTH_INTERVAL: Duration = Duration::from_millis(250);
#[cfg(test)]
const LINUX_DATA_PLANE_HEALTH_INTERVAL: Duration = Duration::from_millis(10);

/// Runtime identity supplied to the helper's activate request.  The start
/// token prevents a reused PID from inheriting a previous generation's TUN.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxRuntimeIdentity {
    pub generation: u64,
    pub pid: u32,
    pub process_start_time: u64,
}

impl LinuxRuntimeIdentity {
    pub fn validate_for(&self, generation: u64) -> Result<(), LinuxPacketRuntimeError> {
        if generation == 0
            || self.generation != generation
            || self.pid == 0
            || self.process_start_time == 0
        {
            return Err(LinuxPacketRuntimeError::invalid(
                "LINUX_RUNTIME_IDENTITY_INVALID",
                "runtime generation, PID, and start token must be non-zero and match",
            ));
        }
        Ok(())
    }
}

/// The stack-facing ends of a native Linux packet runtime.  The eventual
/// controlled IP stack owns these ends; this scaffold does not decode TCP,
/// UDP, fragments, or DNS.
pub struct LinuxPacketRuntimeChannels {
    pub ingress: PacketIngressReceiver,
    pub egress: PacketEgressSender,
    identity: LinuxPacketChannelIdentity,
}

impl fmt::Debug for LinuxPacketRuntimeChannels {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinuxPacketRuntimeChannels")
            .field("identity", &self.identity)
            .field("ingress", &self.ingress)
            .field("egress", &self.egress)
            .finish()
    }
}

/// Immutable queue identity checked before ownership crosses into the
/// controlled packet plane. The queues also validate every frame, but making
/// their generation, platform, and source explicit lets activation fail
/// before any host traffic is redirected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxPacketChannelIdentity {
    pub generation: u64,
    pub platform: CapturePlatform,
    /// Exact process-local packet-device identity shared by both queue
    /// directions. Its opaque source id prevents a stack from acknowledging
    /// queues belonging to a different native device with the same generation.
    pub packet_queue: PacketQueueIdentity,
}

impl LinuxPacketChannelIdentity {
    pub fn source_id(self) -> u64 {
        self.packet_queue.source_id()
    }
}

impl LinuxPacketRuntimeChannels {
    fn validate_for(&self, spec: &CaptureInstallSpec) -> Result<(), LinuxDataPlaneError> {
        let ingress_identity = self.ingress.identity();
        let egress_identity = self.egress.identity();
        if ingress_identity != egress_identity
            || ingress_identity != self.identity.packet_queue
            || ingress_identity.generation != self.identity.generation
            || ingress_identity.platform != self.identity.platform
            || self.identity.source_id() == 0
            || self.identity.generation == 0
            || self.identity.generation != spec.generation
            || self.identity.platform != CapturePlatform::Linux
            || spec.platform != CapturePlatform::Linux
        {
            return Err(LinuxDataPlaneError::invalid(
                "LINUX_PACKET_CHANNEL_IDENTITY_INVALID",
                "packet channels do not match the Linux capture transaction",
            ));
        }
        Ok(())
    }

    pub fn identity(&self) -> LinuxPacketChannelIdentity {
        self.identity
    }
}

/// A runtime object retained by the lifecycle until helper cleanup succeeds.
/// Keeping the runtime in the transaction record prevents a failed stop from
/// accidentally dropping the only owner of a still-open TUN fd.
pub struct LinuxPacketRuntimeBundle {
    pub runtime: Box<dyn LinuxPacketRuntime>,
    channels: Option<LinuxPacketRuntimeChannels>,
}

impl fmt::Debug for LinuxPacketRuntimeBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinuxPacketRuntimeBundle")
            .field("runtime", &self.runtime)
            .field("channels_available", &self.channels.is_some())
            .finish()
    }
}

impl LinuxPacketRuntimeBundle {
    pub fn new(runtime: Box<dyn LinuxPacketRuntime>, channels: LinuxPacketRuntimeChannels) -> Self {
        Self {
            runtime,
            channels: Some(channels),
        }
    }

    pub fn identity(&self) -> LinuxRuntimeIdentity {
        self.runtime.identity()
    }

    /// Transfer the stack-facing queue ends exactly once.  The runtime keeps
    /// owning the native fd after this handoff so lifecycle rollback can still
    /// close it if stack construction fails.
    pub fn take_channels(&mut self) -> Option<LinuxPacketRuntimeChannels> {
        self.channels.take()
    }

    pub fn channels_available(&self) -> bool {
        self.channels.is_some()
    }
}

/// Native runtime contract retained by the capture transaction.  The
/// lifecycle starts and proves both TUN pump directions before transferring
/// the stack-facing queue ends, and keeps the join handles until shutdown has
/// completed or can be retried by recovery.
#[async_trait]
pub trait LinuxPacketRuntime: Send + fmt::Debug {
    fn identity(&self) -> LinuxRuntimeIdentity;

    /// Arm and prove both native TUN pump tasks before the controlled stack is
    /// allowed to report ready.
    async fn start_pump_until(&mut self, deadline: Instant) -> Result<(), LinuxPacketRuntimeError>;

    fn ensure_pump_healthy(&self) -> Result<(), LinuxPacketRuntimeError>;

    async fn close_until(&mut self, deadline: Instant) -> Result<(), LinuxPacketRuntimeError>;
}

/// Concrete TUN-to-queue bridge.  Manual one-packet operations are available
/// before startup for native smoke tests; the lifecycle owns the continuous
/// pump once `start_pump_until` succeeds.
pub struct LinuxTunPacketRuntime {
    reader: Arc<LinuxGlobalTunReader>,
    ingress: Arc<PacketIngressSender>,
    egress: Arc<PacketEgressReceiver>,
    identity: LinuxRuntimeIdentity,
    cancellation: CancellationToken,
    capture_task: Option<JoinHandle<Result<(), LinuxPacketRuntimeError>>>,
    reinject_task: Option<JoinHandle<Result<(), LinuxPacketRuntimeError>>>,
    /// The first non-cancellation pump failure is retained independently of
    /// the join handles. The sibling pump cancels immediately, so consulting
    /// only task completion would otherwise collapse the root cause into the
    /// generic `PUMP_EXITED` health error.
    pump_fault: Arc<std::sync::Mutex<Option<LinuxPacketPumpFault>>>,
    pump_started: AtomicBool,
    closed: AtomicBool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LinuxPacketPumpFault {
    code: String,
    message: String,
}

impl fmt::Debug for LinuxTunPacketRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinuxTunPacketRuntime")
            .field("identity", &self.identity)
            .field("pump_started", &self.pump_started.load(Ordering::Acquire))
            .field("pump_healthy", &self.ensure_pump_healthy().is_ok())
            .field("closed", &self.closed.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

/// Injectable packet writer used to prove that reinjection shutdown remains
/// cancellation-safe while the native device is write-backpressured.
#[async_trait]
trait LinuxReinjectWriter: Send + Sync {
    async fn write_frame(&self, frame: &PacketEgressFrame) -> Result<(), LinuxPacketRuntimeError>;
}

#[async_trait]
impl LinuxReinjectWriter for LinuxGlobalTunReader {
    async fn write_frame(&self, frame: &PacketEgressFrame) -> Result<(), LinuxPacketRuntimeError> {
        LinuxGlobalTunReader::write_frame(self, frame)
            .await
            .map_err(LinuxPacketRuntimeError::Tun)
    }
}

impl LinuxTunPacketRuntime {
    /// Build a bounded L3 bridge around an already verified helper-created
    /// TUN.  This constructor does not mutate routes or start a pump.
    pub fn new(
        reader: LinuxGlobalTunReader,
        identity: LinuxRuntimeIdentity,
        queue_bytes: usize,
    ) -> Result<(Self, LinuxPacketRuntimeChannels), LinuxPacketRuntimeError> {
        let generation = reader.device().config().generation;
        identity.validate_for(generation)?;
        let (native, stack) =
            bounded_packet_device_queues(queue_bytes, generation, CapturePlatform::Linux)
                .map_err(LinuxPacketRuntimeError::Packet)?;
        let packet_queue = stack.ingress.identity();
        Ok((
            Self {
                reader: Arc::new(reader),
                ingress: Arc::new(native.capture),
                egress: Arc::new(native.reinject),
                identity,
                cancellation: CancellationToken::new(),
                capture_task: None,
                reinject_task: None,
                pump_fault: Arc::new(std::sync::Mutex::new(None)),
                pump_started: AtomicBool::new(false),
                closed: AtomicBool::new(false),
            },
            LinuxPacketRuntimeChannels {
                ingress: stack.ingress,
                egress: stack.egress,
                identity: LinuxPacketChannelIdentity {
                    generation,
                    platform: CapturePlatform::Linux,
                    packet_queue,
                },
            },
        ))
    }

    fn ensure_open(&self) -> Result<(), LinuxPacketRuntimeError> {
        if self.closed.load(Ordering::Acquire) {
            Err(LinuxPacketRuntimeError::invalid(
                "LINUX_PACKET_RUNTIME_CLOSED",
                "packet runtime is closed",
            ))
        } else {
            Ok(())
        }
    }

    fn ensure_manual_io(&self) -> Result<(), LinuxPacketRuntimeError> {
        self.ensure_open()?;
        if self.pump_started.load(Ordering::Acquire) {
            return Err(LinuxPacketRuntimeError::invalid(
                "LINUX_PACKET_PUMP_ALREADY_STARTED",
                "manual packet I/O is unavailable after the owned pump starts",
            ));
        }
        Ok(())
    }

    /// Read and enqueue one validated L3 frame.  Queue pressure is surfaced
    /// to the caller; it is never converted into an unbounded wait.
    pub async fn capture_once(&self) -> Result<(), LinuxPacketRuntimeError> {
        self.ensure_manual_io()?;
        let frame = self
            .reader
            .read_frame()
            .await
            .map_err(LinuxPacketRuntimeError::Tun)?;
        self.ingress
            .try_send(frame)
            .map_err(|error: PacketTrySendError<PacketFrame>| {
                LinuxPacketRuntimeError::Packet(error.error)
            })
    }

    /// Reinject one packet supplied by the future stack.  `false` means that
    /// the stack-side egress channel has closed; no synthetic packet is made.
    pub async fn reinject_once(&self) -> Result<bool, LinuxPacketRuntimeError> {
        self.ensure_manual_io()?;
        let Some(lease) = self.egress.receive_packet().await else {
            return Ok(false);
        };
        let frame = lease.into_inner();
        self.reader
            .write_frame(&frame)
            .await
            .map_err(LinuxPacketRuntimeError::Tun)?;
        Ok(true)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    async fn run_capture_pump(
        reader: Arc<LinuxGlobalTunReader>,
        ingress: Arc<PacketIngressSender>,
        cancellation: CancellationToken,
        ready: tokio::sync::oneshot::Sender<()>,
    ) -> Result<(), LinuxPacketRuntimeError> {
        let _ = ready.send(());
        loop {
            let frame = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Ok(()),
                result = reader.read_frame() => result.map_err(LinuxPacketRuntimeError::Tun)?,
            };
            if let Err(error) = ingress.try_send(frame) {
                return Err(LinuxPacketRuntimeError::Packet(error.error));
            }
        }
    }

    async fn run_reinject_pump<W>(
        writer: Arc<W>,
        egress: Arc<PacketEgressReceiver>,
        cancellation: CancellationToken,
        ready: tokio::sync::oneshot::Sender<()>,
    ) -> Result<(), LinuxPacketRuntimeError>
    where
        W: LinuxReinjectWriter + ?Sized + 'static,
    {
        let _ = ready.send(());
        loop {
            let lease = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Ok(()),
                packet = egress.receive_packet() => packet,
            };
            let Some(lease) = lease else {
                return Err(LinuxPacketRuntimeError::invalid(
                    "LINUX_PACKET_EGRESS_CLOSED",
                    "controlled stack closed packet egress unexpectedly",
                ));
            };
            let frame = lease.into_inner();
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Ok(()),
                result = writer.write_frame(&frame) => result?,
            }
        }
    }

    async fn join_pump_task_until(
        task: &mut Option<JoinHandle<Result<(), LinuxPacketRuntimeError>>>,
        deadline: Instant,
    ) -> Result<(), LinuxPacketRuntimeError> {
        let Some(handle) = task.as_mut() else {
            return Ok(());
        };
        let joined = if handle.is_finished() {
            Ok((&mut *handle).await)
        } else {
            tokio::time::timeout_at(deadline, &mut *handle).await
        };
        match joined {
            Ok(Ok(Ok(()))) => {
                task.take();
                Ok(())
            }
            Ok(Ok(Err(error))) => {
                task.take();
                // A pump's data-plane error is the active fault that caused
                // shutdown, not evidence that shutdown failed. The wrapper
                // already retained its first root cause in `pump_fault`; once
                // the join completes, cleanup ownership is discharged.
                let _joined_fault = error;
                Ok(())
            }
            Ok(Err(error)) => {
                task.take();
                Err(if error.is_panic() {
                    LinuxPacketRuntimeError::PumpPanicked
                } else {
                    LinuxPacketRuntimeError::PumpAborted
                })
            }
            Err(_) => Err(LinuxPacketRuntimeError::PumpShutdownTimeout),
        }
    }

    fn record_pump_fault(
        fault: &std::sync::Mutex<Option<LinuxPacketPumpFault>>,
        error: &LinuxPacketRuntimeError,
    ) {
        let mut fault = fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if fault.is_none() {
            *fault = Some(LinuxPacketPumpFault {
                code: error.code(),
                message: error.to_string(),
            });
        }
    }

    fn pump_fault(&self) -> Option<LinuxPacketPumpFault> {
        self.pump_fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[async_trait]
impl LinuxPacketRuntime for LinuxTunPacketRuntime {
    fn identity(&self) -> LinuxRuntimeIdentity {
        self.identity
    }

    async fn start_pump_until(&mut self, deadline: Instant) -> Result<(), LinuxPacketRuntimeError> {
        self.ensure_open()?;
        if Instant::now() >= deadline {
            return Err(LinuxPacketRuntimeError::PumpStartTimeout);
        }
        tokio::runtime::Handle::try_current().map_err(|_| {
            LinuxPacketRuntimeError::invalid(
                "LINUX_PACKET_RUNTIME_UNAVAILABLE",
                "native packet pump requires an active Tokio runtime",
            )
        })?;
        if self.pump_started.swap(true, Ordering::AcqRel) {
            return Err(LinuxPacketRuntimeError::invalid(
                "LINUX_PACKET_PUMP_ALREADY_STARTED",
                "native packet pump can only be started once",
            ));
        }

        let (capture_ready_tx, capture_ready_rx) = tokio::sync::oneshot::channel();
        let (reinject_ready_tx, reinject_ready_rx) = tokio::sync::oneshot::channel();

        let capture_cancellation = self.cancellation.clone();
        let capture_failure = self.cancellation.clone();
        let capture_fault = Arc::clone(&self.pump_fault);
        let capture_reader = Arc::clone(&self.reader);
        let capture_ingress = Arc::clone(&self.ingress);
        self.capture_task = Some(tokio::spawn(async move {
            let result = Self::run_capture_pump(
                capture_reader,
                capture_ingress,
                capture_cancellation,
                capture_ready_tx,
            )
            .await;
            if result.is_err() {
                Self::record_pump_fault(
                    &capture_fault,
                    result.as_ref().expect_err("failed pump has an error"),
                );
                capture_failure.cancel();
            }
            result
        }));

        let reinject_cancellation = self.cancellation.clone();
        let reinject_failure = self.cancellation.clone();
        let reinject_fault = Arc::clone(&self.pump_fault);
        let reinject_reader = Arc::clone(&self.reader);
        let reinject_egress = Arc::clone(&self.egress);
        self.reinject_task = Some(tokio::spawn(async move {
            let result = Self::run_reinject_pump(
                reinject_reader,
                reinject_egress,
                reinject_cancellation,
                reinject_ready_tx,
            )
            .await;
            if result.is_err() {
                Self::record_pump_fault(
                    &reinject_fault,
                    result.as_ref().expect_err("failed pump has an error"),
                );
                reinject_failure.cancel();
            }
            result
        }));

        let ready = async {
            capture_ready_rx
                .await
                .map_err(|_| LinuxPacketRuntimeError::PumpExitedBeforeReady)?;
            reinject_ready_rx
                .await
                .map_err(|_| LinuxPacketRuntimeError::PumpExitedBeforeReady)?;
            Ok::<(), LinuxPacketRuntimeError>(())
        };
        match tokio::time::timeout_at(deadline, ready).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                self.cancellation.cancel();
                return Err(error);
            }
            Err(_) => {
                self.cancellation.cancel();
                return Err(LinuxPacketRuntimeError::PumpStartTimeout);
            }
        }
        // Give an immediately failing task one scheduling turn to publish its
        // terminal state, then enforce the same absolute startup deadline.
        tokio::task::yield_now().await;
        if Instant::now() >= deadline {
            self.cancellation.cancel();
            return Err(LinuxPacketRuntimeError::PumpStartTimeout);
        }
        if let Err(error) = self.ensure_pump_healthy() {
            self.cancellation.cancel();
            return Err(error);
        }
        Ok(())
    }

    fn ensure_pump_healthy(&self) -> Result<(), LinuxPacketRuntimeError> {
        self.ensure_open()?;
        if let Some(fault) = self.pump_fault() {
            return Err(LinuxPacketRuntimeError::PumpFailed {
                code: fault.code,
                message: fault.message,
            });
        }
        if !self.pump_started.load(Ordering::Acquire)
            || self.capture_task.is_none()
            || self.reinject_task.is_none()
        {
            return Err(LinuxPacketRuntimeError::PumpNotStarted);
        }
        if self.cancellation.is_cancelled()
            || self
                .capture_task
                .as_ref()
                .is_some_and(JoinHandle::is_finished)
            || self
                .reinject_task
                .as_ref()
                .is_some_and(JoinHandle::is_finished)
        {
            return Err(LinuxPacketRuntimeError::PumpExited);
        }
        Ok(())
    }

    async fn close_until(&mut self, deadline: Instant) -> Result<(), LinuxPacketRuntimeError> {
        if self.closed.load(Ordering::Acquire)
            && self.capture_task.is_none()
            && self.reinject_task.is_none()
        {
            return Ok(());
        }
        self.cancellation.cancel();

        let mut first_error = None;
        if let Err(error) = Self::join_pump_task_until(&mut self.capture_task, deadline).await {
            first_error = Some(error);
        }
        if let Err(error) = Self::join_pump_task_until(&mut self.reinject_task, deadline).await {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
        if self.capture_task.is_none() && self.reinject_task.is_none() {
            self.closed.store(true, Ordering::Release);
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl Drop for LinuxTunPacketRuntime {
    fn drop(&mut self) {
        // Normal lifecycle cleanup joins both tasks.  Abort is only an
        // emergency containment fallback for process teardown or a violated
        // owner contract; it is not accepted as release-gate cleanup proof.
        self.cancellation.cancel();
        if let Some(task) = self.capture_task.take() {
            task.abort();
        }
        if let Some(task) = self.reinject_task.take() {
            task.abort();
        }
    }
}

/// Factory for the concrete helper-created TUN bridge.  Opening `/dev/net/tun`
/// is the only host operation in this type; the helper must already have
/// prepared the exact interface and owner recorded in `CaptureHandle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxTunPacketRuntimeFactory {
    pub queue_bytes: usize,
    pub mtu: usize,
}

impl Default for LinuxTunPacketRuntimeFactory {
    fn default() -> Self {
        Self {
            queue_bytes: MIN_PACKET_QUEUE_BYTES,
            mtu: TUN_MTU as usize,
        }
    }
}

#[async_trait]
pub trait LinuxPacketRuntimeFactory: Send + Sync {
    async fn open(
        &self,
        spec: &CaptureInstallSpec,
        handle: &CaptureHandle,
    ) -> Result<LinuxPacketRuntimeBundle, LinuxPacketRuntimeError>;
}

#[async_trait]
impl LinuxPacketRuntimeFactory for LinuxTunPacketRuntimeFactory {
    async fn open(
        &self,
        spec: &CaptureInstallSpec,
        handle: &CaptureHandle,
    ) -> Result<LinuxPacketRuntimeBundle, LinuxPacketRuntimeError> {
        if spec.platform != CapturePlatform::Linux {
            return Err(LinuxPacketRuntimeError::invalid(
                "LINUX_RUNTIME_PLATFORM_INVALID",
                "Linux packet runtime requires a Linux specification",
            ));
        }
        if spec.mode != CaptureMode::Global {
            return Err(LinuxPacketRuntimeError::invalid(
                "LINUX_RUNTIME_SCOPE_UNAVAILABLE",
                "the scaffold has no trusted application/PID tuple side channel",
            ));
        }
        spec.validate().map_err(LinuxPacketRuntimeError::Capture)?;
        handle
            .validate_for(spec)
            .map_err(LinuxPacketRuntimeError::Capture)?;
        let owner_uid =
            validate_runtime_handle(spec, handle).map_err(LinuxPacketRuntimeError::Capture)?;
        let interface_name = match handle.artifact.interface_names.as_slice() {
            [name] => name.clone(),
            _ => {
                return Err(LinuxPacketRuntimeError::invalid(
                    "LINUX_RUNTIME_INTERFACE_INVALID",
                    "capture artifact must contain exactly one TUN interface",
                ));
            }
        };
        let config = LinuxTunConfig {
            interface_name,
            generation: spec.generation,
            owner_uid,
            mtu: self.mtu,
        };
        let device = LinuxTunDevice::open(config).map_err(LinuxPacketRuntimeError::Tun)?;
        let reader = LinuxGlobalTunReader::new(device);
        let identity = current_runtime_identity(spec.generation)?;
        let (runtime, channels) = LinuxTunPacketRuntime::new(reader, identity, self.queue_bytes)?;
        Ok(LinuxPacketRuntimeBundle::new(Box::new(runtime), channels))
    }
}

/// Validate the helper artifact again at the unprivileged TUN boundary.  The
/// helper client performs the same checks, but keeping this defense in depth
/// prevents an injected factory or a future alternate client from opening a
/// TUN for a foreign adapter, owner, or interface namespace.
fn validate_runtime_handle(
    spec: &CaptureInstallSpec,
    handle: &CaptureHandle,
) -> Result<u32, CaptureError> {
    if handle.artifact.adapter != LINUX_ADAPTER_ID {
        return Err(CaptureError::invalid(
            "LINUX_RUNTIME_ADAPTER_INVALID",
            "TUN runtime artifact is not owned by the fixed Linux adapter",
        ));
    }
    let owner_uid = handle.artifact.owner_uid.ok_or_else(|| {
        CaptureError::invalid(
            "LINUX_RUNTIME_OWNER_MISSING",
            "TUN runtime requires an explicit helper-authorized owner UID",
        )
    })?;
    let current_uid = current_linux_uid();
    if owner_uid == 0 || owner_uid == u32::MAX || current_uid == 0 || owner_uid != current_uid {
        return Err(CaptureError::invalid(
            "LINUX_RUNTIME_OWNER_INVALID",
            "TUN runtime owner UID must match the current unprivileged user",
        ));
    }
    let plan = super::linux::LinuxCapturePlan::from_artifact(&handle.artifact)?;
    if plan.generation != spec.generation
        || plan.tun_name
            != handle
                .artifact
                .interface_names
                .first()
                .cloned()
                .unwrap_or_default()
    {
        return Err(CaptureError::invalid(
            "LINUX_RUNTIME_INTERFACE_INVALID",
            "TUN runtime interface is outside the deterministic generation namespace",
        ));
    }
    Ok(owner_uid)
}

fn current_linux_uid() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

fn current_runtime_identity(
    generation: u64,
) -> Result<LinuxRuntimeIdentity, LinuxPacketRuntimeError> {
    let pid = std::process::id();
    let process_start_time =
        super::unix_transport::linux_process_start_token(pid).map_err(|_| {
            LinuxPacketRuntimeError::invalid(
                "LINUX_RUNTIME_START_TOKEN_UNAVAILABLE",
                "could not read the current runtime process start token",
            )
        })?;
    let identity = LinuxRuntimeIdentity {
        generation,
        pid,
        process_start_time,
    };
    identity.validate_for(generation)?;
    Ok(identity)
}

#[derive(Debug, thiserror::Error)]
pub enum LinuxPacketRuntimeError {
    #[error("{code}: {message}")]
    Invalid {
        code: &'static str,
        message: &'static str,
    },
    #[error("Linux TUN failed: {0}")]
    Tun(#[source] LinuxTunError),
    #[error("packet device failed: {0}")]
    Packet(#[source] PacketDeviceError),
    #[error("capture contract failed: {0}")]
    Capture(#[source] CaptureError),
    #[error("LINUX_PACKET_PUMP_NOT_STARTED: native packet pump is not armed")]
    PumpNotStarted,
    #[error("LINUX_PACKET_PUMP_EXITED_BEFORE_READY: native packet pump exited before readiness")]
    PumpExitedBeforeReady,
    #[error("LINUX_PACKET_PUMP_START_TIMEOUT: native packet pump readiness timed out")]
    PumpStartTimeout,
    #[error("LINUX_PACKET_PUMP_EXITED: native packet pump is no longer healthy")]
    PumpExited,
    #[error("{code}: native packet pump failed: {message}")]
    PumpFailed { code: String, message: String },
    #[error("LINUX_PACKET_PUMP_PANICKED: native packet pump panicked")]
    PumpPanicked,
    #[error("LINUX_PACKET_PUMP_ABORTED: native packet pump was aborted")]
    PumpAborted,
    #[error("LINUX_PACKET_PUMP_SHUTDOWN_TIMEOUT: native packet pump did not stop before deadline")]
    PumpShutdownTimeout,
}

impl LinuxPacketRuntimeError {
    fn invalid(code: &'static str, message: &'static str) -> Self {
        Self::Invalid { code, message }
    }

    pub fn code(&self) -> String {
        match self {
            Self::Invalid { code, .. } => (*code).into(),
            Self::Tun(error) => error.code().into(),
            Self::Packet(error) => error.code().into(),
            Self::Capture(error) => error.code.clone(),
            Self::PumpNotStarted => "LINUX_PACKET_PUMP_NOT_STARTED".into(),
            Self::PumpExitedBeforeReady => "LINUX_PACKET_PUMP_EXITED_BEFORE_READY".into(),
            Self::PumpStartTimeout => "LINUX_PACKET_PUMP_START_TIMEOUT".into(),
            Self::PumpExited => "LINUX_PACKET_PUMP_EXITED".into(),
            Self::PumpFailed { code, .. } => code.clone(),
            Self::PumpPanicked => "LINUX_PACKET_PUMP_PANICKED".into(),
            Self::PumpAborted => "LINUX_PACKET_PUMP_ABORTED".into(),
            Self::PumpShutdownTimeout => "LINUX_PACKET_PUMP_SHUTDOWN_TIMEOUT".into(),
        }
    }

    fn into_capture_error(self, artifact: Option<CaptureArtifactState>) -> CaptureError {
        match self {
            Self::Capture(error) => error,
            other => CaptureError {
                code: other.code().into(),
                message: other.to_string(),
                recovery_required: false,
                artifact,
            },
        }
    }
}

/// Identity receipt returned only after the native packet pump, controlled IP
/// stack, and decoded-flow runtime have all armed their health supervision.
/// A provider pin is validated by the platform-neutral stack supervisor; this
/// receipt binds that ready plane back to the Linux capture transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxDataPlaneIdentity {
    pub generation: u64,
    pub config_revision: u64,
    pub platform: CapturePlatform,
    pub runtime_pid: u32,
    pub runtime_process_start_time: u64,
    /// Packet-device receipt returned by the controlled plane after it has
    /// taken ownership of the exact queue pair supplied by this lifecycle.
    pub packet_queue: PacketQueueIdentity,
}

impl LinuxDataPlaneIdentity {
    pub fn source_id(self) -> u64 {
        self.packet_queue.source_id()
    }

    fn validate_for(
        &self,
        spec: &CaptureInstallSpec,
        runtime: LinuxRuntimeIdentity,
        channels: LinuxPacketChannelIdentity,
    ) -> Result<(), LinuxDataPlaneError> {
        if self.generation == 0
            || self.generation != spec.generation
            || self.config_revision == 0
            || self.config_revision != spec.config_revision
            || self.platform != CapturePlatform::Linux
            || self.runtime_pid == 0
            || self.runtime_pid != runtime.pid
            || self.runtime_process_start_time == 0
            || self.runtime_process_start_time != runtime.process_start_time
            || self.packet_queue != channels.packet_queue
            || self.packet_queue.generation != self.generation
            || self.packet_queue.platform != self.platform
            || self.source_id() == 0
        {
            return Err(LinuxDataPlaneError::invalid(
                "LINUX_DATA_PLANE_IDENTITY_INVALID",
                "ready data plane does not match the Linux capture transaction",
            ));
        }
        Ok(())
    }
}

/// Owned decoded data plane retained for the entire capture generation.
/// Implementations own and join the controlled packet stack and shared
/// FlowRuntime; the adjacent `LinuxPacketRuntime` independently owns the TUN
/// pumps. `stop_until` must not detach unfinished tasks at its deadline.
#[async_trait]
pub trait LinuxDataPlaneRuntime: Send + fmt::Debug {
    fn identity(&self) -> LinuxDataPlaneIdentity;

    /// Synchronous health fence used immediately before and after helper
    /// activation to close the ready-to-activate race.
    fn ensure_healthy(&self) -> Result<(), LinuxDataPlaneError>;

    async fn stop_until(&mut self, deadline: Instant) -> Result<(), LinuxDataPlaneError>;
}

/// Factory for the full Linux packet plane. Returning `Ok` is a readiness
/// barrier, not merely successful task spawning. The lifecycle has already
/// armed the native pump before transferring these queue ends. The factory
/// starts FlowRuntime before reporting ready and owns cleanup if this future
/// is cancelled before it returns a runtime handle.
#[async_trait]
pub trait LinuxDataPlaneFactory: Send + Sync {
    async fn start_until(
        &self,
        spec: &CaptureInstallSpec,
        runtime: LinuxRuntimeIdentity,
        channels: LinuxPacketRuntimeChannels,
        deadline: Instant,
    ) -> Result<Box<dyn LinuxDataPlaneRuntime>, LinuxDataPlaneError>;
}

#[derive(Debug, thiserror::Error)]
pub enum LinuxDataPlaneError {
    #[error("{code}: {message}")]
    Invalid {
        code: &'static str,
        message: &'static str,
    },
    #[error("{code}: combined Linux data plane failed")]
    Runtime { code: &'static str },
}

impl LinuxDataPlaneError {
    pub fn invalid(code: &'static str, message: &'static str) -> Self {
        Self::Invalid { code, message }
    }

    pub fn runtime(code: &'static str) -> Self {
        Self::Runtime { code }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid { code, .. } | Self::Runtime { code } => code,
        }
    }

    fn into_capture_error(self, artifact: Option<CaptureArtifactState>) -> CaptureError {
        CaptureError {
            code: self.code().into(),
            message: self.to_string(),
            recovery_required: false,
            artifact,
        }
    }
}

/// Typed helper operations used by [`LinuxCaptureLifecycle`].  The production
/// implementation is a thin conversion layer over `LinuxHelperClient`; tests
/// inject a fake and can assert the exact operation order without root access.
#[async_trait]
pub trait LinuxHelperControl: Send + Sync {
    async fn probe(&self) -> Result<AdapterProbe, CaptureError>;
    async fn prepare(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError>;
    async fn activate(
        &self,
        spec: &CaptureInstallSpec,
        runtime_pid: u32,
        runtime_start_token: u64,
    ) -> Result<CaptureHandle, CaptureError>;
    async fn update(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError>;
    async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError>;
    async fn stop(&self, handle: &CaptureHandle) -> Result<(), CaptureError>;
    async fn recover(&self, artifact: &CaptureArtifactState) -> Result<(), CaptureError>;
    async fn recover_generation(&self, generation: u64) -> Result<(), CaptureError>;
    async fn shutdown(&self) -> Result<(), CaptureError>;
}

#[async_trait]
impl LinuxHelperControl for LinuxHelperClient {
    async fn probe(&self) -> Result<AdapterProbe, CaptureError> {
        LinuxHelperClient::probe(self)
            .await
            .map_err(|error| error.into_capture_error())
    }

    async fn prepare(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
        LinuxHelperClient::prepare(self, spec)
            .await
            .map_err(|error| error.into_capture_error())
    }

    async fn activate(
        &self,
        spec: &CaptureInstallSpec,
        runtime_pid: u32,
        runtime_start_token: u64,
    ) -> Result<CaptureHandle, CaptureError> {
        LinuxHelperClient::activate(self, spec, runtime_pid, runtime_start_token)
            .await
            .map_err(|error| error.into_capture_error())
    }

    async fn update(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        LinuxHelperClient::update(self, handle, spec)
            .await
            .map_err(|error| error.into_capture_error())
    }

    async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
        LinuxHelperClient::heartbeat(self, handle)
            .await
            .map_err(|error| error.into_capture_error())
    }

    async fn stop(&self, handle: &CaptureHandle) -> Result<(), CaptureError> {
        LinuxHelperClient::stop(self, handle)
            .await
            .map_err(|error| error.into_capture_error())
    }

    async fn recover(&self, artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
        LinuxHelperClient::recover(self, artifact)
            .await
            .map_err(|error| error.into_capture_error())
    }

    async fn recover_generation(&self, generation: u64) -> Result<(), CaptureError> {
        if generation != self.generation() {
            return Err(CaptureError::recovery(
                "LINUX_HELPER_GENERATION_MISMATCH",
                "generation-only recovery does not match the helper client",
            ));
        }
        LinuxHelperClient::recover_generation(self)
            .await
            .map_err(|error| error.into_capture_error())
    }

    async fn shutdown(&self) -> Result<(), CaptureError> {
        LinuxHelperClient::shutdown(self)
            .await
            .map_err(|error| error.into_capture_error())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxCaptureState {
    Idle,
    Preparing {
        generation: u64,
    },
    RuntimeReady {
        generation: u64,
        config_revision: u64,
    },
    DataPlaneStarting {
        generation: u64,
        config_revision: u64,
    },
    DataPlaneReady {
        generation: u64,
        config_revision: u64,
    },
    Activating {
        generation: u64,
        config_revision: u64,
    },
    Active {
        generation: u64,
        config_revision: u64,
    },
    Stopping {
        generation: u64,
    },
    RecoveryRequired {
        generation: u64,
    },
}

struct LinuxCaptureRecord {
    state: LinuxCaptureState,
    handle: Option<CaptureHandle>,
    runtime: Option<LinuxPacketRuntimeBundle>,
    data_plane: Option<Box<dyn LinuxDataPlaneRuntime>>,
    /// Exact native packet-device identity accepted at the one-shot channel
    /// handoff. Active health checks keep binding the provider to this source;
    /// generation/platform alone are not sufficient to detect cross-wiring.
    packet_queue: Option<PacketQueueIdentity>,
    fault_monitor: Option<LinuxFaultMonitorOwner>,
    /// Root cause of the most recent Active-generation fail-closed cleanup.
    /// This is deliberately separate from cleanup/recovery diagnostics so a
    /// helper timeout cannot overwrite the packet-plane error that triggered
    /// revocation.
    last_active_fault: Option<CaptureError>,
    /// Last authenticated artifact known to require cleanup. This also
    /// covers helper failures that return an artifact without a usable handle.
    recovery_artifact: Option<CaptureArtifactState>,
}

struct LinuxFaultMonitorOwner {
    generation: u64,
    cancellation: CancellationToken,
    task: JoinHandle<()>,
}

enum LinuxActiveHealth {
    Healthy,
    Inactive,
    Fault(CaptureError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxFaultCleanupCaller {
    Monitor,
    Foreground,
}

#[doc(hidden)]
pub struct LinuxCaptureLifecycleInner {
    helper: Arc<dyn LinuxHelperControl>,
    runtime_factory: Arc<dyn LinuxPacketRuntimeFactory>,
    data_plane_factory: Arc<dyn LinuxDataPlaneFactory>,
    /// Serializes complete mutating operations, including fault-triggered
    /// revocation. Exactly one owner can call helper cleanup for a generation.
    operation: Mutex<()>,
    record: Mutex<LinuxCaptureRecord>,
}

/// Injectable Linux lifecycle scaffold.  It is deliberately separate from
/// `CaptureAdapter`: until the complete stack and packet pump exist, exposing
/// this as a product adapter would make it possible to install host capture
/// state that has nowhere safe to deliver packets.
#[derive(Clone)]
pub struct LinuxCaptureLifecycle {
    inner: Arc<LinuxCaptureLifecycleInner>,
}

impl Deref for LinuxCaptureLifecycle {
    type Target = LinuxCaptureLifecycleInner;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

/// Explicit name used by design documents while this remains a scaffold and
/// not a `CaptureAdapter` implementation.
pub type LinuxCaptureAdapterScaffold = LinuxCaptureLifecycle;

impl fmt::Debug for LinuxCaptureLifecycle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinuxCaptureLifecycle")
            .field("state", &"redacted until async snapshot")
            .finish_non_exhaustive()
    }
}

impl LinuxCaptureLifecycle {
    pub fn new(
        helper: Arc<dyn LinuxHelperControl>,
        runtime_factory: Arc<dyn LinuxPacketRuntimeFactory>,
        data_plane_factory: Arc<dyn LinuxDataPlaneFactory>,
    ) -> Self {
        Self {
            inner: Arc::new(LinuxCaptureLifecycleInner {
                helper,
                runtime_factory,
                data_plane_factory,
                operation: Mutex::new(()),
                record: Mutex::new(LinuxCaptureRecord {
                    state: LinuxCaptureState::Idle,
                    handle: None,
                    runtime: None,
                    data_plane: None,
                    packet_queue: None,
                    fault_monitor: None,
                    last_active_fault: None,
                    recovery_artifact: None,
                }),
            }),
        }
    }

    pub async fn state(&self) -> LinuxCaptureState {
        self.record.lock().await.state
    }

    /// Return the artifact retained for a failed cleanup transaction. The
    /// caller must still use the typed recovery operation; this accessor does
    /// not authorize arbitrary host mutations.
    pub async fn recovery_artifact(&self) -> Option<CaptureArtifactState> {
        self.record.lock().await.recovery_artifact.clone()
    }

    /// Preserve the data-plane root cause even when automatic fail-closed
    /// cleanup succeeds and the lifecycle has already returned to `Idle`.
    pub async fn last_active_fault(&self) -> Option<CaptureError> {
        self.record.lock().await.last_active_fault.clone()
    }

    pub async fn probe(&self) -> Result<AdapterProbe, CaptureError> {
        let report = self.helper.probe().await?;
        if report.adapter != LINUX_ADAPTER_ID || report.platform != CapturePlatform::Linux {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_PROBE_IDENTITY_INVALID",
                "helper probe returned an unexpected Linux adapter identity",
            ));
        }
        Ok(report)
    }

    /// Stage one global capture generation.  The method is intentionally not
    /// wired into the product coordinator; it exists for the future adapter
    /// integration and for fake-helper call-order tests.
    pub async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
        validate_global_spec(spec)?;
        let _operation = self.operation.lock().await;
        self.begin_preparing(spec.generation).await?;

        let result = self.install_inner(spec).await;
        if result.is_err() {
            let mut record = self.record.lock().await;
            if !matches!(record.state, LinuxCaptureState::RecoveryRequired { .. }) {
                record.state = LinuxCaptureState::Idle;
                record.handle = None;
                record.runtime = None;
                record.data_plane = None;
                record.packet_queue = None;
                if let Some(owner) = record.fault_monitor.take() {
                    owner.cancellation.cancel();
                }
                record.last_active_fault = None;
                record.recovery_artifact = None;
            }
        }
        result
    }

    async fn install_inner(
        &self,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        let report = match self.probe().await {
            Ok(report) => report,
            Err(error) => {
                if error.recovery_required {
                    self.mark_recovery(spec.generation, None, error.artifact.clone())
                        .await;
                }
                return Err(error);
            }
        };
        if !report.installed
            || !report.privileged_helper_ready
            || !report.signature_verified
            || !report.global_available
        {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_CAPABILITY_LOCKED",
                format!(
                    "Linux global capture is not release-ready: {}",
                    report.detail
                ),
            ));
        }

        let prepared = match self.helper.prepare(spec).await {
            Ok(handle) => handle,
            Err(error) => {
                if error.recovery_required {
                    self.mark_recovery(spec.generation, None, error.artifact.clone())
                        .await;
                }
                return Err(error);
            }
        };
        {
            let mut record = self.record.lock().await;
            record.handle = Some(prepared.clone());
            record.recovery_artifact = None;
        }
        if let Err(error) = prepared.validate_for(spec) {
            return Err(self
                .rollback_prepared(spec.generation, prepared, error)
                .await);
        }

        let runtime = match self.runtime_factory.open(spec, &prepared).await {
            Ok(runtime) => runtime,
            Err(error) => {
                return Err(self
                    .rollback_prepared(spec.generation, prepared, error.into_capture_error(None))
                    .await);
            }
        };
        let identity = runtime.identity();
        {
            let mut record = self.record.lock().await;
            record.state = LinuxCaptureState::RuntimeReady {
                generation: spec.generation,
                config_revision: spec.config_revision,
            };
            record.runtime = Some(runtime);
        }
        if let Err(error) = identity.validate_for(spec.generation) {
            return Err(self
                .rollback_prepared(spec.generation, prepared, error.into_capture_error(None))
                .await);
        }
        let data_plane_start_deadline = Instant::now() + LINUX_DATA_PLANE_START_GRACE;
        let pump_start = {
            // Retain the runtime in the transaction record while readiness is
            // awaited. Cancelling install releases only this lock; recovery
            // still owns both join handles and can close them deterministically.
            let mut record = self.record.lock().await;
            record
                .runtime
                .as_mut()
                .expect("runtime inserted before pump startup")
                .runtime
                .start_pump_until(data_plane_start_deadline)
                .await
        };
        if let Err(error) = pump_start {
            return Err(self
                .rollback_prepared(spec.generation, prepared, error.into_capture_error(None))
                .await);
        }
        let channels = {
            let mut record = self.record.lock().await;
            record
                .runtime
                .as_mut()
                .and_then(LinuxPacketRuntimeBundle::take_channels)
        };
        let Some(channels) = channels else {
            return Err(self
                .rollback_prepared(
                    spec.generation,
                    prepared,
                    CaptureError::invalid(
                        "LINUX_PACKET_CHANNELS_ALREADY_TAKEN",
                        "packet channels were unavailable before data-plane startup",
                    ),
                )
                .await);
        };
        if let Err(error) = channels.validate_for(spec) {
            return Err(self
                .rollback_prepared(spec.generation, prepared, error.into_capture_error(None))
                .await);
        }
        let channel_identity = channels.identity();
        {
            let mut record = self.record.lock().await;
            record.state = LinuxCaptureState::DataPlaneStarting {
                generation: spec.generation,
                config_revision: spec.config_revision,
            };
            record.packet_queue = Some(channel_identity.packet_queue);
        }

        let runtime_identity = {
            let record = self.record.lock().await;
            record
                .runtime
                .as_ref()
                .expect("runtime inserted before activation")
                .identity()
        };
        let data_plane = match self
            .data_plane_factory
            .start_until(spec, runtime_identity, channels, data_plane_start_deadline)
            .await
        {
            Ok(data_plane) => data_plane,
            Err(error) => {
                return Err(self
                    .rollback_prepared(spec.generation, prepared, error.into_capture_error(None))
                    .await);
            }
        };
        {
            let mut record = self.record.lock().await;
            record.state = LinuxCaptureState::DataPlaneReady {
                generation: spec.generation,
                config_revision: spec.config_revision,
            };
            record.data_plane = Some(data_plane);
        }
        if Instant::now() >= data_plane_start_deadline {
            return Err(self
                .rollback_prepared(
                    spec.generation,
                    prepared,
                    LinuxDataPlaneError::invalid(
                        "LINUX_DATA_PLANE_START_TIMEOUT",
                        "combined data plane became ready after its absolute startup deadline",
                    )
                    .into_capture_error(None),
                )
                .await);
        }
        if let Err(error) = self
            .validate_combined_data_plane(spec, runtime_identity, channel_identity)
            .await
        {
            return Err(self
                .rollback_prepared(spec.generation, prepared, error)
                .await);
        }
        {
            let mut record = self.record.lock().await;
            record.state = LinuxCaptureState::Activating {
                generation: spec.generation,
                config_revision: spec.config_revision,
            };
        }
        let activated = match self
            .helper
            .activate(
                spec,
                runtime_identity.pid,
                runtime_identity.process_start_time,
            )
            .await
        {
            Ok(handle) => handle,
            Err(error) => {
                return Err(self
                    .rollback_prepared(spec.generation, prepared, error)
                    .await);
            }
        };
        if let Err(error) = activated.validate_for(spec) {
            return Err(self
                .rollback_prepared(spec.generation, prepared, error)
                .await);
        }
        if let Err(error) = self
            .validate_combined_data_plane(spec, runtime_identity, channel_identity)
            .await
        {
            return Err(self
                .rollback_prepared(spec.generation, activated, error)
                .await);
        }
        {
            let mut record = self.record.lock().await;
            record.handle = Some(activated.clone());
            record.recovery_artifact = None;
            record.last_active_fault = None;
            record.state = LinuxCaptureState::Active {
                generation: spec.generation,
                config_revision: spec.config_revision,
            };
        }
        self.arm_fault_monitor(&activated).await;
        Ok(activated)
    }

    pub async fn update(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        validate_global_spec(spec)?;
        let _operation = self.operation.lock().await;
        self.ensure_active(handle).await?;
        self.ensure_data_plane_healthy(handle).await?;
        if handle.generation != spec.generation || handle.config_revision != spec.config_revision {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_UPDATE_GENERATION_MISMATCH",
                "capture update must keep the active generation and revision",
            ));
        }
        match self.helper.update(handle, spec).await {
            Ok(updated) => {
                if let Err(error) = updated.validate_for(spec) {
                    self.mark_recovery(
                        handle.generation,
                        Some(handle.clone()),
                        Some(handle.artifact.clone()),
                    )
                    .await;
                    return Err(force_recovery_error(
                        error,
                        handle.artifact.clone(),
                        "LINUX_CAPTURE_UPDATE_RESPONSE_INVALID",
                    ));
                }
                self.record.lock().await.handle = Some(updated.clone());
                Ok(updated)
            }
            Err(error) => {
                if error.recovery_required {
                    self.mark_recovery(
                        handle.generation,
                        Some(handle.clone()),
                        error.artifact.clone(),
                    )
                    .await;
                }
                Err(error)
            }
        }
    }

    pub async fn heartbeat(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        validate_global_spec(spec)?;
        let _operation = self.operation.lock().await;
        self.ensure_active(handle).await?;
        self.ensure_data_plane_healthy(handle).await?;
        let refreshed = match self.helper.heartbeat(handle).await {
            Ok(handle) => handle,
            Err(error) => {
                if error.recovery_required {
                    return Err(self
                        .fail_closed_active_fault(
                            handle,
                            error,
                            LinuxFaultCleanupCaller::Foreground,
                        )
                        .await);
                }
                return Err(error);
            }
        };
        if let Err(error) = refreshed.validate_for(spec) {
            self.mark_recovery(
                handle.generation,
                Some(handle.clone()),
                Some(handle.artifact.clone()),
            )
            .await;
            return Err(force_recovery_error(
                error,
                handle.artifact.clone(),
                "LINUX_CAPTURE_HEARTBEAT_RESPONSE_INVALID",
            ));
        }
        self.record.lock().await.handle = Some(refreshed.clone());
        Ok(refreshed)
    }

    pub async fn stop(&self, handle: &CaptureHandle) -> Result<(), CaptureError> {
        let _operation = self.operation.lock().await;
        let (current, fault_monitor) = {
            let mut record = self.record.lock().await;
            if !matches!(record.state, LinuxCaptureState::Active { .. })
                || record.handle.as_ref() != Some(handle)
            {
                if record
                    .last_active_fault
                    .as_ref()
                    .and_then(|fault| fault.artifact.as_ref())
                    == Some(&handle.artifact)
                {
                    let fault = record
                        .last_active_fault
                        .clone()
                        .expect("matching active fault exists");
                    return if matches!(record.state, LinuxCaptureState::Idle) {
                        Err(fault)
                    } else {
                        Err(CaptureError::recovery_with_artifact(
                            "LINUX_CAPTURE_FAULT_RECOVERY_REQUIRED",
                            format!(
                                "{}; automatic fail-closed cleanup remains incomplete",
                                fault
                            ),
                            handle.artifact.clone(),
                        ))
                    };
                }
                return Err(CaptureError::invalid(
                    "LINUX_CAPTURE_STATE_INVALID",
                    "stop requires the active handle owned by this lifecycle",
                ));
            }
            record.state = LinuxCaptureState::Stopping {
                generation: handle.generation,
            };
            (record.handle.clone(), record.fault_monitor.take())
        };
        let mut failures = Vec::new();
        let current_handle = current.expect("active handle present");
        let cleanup_deadline = Instant::now() + LINUX_DATA_PLANE_SHUTDOWN_GRACE;
        self.stop_fault_monitor_until(fault_monitor, cleanup_deadline, &mut failures)
            .await;
        // Remove privileged capture state before closing the local packet
        // runtime. This ordering prevents a still-open TUN from receiving
        // traffic after nft/rule cleanup has started.
        if let Err(error) = self
            .stop_helper_until(&current_handle, cleanup_deadline)
            .await
        {
            failures.push(error.to_string());
        }
        self.cleanup_local_resources_until(cleanup_deadline, &mut failures)
            .await;
        if !failures.is_empty() {
            self.set_recovery(
                handle.generation,
                Some(current_handle),
                Some(handle.artifact.clone()),
            )
            .await;
            return Err(CaptureError::recovery_with_artifact(
                "LINUX_CAPTURE_STOP_FAILED",
                failures.join("; "),
                handle.artifact.clone(),
            ));
        }
        let mut record = self.record.lock().await;
        record.state = LinuxCaptureState::Idle;
        record.handle = None;
        record.runtime = None;
        record.data_plane = None;
        record.packet_queue = None;
        record.fault_monitor = None;
        record.last_active_fault = None;
        record.recovery_artifact = None;
        Ok(())
    }

    pub async fn recover(&self, artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
        artifact.validate()?;
        let _operation = self.operation.lock().await;
        let generation = artifact.generation;
        let handle = self.begin_recovery(generation).await?;
        let mut failures = Vec::new();
        if let Err(error) = self.helper.recover(artifact).await {
            failures.push(error.to_string());
        }
        let cleanup_deadline = Instant::now() + LINUX_DATA_PLANE_SHUTDOWN_GRACE;
        self.cleanup_local_resources_until(cleanup_deadline, &mut failures)
            .await;
        if !failures.is_empty() {
            self.set_recovery(generation, handle, Some(artifact.clone()))
                .await;
            return Err(CaptureError::recovery_with_artifact(
                "LINUX_CAPTURE_RECOVERY_FAILED",
                failures.join("; "),
                artifact.clone(),
            ));
        }
        self.set_idle().await;
        Ok(())
    }

    pub async fn recover_generation(&self, generation: u64) -> Result<(), CaptureError> {
        if generation == 0 {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_GENERATION_INVALID",
                "recovery generation must be non-zero",
            ));
        }
        let _operation = self.operation.lock().await;
        let handle = self.begin_recovery(generation).await?;
        let mut failures = Vec::new();
        if let Err(error) = self.helper.recover_generation(generation).await {
            failures.push(error.to_string());
        }
        let cleanup_deadline = Instant::now() + LINUX_DATA_PLANE_SHUTDOWN_GRACE;
        self.cleanup_local_resources_until(cleanup_deadline, &mut failures)
            .await;
        if !failures.is_empty() {
            self.set_recovery(generation, handle, None).await;
            let message = failures.join("; ");
            return match self.recovery_artifact().await {
                Some(artifact) => Err(CaptureError::recovery_with_artifact(
                    "LINUX_CAPTURE_RECOVERY_FAILED",
                    message,
                    artifact,
                )),
                None => Err(CaptureError::recovery(
                    "LINUX_CAPTURE_RECOVERY_FAILED",
                    message,
                )),
            };
        }
        self.set_idle().await;
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), CaptureError> {
        let _operation = self.operation.lock().await;
        let (generation, handle, prior_artifact) = {
            let mut record = self.record.lock().await;
            let generation = match record.state {
                LinuxCaptureState::Idle => None,
                LinuxCaptureState::Preparing { generation }
                | LinuxCaptureState::RuntimeReady { generation, .. }
                | LinuxCaptureState::DataPlaneStarting { generation, .. }
                | LinuxCaptureState::DataPlaneReady { generation, .. }
                | LinuxCaptureState::Activating { generation, .. }
                | LinuxCaptureState::Active { generation, .. }
                | LinuxCaptureState::Stopping { generation }
                | LinuxCaptureState::RecoveryRequired { generation } => Some(generation),
            };
            record.state = generation.map_or(LinuxCaptureState::Idle, |generation| {
                LinuxCaptureState::Stopping { generation }
            });
            (
                generation,
                record.handle.clone(),
                record.recovery_artifact.clone(),
            )
        };
        let mut failures = Vec::new();
        if let Err(error) = self.helper.shutdown().await {
            failures.push(error.to_string());
        }
        let cleanup_deadline = Instant::now() + LINUX_DATA_PLANE_SHUTDOWN_GRACE;
        self.cleanup_local_resources_until(cleanup_deadline, &mut failures)
            .await;
        if !failures.is_empty() {
            if let Some(generation) = generation {
                self.set_recovery(generation, handle, prior_artifact).await;
            } else {
                // No active generation means there is no safe generation-only
                // cleanup target. Do not fabricate generation 1; leave the
                // lifecycle idle and surface the helper failure to the
                // coordinator for an out-of-band health/recovery decision.
                self.set_idle().await;
            }
            return Err(CaptureError::recovery(
                "LINUX_CAPTURE_SHUTDOWN_FAILED",
                failures.join("; "),
            ));
        }
        self.set_idle().await;
        Ok(())
    }

    async fn begin_preparing(&self, generation: u64) -> Result<(), CaptureError> {
        let mut record = self.record.lock().await;
        if !matches!(record.state, LinuxCaptureState::Idle) {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_BUSY",
                "capture lifecycle already owns a generation",
            ));
        }
        if let Some(owner) = record.fault_monitor.take() {
            owner.cancellation.cancel();
        }
        record.last_active_fault = None;
        record.state = LinuxCaptureState::Preparing { generation };
        Ok(())
    }

    async fn ensure_active(&self, handle: &CaptureHandle) -> Result<(), CaptureError> {
        let record = self.record.lock().await;
        if !matches!(record.state, LinuxCaptureState::Active { .. })
            || record.handle.as_ref() != Some(handle)
        {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_STATE_INVALID",
                "operation requires the active lifecycle handle",
            ));
        }
        Ok(())
    }

    async fn validate_combined_data_plane(
        &self,
        spec: &CaptureInstallSpec,
        expected_runtime: LinuxRuntimeIdentity,
        expected_channels: LinuxPacketChannelIdentity,
    ) -> Result<(), CaptureError> {
        let record = self.record.lock().await;
        let runtime = record.runtime.as_ref().ok_or_else(|| {
            CaptureError::invalid(
                "LINUX_PACKET_RUNTIME_MISSING",
                "capture transaction lost the native packet runtime",
            )
        })?;
        if runtime.identity() != expected_runtime {
            return Err(CaptureError::invalid(
                "LINUX_RUNTIME_IDENTITY_CHANGED",
                "native packet runtime identity changed during startup",
            ));
        }
        runtime
            .runtime
            .ensure_pump_healthy()
            .map_err(|error| error.into_capture_error(None))?;
        let data_plane = record.data_plane.as_ref().ok_or_else(|| {
            CaptureError::invalid(
                "LINUX_DATA_PLANE_MISSING",
                "capture transaction lost the controlled data plane",
            )
        })?;
        data_plane
            .identity()
            .validate_for(spec, expected_runtime, expected_channels)
            .and_then(|_| data_plane.ensure_healthy())
            .map_err(|error| error.into_capture_error(None))
    }

    async fn arm_fault_monitor(&self, handle: &CaptureHandle) {
        let generation = handle.generation;
        let monitored_handle = handle.clone();
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let weak = Arc::downgrade(&self.inner);
        let task = tokio::spawn(async move {
            Self::run_fault_monitor(weak, monitored_handle, task_cancellation).await;
        });

        let mut record = self.record.lock().await;
        debug_assert!(matches!(
            record.state,
            LinuxCaptureState::Active {
                generation: active_generation,
                ..
            } if active_generation == generation
        ));
        debug_assert!(record.fault_monitor.is_none());
        record.fault_monitor = Some(LinuxFaultMonitorOwner {
            generation,
            cancellation,
            task,
        });
    }

    async fn run_fault_monitor(
        weak: std::sync::Weak<LinuxCaptureLifecycleInner>,
        handle: CaptureHandle,
        cancellation: CancellationToken,
    ) {
        loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                _ = tokio::time::sleep(LINUX_DATA_PLANE_HEALTH_INTERVAL) => {}
            }

            let Some(inner) = weak.upgrade() else {
                return;
            };
            let lifecycle = Self { inner };
            match lifecycle.inspect_active_health(&handle).await {
                LinuxActiveHealth::Healthy => continue,
                LinuxActiveHealth::Inactive => return,
                LinuxActiveHealth::Fault(_) => {}
            }

            // Compete with foreground stop/update through the same operation
            // lock. Cancellation is selected while waiting so foreground stop
            // can join this owner without deadlocking on the lock it holds.
            let _operation = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                operation = lifecycle.operation.lock() => operation,
            };
            match lifecycle.inspect_active_health(&handle).await {
                LinuxActiveHealth::Healthy => continue,
                LinuxActiveHealth::Inactive => return,
                LinuxActiveHealth::Fault(error) => {
                    let _ = lifecycle
                        .fail_closed_active_fault(&handle, error, LinuxFaultCleanupCaller::Monitor)
                        .await;
                    return;
                }
            }
        }
    }

    async fn inspect_active_health(&self, handle: &CaptureHandle) -> LinuxActiveHealth {
        let record = self.record.lock().await;
        if !matches!(
            record.state,
            LinuxCaptureState::Active { generation, .. } if generation == handle.generation
        ) || record.handle.as_ref() != Some(handle)
        {
            return LinuxActiveHealth::Inactive;
        }
        let health = (|| {
            let runtime = record.runtime.as_ref().ok_or_else(|| {
                CaptureError::invalid(
                    "LINUX_PACKET_RUNTIME_MISSING",
                    "active capture no longer owns its native packet runtime",
                )
            })?;
            runtime
                .runtime
                .ensure_pump_healthy()
                .map_err(|error| error.into_capture_error(None))?;
            let runtime_identity = runtime.identity();
            let data_plane = record.data_plane.as_ref().ok_or_else(|| {
                CaptureError::invalid(
                    "LINUX_DATA_PLANE_MISSING",
                    "active capture no longer owns its controlled data plane",
                )
            })?;
            let plane_identity = data_plane.identity();
            let expected_packet_queue = record.packet_queue.ok_or_else(|| {
                CaptureError::invalid(
                    "LINUX_PACKET_SOURCE_IDENTITY_MISSING",
                    "active capture lost its native packet-device identity",
                )
            })?;
            if plane_identity.packet_queue != expected_packet_queue
                || plane_identity.source_id() == 0
                || plane_identity.generation != handle.generation
                || plane_identity.config_revision != handle.config_revision
                || plane_identity.platform != CapturePlatform::Linux
                || plane_identity.runtime_pid != runtime_identity.pid
                || plane_identity.runtime_process_start_time != runtime_identity.process_start_time
            {
                return Err(CaptureError::invalid(
                    "LINUX_DATA_PLANE_IDENTITY_INVALID",
                    "active data-plane identity no longer matches the capture handle",
                ));
            }
            data_plane
                .ensure_healthy()
                .map_err(|error| error.into_capture_error(None))
        })();
        match health {
            Ok(()) => LinuxActiveHealth::Healthy,
            Err(error) => LinuxActiveHealth::Fault(error),
        }
    }

    async fn ensure_data_plane_healthy(&self, handle: &CaptureHandle) -> Result<(), CaptureError> {
        match self.inspect_active_health(handle).await {
            LinuxActiveHealth::Healthy => Ok(()),
            LinuxActiveHealth::Inactive => Err(CaptureError::invalid(
                "LINUX_CAPTURE_STATE_INVALID",
                "operation requires the active lifecycle handle",
            )),
            LinuxActiveHealth::Fault(error) => Err(self
                .fail_closed_active_fault(handle, error, LinuxFaultCleanupCaller::Foreground)
                .await),
        }
    }

    async fn fail_closed_active_fault(
        &self,
        handle: &CaptureHandle,
        mut primary: CaptureError,
        caller: LinuxFaultCleanupCaller,
    ) -> CaptureError {
        let cleanup_artifact = primary
            .artifact
            .clone()
            .unwrap_or_else(|| handle.artifact.clone());
        primary.recovery_required = false;
        primary.artifact = Some(cleanup_artifact.clone());
        let fault_monitor = {
            let mut record = self.record.lock().await;
            if !matches!(record.state, LinuxCaptureState::Active { .. })
                || record.handle.as_ref() != Some(handle)
            {
                return record.last_active_fault.clone().unwrap_or_else(|| {
                    CaptureError::invalid(
                        "LINUX_CAPTURE_STATE_INVALID",
                        "data-plane fault no longer belongs to the active generation",
                    )
                });
            }
            record.state = LinuxCaptureState::Stopping {
                generation: handle.generation,
            };
            record.last_active_fault = Some(primary.clone());
            record.fault_monitor.take()
        };

        let cleanup_deadline = Instant::now() + LINUX_DATA_PLANE_SHUTDOWN_GRACE;
        let mut failures = Vec::new();
        match caller {
            LinuxFaultCleanupCaller::Monitor => {
                if let Some(owner) = fault_monitor {
                    debug_assert_eq!(owner.generation, handle.generation);
                    owner.cancellation.cancel();
                    // This is the current task's own handle. Dropping it does
                    // not detach unfinished cleanup: execution continues here
                    // and returns immediately after the owned cleanup below.
                    drop(owner.task);
                }
            }
            LinuxFaultCleanupCaller::Foreground => {
                self.stop_fault_monitor_until(fault_monitor, cleanup_deadline, &mut failures)
                    .await;
            }
        }

        if let Err(error) = self.stop_helper_until(handle, cleanup_deadline).await {
            failures.push(error.to_string());
        }
        self.cleanup_local_resources_until(cleanup_deadline, &mut failures)
            .await;

        if failures.is_empty() {
            self.set_idle_after_fault(primary.clone()).await;
            primary
        } else {
            self.set_recovery(
                handle.generation,
                Some(handle.clone()),
                Some(cleanup_artifact.clone()),
            )
            .await;
            // `set_recovery` deliberately leaves the separately journaled
            // root cause untouched. Return cleanup status to the foreground;
            // callers can retrieve the exact root cause through
            // `last_active_fault`.
            CaptureError::recovery_with_artifact(
                "LINUX_CAPTURE_FAULT_CLEANUP_FAILED",
                format!("{}; cleanup: {}", primary, failures.join("; ")),
                cleanup_artifact,
            )
        }
    }

    async fn stop_helper_until(
        &self,
        handle: &CaptureHandle,
        deadline: Instant,
    ) -> Result<(), CaptureError> {
        match tokio::time::timeout_at(deadline, self.helper.stop(handle)).await {
            Ok(result) => result,
            Err(_) => Err(CaptureError::recovery_with_artifact(
                "LINUX_HELPER_STOP_TIMEOUT",
                "helper capture cleanup did not finish before the lifecycle deadline",
                handle.artifact.clone(),
            )),
        }
    }

    async fn stop_fault_monitor_until(
        &self,
        owner: Option<LinuxFaultMonitorOwner>,
        deadline: Instant,
        failures: &mut Vec<String>,
    ) {
        let Some(mut owner) = owner else {
            return;
        };
        owner.cancellation.cancel();
        match tokio::time::timeout_at(deadline, &mut owner.task).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failures.push(format!(
                "LINUX_FAULT_MONITOR_JOIN_FAILED: generation {}: {error}",
                owner.generation
            )),
            Err(_) => {
                owner.task.abort();
                let _ = owner.task.await;
                failures.push(format!(
                    "LINUX_FAULT_MONITOR_SHUTDOWN_TIMEOUT: generation {}",
                    owner.generation
                ));
            }
        }
    }

    async fn rollback_prepared(
        &self,
        generation: u64,
        handle: CaptureHandle,
        primary: CaptureError,
    ) -> CaptureError {
        let mut failures = Vec::new();
        // The helper owns the system mutation; roll it back before dropping
        // the local TUN/runtime owner.
        if let Err(error) = self.helper.stop(&handle).await {
            failures.push(error.to_string());
        }
        let cleanup_deadline = Instant::now() + LINUX_DATA_PLANE_SHUTDOWN_GRACE;
        self.cleanup_local_resources_until(cleanup_deadline, &mut failures)
            .await;
        if failures.is_empty() {
            self.set_idle().await;
            primary
        } else {
            self.set_recovery(
                generation,
                Some(handle.clone()),
                Some(handle.artifact.clone()),
            )
            .await;
            CaptureError::recovery_with_artifact(
                "LINUX_CAPTURE_ROLLBACK_INCOMPLETE",
                format!("{}; rollback: {}", primary.message, failures.join("; ")),
                handle.artifact,
            )
        }
    }

    async fn mark_recovery(
        &self,
        generation: u64,
        handle: Option<CaptureHandle>,
        artifact: Option<CaptureArtifactState>,
    ) {
        let mut record = self.record.lock().await;
        record.state = LinuxCaptureState::RecoveryRequired { generation };
        if let Some(owner) = record.fault_monitor.as_ref() {
            owner.cancellation.cancel();
        }
        record.recovery_artifact =
            artifact.or_else(|| handle.as_ref().map(|item| item.artifact.clone()));
        if handle.is_some() {
            record.handle = handle;
        }
    }

    async fn begin_recovery(&self, generation: u64) -> Result<Option<CaptureHandle>, CaptureError> {
        let mut record = self.record.lock().await;
        let owned_generation = match record.state {
            LinuxCaptureState::Idle => generation,
            LinuxCaptureState::Preparing { generation }
            | LinuxCaptureState::RuntimeReady { generation, .. }
            | LinuxCaptureState::DataPlaneStarting { generation, .. }
            | LinuxCaptureState::DataPlaneReady { generation, .. }
            | LinuxCaptureState::Activating { generation, .. }
            | LinuxCaptureState::Active { generation, .. }
            | LinuxCaptureState::Stopping { generation }
            | LinuxCaptureState::RecoveryRequired { generation } => generation,
        };
        if owned_generation != generation {
            return Err(CaptureError::recovery(
                "LINUX_CAPTURE_GENERATION_MISMATCH",
                "recovery generation does not match the lifecycle state",
            ));
        }
        record.state = LinuxCaptureState::Stopping { generation };
        Ok(record.handle.clone())
    }

    async fn set_recovery(
        &self,
        generation: u64,
        handle: Option<CaptureHandle>,
        artifact: Option<CaptureArtifactState>,
    ) {
        let mut record = self.record.lock().await;
        record.state = LinuxCaptureState::RecoveryRequired { generation };
        if let Some(owner) = record.fault_monitor.as_ref() {
            owner.cancellation.cancel();
        }
        record.recovery_artifact = artifact
            .or_else(|| handle.as_ref().map(|item| item.artifact.clone()))
            .or_else(|| record.recovery_artifact.clone());
        record.handle = handle;
    }

    /// Stop local owners without moving them out of the transaction record.
    /// Holding the record lock across these terminal awaits is intentional:
    /// if the caller cancels the public operation, the lock is released but
    /// each joinable owner remains in the record for a recovery retry.
    async fn cleanup_local_resources_until(&self, deadline: Instant, failures: &mut Vec<String>) {
        let mut record = self.record.lock().await;
        if let Some(data_plane) = record.data_plane.as_mut() {
            match data_plane.stop_until(deadline).await {
                Ok(()) => record.data_plane = None,
                Err(error) => failures.push(error.to_string()),
            }
        }
        if let Some(runtime) = record.runtime.as_mut() {
            match runtime.runtime.close_until(deadline).await {
                Ok(()) => record.runtime = None,
                Err(error) => failures.push(error.to_string()),
            }
        }
    }

    async fn set_idle(&self) {
        let mut record = self.record.lock().await;
        record.state = LinuxCaptureState::Idle;
        record.handle = None;
        record.runtime = None;
        record.data_plane = None;
        record.packet_queue = None;
        if let Some(owner) = record.fault_monitor.take() {
            owner.cancellation.cancel();
        }
        record.last_active_fault = None;
        record.recovery_artifact = None;
    }

    async fn set_idle_after_fault(&self, primary: CaptureError) {
        let mut record = self.record.lock().await;
        record.state = LinuxCaptureState::Idle;
        record.handle = None;
        record.runtime = None;
        record.data_plane = None;
        record.packet_queue = None;
        if let Some(owner) = record.fault_monitor.take() {
            owner.cancellation.cancel();
        }
        record.last_active_fault = Some(primary);
        record.recovery_artifact = None;
    }
}

fn validate_global_spec(spec: &CaptureInstallSpec) -> Result<(), CaptureError> {
    spec.validate()?;
    if spec.platform != CapturePlatform::Linux {
        return Err(CaptureError::invalid(
            "LINUX_CAPTURE_PLATFORM_MISMATCH",
            "Linux capture lifecycle requires a Linux specification",
        ));
    }
    if spec.mode != CaptureMode::Global {
        return Err(CaptureError::invalid(
            "LINUX_CAPTURE_SCOPE_UNAVAILABLE",
            "application/PID capture requires a trusted tuple-to-process side channel",
        ));
    }
    Ok(())
}

fn force_recovery_error(
    mut error: CaptureError,
    artifact: CaptureArtifactState,
    fallback_code: &'static str,
) -> CaptureError {
    if !error.recovery_required {
        error.code = fallback_code.into();
        error.recovery_required = true;
    }
    // The returned artifact was rejected by validation; retain only the last
    // known-good identity in the recovery journal and diagnostic error.
    error.artifact = Some(artifact);
    error
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::sync::Notify;

    use super::*;
    use crate::sockscap::capture::linux::LinuxCapturePlan;
    use crate::sockscap::capture::{CaptureProcessRestore, CaptureSelector};
    use crate::sockscap::types::AppSelectorKind;

    const GENERATION: u64 = 7;
    const REVISION: u64 = 3;

    fn events() -> Arc<StdMutex<Vec<&'static str>>> {
        Arc::new(StdMutex::new(Vec::new()))
    }

    fn ipv4_packet() -> bytes::Bytes {
        let mut packet = vec![0_u8; 20];
        packet[0] = 0x45;
        packet[2..4].copy_from_slice(&20_u16.to_be_bytes());
        packet[8] = 64;
        packet[9] = 6;
        packet[12..16].copy_from_slice(&[127, 0, 0, 1]);
        packet[16..20].copy_from_slice(&[198, 51, 100, 8]);
        packet.into()
    }

    #[derive(Debug)]
    struct BlockingReinjectWriter {
        entered: Arc<Notify>,
    }

    #[async_trait]
    impl LinuxReinjectWriter for BlockingReinjectWriter {
        async fn write_frame(
            &self,
            _frame: &PacketEgressFrame,
        ) -> Result<(), LinuxPacketRuntimeError> {
            self.entered.notify_one();
            pending::<Result<(), LinuxPacketRuntimeError>>().await
        }
    }

    fn spec(mode: CaptureMode) -> CaptureInstallSpec {
        let selectors = if mode == CaptureMode::Global {
            Vec::new()
        } else {
            vec![CaptureSelector {
                profile_id: "profile-1".into(),
                kind: AppSelectorKind::ExecutablePath,
                value: "/usr/bin/curl".into(),
                pid: None,
                process_start_time: None,
                include_children: true,
            }]
        };
        CaptureInstallSpec {
            generation: GENERATION,
            config_revision: REVISION,
            platform: CapturePlatform::Linux,
            mode,
            gateway: "127.0.0.1:32100".parse().unwrap(),
            route_ipv6: true,
            selectors,
            bypass_ips: vec!["127.0.0.1".parse().unwrap()],
            taomni_pid: 42,
            helper_pid: Some(99),
        }
    }

    fn artifact(generation: u64) -> CaptureArtifactState {
        CaptureArtifactState {
            adapter: LINUX_ADAPTER_ID.into(),
            generation,
            owner_uid: Some(1000),
            interface_names: vec![format!("ts{generation}")],
            rule_ids: vec![format!("rule-{generation}")],
            route_ids: vec![format!("route-{generation}")],
            cgroup_paths: vec![format!("/sys/fs/cgroup/taomni/g{generation}")],
            driver_service: None,
            extension_bundle_id: None,
            process_restores: vec![CaptureProcessRestore {
                pid: 42,
                process_start_time: 123,
                owner_uid: 1000,
                original_group: "/user.slice/taomni.scope".into(),
            }],
        }
    }

    fn handle_for(spec: &CaptureInstallSpec) -> CaptureHandle {
        CaptureHandle {
            generation: spec.generation,
            config_revision: spec.config_revision,
            helper_pid: 99,
            artifact: artifact(spec.generation),
        }
    }

    #[tokio::test]
    async fn reinject_pump_cancels_while_writer_is_backpressured() {
        let (native, stack) = bounded_packet_device_queues(
            MIN_PACKET_QUEUE_BYTES,
            GENERATION,
            CapturePlatform::Linux,
        )
        .unwrap();
        stack
            .egress
            .try_send(PacketEgressFrame {
                generation: GENERATION,
                packet_id: 1,
                platform: CapturePlatform::Linux,
                payload: ipv4_packet(),
            })
            .unwrap();

        let entered = Arc::new(Notify::new());
        let cancellation = CancellationToken::new();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(LinuxTunPacketRuntime::run_reinject_pump(
            Arc::new(BlockingReinjectWriter {
                entered: Arc::clone(&entered),
            }),
            Arc::new(native.reinject),
            cancellation.clone(),
            ready_tx,
        ));

        tokio::time::timeout(Duration::from_secs(1), ready_rx)
            .await
            .expect("reinject pump reported ready")
            .expect("reinject ready sender remained alive");
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("reinject pump reached the backpressured writer");
        assert!(!task.is_finished());

        cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("cancellation released the backpressured writer")
            .expect("reinject task joined")
            .expect("reinject pump stopped cleanly");
    }

    #[test]
    fn packet_pump_fault_journal_keeps_the_first_root_cause() {
        let fault = std::sync::Mutex::new(None);
        let first = LinuxPacketRuntimeError::invalid(
            "FAKE_CAPTURE_READ_FAILED",
            "capture read failed in the injected pump",
        );
        let sibling = LinuxPacketRuntimeError::invalid(
            "FAKE_REINJECT_CANCELLED",
            "sibling observed cancellation",
        );
        LinuxTunPacketRuntime::record_pump_fault(&fault, &first);
        LinuxTunPacketRuntime::record_pump_fault(&fault, &sibling);

        let recorded = fault.into_inner().unwrap().unwrap();
        assert_eq!(recorded.code, "FAKE_CAPTURE_READ_FAILED");
        assert!(recorded.message.contains("capture read failed"));
    }

    #[tokio::test]
    async fn joined_pump_fault_is_not_misreported_as_cleanup_failure() {
        let mut task = Some(tokio::spawn(async {
            Err(LinuxPacketRuntimeError::invalid(
                "FAKE_CAPTURE_READ_FAILED",
                "capture read failed before shutdown",
            ))
        }));

        LinuxTunPacketRuntime::join_pump_task_until(
            &mut task,
            Instant::now() + Duration::from_secs(1),
        )
        .await
        .expect("a completed faulting pump is still fully joined");

        assert!(task.is_none());
    }

    #[derive(Clone)]
    struct FakeHelper {
        events: Arc<StdMutex<Vec<&'static str>>>,
        report: AdapterProbe,
        fail_activate: Arc<AtomicBool>,
        fail_stop: Arc<AtomicBool>,
        fail_heartbeat_recovery: Arc<AtomicBool>,
        heartbeat_started: Option<Arc<Notify>>,
        heartbeat_release: Option<Arc<Notify>>,
        stop_started: Option<Arc<Notify>>,
        stop_release: Option<Arc<Notify>>,
    }

    impl FakeHelper {
        fn push(&self, event: &'static str) {
            self.events.lock().unwrap().push(event);
        }
    }

    #[async_trait]
    impl LinuxHelperControl for FakeHelper {
        async fn probe(&self) -> Result<AdapterProbe, CaptureError> {
            self.push("probe");
            Ok(self.report.clone())
        }

        async fn prepare(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
            self.push("prepare");
            Ok(handle_for(spec))
        }

        async fn activate(
            &self,
            spec: &CaptureInstallSpec,
            _runtime_pid: u32,
            _runtime_start_token: u64,
        ) -> Result<CaptureHandle, CaptureError> {
            self.push("activate");
            if self.fail_activate.load(Ordering::Acquire) {
                return Err(CaptureError::recovery_with_artifact(
                    "FAKE_ACTIVATE_FAILED",
                    "activation failed in the injected helper",
                    artifact(spec.generation),
                ));
            }
            Ok(handle_for(spec))
        }

        async fn update(
            &self,
            handle: &CaptureHandle,
            _spec: &CaptureInstallSpec,
        ) -> Result<CaptureHandle, CaptureError> {
            self.push("update");
            Ok(handle.clone())
        }

        async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
            self.push("heartbeat");
            if let Some(started) = &self.heartbeat_started {
                started.notify_one();
            }
            if let Some(release) = &self.heartbeat_release {
                release.notified().await;
            }
            if self.fail_heartbeat_recovery.load(Ordering::Acquire) {
                let mut artifact = handle.artifact.clone();
                artifact.process_restores.push(CaptureProcessRestore {
                    pid: 84,
                    process_start_time: 456,
                    owner_uid: artifact.owner_uid.expect("Linux artifact owner"),
                    original_group: "/user.slice/new-child.scope".into(),
                });
                return Err(CaptureError::recovery_with_artifact(
                    "FAKE_HEARTBEAT_STATE_UNCERTAIN",
                    "heartbeat may have changed process membership",
                    artifact,
                ));
            }
            Ok(handle.clone())
        }

        async fn stop(&self, _handle: &CaptureHandle) -> Result<(), CaptureError> {
            self.push("stop");
            if let Some(started) = &self.stop_started {
                started.notify_one();
            }
            if let Some(release) = &self.stop_release {
                release.notified().await;
            }
            if self.fail_stop.load(Ordering::Acquire) {
                Err(CaptureError::recovery(
                    "FAKE_STOP_FAILED",
                    "stop failed in the injected helper",
                ))
            } else {
                Ok(())
            }
        }

        async fn recover(&self, _artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
            self.push("recover");
            Ok(())
        }

        async fn recover_generation(&self, _generation: u64) -> Result<(), CaptureError> {
            self.push("recover_generation");
            Ok(())
        }

        async fn shutdown(&self) -> Result<(), CaptureError> {
            self.push("shutdown");
            Ok(())
        }
    }

    struct FakeRuntime {
        identity: LinuxRuntimeIdentity,
        events: Arc<StdMutex<Vec<&'static str>>>,
        pump_started: bool,
        healthy: Arc<AtomicBool>,
        fail_start: bool,
        fail_close: bool,
    }

    impl fmt::Debug for FakeRuntime {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("FakeRuntime")
                .field("identity", &self.identity)
                .finish()
        }
    }

    #[async_trait]
    impl LinuxPacketRuntime for FakeRuntime {
        fn identity(&self) -> LinuxRuntimeIdentity {
            self.identity
        }

        async fn start_pump_until(
            &mut self,
            deadline: Instant,
        ) -> Result<(), LinuxPacketRuntimeError> {
            if Instant::now() >= deadline {
                return Err(LinuxPacketRuntimeError::PumpStartTimeout);
            }
            if self.fail_start {
                self.events.lock().unwrap().push("runtime.pump.failed");
                return Err(LinuxPacketRuntimeError::invalid(
                    "FAKE_RUNTIME_PUMP_FAILED",
                    "pump failed in the injected runtime",
                ));
            }
            self.pump_started = true;
            self.events.lock().unwrap().push("runtime.pump.ready");
            Ok(())
        }

        fn ensure_pump_healthy(&self) -> Result<(), LinuxPacketRuntimeError> {
            if self.pump_started && self.healthy.load(Ordering::Acquire) {
                Ok(())
            } else if self.pump_started {
                Err(LinuxPacketRuntimeError::invalid(
                    "FAKE_RUNTIME_ACTIVE_FAULT",
                    "pump failed after activation in the injected runtime",
                ))
            } else {
                Err(LinuxPacketRuntimeError::PumpNotStarted)
            }
        }

        async fn close_until(&mut self, _deadline: Instant) -> Result<(), LinuxPacketRuntimeError> {
            self.events.lock().unwrap().push("runtime.close");
            if self.fail_close {
                Err(LinuxPacketRuntimeError::invalid(
                    "FAKE_RUNTIME_CLOSE_FAILED",
                    "close failed in the injected runtime",
                ))
            } else {
                Ok(())
            }
        }
    }

    struct FakeFactory {
        events: Arc<StdMutex<Vec<&'static str>>>,
        identity_generation: u64,
        healthy: Arc<AtomicBool>,
        fail_pump_start: bool,
        fail_close: bool,
    }

    #[async_trait]
    impl LinuxPacketRuntimeFactory for FakeFactory {
        async fn open(
            &self,
            spec: &CaptureInstallSpec,
            _handle: &CaptureHandle,
        ) -> Result<LinuxPacketRuntimeBundle, LinuxPacketRuntimeError> {
            self.events.lock().unwrap().push("runtime.open");
            let (_, stack) = bounded_packet_device_queues(
                MIN_PACKET_QUEUE_BYTES,
                spec.generation,
                CapturePlatform::Linux,
            )
            .map_err(LinuxPacketRuntimeError::Packet)?;
            let packet_queue = stack.ingress.identity();
            let runtime = FakeRuntime {
                identity: LinuxRuntimeIdentity {
                    generation: self.identity_generation,
                    pid: 777,
                    process_start_time: 888,
                },
                events: Arc::clone(&self.events),
                pump_started: false,
                healthy: Arc::clone(&self.healthy),
                fail_start: self.fail_pump_start,
                fail_close: self.fail_close,
            };
            Ok(LinuxPacketRuntimeBundle::new(
                Box::new(runtime),
                LinuxPacketRuntimeChannels {
                    ingress: stack.ingress,
                    egress: stack.egress,
                    identity: LinuxPacketChannelIdentity {
                        generation: spec.generation,
                        platform: CapturePlatform::Linux,
                        packet_queue,
                    },
                },
            ))
        }
    }

    struct FakeDataPlane {
        identity: LinuxDataPlaneIdentity,
        events: Arc<StdMutex<Vec<&'static str>>>,
        healthy: Arc<AtomicBool>,
        fail_stop: bool,
    }

    impl fmt::Debug for FakeDataPlane {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("FakeDataPlane")
                .field("identity", &self.identity)
                .finish_non_exhaustive()
        }
    }

    #[async_trait]
    impl LinuxDataPlaneRuntime for FakeDataPlane {
        fn identity(&self) -> LinuxDataPlaneIdentity {
            self.identity
        }

        fn ensure_healthy(&self) -> Result<(), LinuxDataPlaneError> {
            if self.healthy.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(LinuxDataPlaneError::runtime("FAKE_DATA_PLANE_UNHEALTHY"))
            }
        }

        async fn stop_until(&mut self, _deadline: Instant) -> Result<(), LinuxDataPlaneError> {
            self.events.lock().unwrap().push("plane.stop");
            if self.fail_stop {
                Err(LinuxDataPlaneError::runtime("FAKE_DATA_PLANE_STOP_FAILED"))
            } else {
                Ok(())
            }
        }
    }

    struct FakeDataPlaneFactory {
        events: Arc<StdMutex<Vec<&'static str>>>,
        identity_generation: u64,
        mismatch_packet_source: bool,
        fail_start: bool,
        fail_stop: bool,
        healthy: Arc<AtomicBool>,
    }

    struct BlockingDataPlaneFactory {
        events: Arc<StdMutex<Vec<&'static str>>>,
        started: Arc<Notify>,
    }

    #[async_trait]
    impl LinuxDataPlaneFactory for BlockingDataPlaneFactory {
        async fn start_until(
            &self,
            spec: &CaptureInstallSpec,
            _runtime: LinuxRuntimeIdentity,
            channels: LinuxPacketRuntimeChannels,
            _deadline: Instant,
        ) -> Result<Box<dyn LinuxDataPlaneRuntime>, LinuxDataPlaneError> {
            channels.validate_for(spec)?;
            self.events.lock().unwrap().push("plane.start.blocked");
            self.started.notify_one();
            pending().await
        }
    }

    #[async_trait]
    impl LinuxDataPlaneFactory for FakeDataPlaneFactory {
        async fn start_until(
            &self,
            spec: &CaptureInstallSpec,
            runtime: LinuxRuntimeIdentity,
            channels: LinuxPacketRuntimeChannels,
            _deadline: Instant,
        ) -> Result<Box<dyn LinuxDataPlaneRuntime>, LinuxDataPlaneError> {
            self.events.lock().unwrap().push("plane.start");
            let channel_identity = channels.identity();
            channels.validate_for(spec)?;
            if self.fail_start {
                return Err(LinuxDataPlaneError::runtime("FAKE_DATA_PLANE_START_FAILED"));
            }
            let packet_queue = if self.mismatch_packet_source {
                let (_, unrelated) = bounded_packet_device_queues(
                    MIN_PACKET_QUEUE_BYTES,
                    spec.generation,
                    CapturePlatform::Linux,
                )
                .map_err(|_| LinuxDataPlaneError::runtime("FAKE_PACKET_QUEUE_FAILED"))?;
                unrelated.ingress.identity()
            } else {
                channel_identity.packet_queue
            };
            Ok(Box::new(FakeDataPlane {
                identity: LinuxDataPlaneIdentity {
                    generation: self.identity_generation,
                    config_revision: spec.config_revision,
                    platform: CapturePlatform::Linux,
                    runtime_pid: runtime.pid,
                    runtime_process_start_time: runtime.process_start_time,
                    packet_queue,
                },
                events: Arc::clone(&self.events),
                healthy: Arc::clone(&self.healthy),
                fail_stop: self.fail_stop,
            }))
        }
    }

    #[derive(Debug, Clone, Copy)]
    struct FakeDataPlaneOptions {
        identity_generation: u64,
        mismatch_packet_source: bool,
        fail_start: bool,
        fail_stop: bool,
        healthy: bool,
    }

    impl Default for FakeDataPlaneOptions {
        fn default() -> Self {
            Self {
                identity_generation: GENERATION,
                mismatch_packet_source: false,
                fail_start: false,
                fail_stop: false,
                healthy: true,
            }
        }
    }

    fn lifecycle(
        events: Arc<StdMutex<Vec<&'static str>>>,
        global_available: bool,
        fail_activate: bool,
        fail_stop: bool,
        identity_generation: u64,
        fail_runtime_close: bool,
    ) -> LinuxCaptureLifecycle {
        lifecycle_with_plane(
            events,
            global_available,
            fail_activate,
            fail_stop,
            identity_generation,
            fail_runtime_close,
            FakeDataPlaneOptions::default(),
        )
    }

    fn lifecycle_with_plane(
        events: Arc<StdMutex<Vec<&'static str>>>,
        global_available: bool,
        fail_activate: bool,
        fail_stop: bool,
        identity_generation: u64,
        fail_runtime_close: bool,
        plane: FakeDataPlaneOptions,
    ) -> LinuxCaptureLifecycle {
        lifecycle_with_plane_and_heartbeat(
            events,
            global_available,
            fail_activate,
            fail_stop,
            identity_generation,
            fail_runtime_close,
            plane,
            false,
            false,
            None,
            None,
        )
    }

    fn lifecycle_with_pump_start_failure(
        events: Arc<StdMutex<Vec<&'static str>>>,
    ) -> LinuxCaptureLifecycle {
        lifecycle_with_plane_and_heartbeat(
            events,
            true,
            false,
            false,
            GENERATION,
            false,
            FakeDataPlaneOptions::default(),
            true,
            false,
            None,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn lifecycle_with_plane_and_heartbeat(
        events: Arc<StdMutex<Vec<&'static str>>>,
        global_available: bool,
        fail_activate: bool,
        fail_stop: bool,
        identity_generation: u64,
        fail_runtime_close: bool,
        plane: FakeDataPlaneOptions,
        fail_runtime_start: bool,
        fail_heartbeat_recovery: bool,
        heartbeat_started: Option<Arc<Notify>>,
        heartbeat_release: Option<Arc<Notify>>,
    ) -> LinuxCaptureLifecycle {
        let helper = FakeHelper {
            events: Arc::clone(&events),
            report: AdapterProbe {
                adapter: LINUX_ADAPTER_ID.into(),
                platform: CapturePlatform::Linux,
                installed: true,
                privileged_helper_ready: true,
                signature_verified: true,
                global_available,
                application_group_available: false,
                runtime_pid_available: false,
                detail: "fake".into(),
            },
            fail_activate: Arc::new(AtomicBool::new(fail_activate)),
            fail_stop: Arc::new(AtomicBool::new(fail_stop)),
            fail_heartbeat_recovery: Arc::new(AtomicBool::new(fail_heartbeat_recovery)),
            heartbeat_started,
            heartbeat_release,
            stop_started: None,
            stop_release: None,
        };
        let plane_events = Arc::clone(&events);
        LinuxCaptureLifecycle::new(
            Arc::new(helper),
            Arc::new(FakeFactory {
                events,
                identity_generation,
                healthy: Arc::new(AtomicBool::new(true)),
                fail_pump_start: fail_runtime_start,
                fail_close: fail_runtime_close,
            }),
            Arc::new(FakeDataPlaneFactory {
                events: plane_events,
                identity_generation: plane.identity_generation,
                mismatch_packet_source: plane.mismatch_packet_source,
                fail_start: plane.fail_start,
                fail_stop: plane.fail_stop,
                healthy: Arc::new(AtomicBool::new(plane.healthy)),
            }),
        )
    }

    fn lifecycle_with_active_health(
        events: Arc<StdMutex<Vec<&'static str>>>,
        runtime_healthy: Arc<AtomicBool>,
        plane_healthy: Arc<AtomicBool>,
        stop_started: Option<Arc<Notify>>,
        stop_release: Option<Arc<Notify>>,
    ) -> LinuxCaptureLifecycle {
        let helper = FakeHelper {
            events: Arc::clone(&events),
            report: AdapterProbe {
                adapter: LINUX_ADAPTER_ID.into(),
                platform: CapturePlatform::Linux,
                installed: true,
                privileged_helper_ready: true,
                signature_verified: true,
                global_available: true,
                application_group_available: false,
                runtime_pid_available: false,
                detail: "fake".into(),
            },
            fail_activate: Arc::new(AtomicBool::new(false)),
            fail_stop: Arc::new(AtomicBool::new(false)),
            fail_heartbeat_recovery: Arc::new(AtomicBool::new(false)),
            heartbeat_started: None,
            heartbeat_release: None,
            stop_started,
            stop_release,
        };
        LinuxCaptureLifecycle::new(
            Arc::new(helper),
            Arc::new(FakeFactory {
                events: Arc::clone(&events),
                identity_generation: GENERATION,
                healthy: runtime_healthy,
                fail_pump_start: false,
                fail_close: false,
            }),
            Arc::new(FakeDataPlaneFactory {
                events,
                identity_generation: GENERATION,
                mismatch_packet_source: false,
                fail_start: false,
                fail_stop: false,
                healthy: plane_healthy,
            }),
        )
    }

    async fn wait_until_idle(lifecycle: &LinuxCaptureLifecycle) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if lifecycle.state().await == LinuxCaptureState::Idle {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("fault monitor completed bounded fail-closed cleanup");
    }

    #[tokio::test]
    async fn global_install_and_stop_have_explicit_order() {
        let events = events();
        let lifecycle = lifecycle(Arc::clone(&events), true, false, false, GENERATION, false);
        let handle = lifecycle.install(&spec(CaptureMode::Global)).await.unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start",
                "activate"
            ]
        );
        assert_eq!(
            lifecycle.state().await,
            LinuxCaptureState::Active {
                generation: GENERATION,
                config_revision: REVISION
            }
        );
        {
            let record = lifecycle.record.lock().await;
            let ready_identity = record.data_plane.as_ref().unwrap().identity();
            assert_eq!(ready_identity.packet_queue.generation, GENERATION);
            assert_eq!(ready_identity.packet_queue.platform, CapturePlatform::Linux);
            assert_ne!(ready_identity.source_id(), 0);
        }
        lifecycle.stop(&handle).await.unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start",
                "activate",
                "stop",
                "plane.stop",
                "runtime.close"
            ]
        );
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[tokio::test]
    async fn active_data_plane_fault_is_automatically_revoked_and_retained() {
        let events = events();
        let runtime_healthy = Arc::new(AtomicBool::new(true));
        let plane_healthy = Arc::new(AtomicBool::new(true));
        let lifecycle = lifecycle_with_active_health(
            Arc::clone(&events),
            runtime_healthy,
            Arc::clone(&plane_healthy),
            None,
            None,
        );
        let handle = lifecycle.install(&spec(CaptureMode::Global)).await.unwrap();

        plane_healthy.store(false, Ordering::Release);
        wait_until_idle(&lifecycle).await;

        let fault = lifecycle
            .last_active_fault()
            .await
            .expect("root cause retained after successful cleanup");
        assert_eq!(fault.code, "FAKE_DATA_PLANE_UNHEALTHY");
        assert!(!fault.recovery_required);
        assert_eq!(fault.artifact, Some(handle.artifact.clone()));
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start",
                "activate",
                "stop",
                "plane.stop",
                "runtime.close"
            ]
        );

        let repeated = lifecycle.stop(&handle).await.unwrap_err();
        assert_eq!(repeated.code, "FAKE_DATA_PLANE_UNHEALTHY");
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| **e == "stop")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn active_packet_pump_fault_is_automatically_revoked() {
        let events = events();
        let runtime_healthy = Arc::new(AtomicBool::new(true));
        let lifecycle = lifecycle_with_active_health(
            Arc::clone(&events),
            Arc::clone(&runtime_healthy),
            Arc::new(AtomicBool::new(true)),
            None,
            None,
        );
        let handle = lifecycle.install(&spec(CaptureMode::Global)).await.unwrap();

        runtime_healthy.store(false, Ordering::Release);
        wait_until_idle(&lifecycle).await;

        let fault = lifecycle.last_active_fault().await.unwrap();
        assert_eq!(fault.code, "FAKE_RUNTIME_ACTIVE_FAULT");
        assert_eq!(fault.artifact, Some(handle.artifact));
        let events = events.lock().unwrap();
        assert_eq!(events.iter().filter(|e| **e == "stop").count(), 1);
        assert_eq!(events.iter().filter(|e| **e == "plane.stop").count(), 1);
        assert_eq!(events.iter().filter(|e| **e == "runtime.close").count(), 1);
    }

    #[tokio::test]
    async fn active_packet_source_change_is_automatically_revoked() {
        let events = events();
        let lifecycle = lifecycle_with_active_health(
            Arc::clone(&events),
            Arc::new(AtomicBool::new(true)),
            Arc::new(AtomicBool::new(true)),
            None,
            None,
        );
        let handle = lifecycle.install(&spec(CaptureMode::Global)).await.unwrap();
        let (_, unrelated) = bounded_packet_device_queues(
            MIN_PACKET_QUEUE_BYTES,
            GENERATION,
            CapturePlatform::Linux,
        )
        .unwrap();
        let unrelated_queue = unrelated.ingress.identity();
        {
            let mut record = lifecycle.record.lock().await;
            let mut identity = record.data_plane.as_ref().expect("active plane").identity();
            assert_ne!(identity.packet_queue, unrelated_queue);
            identity.packet_queue = unrelated_queue;
            record.data_plane = Some(Box::new(FakeDataPlane {
                identity,
                events: Arc::clone(&events),
                healthy: Arc::new(AtomicBool::new(true)),
                fail_stop: false,
            }));
        }

        wait_until_idle(&lifecycle).await;

        let fault = lifecycle.last_active_fault().await.unwrap();
        assert_eq!(fault.code, "LINUX_DATA_PLANE_IDENTITY_INVALID");
        assert_eq!(fault.artifact, Some(handle.artifact));
        let events = events.lock().unwrap();
        assert_eq!(events.iter().filter(|e| **e == "stop").count(), 1);
        assert_eq!(events.iter().filter(|e| **e == "plane.stop").count(), 1);
        assert_eq!(events.iter().filter(|e| **e == "runtime.close").count(), 1);
    }

    #[tokio::test]
    async fn concurrent_explicit_stop_does_not_duplicate_fault_cleanup() {
        let events = events();
        let plane_healthy = Arc::new(AtomicBool::new(true));
        let stop_started = Arc::new(Notify::new());
        let stop_release = Arc::new(Notify::new());
        let lifecycle = Arc::new(lifecycle_with_active_health(
            Arc::clone(&events),
            Arc::new(AtomicBool::new(true)),
            Arc::clone(&plane_healthy),
            Some(Arc::clone(&stop_started)),
            Some(Arc::clone(&stop_release)),
        ));
        let handle = lifecycle.install(&spec(CaptureMode::Global)).await.unwrap();

        plane_healthy.store(false, Ordering::Release);
        tokio::time::timeout(Duration::from_secs(1), stop_started.notified())
            .await
            .expect("fault owner began helper revocation");
        let explicit_stop = {
            let lifecycle = Arc::clone(&lifecycle);
            let handle = handle.clone();
            tokio::spawn(async move { lifecycle.stop(&handle).await })
        };
        tokio::task::yield_now().await;
        assert!(
            !explicit_stop.is_finished(),
            "explicit stop waits for the single fault cleanup owner"
        );

        stop_release.notify_one();
        let error = tokio::time::timeout(Duration::from_secs(2), explicit_stop)
            .await
            .expect("concurrent stop remained bounded")
            .expect("explicit stop task joined")
            .expect_err("fault is reported after automatic cleanup");
        assert_eq!(error.code, "FAKE_DATA_PLANE_UNHEALTHY");
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
        let events = events.lock().unwrap();
        assert_eq!(events.iter().filter(|e| **e == "stop").count(), 1);
        assert_eq!(events.iter().filter(|e| **e == "plane.stop").count(), 1);
        assert_eq!(events.iter().filter(|e| **e == "runtime.close").count(), 1);
    }

    #[tokio::test]
    async fn heartbeat_and_stop_are_serialized_across_helper_io() {
        let events = events();
        let heartbeat_started = Arc::new(Notify::new());
        let heartbeat_release = Arc::new(Notify::new());
        let lifecycle = Arc::new(lifecycle_with_plane_and_heartbeat(
            Arc::clone(&events),
            true,
            false,
            false,
            GENERATION,
            false,
            FakeDataPlaneOptions::default(),
            false,
            false,
            Some(Arc::clone(&heartbeat_started)),
            Some(Arc::clone(&heartbeat_release)),
        ));
        let capture_spec = spec(CaptureMode::Global);
        let handle = lifecycle.install(&capture_spec).await.unwrap();

        let heartbeat_task = {
            let lifecycle = Arc::clone(&lifecycle);
            let handle = handle.clone();
            let capture_spec = capture_spec.clone();
            tokio::spawn(async move { lifecycle.heartbeat(&handle, &capture_spec).await })
        };
        tokio::time::timeout(Duration::from_secs(1), heartbeat_started.notified())
            .await
            .expect("heartbeat reached injected helper");

        let stop_task = {
            let lifecycle = Arc::clone(&lifecycle);
            let handle = handle.clone();
            tokio::spawn(async move { lifecycle.stop(&handle).await })
        };
        tokio::task::yield_now().await;
        assert!(
            !stop_task.is_finished(),
            "stop must wait for the in-flight heartbeat transaction"
        );

        heartbeat_release.notify_one();
        heartbeat_task.await.unwrap().unwrap();
        stop_task.await.unwrap().unwrap();
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
        let events = events.lock().unwrap();
        let heartbeat_index = events
            .iter()
            .position(|event| *event == "heartbeat")
            .unwrap();
        let stop_index = events.iter().position(|event| *event == "stop").unwrap();
        assert!(heartbeat_index < stop_index);
    }

    #[tokio::test]
    async fn uncertain_heartbeat_is_fail_closed_with_authoritative_wal_artifact() {
        let events = events();
        let lifecycle = lifecycle_with_plane_and_heartbeat(
            Arc::clone(&events),
            true,
            false,
            false,
            GENERATION,
            false,
            FakeDataPlaneOptions::default(),
            false,
            true,
            None,
            None,
        );
        let capture_spec = spec(CaptureMode::Global);
        let handle = lifecycle.install(&capture_spec).await.unwrap();

        let error = lifecycle
            .heartbeat(&handle, &capture_spec)
            .await
            .unwrap_err();

        assert_eq!(error.code, "FAKE_HEARTBEAT_STATE_UNCERTAIN");
        assert!(!error.recovery_required);
        let authoritative = error.artifact.clone().expect("heartbeat WAL artifact");
        assert_eq!(authoritative.process_restores.len(), 2);
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
        assert_eq!(
            lifecycle.last_active_fault().await.unwrap().artifact,
            Some(authoritative)
        );
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start",
                "activate",
                "heartbeat",
                "stop",
                "plane.stop",
                "runtime.close"
            ]
        );
    }

    #[tokio::test]
    async fn capability_lock_prevents_prepare_when_probe_is_not_ready() {
        let events = events();
        let lifecycle = lifecycle(Arc::clone(&events), false, false, false, GENERATION, false);
        let error = lifecycle
            .install(&spec(CaptureMode::Global))
            .await
            .unwrap_err();
        assert_eq!(error.code, "LINUX_CAPTURE_CAPABILITY_LOCKED");
        assert_eq!(*events.lock().unwrap(), vec!["probe"]);
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[tokio::test]
    async fn native_pump_failure_rolls_back_before_stack_or_activation() {
        let events = events();
        let lifecycle = lifecycle_with_pump_start_failure(Arc::clone(&events));
        let error = lifecycle
            .install(&spec(CaptureMode::Global))
            .await
            .unwrap_err();
        assert_eq!(error.code, "FAKE_RUNTIME_PUMP_FAILED");
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.failed",
                "stop",
                "runtime.close"
            ]
        );
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[tokio::test]
    async fn cancelled_install_retains_runtime_owner_for_shutdown_recovery() {
        let events = events();
        let plane_started = Arc::new(Notify::new());
        let helper = FakeHelper {
            events: Arc::clone(&events),
            report: AdapterProbe {
                adapter: LINUX_ADAPTER_ID.into(),
                platform: CapturePlatform::Linux,
                installed: true,
                privileged_helper_ready: true,
                signature_verified: true,
                global_available: true,
                application_group_available: false,
                runtime_pid_available: false,
                detail: "fake".into(),
            },
            fail_activate: Arc::new(AtomicBool::new(false)),
            fail_stop: Arc::new(AtomicBool::new(false)),
            fail_heartbeat_recovery: Arc::new(AtomicBool::new(false)),
            heartbeat_started: None,
            heartbeat_release: None,
            stop_started: None,
            stop_release: None,
        };
        let lifecycle = Arc::new(LinuxCaptureLifecycle::new(
            Arc::new(helper),
            Arc::new(FakeFactory {
                events: Arc::clone(&events),
                identity_generation: GENERATION,
                healthy: Arc::new(AtomicBool::new(true)),
                fail_pump_start: false,
                fail_close: false,
            }),
            Arc::new(BlockingDataPlaneFactory {
                events: Arc::clone(&events),
                started: Arc::clone(&plane_started),
            }),
        ));
        let install_task = {
            let lifecycle = Arc::clone(&lifecycle);
            tokio::spawn(async move { lifecycle.install(&spec(CaptureMode::Global)).await })
        };
        tokio::time::timeout(Duration::from_secs(1), plane_started.notified())
            .await
            .expect("data-plane startup reached blocking factory");
        install_task.abort();
        assert!(install_task.await.unwrap_err().is_cancelled());
        assert_eq!(
            lifecycle.state().await,
            LinuxCaptureState::DataPlaneStarting {
                generation: GENERATION,
                config_revision: REVISION,
            }
        );

        lifecycle.shutdown().await.unwrap();
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start.blocked",
                "shutdown",
                "runtime.close",
            ]
        );
    }

    #[tokio::test]
    async fn application_scope_fails_closed_before_helper_calls() {
        let events = events();
        let lifecycle = lifecycle(Arc::clone(&events), true, false, false, GENERATION, false);
        let error = lifecycle
            .install(&spec(CaptureMode::ApplicationGroup))
            .await
            .unwrap_err();
        assert_eq!(error.code, "LINUX_CAPTURE_SCOPE_UNAVAILABLE");
        assert!(events.lock().unwrap().is_empty());
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[tokio::test]
    async fn activation_failure_rolls_back_helper_before_closing_runtime() {
        let events = events();
        let lifecycle = lifecycle(Arc::clone(&events), true, true, false, GENERATION, false);
        let error = lifecycle
            .install(&spec(CaptureMode::Global))
            .await
            .unwrap_err();
        assert_eq!(error.code, "FAKE_ACTIVATE_FAILED");
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start",
                "activate",
                "stop",
                "plane.stop",
                "runtime.close"
            ]
        );
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[tokio::test]
    async fn data_plane_start_failure_rolls_back_without_activation() {
        let events = events();
        let lifecycle = lifecycle_with_plane(
            Arc::clone(&events),
            true,
            false,
            false,
            GENERATION,
            false,
            FakeDataPlaneOptions {
                fail_start: true,
                ..FakeDataPlaneOptions::default()
            },
        );
        let error = lifecycle
            .install(&spec(CaptureMode::Global))
            .await
            .unwrap_err();
        assert_eq!(error.code, "FAKE_DATA_PLANE_START_FAILED");
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start",
                "stop",
                "runtime.close"
            ]
        );
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[tokio::test]
    async fn data_plane_identity_mismatch_never_activates() {
        let events = events();
        let lifecycle = lifecycle_with_plane(
            Arc::clone(&events),
            true,
            false,
            false,
            GENERATION,
            false,
            FakeDataPlaneOptions {
                identity_generation: GENERATION + 1,
                ..FakeDataPlaneOptions::default()
            },
        );
        let error = lifecycle
            .install(&spec(CaptureMode::Global))
            .await
            .unwrap_err();
        assert_eq!(error.code, "LINUX_DATA_PLANE_IDENTITY_INVALID");
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start",
                "stop",
                "plane.stop",
                "runtime.close"
            ]
        );
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[tokio::test]
    async fn data_plane_packet_source_mismatch_never_activates() {
        let events = events();
        let lifecycle = lifecycle_with_plane(
            Arc::clone(&events),
            true,
            false,
            false,
            GENERATION,
            false,
            FakeDataPlaneOptions {
                mismatch_packet_source: true,
                ..FakeDataPlaneOptions::default()
            },
        );
        let error = lifecycle
            .install(&spec(CaptureMode::Global))
            .await
            .unwrap_err();
        assert_eq!(error.code, "LINUX_DATA_PLANE_IDENTITY_INVALID");
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start",
                "stop",
                "plane.stop",
                "runtime.close"
            ]
        );
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[tokio::test]
    async fn unhealthy_data_plane_never_activates() {
        let events = events();
        let lifecycle = lifecycle_with_plane(
            Arc::clone(&events),
            true,
            false,
            false,
            GENERATION,
            false,
            FakeDataPlaneOptions {
                healthy: false,
                ..FakeDataPlaneOptions::default()
            },
        );
        let error = lifecycle
            .install(&spec(CaptureMode::Global))
            .await
            .unwrap_err();
        assert_eq!(error.code, "FAKE_DATA_PLANE_UNHEALTHY");
        assert!(!events.lock().unwrap().contains(&"activate"));
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[tokio::test]
    async fn failed_stop_enters_recovery_and_keeps_runtime_owner() {
        let events = events();
        let lifecycle = lifecycle(Arc::clone(&events), true, false, true, GENERATION, false);
        let handle = lifecycle.install(&spec(CaptureMode::Global)).await.unwrap();
        let error = lifecycle.stop(&handle).await.unwrap_err();
        assert!(error.recovery_required);
        assert_eq!(
            lifecycle.state().await,
            LinuxCaptureState::RecoveryRequired {
                generation: GENERATION
            }
        );
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "probe",
                "prepare",
                "runtime.open",
                "runtime.pump.ready",
                "plane.start",
                "activate",
                "stop",
                "plane.stop",
                "runtime.close"
            ]
        );
        assert_eq!(
            lifecycle.recovery_artifact().await,
            Some(handle.artifact.clone())
        );
    }

    #[tokio::test]
    async fn failed_data_plane_stop_retains_recovery_artifact() {
        let events = events();
        let lifecycle = lifecycle_with_plane(
            Arc::clone(&events),
            true,
            false,
            false,
            GENERATION,
            false,
            FakeDataPlaneOptions {
                fail_stop: true,
                ..FakeDataPlaneOptions::default()
            },
        );
        let handle = lifecycle.install(&spec(CaptureMode::Global)).await.unwrap();
        let error = lifecycle.stop(&handle).await.unwrap_err();
        assert!(error.recovery_required);
        assert!(error.message.contains("FAKE_DATA_PLANE_STOP_FAILED"));
        assert_eq!(
            lifecycle.state().await,
            LinuxCaptureState::RecoveryRequired {
                generation: GENERATION
            }
        );
        assert_eq!(
            lifecycle.recovery_artifact().await,
            Some(handle.artifact.clone())
        );
    }

    #[tokio::test]
    async fn runtime_generation_mismatch_rolls_back_without_activation() {
        let events = events();
        let lifecycle = lifecycle(
            Arc::clone(&events),
            true,
            false,
            false,
            GENERATION + 1,
            false,
        );
        let error = lifecycle
            .install(&spec(CaptureMode::Global))
            .await
            .unwrap_err();
        assert_eq!(error.code, "LINUX_RUNTIME_IDENTITY_INVALID");
        assert_eq!(
            *events.lock().unwrap(),
            vec!["probe", "prepare", "runtime.open", "stop", "runtime.close"]
        );
        assert_eq!(lifecycle.state().await, LinuxCaptureState::Idle);
    }

    #[test]
    fn runtime_identity_rejects_zero_or_stale_tokens() {
        let identity = LinuxRuntimeIdentity {
            generation: GENERATION,
            pid: 0,
            process_start_time: 1,
        };
        assert_eq!(
            identity.validate_for(GENERATION).unwrap_err().code(),
            "LINUX_RUNTIME_IDENTITY_INVALID"
        );
        let identity = LinuxRuntimeIdentity {
            generation: GENERATION + 1,
            pid: 1,
            process_start_time: 1,
        };
        assert_eq!(
            identity.validate_for(GENERATION).unwrap_err().code(),
            "LINUX_RUNTIME_IDENTITY_INVALID"
        );
    }

    #[test]
    fn runtime_boundary_rechecks_adapter_owner_and_namespace() {
        let spec = spec(CaptureMode::Global);
        let owner_uid = current_linux_uid();
        let artifact = LinuxCapturePlan::from_spec(&spec, owner_uid)
            .unwrap()
            .artifact(Vec::new());
        let handle = CaptureHandle {
            generation: spec.generation,
            config_revision: spec.config_revision,
            helper_pid: 99,
            artifact,
        };
        if owner_uid != 0 {
            assert_eq!(validate_runtime_handle(&spec, &handle).unwrap(), owner_uid);
        }

        let mut foreign = handle.clone();
        foreign.artifact.adapter = "foreign_adapter".into();
        assert_eq!(
            validate_runtime_handle(&spec, &foreign).unwrap_err().code,
            "LINUX_RUNTIME_ADAPTER_INVALID"
        );

        let mut foreign_owner = handle;
        foreign_owner.artifact.owner_uid = Some(owner_uid.wrapping_add(1));
        assert_eq!(
            validate_runtime_handle(&spec, &foreign_owner)
                .unwrap_err()
                .code,
            "LINUX_RUNTIME_OWNER_INVALID"
        );
    }
}
