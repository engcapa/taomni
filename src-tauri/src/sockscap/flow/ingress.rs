//! Platform-neutral, bounded ingress contracts for decoded transport flows.
//!
//! Capture adapters and lower IP-stack adapters must attach identity before a
//! flow crosses this boundary. `FlowDescriptor::validate_for` deliberately
//! fails closed on stale or incomplete metadata; the runtime must never guess
//! a PID, application identity, profile, or hostname after the fact.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, Notify, mpsc};

use crate::sockscap::flow::attribution::AttributionHints;
use crate::sockscap::policy::rules::normalize_hostname;
use crate::sockscap::policy::selector::{
    ApplicationIdentity, ProfileSelectionBinding, ProfileSelectionInput, ProfileSelectionIntent,
    RuntimeProcessIdentity,
};
use crate::sockscap::types::{AppSelectorKind, CapturePlatform};

const MAX_PROFILE_ID_BYTES: usize = 128;
const MAX_APP_IDENTITY_BYTES: usize = 4096;
const MAX_HOSTNAME_BYTES: usize = 253;
pub const MAX_INGRESS_QUEUE_CAPACITY: usize = 65_536;
/// UDP associations have an independent admission budget from TCP flows.
pub const MAX_UDP_INGRESS_QUEUE_CAPACITY: usize = 65_536;
/// Conservative UDP payload ceiling that is valid without IP jumbograms.
///
/// IPv4's maximum 65,535-byte packet minus its minimum 20-byte header and the
/// 8-byte UDP header leaves 65,507 bytes. Using the smaller IPv4/IPv6-safe
/// ceiling keeps this transport-neutral ingress contract independent of IP
/// version and extension-header layout.
pub const MAX_UDP_DATAGRAM_BYTES: usize = 65_507;

/// Transport protocol carried by one decoded flow descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowTransport {
    Tcp,
    Udp,
}

/// Optional trusted binding to an exact policy snapshot.
///
/// Packet queues that cannot prove the selected profile use `AutoSelect`; the
/// shared runtime then applies its own ordered profile selection. A native
/// queue that is already isolated per profile may use `TrustedQueue`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProfileBinding {
    AutoSelect,
    TrustedQueue {
        profile_id: String,
        config_revision: u64,
    },
}

/// Trusted capture-time routing intent for this flow.
///
/// This is not a policy decision supplied by packet contents. It is frozen by
/// the capture adapter when the flow is admitted. Scoped capture must use one
/// of the `Require*` variants so missing or stale identity evidence cannot
/// silently escape into a global profile. `TrustedProfile` is reserved for an
/// authenticated, profile-isolated queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CaptureIntent {
    /// Specific attribution is preferred, but an enabled global profile is a
    /// legitimate fallback for this capture source.
    AllowGlobalFallback,
    /// The flow must carry application identity and match an application
    /// profile. A global profile is never a fallback.
    RequireApplication,
    /// The flow must carry an exact PID/start-token pair and match a runtime
    /// process profile. A global profile is never a fallback.
    RequireRuntimeProcess,
    /// The flow must carry and match at least one application or runtime
    /// identity. A global profile is never a fallback.
    RequireAnySpecific,
    /// The authenticated queue already selected an exact profile.
    ///
    /// `inherited_child` freezes `include_children` semantics: a child may
    /// inherit a parent's profile only through a trusted, profile-isolated
    /// queue. The selector still verifies the active profile enables child
    /// inheritance; otherwise selection fails closed.
    TrustedProfile {
        profile_id: String,
        inherited_child: bool,
    },
}

impl ProfileBinding {
    fn validate(&self) -> Result<(), IngressError> {
        let Self::TrustedQueue {
            profile_id,
            config_revision,
        } = self
        else {
            return Ok(());
        };
        if profile_id.is_empty() || profile_id.len() > MAX_PROFILE_ID_BYTES {
            return Err(IngressError::invalid(
                "INGRESS_PROFILE_INVALID",
                "profile id is empty or exceeds the ingress limit",
            ));
        }
        if profile_id.contains('\0')
            || !profile_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(IngressError::invalid(
                "INGRESS_PROFILE_INVALID",
                "profile id contains unsupported characters",
            ));
        }
        if *config_revision == 0 {
            return Err(IngressError::invalid(
                "INGRESS_PROFILE_REVISION_INVALID",
                "profile config revision must be non-zero",
            ));
        }
        Ok(())
    }
}

/// Complete identity and original transport tuple for one decoded flow.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDescriptor {
    pub generation: u64,
    pub flow_id: u64,
    pub platform: CapturePlatform,
    pub transport: FlowTransport,
    pub source: SocketAddr,
    pub destination: SocketAddr,
    /// Raw bounded hostname hints. Call `effective_attribution` before matching;
    /// it always replaces the string destination IP with the typed tuple IP.
    pub attribution: AttributionHints,
    pub pid: Option<u32>,
    pub process_start_time: Option<u64>,
    pub app_kind: Option<AppSelectorKind>,
    pub app_identity: Option<String>,
    pub capture_intent: CaptureIntent,
    pub profile_binding: ProfileBinding,
}

impl fmt::Debug for FlowDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FlowDescriptor")
            .field("generation", &self.generation)
            .field("flow_id", &self.flow_id)
            .field("platform", &self.platform)
            .field("transport", &self.transport)
            .field("source", &"redacted socket")
            .field("destination", &"redacted socket")
            .field("attribution", &"redacted hostname hints")
            .field("process_identity", &self.pid.is_some())
            .field("application_identity", &self.app_identity.is_some())
            .field(
                "capture_intent",
                &match &self.capture_intent {
                    CaptureIntent::AllowGlobalFallback => "allow_global_fallback",
                    CaptureIntent::RequireApplication => "require_application",
                    CaptureIntent::RequireRuntimeProcess => "require_runtime_process",
                    CaptureIntent::RequireAnySpecific => "require_any_specific",
                    CaptureIntent::TrustedProfile { .. } => "trusted_profile",
                },
            )
            .field(
                "profile_binding",
                &match &self.profile_binding {
                    ProfileBinding::AutoSelect => "auto_select",
                    ProfileBinding::TrustedQueue { .. } => "trusted_queue",
                },
            )
            .finish()
    }
}

impl FlowDescriptor {
    /// Validate this descriptor against the one active capture generation.
    ///
    /// The caller supplies the generation committed by the coordinator. An old
    /// adapter or queued flow therefore cannot enter a newer runtime.
    pub fn validate_for(&self, expected_generation: u64) -> Result<(), IngressError> {
        if expected_generation == 0 {
            return Err(IngressError::invalid(
                "INGRESS_EXPECTED_GENERATION_INVALID",
                "active capture generation must be non-zero",
            ));
        }
        if self.generation == 0 {
            return Err(IngressError::invalid(
                "INGRESS_GENERATION_INVALID",
                "flow capture generation must be non-zero",
            ));
        }
        if self.generation != expected_generation {
            return Err(IngressError::StaleGeneration {
                expected: expected_generation,
                actual: self.generation,
            });
        }
        if self.flow_id == 0 {
            return Err(IngressError::invalid(
                "INGRESS_FLOW_ID_INVALID",
                "flow id must be non-zero",
            ));
        }
        if self.platform == CapturePlatform::Unknown {
            return Err(IngressError::invalid(
                "INGRESS_PLATFORM_INVALID",
                "flow platform must be explicit",
            ));
        }

        validate_socket_pair(self.source, self.destination)?;
        validate_process_identity(self.pid, self.process_start_time)?;
        validate_application_identity(self.platform, self.app_kind, self.app_identity.as_deref())?;
        validate_attribution(&self.attribution)?;
        self.profile_binding.validate()?;
        validate_capture_intent(self)
    }

