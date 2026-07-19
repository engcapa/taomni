//! Platform-neutral, bounded ingress contract for decoded TCP flows.
//!
//! Capture adapters and lower IP-stack adapters must attach identity before a
//! flow crosses this boundary. `FlowDescriptor::validate_for` deliberately
//! fails closed on stale or incomplete metadata; the runtime must never guess
//! a PID, application identity, profile, or hostname after the fact.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, mpsc};

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

/// Complete identity and original five-tuple for one decoded TCP flow.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDescriptor {
    pub generation: u64,
    pub flow_id: u64,
    pub platform: CapturePlatform,
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
            "TCP source must have a concrete address and non-zero port",
        ));
    }
    if destination.port() == 0
        || destination.ip().is_unspecified()
        || destination.ip().is_multicast()
    {
        return Err(IngressError::invalid(
            "INGRESS_DESTINATION_INVALID",
            "TCP destination must have a concrete unicast address and non-zero port",
        ));
    }
    if matches!(source.ip(), IpAddr::V4(_)) != matches!(destination.ip(), IpAddr::V4(_)) {
        return Err(IngressError::invalid(
            "INGRESS_ADDRESS_FAMILY_MISMATCH",
            "TCP source and destination address families must match",
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

/// Completion hook owned by the capture/IP-stack adapter.
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
            Self::QueueFull => "INGRESS_QUEUE_FULL",
            Self::Closed => "INGRESS_CLOSED",
            Self::Control { .. } => "INGRESS_CONTROL_FAILED",
        }
    }
}

/// A source of decoded TCP flows. Implementations must be bounded internally.
#[async_trait]
pub trait FlowIngress: Send + Sync {
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
}

impl BoundedFlowIngressSender {
    /// Never waits and never allocates an overflow queue. On failure, ownership
    /// of the flow is returned so the producer can issue `Overloaded`
    /// explicitly.
    pub fn try_send(&self, flow: IngressTcpFlow) -> Result<(), IngressTrySendError> {
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
        self.sender.is_closed()
    }
}

#[derive(Debug)]
pub struct BoundedFlowIngress {
    receiver: Mutex<mpsc::Receiver<IngressTcpFlow>>,
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
    Ok((
        BoundedFlowIngressSender { sender },
        BoundedFlowIngress {
            receiver: Mutex::new(receiver),
        },
    ))
}

#[async_trait]
impl FlowIngress for BoundedFlowIngress {
    async fn accept_tcp(&self) -> Result<Option<IngressTcpFlow>, IngressError> {
        Ok(self.receiver.lock().await.recv().await)
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

    fn descriptor(source: SocketAddr, destination: SocketAddr) -> FlowDescriptor {
        FlowDescriptor {
            generation: 7,
            flow_id: 11,
            platform: CapturePlatform::Linux,
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
        assert_send_sync::<BoundedFlowIngress>();
        assert_send_sync::<BoundedFlowIngressSender>();
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