    /// Return hints safe for policy attribution. The typed original
    /// destination is authoritative even if a provider supplied a stale or
    /// contradictory `destination_ip` string.
    pub fn effective_attribution(&self) -> AttributionHints {
        let mut hints = self.attribution.clone();
        hints.destination_ip = Some(self.destination.ip().to_string());
        hints
    }

    /// Project the validated capture contract into the selector's borrowed
    /// view. Keeping this conversion here prevents runtime/platform-specific
    /// code from accidentally weakening the capture intent.
    pub fn profile_selection_input(&self) -> ProfileSelectionInput<'_> {
        ProfileSelectionInput {
            binding: match &self.profile_binding {
                ProfileBinding::AutoSelect => ProfileSelectionBinding::Attributed,
                ProfileBinding::TrustedQueue { profile_id, .. } => {
                    ProfileSelectionBinding::TrustedQueue { profile_id }
                }
            },
            intent: match &self.capture_intent {
                CaptureIntent::AllowGlobalFallback => ProfileSelectionIntent::AllowGlobalFallback,
                CaptureIntent::RequireApplication => ProfileSelectionIntent::RequireApplication,
                CaptureIntent::RequireRuntimeProcess => {
                    ProfileSelectionIntent::RequireRuntimeProcess
                }
                CaptureIntent::RequireAnySpecific => ProfileSelectionIntent::RequireAnySpecific,
                CaptureIntent::TrustedProfile {
                    profile_id,
                    inherited_child,
                } => ProfileSelectionIntent::TrustedProfile {
                    profile_id,
                    inherited_child: *inherited_child,
                },
            },
            runtime_process: self.pid.zip(self.process_start_time).map(
                |(pid, process_start_time)| RuntimeProcessIdentity {
                    pid,
                    process_start_time,
                },
            ),
            application: self
                .app_kind
                .zip(self.app_identity.as_deref())
                .map(|(kind, value)| ApplicationIdentity { kind, value }),
        }
    }
}

fn validate_socket_pair(source: SocketAddr, destination: SocketAddr) -> Result<(), IngressError> {
    if source.port() == 0 || source.ip().is_unspecified() {
        return Err(IngressError::invalid(
            "INGRESS_SOURCE_INVALID",
            "transport source must have a concrete address and non-zero port",
        ));
    }
    if destination.port() == 0
        || destination.ip().is_unspecified()
        || destination.ip().is_multicast()
    {
        return Err(IngressError::invalid(
            "INGRESS_DESTINATION_INVALID",
            "transport destination must have a concrete unicast address and non-zero port",
        ));
    }
    if matches!(source.ip(), IpAddr::V4(_)) != matches!(destination.ip(), IpAddr::V4(_)) {
        return Err(IngressError::invalid(
            "INGRESS_ADDRESS_FAMILY_MISMATCH",
            "transport source and destination address families must match",
        ));
    }
    Ok(())
}

fn validate_process_identity(
    pid: Option<u32>,
    process_start_time: Option<u64>,
) -> Result<(), IngressError> {
    match (pid, process_start_time) {
        (None, None) => Ok(()),
        (Some(pid), Some(start_time)) if pid != 0 && start_time != 0 => Ok(()),
        _ => Err(IngressError::invalid(
            "INGRESS_PROCESS_IDENTITY_INVALID",
            "PID and process start token must be present together and non-zero",
        )),
    }
}

fn validate_application_identity(
    platform: CapturePlatform,
    kind: Option<AppSelectorKind>,
    identity: Option<&str>,
) -> Result<(), IngressError> {
    match (kind, identity) {
        (None, None) => return Ok(()),
        (Some(_), Some(identity))
            if !identity.trim().is_empty()
                && identity.len() <= MAX_APP_IDENTITY_BYTES
                && !identity.contains('\0') => {}
        _ => {
            return Err(IngressError::invalid(
                "INGRESS_APP_IDENTITY_INVALID",
                "application kind and bounded identity must be present together",
            ));
        }
    }

    match (platform, kind.expect("validated application kind")) {
        (CapturePlatform::Macos, AppSelectorKind::LinuxCgroup)
        | (CapturePlatform::Windows, AppSelectorKind::LinuxCgroup)
        | (CapturePlatform::Windows, AppSelectorKind::MacosSigningIdentity)
        | (CapturePlatform::Linux, AppSelectorKind::MacosSigningIdentity) => {
            Err(IngressError::invalid(
                "INGRESS_APP_KIND_PLATFORM_MISMATCH",
                "application identity kind does not match the capture platform",
            ))
        }
        _ => Ok(()),
    }
}

fn validate_capture_intent(descriptor: &FlowDescriptor) -> Result<(), IngressError> {
    match (&descriptor.capture_intent, &descriptor.profile_binding) {
        (CaptureIntent::AllowGlobalFallback, ProfileBinding::AutoSelect) => Ok(()),
        (CaptureIntent::RequireApplication, ProfileBinding::AutoSelect) => {
            if descriptor.app_kind.is_some() && descriptor.app_identity.is_some() {
                Ok(())
            } else {
                Err(IngressError::invalid(
                    "INGRESS_REQUIRED_APP_EVIDENCE_MISSING",
                    "application-scoped capture requires trusted application identity",
                ))
            }
        }
        (CaptureIntent::RequireRuntimeProcess, ProfileBinding::AutoSelect) => {
            if descriptor.pid.is_some() && descriptor.process_start_time.is_some() {
                Ok(())
            } else {
                Err(IngressError::invalid(
                    "INGRESS_REQUIRED_RUNTIME_EVIDENCE_MISSING",
                    "runtime-scoped capture requires a trusted PID/start-token pair",
                ))
            }
        }
        (CaptureIntent::RequireAnySpecific, ProfileBinding::AutoSelect) => {
            if (descriptor.app_kind.is_some() && descriptor.app_identity.is_some())
                || (descriptor.pid.is_some() && descriptor.process_start_time.is_some())
            {
                Ok(())
            } else {
                Err(IngressError::invalid(
                    "INGRESS_REQUIRED_SPECIFIC_EVIDENCE_MISSING",
                    "specific capture requires trusted application or runtime identity",
                ))
            }
        }
        (
            CaptureIntent::TrustedProfile {
                profile_id: intended_profile,
                ..
            },
            ProfileBinding::TrustedQueue {
                profile_id: bound_profile,
                ..
            },
        ) if safe_profile_id(intended_profile) && intended_profile == bound_profile => Ok(()),
        (CaptureIntent::TrustedProfile { profile_id, .. }, ProfileBinding::TrustedQueue { .. })
            if !safe_profile_id(profile_id) =>
        {
            Err(IngressError::invalid(
                "INGRESS_CAPTURE_INTENT_PROFILE_INVALID",
                "trusted capture intent profile id is invalid",
            ))
        }
        _ => Err(IngressError::invalid(
            "INGRESS_CAPTURE_INTENT_BINDING_MISMATCH",
            "capture intent and profile binding are inconsistent",
        )),
    }
}

fn safe_profile_id(profile_id: &str) -> bool {
    !profile_id.is_empty()
        && profile_id.len() <= MAX_PROFILE_ID_BYTES
        && !profile_id.contains('\0')
        && profile_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_attribution(hints: &AttributionHints) -> Result<(), IngressError> {
    for candidate in [
        hints.platform_hostname.as_deref(),
        hints.fake_ip_hostname.as_deref(),
        hints.tls_sni.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if candidate.is_empty()
            || candidate.len() > MAX_HOSTNAME_BYTES
            || candidate.contains('\0')
            || normalize_hostname(candidate).is_none()
        {
            return Err(IngressError::invalid(
                "INGRESS_HOSTNAME_INVALID",
                "hostname attribution hints must be bounded and syntactically valid",
            ));
        }
    }

    if let Some(host) = hints.http_host.as_deref()
        && !valid_http_host_hint(host)
    {
        return Err(IngressError::invalid(
            "INGRESS_HOSTNAME_INVALID",
            "HTTP Host attribution hint is invalid",
        ));
    }
    if let Some(destination_ip) = hints.destination_ip.as_deref()
        && (destination_ip.is_empty()
            || destination_ip.len() > 64
            || destination_ip.contains('\0')
            || destination_ip.parse::<IpAddr>().is_err())
    {
        return Err(IngressError::invalid(
            "INGRESS_ATTRIBUTION_IP_INVALID",
            "attribution destination IP hint is invalid",
        ));
    }
    Ok(())
}

fn valid_http_host_hint(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed != value {
        return false;
    }
    let value = trimmed;
    if value.is_empty()
        || value.len() > MAX_HOSTNAME_BYTES + 8
        || value.contains('\0')
        || value.bytes().any(|byte| byte.is_ascii_whitespace())
        || value.contains(['/', '\\', '@', '#', '?'])
    {
        return false;
    }
    if let Some(rest) = value.strip_prefix('[') {
        let Some((literal, suffix)) = rest.split_once(']') else {
            return false;
        };
        return literal.parse::<IpAddr>().is_ok_and(|ip| ip.is_ipv6())
            && (suffix.is_empty() || valid_port_suffix(suffix));
    }
    if value.parse::<IpAddr>().is_ok() {
        return true;
    }
    let host = match value.rsplit_once(':') {
        Some((host, port)) if port.parse::<u16>().is_ok_and(|port| port != 0) => host,
        Some(_) if value.contains(':') => return false,
        _ => value,
    };
    normalize_hostname(host).is_some()
}

fn valid_port_suffix(value: &str) -> bool {
    value
        .strip_prefix(':')
        .is_some_and(|port| port.parse::<u16>().is_ok_and(|port| port != 0))
}

/// One UDP payload with its datagram boundary preserved.
///
/// The payload is intentionally private so every producer must pass the same
/// non-jumbogram size check. Empty UDP datagrams are valid and are not used as
/// an end-of-stream sentinel; [`IngressUdpIo::receive`] uses `None` for that.
#[derive(Clone, PartialEq, Eq)]
pub struct UdpDatagram {
    payload: Vec<u8>,
}

impl UdpDatagram {
    pub fn new(payload: Vec<u8>) -> Result<Self, IngressError> {
        if payload.len() > MAX_UDP_DATAGRAM_BYTES {
            return Err(IngressError::OversizedDatagram {
                actual_bytes: payload.len(),
                max_bytes: MAX_UDP_DATAGRAM_BYTES,
            });
        }
        // Discard attacker-controlled spare capacity as well as bounding the
        // visible length. Otherwise a zero-length datagram backed by a huge
        // allocation could bypass queue byte accounting.
        let payload = payload.into_boxed_slice().into_vec();
        Ok(Self { payload })
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.payload
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.payload
    }

    pub fn len(&self) -> usize {
        self.payload.len()
    }

    pub fn is_empty(&self) -> bool {
        self.payload.is_empty()
    }
}

impl fmt::Debug for UdpDatagram {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UdpDatagram")
            .field("payload", &"redacted")
            .field("len", &self.payload.len())
            .finish()
    }
}

/// Why the shared runtime is terminating the intercepted side. Adapters map
/// `Finished` to FIN and all other dispositions to their fail-closed reset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TcpCloseDisposition {
    Finished,
    PolicyBlocked,
    Overloaded,
    StaleGeneration,
    InvalidDescriptor,
    DuplicateFlow,
    NoProfile,
    Cancelled,
    RuntimeFailure,
}

/// Why the shared runtime is retiring one intercepted UDP association.
///
/// UDP has no FIN/RST handshake. The adapter uses this disposition to expire
/// tuple state, discard queued datagrams, and record a stable terminal reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UdpCloseDisposition {
    Finished,
    IdleTimeout,
    PolicyBlocked,
    Overloaded,
    StaleGeneration,
    InvalidDescriptor,
    DuplicateFlow,
    NoProfile,
    Cancelled,
    RuntimeFailure,
}

/// Completion hook owned by the capture/IP-stack adapter.
///
/// `close` must be cancellation-safe, idempotent, and retryable. Dropping its
/// future must not leave detached work running: the close is either not
/// committed or has completed one atomic terminal transition. Calling it again
/// after cancellation, timeout, error, or panic must safely resume or confirm
/// that transition without duplicating externally visible effects.
#[async_trait]
pub trait IngressTcpControl: Send + Sync {
    async fn close(&self, disposition: TcpCloseDisposition) -> Result<(), IngressError>;
}

/// Object-safe bidirectional stream accepted by the shared runtime.
pub trait AsyncIngressStream: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T> AsyncIngressStream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

pub type BoxedIngressStream = Box<dyn AsyncIngressStream>;

/// One decoded TCP flow and the adapter hook needed to close it explicitly.
pub struct IngressTcpFlow {
    pub descriptor: FlowDescriptor,
    pub stream: BoxedIngressStream,
    pub control: Arc<dyn IngressTcpControl>,
}

/// Datagram-preserving I/O owned by the capture/IP-stack adapter.
///
/// `receive` yields exactly one intercepted payload per `Some` value. Empty
/// payloads are valid; `None` exclusively means orderly producer shutdown.
/// `send` writes exactly one reply payload back to the intercepted side. A
/// provider must not merge or split values across either operation.
///
/// Both operations must be cancellation-safe and must not detach background
/// work. Dropping `receive` before completion must not consume a datagram;
/// dropping `send` before completion must leave the datagram uncommitted (or
/// have completed its one atomic enqueue). A completed call transfers exactly
/// one datagram and a cancelled call must never later deliver it.
#[async_trait]
pub trait IngressUdpIo: Send + Sync {
    async fn receive(&self) -> Result<Option<UdpDatagram>, IngressError>;

    async fn send(&self, datagram: UdpDatagram) -> Result<(), IngressError>;
}

/// Completion hook owned by the capture/IP-stack adapter for one UDP tuple.
///
/// `close` has the same cancellation-safe, no-detached, idempotent, retryable
/// contract as [`IngressTcpControl::close`]. A retry after an inconclusive
/// attempt must expire or confirm the same tuple transition, never a newer
/// association that reused its addresses.
#[async_trait]
pub trait IngressUdpControl: Send + Sync {
    async fn close(&self, disposition: UdpCloseDisposition) -> Result<(), IngressError>;
}

/// One decoded UDP association and its adapter-owned datagram/control hooks.
pub struct IngressUdpAssociation {
    pub descriptor: FlowDescriptor,
    pub io: Arc<dyn IngressUdpIo>,
    pub control: Arc<dyn IngressUdpControl>,
}

impl fmt::Debug for IngressUdpAssociation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IngressUdpAssociation")
            .field("descriptor", &"redacted flow descriptor")
            .field("io", &"datagram I/O")
            .field("control", &"UDP close control")
            .finish()
    }
}

impl fmt::Debug for IngressTcpFlow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IngressTcpFlow")
            .field("descriptor", &"redacted flow descriptor")
            .field("stream", &"bidirectional stream")
            .field("control", &"TCP close control")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IngressError {
    #[error("{code}: {message}")]
    InvalidDescriptor {
        code: &'static str,
        message: &'static str,
    },
    #[error("INGRESS_STALE_GENERATION: expected generation {expected}, got {actual}")]
    StaleGeneration { expected: u64, actual: u64 },
    #[error("INGRESS_QUEUE_CAPACITY_INVALID: ingress queue capacity is outside its limit")]
    InvalidCapacity,
    #[error(
        "INGRESS_UDP_DATAGRAM_OVERSIZED: UDP datagram has {actual_bytes} bytes; maximum is {max_bytes}"
    )]
    OversizedDatagram {
        actual_bytes: usize,
        max_bytes: usize,
    },
    #[error("INGRESS_UDP_QUEUE_CAPACITY_INVALID: UDP ingress queue capacity is outside its limit")]
    InvalidUdpCapacity,
    #[error("INGRESS_QUEUE_FULL: ingress queue is full")]
    QueueFull,
    #[error("INGRESS_CLOSED: ingress queue is closed")]
    Closed,
    #[error("INGRESS_CONTROL_FAILED: {code}")]
    Control { code: String },
}

impl IngressError {
    fn invalid(code: &'static str, message: &'static str) -> Self {
        Self::InvalidDescriptor { code, message }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidDescriptor { code, .. } => code,
            Self::StaleGeneration { .. } => "INGRESS_STALE_GENERATION",
            Self::InvalidCapacity => "INGRESS_QUEUE_CAPACITY_INVALID",
            Self::OversizedDatagram { .. } => "INGRESS_UDP_DATAGRAM_OVERSIZED",
            Self::InvalidUdpCapacity => "INGRESS_UDP_QUEUE_CAPACITY_INVALID",
            Self::QueueFull => "INGRESS_QUEUE_FULL",
            Self::Closed => "INGRESS_CLOSED",
            Self::Control { .. } => "INGRESS_CONTROL_FAILED",
        }
    }
}

/// A source of decoded TCP flows. Implementations must be bounded internally.
#[async_trait]
pub trait FlowIngress: Send + Sync {
    /// Exact, immutable maximum number of TCP flows that can remain queued
    /// behind this ingress. It excludes a flow already returned by
    /// [`Self::accept_tcp`].
    ///
    /// Implementations must return a value in
    /// `1..=`[`MAX_INGRESS_QUEUE_CAPACITY`]. The runtime uses this value as a hard
    /// upper bound when it drains objects retained by the admission fence; an
    /// implementation must not merely estimate or advertise a lower bound
    /// than its real buffering.
    fn max_buffered_tcp(&self) -> usize;

    /// Permanently close TCP admission for this ingress instance.
    ///
    /// After this method returns `Ok(())`, no producer operation may
    /// successfully enqueue a new flow. Flows queued before the fence remain
    /// owned by the ingress and [`Self::accept_tcp`] returns them in their
    /// original order before returning `Ok(None)`.
    ///
    /// The operation must be idempotent, cancellation-safe, and must not
    /// detach work. If its future is dropped, the fence is either not
    /// committed or remains permanently committed; retrying must complete or
    /// confirm the same fence.
    async fn close_tcp_admission(&self) -> Result<(), IngressError>;

    /// `Ok(None)` is an orderly producer shutdown, distinct from an ingress
    /// failure and suitable for a clean runtime drain.
    ///
    /// This operation must be cancellation-safe: dropping its future before it
    /// returns must not consume, lose, or partially transfer a flow. This lets
    /// the runtime race admission against shutdown without leaking an
    /// intercepted connection. [`BoundedFlowIngress`] satisfies the contract
    /// because Tokio's bounded `Receiver::recv` is cancellation-safe and the
    /// receiver remains owned behind the mutex.
    async fn accept_tcp(&self) -> Result<Option<IngressTcpFlow>, IngressError>;
}

/// Sending error that preserves the rejected flow so the adapter can close it.
#[derive(Debug)]
pub struct IngressTrySendError {
    pub error: IngressError,
    pub flow: IngressTcpFlow,
}

#[derive(Debug, Clone)]
pub struct BoundedFlowIngressSender {
    sender: mpsc::Sender<IngressTcpFlow>,
    admission: Arc<AdmissionFence>,
}

impl BoundedFlowIngressSender {
    /// Never waits and never allocates an overflow queue. On failure, ownership
    /// of the flow is returned so the producer can issue `Overloaded`
    /// explicitly.
    pub fn try_send(&self, flow: IngressTcpFlow) -> Result<(), IngressTrySendError> {
        if self.admission.is_closed() {
            return Err(IngressTrySendError {
                error: IngressError::Closed,
                flow,
            });
        }
        self.sender.try_send(flow).map_err(|error| match error {
            mpsc::error::TrySendError::Full(flow) => IngressTrySendError {
                error: IngressError::QueueFull,
                flow,
            },
            mpsc::error::TrySendError::Closed(flow) => IngressTrySendError {
                error: IngressError::Closed,
                flow,
            },
        })
    }

    pub fn is_closed(&self) -> bool {
        self.admission.is_closed() || self.sender.is_closed()
    }
}

#[derive(Debug)]
struct AdmissionFence {
    closed: AtomicBool,
    close_requested: Notify,
}

impl AdmissionFence {
    fn new() -> Self {
        Self {
            closed: AtomicBool::new(false),
            close_requested: Notify::new(),
        }
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Commit the irreversible producer-side fence and wake an acceptor that
    /// may currently own the receiver while waiting on an empty queue.
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.close_requested.notify_one();
    }
}

#[derive(Debug)]
pub struct BoundedFlowIngress {
    receiver: Mutex<mpsc::Receiver<IngressTcpFlow>>,
    admission: Arc<AdmissionFence>,
    capacity: usize,
}

/// Create a bounded adapter/runtime handoff. Zero and unreasonable capacities
/// are rejected instead of reaching Tokio's panic path or reserving unchecked
/// memory.
pub fn bounded_flow_ingress(
    capacity: usize,
) -> Result<(BoundedFlowIngressSender, BoundedFlowIngress), IngressError> {
    if capacity == 0 || capacity > MAX_INGRESS_QUEUE_CAPACITY {
        return Err(IngressError::InvalidCapacity);
    }
    let (sender, receiver) = mpsc::channel(capacity);
    let admission = Arc::new(AdmissionFence::new());
    Ok((
        BoundedFlowIngressSender {
            sender,
            admission: Arc::clone(&admission),
        },
        BoundedFlowIngress {
            receiver: Mutex::new(receiver),
            admission,
            capacity,
        },
    ))
}

#[async_trait]
impl FlowIngress for BoundedFlowIngress {
    fn max_buffered_tcp(&self) -> usize {
        self.capacity
    }

    async fn close_tcp_admission(&self) -> Result<(), IngressError> {
        // Commit before the first await. If this future is then cancelled,
        // wrapper senders still fail closed and a later accept/retry completes
        // the receiver-side close without needing detached cleanup.
        self.admission.close();
        self.receiver.lock().await.close();
        Ok(())
    }

    async fn accept_tcp(&self) -> Result<Option<IngressTcpFlow>, IngressError> {
        let mut receiver = self.receiver.lock().await;
        loop {
            if self.admission.is_closed() {
                receiver.close();
                return Ok(receiver.recv().await);
            }

            tokio::select! {
                flow = receiver.recv() => return Ok(flow),
                _ = self.admission.close_requested.notified() => {
                    // Only `AdmissionFence::close` emits this notification.
                    // Re-checking the durable flag also makes a stored or
                    // coalesced notification harmless.
                    if self.admission.is_closed() {
                        receiver.close();
                        return Ok(receiver.recv().await);
                    }
                }
            }
        }
    }
}

/// A source of decoded UDP associations. Implementations must be bounded
/// independently from TCP flow admission.
#[async_trait]
pub trait UdpFlowIngress: Send + Sync {
    /// Exact, immutable maximum number of UDP associations that can remain
    /// queued behind this ingress, excluding an association already returned
    /// by [`Self::accept_udp`].
    ///
    /// Implementations must return a value in
    /// `1..=`[`MAX_UDP_INGRESS_QUEUE_CAPACITY`]; the runtime treats it as the hard
    /// upper bound for admission-fence draining.
    fn max_buffered_udp(&self) -> usize;

    /// Permanently close UDP association admission.
    ///
    /// The ordering, retained-queue, idempotency, cancellation-safety, and
    /// no-detached-work requirements are identical to
    /// [`FlowIngress::close_tcp_admission`]. A successful fence is followed by
    /// the previously queued associations in order and then `Ok(None)` from
    /// [`Self::accept_udp`].
    async fn close_udp_admission(&self) -> Result<(), IngressError>;

    /// `Ok(None)` is an orderly producer shutdown, distinct from a failure.
    ///
    /// This operation must be cancellation-safe: dropping its future before it
    /// returns must not consume, lose, or partially transfer an association.
    async fn accept_udp(&self) -> Result<Option<IngressUdpAssociation>, IngressError>;
}

/// Sending error that preserves the rejected association so the adapter can
/// close it explicitly without leaking tuple state.
#[derive(Debug)]
pub struct UdpIngressTrySendError {
    pub error: IngressError,
    pub association: IngressUdpAssociation,
}

#[derive(Debug, Clone)]
pub struct BoundedUdpFlowIngressSender {
    sender: mpsc::Sender<IngressUdpAssociation>,
    admission: Arc<AdmissionFence>,
}

impl BoundedUdpFlowIngressSender {
    /// Never waits and never allocates an overflow queue. On failure, ownership
    /// of the association is returned to the producer.
    pub fn try_send(
        &self,
        association: IngressUdpAssociation,
    ) -> Result<(), UdpIngressTrySendError> {
        if self.admission.is_closed() {
            return Err(UdpIngressTrySendError {
                error: IngressError::Closed,
                association,
            });
        }
        self.sender
            .try_send(association)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(association) => UdpIngressTrySendError {
                    error: IngressError::QueueFull,
                    association,
                },
                mpsc::error::TrySendError::Closed(association) => UdpIngressTrySendError {
                    error: IngressError::Closed,
                    association,
                },
            })
    }

    pub fn is_closed(&self) -> bool {
        self.admission.is_closed() || self.sender.is_closed()
    }
}

#[derive(Debug)]
pub struct BoundedUdpFlowIngress {
    receiver: Mutex<mpsc::Receiver<IngressUdpAssociation>>,
    admission: Arc<AdmissionFence>,
    capacity: usize,
}

/// Create the independently bounded UDP association handoff.
pub fn bounded_udp_flow_ingress(
    capacity: usize,
) -> Result<(BoundedUdpFlowIngressSender, BoundedUdpFlowIngress), IngressError> {
    if capacity == 0 || capacity > MAX_UDP_INGRESS_QUEUE_CAPACITY {
        return Err(IngressError::InvalidUdpCapacity);
    }
    let (sender, receiver) = mpsc::channel(capacity);
    let admission = Arc::new(AdmissionFence::new());
    Ok((
        BoundedUdpFlowIngressSender {
            sender,
            admission: Arc::clone(&admission),
        },
        BoundedUdpFlowIngress {
            receiver: Mutex::new(receiver),
            admission,
            capacity,
        },
    ))
}

#[async_trait]
impl UdpFlowIngress for BoundedUdpFlowIngress {
    fn max_buffered_udp(&self) -> usize {
        self.capacity
    }

    async fn close_udp_admission(&self) -> Result<(), IngressError> {
        self.admission.close();
        self.receiver.lock().await.close();
        Ok(())
    }

    async fn accept_udp(&self) -> Result<Option<IngressUdpAssociation>, IngressError> {
        let mut receiver = self.receiver.lock().await;
        loop {
            if self.admission.is_closed() {
                receiver.close();
                return Ok(receiver.recv().await);
            }

            tokio::select! {
                association = receiver.recv() => return Ok(association),
                _ = self.admission.close_requested.notified() => {
                    if self.admission.is_closed() {
                        receiver.close();
                        return Ok(receiver.recv().await);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::*;

    #[derive(Debug, Default)]
    struct NoopControl;

    #[async_trait]
    impl IngressTcpControl for NoopControl {
        async fn close(&self, _disposition: TcpCloseDisposition) -> Result<(), IngressError> {
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct NoopUdpIo;

    #[async_trait]
    impl IngressUdpIo for NoopUdpIo {
        async fn receive(&self) -> Result<Option<UdpDatagram>, IngressError> {
            Ok(None)
        }

        async fn send(&self, _datagram: UdpDatagram) -> Result<(), IngressError> {
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct NoopUdpControl;

    #[async_trait]
    impl IngressUdpControl for NoopUdpControl {
        async fn close(&self, _disposition: UdpCloseDisposition) -> Result<(), IngressError> {
            Ok(())
        }
    }

    #[derive(Debug)]
    struct ChannelUdpIo {
        incoming: Mutex<mpsc::Receiver<UdpDatagram>>,
        outgoing: mpsc::Sender<UdpDatagram>,
    }

    #[async_trait]
    impl IngressUdpIo for ChannelUdpIo {
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

    fn descriptor(source: SocketAddr, destination: SocketAddr) -> FlowDescriptor {
        FlowDescriptor {
            generation: 7,
            flow_id: 11,
            platform: CapturePlatform::Linux,
            transport: FlowTransport::Tcp,
            source,
            destination,
            attribution: AttributionHints {
                tls_sni: Some("api.example.com".into()),
                destination_ip: Some("198.51.100.99".into()),
                ..AttributionHints::default()
            },
            pid: Some(1234),
            process_start_time: Some(9988),
            app_kind: Some(AppSelectorKind::ExecutablePath),
            app_identity: Some("/usr/bin/curl".into()),
            capture_intent: CaptureIntent::RequireAnySpecific,
            profile_binding: ProfileBinding::AutoSelect,
        }
    }

    fn flow(flow_id: u64) -> IngressTcpFlow {
        let (stream, _peer) = tokio::io::duplex(64);
        let mut descriptor = descriptor(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
        );
        descriptor.flow_id = flow_id;
        IngressTcpFlow {
            descriptor,
            stream: Box::new(stream),
            control: Arc::new(NoopControl),
        }
    }

    fn udp_association(flow_id: u64) -> IngressUdpAssociation {
        let mut descriptor = descriptor(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 53), 53)),
        );
        descriptor.flow_id = flow_id;
        descriptor.transport = FlowTransport::Udp;
        IngressUdpAssociation {
            descriptor,
            io: Arc::new(NoopUdpIo),
            control: Arc::new(NoopUdpControl),
        }
    }

    #[test]
    fn rejects_stale_generation() {
        let error = descriptor(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
        )
        .validate_for(8)
        .expect_err("old generation must fail closed");
        assert_eq!(error.code(), "INGRESS_STALE_GENERATION");
    }

    #[test]
    fn rejects_incomplete_identity_pairs() {
        let mut descriptor = descriptor(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
        );
        descriptor.process_start_time = None;
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_PROCESS_IDENTITY_INVALID"
        );

        descriptor.process_start_time = Some(9988);
        descriptor.app_kind = None;
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_APP_IDENTITY_INVALID"
        );

        descriptor.app_kind = Some(AppSelectorKind::ExecutablePath);
        descriptor.app_identity = Some("   ".into());
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_APP_IDENTITY_INVALID"
        );

        descriptor.app_identity = Some("/usr/bin/curl".into());
        descriptor.attribution.tls_sni = Some("bad\0host".into());
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_HOSTNAME_INVALID"
        );
    }

    #[tokio::test]
    async fn bounded_ingress_returns_full_flow_to_producer() {
        let (sender, ingress) = bounded_flow_ingress(1).expect("bounded ingress");
        sender.try_send(flow(1)).expect("first slot");
        let rejected = sender.try_send(flow(2)).expect_err("queue must be full");
        assert_eq!(rejected.error, IngressError::QueueFull);
        assert_eq!(rejected.flow.descriptor.flow_id, 2);

        let accepted = ingress
            .accept_tcp()
            .await
            .expect("ingress read")
            .expect("queued flow");
        assert_eq!(accepted.descriptor.flow_id, 1);
    }

    #[tokio::test]
    async fn bounded_ingress_reports_clean_end_of_stream() {
        let (sender, ingress) = bounded_flow_ingress(1).expect("bounded ingress");
        drop(sender);
        assert!(
            ingress
                .accept_tcp()
                .await
                .expect("clean ingress EOF")
                .is_none()
        );
    }

    #[tokio::test]
    async fn bounded_accept_is_cancellation_safe() {
        let (sender, ingress) = bounded_flow_ingress(1).expect("bounded ingress");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(1), ingress.accept_tcp())
                .await
                .is_err(),
            "empty accept should be cancelled by timeout"
        );

        sender.try_send(flow(9)).expect("flow after cancellation");
        let accepted = ingress
            .accept_tcp()
            .await
            .expect("ingress read")
            .expect("flow must not be lost");
        assert_eq!(accepted.descriptor.flow_id, 9);
    }

    #[tokio::test]
    async fn tcp_admission_fence_retains_order_and_rejects_new_flows() {
        let (sender, ingress) = bounded_flow_ingress(3).expect("bounded ingress");
        assert_eq!(ingress.max_buffered_tcp(), 3);
        sender.try_send(flow(1)).expect("first queued flow");
        sender.try_send(flow(2)).expect("second queued flow");

        ingress
            .close_tcp_admission()
            .await
            .expect("close TCP admission");
        ingress
            .close_tcp_admission()
            .await
            .expect("repeated TCP admission close is idempotent");
        assert!(sender.is_closed());

        let rejected = sender
            .try_send(flow(3))
            .expect_err("post-fence flow must be returned");
        assert_eq!(rejected.error, IngressError::Closed);
        assert_eq!(rejected.flow.descriptor.flow_id, 3);

        let first = ingress
            .accept_tcp()
            .await
            .expect("first drain")
            .expect("first retained flow");
        let second = ingress
            .accept_tcp()
            .await
            .expect("second drain")
            .expect("second retained flow");
        assert_eq!(first.descriptor.flow_id, 1);
        assert_eq!(second.descriptor.flow_id, 2);
        assert!(
            ingress
                .accept_tcp()
                .await
                .expect("fenced TCP ingress EOF")
                .is_none()
        );
    }

    #[tokio::test]
    async fn cancelled_tcp_admission_close_keeps_committed_fence() {
        let (sender, ingress) = bounded_flow_ingress(2).expect("bounded ingress");
        sender.try_send(flow(1)).expect("pre-fence flow");

        // Holding the receiver proves the close future reaches its first await.
        // Dropping that pending future must not roll back the producer fence.
        let receiver_guard = ingress.receiver.lock().await;
        let mut close = Box::pin(ingress.close_tcp_admission());
        assert!(matches!(
            futures::poll!(close.as_mut()),
            std::task::Poll::Pending
        ));
        drop(close);

        let rejected = sender
            .try_send(flow(2))
            .expect_err("cancelled close left a committed fence");
        assert_eq!(rejected.error, IngressError::Closed);
        assert_eq!(rejected.flow.descriptor.flow_id, 2);
        drop(receiver_guard);

        assert_eq!(
            ingress
                .accept_tcp()
                .await
                .expect("drain after cancelled close")
                .expect("retained pre-fence flow")
                .descriptor
                .flow_id,
            1
        );
        assert!(
            ingress
                .accept_tcp()
                .await
                .expect("EOF after cancelled close")
                .is_none()
        );
        ingress
            .close_tcp_admission()
            .await
            .expect("retry confirms committed TCP fence");
    }

    #[tokio::test]
    async fn tcp_admission_close_wakes_a_pending_accept() {
        let (_sender, ingress) = bounded_flow_ingress(1).expect("bounded ingress");
        let ingress = Arc::new(ingress);
        let accept_task = {
            let ingress = Arc::clone(&ingress);
            tokio::spawn(async move { ingress.accept_tcp().await })
        };
        tokio::task::yield_now().await;

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            ingress.close_tcp_admission(),
        )
        .await
        .expect("close must not deadlock behind pending accept")
        .expect("close TCP admission");
        assert!(
            accept_task
                .await
                .expect("accept task")
                .expect("clean close")
                .is_none()
        );
    }

    #[test]
    fn tcp_ingress_capacity_is_validated_and_frozen() {
        assert_eq!(
            bounded_flow_ingress(0).unwrap_err(),
            IngressError::InvalidCapacity
        );
        assert_eq!(
            bounded_flow_ingress(MAX_INGRESS_QUEUE_CAPACITY + 1).unwrap_err(),
            IngressError::InvalidCapacity
        );
        let (_, ingress) = bounded_flow_ingress(MAX_INGRESS_QUEUE_CAPACITY)
            .expect("maximum bounded TCP flow queue");
        assert_eq!(ingress.max_buffered_tcp(), MAX_INGRESS_QUEUE_CAPACITY);
    }

    #[test]
    fn udp_datagram_accepts_empty_and_non_jumbo_maximum() {
        let empty = UdpDatagram::new(Vec::new()).expect("empty UDP datagram");
        assert!(empty.is_empty());
        assert_eq!(empty.len(), 0);
        assert_eq!(empty.as_slice(), &[] as &[u8]);
        assert!(empty.into_bytes().is_empty());

        let spare_capacity = Vec::with_capacity(1_024);
        let normalized = UdpDatagram::new(spare_capacity)
            .expect("empty UDP datagram with excess backing capacity")
            .into_bytes();
        assert_eq!(normalized.capacity(), 0);

        let payload = vec![0xa5; MAX_UDP_DATAGRAM_BYTES];
        let maximum = UdpDatagram::new(payload.clone()).expect("maximum UDP datagram");
        assert!(!maximum.is_empty());
        assert_eq!(maximum.len(), MAX_UDP_DATAGRAM_BYTES);
        assert_eq!(maximum.as_slice(), payload.as_slice());
        assert_eq!(maximum.into_bytes(), payload);
    }

    #[test]
    fn udp_datagram_rejects_payload_above_non_jumbo_limit() {
        let error = UdpDatagram::new(vec![0; MAX_UDP_DATAGRAM_BYTES + 1])
            .expect_err("oversized UDP datagram must fail closed");
        assert_eq!(error.code(), "INGRESS_UDP_DATAGRAM_OVERSIZED");
        assert_eq!(
            error,
            IngressError::OversizedDatagram {
                actual_bytes: MAX_UDP_DATAGRAM_BYTES + 1,
                max_bytes: MAX_UDP_DATAGRAM_BYTES,
            }
        );
    }

    #[tokio::test]
    async fn udp_io_preserves_empty_and_non_empty_datagram_boundaries() {
        let (incoming_sender, incoming_receiver) = mpsc::channel(2);
        let (outgoing_sender, mut outgoing_receiver) = mpsc::channel(2);
        let io = ChannelUdpIo {
            incoming: Mutex::new(incoming_receiver),
            outgoing: outgoing_sender,
        };

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(1), io.receive())
                .await
                .is_err(),
            "an empty receive must remain cancellation-safe"
        );

        incoming_sender
            .try_send(UdpDatagram::new(vec![1, 2]).expect("first datagram"))
            .expect("first incoming slot");
        incoming_sender
            .try_send(UdpDatagram::new(vec![3]).expect("second datagram"))
            .expect("second incoming slot");
        assert_eq!(
            io.receive()
                .await
                .expect("first receive")
                .expect("first payload")
                .as_slice(),
            &[1, 2]
        );
        assert_eq!(
            io.receive()
                .await
                .expect("second receive")
                .expect("second payload")
                .as_slice(),
            &[3]
        );

        io.send(UdpDatagram::new(Vec::new()).expect("empty reply"))
            .await
            .expect("send empty reply");
        io.send(UdpDatagram::new(vec![4, 5, 6]).expect("non-empty reply"))
            .await
            .expect("send non-empty reply");
        assert!(
            outgoing_receiver
                .recv()
                .await
                .expect("empty reply boundary")
                .is_empty()
        );
        assert_eq!(
            outgoing_receiver
                .recv()
                .await
                .expect("non-empty reply boundary")
                .as_slice(),
            &[4, 5, 6]
        );

        drop(incoming_sender);
        assert!(io.receive().await.expect("clean UDP I/O EOF").is_none());
    }

    #[tokio::test]
    async fn bounded_udp_ingress_returns_full_association_to_producer() {
        let (sender, ingress) = bounded_udp_flow_ingress(1).expect("bounded UDP ingress");
        sender
            .try_send(udp_association(1))
            .expect("first UDP association slot");
        let rejected = sender
            .try_send(udp_association(2))
            .expect_err("UDP association queue must be full");
        assert_eq!(rejected.error, IngressError::QueueFull);
        assert_eq!(rejected.association.descriptor.flow_id, 2);

        let accepted = ingress
            .accept_udp()
            .await
            .expect("UDP ingress read")
            .expect("queued UDP association");
        assert_eq!(accepted.descriptor.flow_id, 1);
        assert_eq!(accepted.descriptor.transport, FlowTransport::Udp);
    }

    #[tokio::test]
    async fn bounded_udp_ingress_reports_clean_end_of_stream() {
        let (sender, ingress) = bounded_udp_flow_ingress(1).expect("bounded UDP ingress");
        drop(sender);
        assert!(
            ingress
                .accept_udp()
                .await
                .expect("clean UDP ingress EOF")
                .is_none()
        );
    }

    #[tokio::test]
    async fn bounded_udp_accept_is_cancellation_safe() {
        let (sender, ingress) = bounded_udp_flow_ingress(1).expect("bounded UDP ingress");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(1), ingress.accept_udp())
                .await
                .is_err(),
            "empty UDP accept should be cancelled by timeout"
        );

        sender
            .try_send(udp_association(9))
            .expect("UDP association after cancellation");
        let accepted = ingress
            .accept_udp()
            .await
            .expect("UDP ingress read")
            .expect("UDP association must not be lost");
        assert_eq!(accepted.descriptor.flow_id, 9);
    }

    #[tokio::test]
    async fn udp_admission_fence_retains_order_and_rejects_new_associations() {
        let (sender, ingress) = bounded_udp_flow_ingress(3).expect("bounded UDP ingress");
        assert_eq!(ingress.max_buffered_udp(), 3);
        sender
            .try_send(udp_association(1))
            .expect("first queued association");
        sender
            .try_send(udp_association(2))
            .expect("second queued association");

        ingress
            .close_udp_admission()
            .await
            .expect("close UDP admission");
        ingress
            .close_udp_admission()
            .await
            .expect("repeated UDP admission close is idempotent");
        assert!(sender.is_closed());

        let rejected = sender
            .try_send(udp_association(3))
            .expect_err("post-fence association must be returned");
        assert_eq!(rejected.error, IngressError::Closed);
        assert_eq!(rejected.association.descriptor.flow_id, 3);

        let first = ingress
            .accept_udp()
            .await
            .expect("first UDP drain")
            .expect("first retained association");
        let second = ingress
            .accept_udp()
            .await
            .expect("second UDP drain")
            .expect("second retained association");
        assert_eq!(first.descriptor.flow_id, 1);
        assert_eq!(second.descriptor.flow_id, 2);
        assert!(
            ingress
                .accept_udp()
                .await
                .expect("fenced UDP ingress EOF")
                .is_none()
        );
    }

    #[tokio::test]
    async fn cancelled_udp_admission_close_keeps_committed_fence() {
        let (sender, ingress) = bounded_udp_flow_ingress(2).expect("bounded UDP ingress");
        sender
            .try_send(udp_association(1))
            .expect("pre-fence association");

        let receiver_guard = ingress.receiver.lock().await;
        let mut close = Box::pin(ingress.close_udp_admission());
        assert!(matches!(
            futures::poll!(close.as_mut()),
            std::task::Poll::Pending
        ));
        drop(close);

        let rejected = sender
            .try_send(udp_association(2))
            .expect_err("cancelled close left a committed UDP fence");
        assert_eq!(rejected.error, IngressError::Closed);
        assert_eq!(rejected.association.descriptor.flow_id, 2);
        drop(receiver_guard);

        assert_eq!(
            ingress
                .accept_udp()
                .await
                .expect("UDP drain after cancelled close")
                .expect("retained pre-fence association")
                .descriptor
                .flow_id,
            1
        );
        assert!(
            ingress
                .accept_udp()
                .await
                .expect("UDP EOF after cancelled close")
                .is_none()
        );
        ingress
            .close_udp_admission()
            .await
            .expect("retry confirms committed UDP fence");
    }

    #[tokio::test]
    async fn udp_admission_close_wakes_a_pending_accept() {
        let (_sender, ingress) = bounded_udp_flow_ingress(1).expect("bounded UDP ingress");
        let ingress = Arc::new(ingress);
        let accept_task = {
            let ingress = Arc::clone(&ingress);
            tokio::spawn(async move { ingress.accept_udp().await })
        };
        tokio::task::yield_now().await;

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            ingress.close_udp_admission(),
        )
        .await
        .expect("UDP close must not deadlock behind pending accept")
        .expect("close UDP admission");
        assert!(
            accept_task
                .await
                .expect("UDP accept task")
                .expect("clean UDP close")
                .is_none()
        );
    }

    #[test]
    fn udp_ingress_capacity_is_validated_independently() {
        assert_eq!(
            bounded_udp_flow_ingress(0).unwrap_err(),
            IngressError::InvalidUdpCapacity
        );
        assert_eq!(
            bounded_udp_flow_ingress(MAX_UDP_INGRESS_QUEUE_CAPACITY + 1).unwrap_err(),
            IngressError::InvalidUdpCapacity
        );
        let (_, ingress) = bounded_udp_flow_ingress(MAX_UDP_INGRESS_QUEUE_CAPACITY)
            .expect("maximum bounded UDP association queue");
        assert_eq!(ingress.max_buffered_udp(), MAX_UDP_INGRESS_QUEUE_CAPACITY);
    }

    #[test]
    fn accepts_valid_ipv4_and_ipv6_descriptors() {
        let ipv4 = descriptor(
            SocketAddr::from((Ipv4Addr::new(192, 0, 2, 4), 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
        );
        ipv4.validate_for(7).expect("valid IPv4 descriptor");
        assert_eq!(
            ipv4.effective_attribution().destination_ip.as_deref(),
            Some("203.0.113.8")
        );

        let ipv6 = descriptor(
            SocketAddr::from((Ipv6Addr::LOCALHOST, 40_000)),
            SocketAddr::from((Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 8), 443)),
        );
        ipv6.validate_for(7).expect("valid IPv6 descriptor");

        fn assert_send<T: Send>() {}
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send::<IngressTcpFlow>();
        assert_send::<IngressUdpAssociation>();
        assert_send_sync::<UdpDatagram>();
        assert_send_sync::<BoundedFlowIngress>();
        assert_send_sync::<BoundedFlowIngressSender>();
        assert_send_sync::<BoundedUdpFlowIngress>();
        assert_send_sync::<BoundedUdpFlowIngressSender>();
    }

    #[test]
    fn descriptor_transport_is_explicit_validated_and_snake_case_serialized() {
        let mut descriptor = descriptor(
            SocketAddr::from((Ipv4Addr::new(192, 0, 2, 4), 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 53)),
        );
        descriptor.transport = FlowTransport::Udp;
        descriptor.validate_for(7).expect("valid UDP descriptor");

        let serialized = serde_json::to_value(&descriptor).expect("serialize descriptor");
        assert_eq!(serialized["transport"], "udp");
        let round_trip: FlowDescriptor =
            serde_json::from_value(serialized).expect("deserialize descriptor");
        assert_eq!(round_trip.transport, FlowTransport::Udp);

        let mut invalid = serde_json::to_value(&descriptor).expect("serialize descriptor");
        invalid["transport"] = serde_json::json!("quic");
        assert!(
            serde_json::from_value::<FlowDescriptor>(invalid).is_err(),
            "unknown transports must fail deserialization"
        );

        descriptor.transport = FlowTransport::Tcp;
        let serialized = serde_json::to_value(&descriptor).expect("serialize TCP descriptor");
        assert_eq!(serialized["transport"], "tcp");
    }

    #[test]
    fn trusted_queue_requires_a_bounded_profile_and_revision() {
        let mut descriptor = descriptor(
            SocketAddr::from((Ipv4Addr::new(192, 0, 2, 4), 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
        );
        descriptor.profile_binding = ProfileBinding::TrustedQueue {
            profile_id: "profile-1".into(),
            config_revision: 0,
        };
        descriptor.capture_intent = CaptureIntent::TrustedProfile {
            profile_id: "profile-1".into(),
            inherited_child: false,
        };
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_PROFILE_REVISION_INVALID"
        );
    }

    #[test]
    fn required_capture_evidence_never_degrades_to_global_intent() {
        let mut descriptor = descriptor(
            SocketAddr::from((Ipv4Addr::new(192, 0, 2, 4), 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
        );
        descriptor.pid = None;
        descriptor.process_start_time = None;
        descriptor.capture_intent = CaptureIntent::RequireRuntimeProcess;
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_REQUIRED_RUNTIME_EVIDENCE_MISSING"
        );

        descriptor.capture_intent = CaptureIntent::RequireAnySpecific;
        descriptor.app_kind = None;
        descriptor.app_identity = None;
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_REQUIRED_SPECIFIC_EVIDENCE_MISSING"
        );

        descriptor.capture_intent = CaptureIntent::AllowGlobalFallback;
        descriptor
            .validate_for(7)
            .expect("global capture explicitly permits missing specific identity");

        descriptor.capture_intent = CaptureIntent::RequireApplication;
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_REQUIRED_APP_EVIDENCE_MISSING"
        );
    }

    #[test]
    fn trusted_queue_requires_the_same_trusted_profile_intent() {
        let mut descriptor = descriptor(
            SocketAddr::from((Ipv4Addr::new(192, 0, 2, 4), 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
        );
        descriptor.capture_intent = CaptureIntent::TrustedProfile {
            profile_id: "profile-a".into(),
            inherited_child: true,
        };
        descriptor.profile_binding = ProfileBinding::TrustedQueue {
            profile_id: "profile-b".into(),
            config_revision: 3,
        };
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_CAPTURE_INTENT_BINDING_MISMATCH"
        );

        descriptor.profile_binding = ProfileBinding::TrustedQueue {
            profile_id: "profile-a".into(),
            config_revision: 3,
        };
        descriptor
            .validate_for(7)
            .expect("matching trusted queue intent");
        let selection_input = descriptor.profile_selection_input();
        assert!(matches!(
            selection_input.binding,
            ProfileSelectionBinding::TrustedQueue {
                profile_id: "profile-a"
            }
        ));
        assert!(matches!(
            selection_input.intent,
            ProfileSelectionIntent::TrustedProfile {
                profile_id: "profile-a",
                inherited_child: true
            }
        ));

        descriptor.capture_intent = CaptureIntent::AllowGlobalFallback;
        assert_eq!(
            descriptor.validate_for(7).unwrap_err().code(),
            "INGRESS_CAPTURE_INTENT_BINDING_MISMATCH"
        );
    }

    #[test]
    fn descriptor_debug_redacts_network_and_identity_data() {
        let descriptor = descriptor(
            SocketAddr::from((Ipv4Addr::new(192, 0, 2, 4), 40_000)),
            SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
        );
        let debug = format!("{descriptor:?}");
        assert!(!debug.contains("api.example.com"));
        assert!(!debug.contains("203.0.113.8"));
        assert!(!debug.contains("/usr/bin/curl"));
        assert!(!debug.contains("1234"));
    }
}
