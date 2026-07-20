//! Bounded L3 packet-device contract shared by native capture adapters.
//!
//! This module deliberately stops at the IP boundary.  A Wintun/TUN reader,
//! WinDivert reinjection loop, or macOS provider may implement the same
//! contract, while the replaceable TCP/UDP stack remains above it.  No adapter
//! is allowed to hand an unbounded or ambiguously attributed packet to that
//! stack.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc};

use crate::sockscap::flow::attribution::AttributionHints;
use crate::sockscap::flow::ingress::{CaptureIntent, ProfileBinding};
use crate::sockscap::policy::rules::normalize_hostname;
use crate::sockscap::types::{AppSelectorKind, CapturePlatform};

/// Maximum non-jumbo IP packet accepted by this contract.  IPv6 jumbograms
/// require a separate, explicitly audited path and are rejected here.
pub const MAX_IP_PACKET_BYTES: usize = u16::MAX as usize;
pub const MIN_PACKET_QUEUE_BYTES: usize = MAX_IP_PACKET_BYTES;
pub const MAX_PACKET_QUEUE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PACKET_QUEUE_FRAMES: usize = 4096;
const IPV6_FIXED_HEADER_BYTES: usize = 40;
const MAX_IPV6_EXTENSION_HEADERS: usize = 16;
const MAX_IPV6_EXTENSION_BYTES: usize = 2048;
const MAX_PROFILE_ID_BYTES: usize = 128;
const MAX_APP_IDENTITY_BYTES: usize = 4096;
const MAX_HOSTNAME_BYTES: usize = 253;
static NEXT_PACKET_DEVICE_SOURCE_ID: AtomicU64 = AtomicU64::new(1);

/// Immutable identity carried by both ends of every bounded packet queue.
/// Exposing this metadata lets a stack supervisor reject a miswired queue
/// before native capture is activated instead of waiting for the first frame
/// to fail generation/platform validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PacketQueueIdentity {
    pub generation: u64,
    pub platform: CapturePlatform,
    source_id: u64,
}

impl PacketQueueIdentity {
    pub fn source_id(self) -> u64 {
        self.source_id
    }
}

/// Parsed envelope facts needed by the stack without exposing packet payloads
/// in logs or metrics. This boundary validates the IP header and audited IPv6
/// extension chain; the stack validates the final TCP/UDP header at the
/// trusted `transport_offset`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IpVersion {
    V4,
    V6,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpPacketInfo {
    pub version: IpVersion,
    pub total_len: usize,
    pub transport_protocol: u8,
    pub fragmented: bool,
    pub source: IpAddr,
    pub destination: IpAddr,
    /// Offset of the final transport header after a fully validated IP and
    /// IPv6-extension envelope. Fragments deliberately never expose an
    /// offset: their tuple is not authoritative until bounded reassembly has
    /// completed.
    pub transport_offset: Option<usize>,
}

impl fmt::Debug for IpPacketInfo {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IpPacketInfo")
            .field("version", &self.version)
            .field("total_len", &self.total_len)
            .field("transport_protocol", &self.transport_protocol)
            .field("fragmented", &self.fragmented)
            .field("has_source", &true)
            .field("has_destination", &true)
            .field("transport_offset", &self.transport_offset)
            .finish()
    }
}

/// Capture-time identity attached by the native adapter or its authenticated
/// side channel.  It is intentionally separate from a policy decision: the
/// selector still evaluates the immutable profile snapshot later.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketIdentity {
    pub generation: u64,
    /// Optional stable flow identity supplied by a native capture source.
    /// Plain TUN devices cannot derive this safely and leave it unset; the
    /// controlled IP stack allocates its own bounded tuple-local `flow_id`.
    /// Sources such as a divert driver may set it, but it must then remain
    /// stable for every packet in that tuple and must never be zero.
    pub capture_id: Option<u64>,
    pub platform: CapturePlatform,
    pub pid: Option<u32>,
    pub process_start_time: Option<u64>,
    pub app_kind: Option<AppSelectorKind>,
    pub app_identity: Option<String>,
    pub attribution: AttributionHints,
    pub capture_intent: CaptureIntent,
    pub profile_binding: ProfileBinding,
}

impl fmt::Debug for PacketIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketIdentity")
            .field("generation", &self.generation)
            .field("capture_id", &self.capture_id)
            .field("platform", &self.platform)
            .field("has_process_identity", &(self.pid.is_some()))
            .field("app_kind", &self.app_kind)
            .field("has_app_identity", &self.app_identity.is_some())
            .field("capture_intent", &self.capture_intent_name())
            .field("profile_binding", &self.profile_binding_name())
            .finish()
    }
}

impl PacketIdentity {
    pub fn global(generation: u64, capture_id: Option<u64>, platform: CapturePlatform) -> Self {
        Self {
            generation,
            capture_id,
            platform,
            pid: None,
            process_start_time: None,
            app_kind: None,
            app_identity: None,
            attribution: AttributionHints::default(),
            capture_intent: CaptureIntent::AllowGlobalFallback,
            profile_binding: ProfileBinding::AutoSelect,
        }
    }

    pub fn validate_for(
        &self,
        expected_generation: u64,
        expected_platform: CapturePlatform,
    ) -> Result<(), PacketDeviceError> {
        if expected_generation == 0 || self.generation == 0 {
            return Err(PacketDeviceError::invalid(
                "PACKET_GENERATION_INVALID",
                "packet and active capture generations must be non-zero",
            ));
        }
        if self.generation != expected_generation {
            return Err(PacketDeviceError::StaleGeneration {
                expected: expected_generation,
                actual: self.generation,
            });
        }
        if expected_platform == CapturePlatform::Unknown
            || self.platform == CapturePlatform::Unknown
        {
            return Err(PacketDeviceError::invalid(
                "PACKET_PLATFORM_INVALID",
                "packet platform must be explicit",
            ));
        }
        if self.platform != expected_platform {
            return Err(PacketDeviceError::PlatformMismatch {
                expected: expected_platform,
                actual: self.platform,
            });
        }
        if self.capture_id == Some(0) {
            return Err(PacketDeviceError::invalid(
                "PACKET_CAPTURE_ID_INVALID",
                "an adapter-supplied capture id must be non-zero",
            ));
        }
        match (self.pid, self.process_start_time) {
            (None, None) => {}
            (Some(pid), Some(start)) if pid != 0 && start != 0 => {}
            _ => {
                return Err(PacketDeviceError::invalid(
                    "PACKET_PROCESS_IDENTITY_INVALID",
                    "PID and process start token must be present together",
                ));
            }
        }
        match (self.app_kind, self.app_identity.as_deref()) {
            (None, None) => {}
            (Some(_), Some(identity))
                if !identity.trim().is_empty()
                    && identity.len() <= MAX_APP_IDENTITY_BYTES
                    && !identity.contains('\0') => {}
            _ => {
                return Err(PacketDeviceError::invalid(
                    "PACKET_APP_IDENTITY_INVALID",
                    "application kind and bounded identity must be present together",
                ));
            }
        }
        if let Some(kind) = self.app_kind {
            let incompatible = matches!(
                (self.platform, kind),
                (CapturePlatform::Macos, AppSelectorKind::LinuxCgroup)
                    | (CapturePlatform::Windows, AppSelectorKind::LinuxCgroup)
                    | (
                        CapturePlatform::Windows,
                        AppSelectorKind::MacosSigningIdentity
                    )
                    | (
                        CapturePlatform::Linux,
                        AppSelectorKind::MacosSigningIdentity
                    )
            );
            if incompatible {
                return Err(PacketDeviceError::invalid(
                    "PACKET_APP_KIND_PLATFORM_MISMATCH",
                    "application identity kind does not match packet platform",
                ));
            }
        }
        validate_profile_binding(&self.profile_binding)?;
        validate_capture_intent(self)?;
        validate_attribution(&self.attribution)
    }

    fn capture_intent_name(&self) -> &'static str {
        match &self.capture_intent {
            CaptureIntent::AllowGlobalFallback => "allow_global_fallback",
            CaptureIntent::RequireApplication => "require_application",
            CaptureIntent::RequireRuntimeProcess => "require_runtime_process",
            CaptureIntent::RequireAnySpecific => "require_any_specific",
            CaptureIntent::TrustedProfile { .. } => "trusted_profile",
        }
    }

    fn profile_binding_name(&self) -> &'static str {
        match &self.profile_binding {
            ProfileBinding::AutoSelect => "auto_select",
            ProfileBinding::TrustedQueue { .. } => "trusted_queue",
        }
    }
}

/// Raw L3 packet plus capture identity.  The constructor and queue sender
/// validate the IP envelope; no Ethernet frame or unchecked jumbo payload can
/// cross this boundary.
#[derive(Clone)]
pub struct PacketFrame {
    pub identity: PacketIdentity,
    pub payload: Bytes,
}

impl fmt::Debug for PacketFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketFrame")
            .field("identity", &self.identity)
            .field("payload_len", &self.payload.len())
            .finish()
    }
}

impl PacketFrame {
    pub fn new(
        identity: PacketIdentity,
        payload: impl Into<Bytes>,
        expected_generation: u64,
        expected_platform: CapturePlatform,
    ) -> Result<Self, PacketDeviceError> {
        let frame = Self {
            identity,
            payload: payload.into(),
        };
        frame.validate_for(expected_generation, expected_platform)?;
        Ok(frame)
    }

    pub fn validate_for(
        &self,
        expected_generation: u64,
        expected_platform: CapturePlatform,
    ) -> Result<IpPacketInfo, PacketDeviceError> {
        self.identity
            .validate_for(expected_generation, expected_platform)?;
        parse_ip_packet(&self.payload)
    }
}

/// Packet produced by the IP stack for native reinjection/TUN write.
#[derive(Clone)]
pub struct PacketEgressFrame {
    pub generation: u64,
    pub packet_id: u64,
    pub platform: CapturePlatform,
    pub payload: Bytes,
}

impl fmt::Debug for PacketEgressFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketEgressFrame")
            .field("generation", &self.generation)
            .field("packet_id", &self.packet_id)
            .field("platform", &self.platform)
            .field("payload_len", &self.payload.len())
            .finish()
    }
}

impl PacketEgressFrame {
    pub fn validate_for(
        &self,
        expected_generation: u64,
        expected_platform: CapturePlatform,
    ) -> Result<IpPacketInfo, PacketDeviceError> {
        if self.generation == 0 || self.packet_id == 0 {
            return Err(PacketDeviceError::invalid(
                "PACKET_EGRESS_ID_INVALID",
                "egress generation and packet id must be non-zero",
            ));
        }
        if self.generation != expected_generation {
            return Err(PacketDeviceError::StaleGeneration {
                expected: expected_generation,
                actual: self.generation,
            });
        }
        if self.platform != expected_platform || expected_platform == CapturePlatform::Unknown {
            return Err(PacketDeviceError::PlatformMismatch {
                expected: expected_platform,
                actual: self.platform,
            });
        }
        parse_ip_packet(&self.payload)
    }
}

fn validate_capture_intent(identity: &PacketIdentity) -> Result<(), PacketDeviceError> {
    match (&identity.capture_intent, &identity.profile_binding) {
        (CaptureIntent::AllowGlobalFallback, ProfileBinding::AutoSelect) => Ok(()),
        (CaptureIntent::RequireApplication, ProfileBinding::AutoSelect)
            if identity.app_kind.is_some() && identity.app_identity.is_some() =>
        {
            Ok(())
        }
        (CaptureIntent::RequireRuntimeProcess, ProfileBinding::AutoSelect)
            if identity.pid.is_some() && identity.process_start_time.is_some() =>
        {
            Ok(())
        }
        (CaptureIntent::RequireAnySpecific, ProfileBinding::AutoSelect)
            if (identity.app_kind.is_some() && identity.app_identity.is_some())
                || (identity.pid.is_some() && identity.process_start_time.is_some()) =>
        {
            Ok(())
        }
        (
            CaptureIntent::TrustedProfile { profile_id, .. },
            ProfileBinding::TrustedQueue {
                profile_id: bound, ..
            },
        ) if safe_profile_id(profile_id) && profile_id == bound => Ok(()),
        (CaptureIntent::RequireApplication, ProfileBinding::AutoSelect) => {
            Err(PacketDeviceError::invalid(
                "PACKET_REQUIRED_APP_EVIDENCE_MISSING",
                "application-scoped packet capture requires application identity",
            ))
        }
        (CaptureIntent::RequireRuntimeProcess, ProfileBinding::AutoSelect) => {
            Err(PacketDeviceError::invalid(
                "PACKET_REQUIRED_RUNTIME_EVIDENCE_MISSING",
                "PID-scoped packet capture requires PID/start-token identity",
            ))
        }
        (CaptureIntent::RequireAnySpecific, ProfileBinding::AutoSelect) => {
            Err(PacketDeviceError::invalid(
                "PACKET_REQUIRED_SPECIFIC_EVIDENCE_MISSING",
                "specific packet capture requires application or PID identity",
            ))
        }
        (CaptureIntent::TrustedProfile { .. }, _) => Err(PacketDeviceError::invalid(
            "PACKET_CAPTURE_INTENT_BINDING_MISMATCH",
            "trusted packet capture requires the same trusted queue profile",
        )),
        _ => Err(PacketDeviceError::invalid(
            "PACKET_CAPTURE_INTENT_BINDING_MISMATCH",
            "packet capture intent and profile binding are inconsistent",
        )),
    }
}

fn safe_profile_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PROFILE_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_profile_binding(binding: &ProfileBinding) -> Result<(), PacketDeviceError> {
    if let ProfileBinding::TrustedQueue {
        profile_id,
        config_revision,
    } = binding
    {
        if !safe_profile_id(profile_id) {
            return Err(PacketDeviceError::invalid(
                "PACKET_PROFILE_INVALID",
                "trusted queue profile id is invalid",
            ));
        }
        if *config_revision == 0 {
            return Err(PacketDeviceError::invalid(
                "PACKET_PROFILE_REVISION_INVALID",
                "trusted queue config revision must be non-zero",
            ));
        }
    }
    Ok(())
}

fn validate_attribution(hints: &AttributionHints) -> Result<(), PacketDeviceError> {
    for value in [
        hints.platform_hostname.as_deref(),
        hints.fake_ip_hostname.as_deref(),
        hints.tls_sni.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value.is_empty()
            || value.len() > MAX_HOSTNAME_BYTES
            || value.contains('\0')
            || normalize_hostname(value).is_none()
        {
            return Err(PacketDeviceError::invalid(
                "PACKET_HOSTNAME_INVALID",
                "packet hostname hints must be bounded and syntactically valid",
            ));
        }
    }
    if let Some(value) = hints.http_host.as_deref()
        && (value.is_empty()
            || value.len() > MAX_HOSTNAME_BYTES + 8
            || value.contains('\0')
            || value.bytes().any(|byte| byte.is_ascii_whitespace()))
    {
        return Err(PacketDeviceError::invalid(
            "PACKET_HOSTNAME_INVALID",
            "packet HTTP Host hint is invalid",
        ));
    }
    if let Some(value) = hints.destination_ip.as_deref()
        && (value.is_empty() || value.len() > 64 || value.parse::<IpAddr>().is_err())
    {
        return Err(PacketDeviceError::invalid(
            "PACKET_ATTRIBUTION_IP_INVALID",
            "packet attribution IP hint is invalid",
        ));
    }
    Ok(())
}

fn parse_ip_packet(payload: &[u8]) -> Result<IpPacketInfo, PacketDeviceError> {
    if payload.is_empty() || payload.len() > MAX_IP_PACKET_BYTES {
        return Err(PacketDeviceError::invalid(
            "PACKET_LENGTH_INVALID",
            "L3 packet length is outside the supported range",
        ));
    }
    let version = payload[0] >> 4;
    match version {
        4 => parse_ipv4(payload),
        6 => parse_ipv6(payload),
        _ => Err(PacketDeviceError::invalid(
            "PACKET_VERSION_INVALID",
            "only IPv4 and IPv6 L3 packets are accepted",
        )),
    }
}

fn parse_ipv4(payload: &[u8]) -> Result<IpPacketInfo, PacketDeviceError> {
    if payload.len() < 20 {
        return Err(PacketDeviceError::invalid(
            "PACKET_IPV4_HEADER_TRUNCATED",
            "IPv4 header is shorter than the minimum header",
        ));
    }
    let header_len = ((payload[0] & 0x0f) as usize) * 4;
    if !(20..=60).contains(&header_len) || header_len > payload.len() {
        return Err(PacketDeviceError::invalid(
            "PACKET_IPV4_HEADER_INVALID",
            "IPv4 IHL is invalid or exceeds the packet",
        ));
    }
    let total_len = u16::from_be_bytes([payload[2], payload[3]]) as usize;
    if total_len < header_len || total_len != payload.len() {
        return Err(PacketDeviceError::invalid(
            "PACKET_IPV4_LENGTH_INVALID",
            "IPv4 total length does not match the L3 frame",
        ));
    }
    let flags_fragment = u16::from_be_bytes([payload[6], payload[7]]);
    if flags_fragment & 0x8000 != 0 {
        return Err(PacketDeviceError::invalid(
            "PACKET_IPV4_FLAGS_INVALID",
            "IPv4 reserved flag must be zero",
        ));
    }
    let fragmented = flags_fragment & 0x3fff != 0;
    Ok(IpPacketInfo {
        version: IpVersion::V4,
        total_len,
        transport_protocol: payload[9],
        fragmented,
        source: IpAddr::V4(Ipv4Addr::new(
            payload[12],
            payload[13],
            payload[14],
            payload[15],
        )),
        destination: IpAddr::V4(Ipv4Addr::new(
            payload[16],
            payload[17],
            payload[18],
            payload[19],
        )),
        transport_offset: (!fragmented).then_some(header_len),
    })
}

fn parse_ipv6(payload: &[u8]) -> Result<IpPacketInfo, PacketDeviceError> {
    if payload.len() < IPV6_FIXED_HEADER_BYTES {
        return Err(PacketDeviceError::invalid(
            "PACKET_IPV6_HEADER_TRUNCATED",
            "IPv6 header is shorter than the minimum header",
        ));
    }
    let payload_len = u16::from_be_bytes([payload[4], payload[5]]) as usize;
    if payload_len == 0 {
        return Err(PacketDeviceError::invalid(
            "PACKET_IPV6_JUMBO_UNSUPPORTED",
            "IPv6 jumbograms are not accepted by the bounded device contract",
        ));
    }
    let total_len = IPV6_FIXED_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or_else(|| {
            PacketDeviceError::invalid(
                "PACKET_IPV6_LENGTH_INVALID",
                "IPv6 payload length overflows the L3 frame length",
            )
        })?;
    if total_len != payload.len() {
        return Err(PacketDeviceError::invalid(
            "PACKET_IPV6_LENGTH_INVALID",
            "IPv6 payload length does not match the L3 frame",
        ));
    }

    let mut cursor = IPV6_FIXED_HEADER_BYTES;
    let mut next_header = payload[6];
    let mut extension_headers = 0usize;
    let mut extension_bytes = 0usize;
    let mut fragmented = false;
    let mut order = Ipv6ExtensionOrder::default();

    loop {
        let kind = match next_header {
            0 => Ipv6ExtensionKind::HopByHop,
            43 => Ipv6ExtensionKind::Routing,
            44 => Ipv6ExtensionKind::Fragment,
            51 => Ipv6ExtensionKind::Authentication,
            60 => Ipv6ExtensionKind::Destination,
            _ => break,
        };
        if extension_headers >= MAX_IPV6_EXTENSION_HEADERS {
            return Err(PacketDeviceError::invalid(
                "PACKET_IPV6_EXTENSION_CHAIN_TOO_LONG",
                "IPv6 extension header count exceeds the audited bound",
            ));
        }

        order.observe(kind, extension_headers)?;
        let parsed = parse_ipv6_extension(payload, cursor, kind)?;
        extension_bytes = extension_bytes
            .checked_add(parsed.header_len)
            .filter(|bytes| *bytes <= MAX_IPV6_EXTENSION_BYTES)
            .ok_or_else(|| {
                PacketDeviceError::invalid(
                    "PACKET_IPV6_EXTENSION_CHAIN_TOO_LONG",
                    "IPv6 extension header bytes exceed the audited bound",
                )
            })?;
        cursor = cursor.checked_add(parsed.header_len).ok_or_else(|| {
            PacketDeviceError::invalid(
                "PACKET_IPV6_EXTENSION_LENGTH_INVALID",
                "IPv6 extension header offset overflowed",
            )
        })?;
        next_header = parsed.next_header;
        extension_headers += 1;

        if kind == Ipv6ExtensionKind::Fragment {
            // Even an atomic Fragment header is routed through the bounded
            // reassembly layer so it cannot be used to bypass tuple policy.
            fragmented = true;
            // A non-initial fragment begins in the middle of the fragmentable
            // part. Its Next Header byte is useful to the reassembler, but it
            // is not safe to interpret the following payload as another
            // extension header before reassembly.
            if parsed.non_initial_fragment {
                break;
            }
        }
    }

    let source = payload
        .get(8..24)
        .and_then(|bytes| <[u8; 16]>::try_from(bytes).ok())
        .map(Ipv6Addr::from)
        .ok_or_else(|| {
            PacketDeviceError::invalid(
                "PACKET_IPV6_HEADER_TRUNCATED",
                "IPv6 source address is truncated",
            )
        })?;
    let destination = payload
        .get(24..40)
        .and_then(|bytes| <[u8; 16]>::try_from(bytes).ok())
        .map(Ipv6Addr::from)
        .ok_or_else(|| {
            PacketDeviceError::invalid(
                "PACKET_IPV6_HEADER_TRUNCATED",
                "IPv6 destination address is truncated",
            )
        })?;

    Ok(IpPacketInfo {
        version: IpVersion::V6,
        total_len,
        transport_protocol: next_header,
        fragmented,
        source: IpAddr::V6(source),
        destination: IpAddr::V6(destination),
        transport_offset: (!fragmented).then_some(cursor),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ipv6ExtensionKind {
    HopByHop,
    Destination,
    Routing,
    Fragment,
    Authentication,
}

#[derive(Debug, Default)]
struct Ipv6ExtensionOrder {
    saw_hop_by_hop: bool,
    saw_destination_before_routing: bool,
    saw_routing: bool,
    saw_fragment: bool,
    saw_authentication: bool,
    saw_final_destination: bool,
}

impl Ipv6ExtensionOrder {
    fn observe(
        &mut self,
        kind: Ipv6ExtensionKind,
        extension_index: usize,
    ) -> Result<(), PacketDeviceError> {
        let invalid = match kind {
            Ipv6ExtensionKind::HopByHop => {
                let invalid = extension_index != 0 || self.saw_hop_by_hop;
                self.saw_hop_by_hop = true;
                invalid
            }
            Ipv6ExtensionKind::Destination => {
                if self.saw_final_destination {
                    true
                } else if self.saw_routing || self.saw_fragment || self.saw_authentication {
                    self.saw_final_destination = true;
                    false
                } else if self.saw_destination_before_routing {
                    true
                } else {
                    // This may be the sole final-destination header or the
                    // pre-routing header. A later Routing header disambiguates
                    // the two without accepting two pre-routing headers.
                    self.saw_destination_before_routing = true;
                    false
                }
            }
            Ipv6ExtensionKind::Routing => {
                let invalid = self.saw_routing
                    || self.saw_fragment
                    || self.saw_authentication
                    || self.saw_final_destination;
                self.saw_routing = true;
                invalid
            }
            Ipv6ExtensionKind::Fragment => {
                let invalid = self.saw_fragment
                    || self.saw_authentication
                    || self.saw_final_destination
                    || (self.saw_destination_before_routing && !self.saw_routing);
                self.saw_fragment = true;
                invalid
            }
            Ipv6ExtensionKind::Authentication => {
                let invalid = self.saw_authentication
                    || self.saw_final_destination
                    || (self.saw_destination_before_routing && !self.saw_routing);
                self.saw_authentication = true;
                invalid
            }
        };
        if invalid {
            return Err(PacketDeviceError::invalid(
                "PACKET_IPV6_EXTENSION_ORDER_INVALID",
                "IPv6 extension headers are duplicated or out of audited order",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
struct ParsedIpv6Extension {
    next_header: u8,
    header_len: usize,
    non_initial_fragment: bool,
}

fn parse_ipv6_extension(
    payload: &[u8],
    cursor: usize,
    kind: Ipv6ExtensionKind,
) -> Result<ParsedIpv6Extension, PacketDeviceError> {
    let remaining = payload.get(cursor..).ok_or_else(|| {
        PacketDeviceError::invalid(
            "PACKET_IPV6_EXTENSION_TRUNCATED",
            "IPv6 extension header starts beyond the L3 frame",
        )
    })?;
    let prefix = remaining.get(..2).ok_or_else(|| {
        PacketDeviceError::invalid(
            "PACKET_IPV6_EXTENSION_TRUNCATED",
            "IPv6 extension header is missing its length prefix",
        )
    })?;

    let header_len = match kind {
        Ipv6ExtensionKind::HopByHop
        | Ipv6ExtensionKind::Destination
        | Ipv6ExtensionKind::Routing => (usize::from(prefix[1]) + 1) * 8,
        Ipv6ExtensionKind::Authentication => (usize::from(prefix[1]) + 2) * 4,
        Ipv6ExtensionKind::Fragment => 8,
    };
    let header = remaining.get(..header_len).ok_or_else(|| {
        PacketDeviceError::invalid(
            "PACKET_IPV6_EXTENSION_TRUNCATED",
            "IPv6 extension header length exceeds the L3 frame",
        )
    })?;

    let mut non_initial_fragment = false;
    match kind {
        Ipv6ExtensionKind::HopByHop | Ipv6ExtensionKind::Destination => {
            validate_ipv6_options(header)?;
        }
        Ipv6ExtensionKind::Routing => {}
        Ipv6ExtensionKind::Fragment => {
            let fragment_bits = u16::from_be_bytes([header[2], header[3]]);
            if header[1] != 0 || fragment_bits & 0x0006 != 0 {
                return Err(PacketDeviceError::invalid(
                    "PACKET_IPV6_FRAGMENT_HEADER_INVALID",
                    "IPv6 Fragment reserved fields must be zero",
                ));
            }
            non_initial_fragment = fragment_bits & 0xfff8 != 0;
        }
        Ipv6ExtensionKind::Authentication => {
            if header_len < 12 || header_len % 8 != 0 || header[2] != 0 || header[3] != 0 {
                return Err(PacketDeviceError::invalid(
                    "PACKET_IPV6_AUTH_HEADER_INVALID",
                    "IPv6 Authentication header length or reserved fields are invalid",
                ));
            }
        }
    }

    Ok(ParsedIpv6Extension {
        next_header: header[0],
        header_len,
        non_initial_fragment,
    })
}

fn validate_ipv6_options(header: &[u8]) -> Result<(), PacketDeviceError> {
    let mut cursor = 2usize;
    while cursor < header.len() {
        let option_type = header[cursor];
        if option_type == 0 {
            cursor += 1;
            continue;
        }
        let option_len = usize::from(*header.get(cursor + 1).ok_or_else(|| {
            PacketDeviceError::invalid(
                "PACKET_IPV6_OPTIONS_INVALID",
                "IPv6 option is missing its length byte",
            )
        })?);
        let option_end = cursor
            .checked_add(2)
            .and_then(|start| start.checked_add(option_len))
            .filter(|end| *end <= header.len())
            .ok_or_else(|| {
                PacketDeviceError::invalid(
                    "PACKET_IPV6_OPTIONS_INVALID",
                    "IPv6 option length exceeds its extension header",
                )
            })?;
        if option_type == 1 && header[cursor + 2..option_end].iter().any(|byte| *byte != 0) {
            return Err(PacketDeviceError::invalid(
                "PACKET_IPV6_OPTIONS_INVALID",
                "IPv6 PadN option contains non-zero padding",
            ));
        }
        cursor = option_end;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PacketDeviceError {
    #[error("{code}: {message}")]
    Invalid {
        code: &'static str,
        message: &'static str,
    },
    #[error("PACKET_STALE_GENERATION: expected {expected}, got {actual}")]
    StaleGeneration { expected: u64, actual: u64 },
    #[error("PACKET_PLATFORM_MISMATCH: expected {expected:?}, got {actual:?}")]
    PlatformMismatch {
        expected: CapturePlatform,
        actual: CapturePlatform,
    },
    #[error("PACKET_QUEUE_FULL: bounded packet queue is full")]
    QueueFull,
    #[error("PACKET_QUEUE_CLOSED: bounded packet queue is closed")]
    Closed,
    #[error("PACKET_QUEUE_BUDGET_EXHAUSTED: packet byte budget is exhausted")]
    BudgetExhausted,
    #[error("PACKET_DEVICE_ID_EXHAUSTED: packet-device source id space is exhausted")]
    SourceIdExhausted,
}

impl PacketDeviceError {
    fn invalid(code: &'static str, message: &'static str) -> Self {
        Self::Invalid { code, message }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid { code, .. } => code,
            Self::StaleGeneration { .. } => "PACKET_STALE_GENERATION",
            Self::PlatformMismatch { .. } => "PACKET_PLATFORM_MISMATCH",
            Self::QueueFull => "PACKET_QUEUE_FULL",
            Self::Closed => "PACKET_QUEUE_CLOSED",
            Self::BudgetExhausted => "PACKET_QUEUE_BUDGET_EXHAUSTED",
            Self::SourceIdExhausted => "PACKET_DEVICE_ID_EXHAUSTED",
        }
    }
}

#[derive(Debug)]
pub struct PacketTrySendError<T> {
    pub error: PacketDeviceError,
    pub packet: T,
}

/// A packet lease holds the byte-budget permit until the stack has finished
/// processing the packet.  This bounds queued *and in-flight* memory rather
/// than merely bounding the number of channel entries.
pub struct PacketLease<T> {
    packet: T,
    _permit: OwnedSemaphorePermit,
}

impl<T: fmt::Debug> fmt::Debug for PacketLease<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketLease")
            .field("packet", &self.packet)
            .finish_non_exhaustive()
    }
}

impl<T> PacketLease<T> {
    pub fn as_ref(&self) -> &T {
        &self.packet
    }

    pub fn into_inner(self) -> T {
        self.packet
    }
}

trait PacketEnvelope: Sized + Send + 'static {
    fn payload_len(&self) -> usize;
    fn validate_for(
        &self,
        expected_generation: u64,
        expected_platform: CapturePlatform,
    ) -> Result<IpPacketInfo, PacketDeviceError>;
}

impl PacketEnvelope for PacketFrame {
    fn payload_len(&self) -> usize {
        self.payload.len()
    }

    fn validate_for(
        &self,
        expected_generation: u64,
        expected_platform: CapturePlatform,
    ) -> Result<IpPacketInfo, PacketDeviceError> {
        PacketFrame::validate_for(self, expected_generation, expected_platform)
    }
}

impl PacketEnvelope for PacketEgressFrame {
    fn payload_len(&self) -> usize {
        self.payload.len()
    }

    fn validate_for(
        &self,
        expected_generation: u64,
        expected_platform: CapturePlatform,
    ) -> Result<IpPacketInfo, PacketDeviceError> {
        PacketEgressFrame::validate_for(self, expected_generation, expected_platform)
    }
}

struct QueuedPacket<T> {
    packet: T,
    permit: OwnedSemaphorePermit,
}

struct PacketQueueSender<T> {
    sender: mpsc::Sender<QueuedPacket<T>>,
    budget: Arc<Semaphore>,
    expected_generation: u64,
    expected_platform: CapturePlatform,
    source_id: u64,
}

impl<T: PacketEnvelope> PacketQueueSender<T> {
    fn try_send(&self, packet: T) -> Result<(), PacketTrySendError<T>> {
        if let Err(error) = packet.validate_for(self.expected_generation, self.expected_platform) {
            return Err(PacketTrySendError { error, packet });
        }
        let bytes = packet.payload_len();
        let permit = match self.budget.clone().try_acquire_many_owned(bytes as u32) {
            Ok(permit) => permit,
            Err(_) => {
                return Err(PacketTrySendError {
                    error: PacketDeviceError::BudgetExhausted,
                    packet,
                });
            }
        };
        match self.sender.try_send(QueuedPacket { packet, permit }) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(queued)) => Err(PacketTrySendError {
                error: PacketDeviceError::QueueFull,
                packet: queued.packet,
            }),
            Err(mpsc::error::TrySendError::Closed(queued)) => Err(PacketTrySendError {
                error: PacketDeviceError::Closed,
                packet: queued.packet,
            }),
        }
    }

    fn is_closed(&self) -> bool {
        self.sender.is_closed()
    }

    fn identity(&self) -> PacketQueueIdentity {
        PacketQueueIdentity {
            generation: self.expected_generation,
            platform: self.expected_platform,
            source_id: self.source_id,
        }
    }
}

struct PacketQueueReceiver<T> {
    receiver: Mutex<mpsc::Receiver<QueuedPacket<T>>>,
    identity: PacketQueueIdentity,
}

/// Native-adapter side of the bounded packet ingress queue.
pub struct PacketIngressSender {
    inner: PacketQueueSender<PacketFrame>,
}

/// Stack side of the bounded packet ingress queue.
pub struct PacketIngressReceiver {
    inner: PacketQueueReceiver<PacketFrame>,
}

/// Stack side of the bounded packet egress queue.
pub struct PacketEgressSender {
    inner: PacketQueueSender<PacketEgressFrame>,
}

/// Native-adapter side of the bounded packet egress queue.
pub struct PacketEgressReceiver {
    inner: PacketQueueReceiver<PacketEgressFrame>,
}

impl fmt::Debug for PacketIngressSender {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PacketIngressSender { bounded: true }")
    }
}

impl fmt::Debug for PacketIngressReceiver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PacketIngressReceiver { bounded: true }")
    }
}

impl fmt::Debug for PacketEgressSender {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PacketEgressSender { bounded: true }")
    }
}

impl fmt::Debug for PacketEgressReceiver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PacketEgressReceiver { bounded: true }")
    }
}

impl PacketIngressSender {
    pub fn try_send(&self, packet: PacketFrame) -> Result<(), PacketTrySendError<PacketFrame>> {
        self.inner.try_send(packet)
    }

    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    pub fn identity(&self) -> PacketQueueIdentity {
        self.inner.identity()
    }
}

impl PacketIngressReceiver {
    pub async fn accept_packet(&self) -> Option<PacketLease<PacketFrame>> {
        self.inner.recv().await
    }

    pub fn identity(&self) -> PacketQueueIdentity {
        self.inner.identity
    }
}

impl PacketEgressSender {
    pub fn try_send(
        &self,
        packet: PacketEgressFrame,
    ) -> Result<(), PacketTrySendError<PacketEgressFrame>> {
        self.inner.try_send(packet)
    }

    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    pub fn identity(&self) -> PacketQueueIdentity {
        self.inner.identity()
    }
}

impl PacketEgressReceiver {
    pub async fn receive_packet(&self) -> Option<PacketLease<PacketEgressFrame>> {
        self.inner.recv().await
    }

    pub fn identity(&self) -> PacketQueueIdentity {
        self.inner.identity
    }
}

impl<T> PacketQueueReceiver<T> {
    async fn recv(&self) -> Option<PacketLease<T>> {
        self.receiver
            .lock()
            .await
            .recv()
            .await
            .map(|queued| PacketLease {
                packet: queued.packet,
                _permit: queued.permit,
            })
    }
}

fn packet_queue<T: PacketEnvelope>(
    byte_capacity: usize,
    identity: PacketQueueIdentity,
) -> Result<(PacketQueueSender<T>, PacketQueueReceiver<T>), PacketDeviceError> {
    if !(MIN_PACKET_QUEUE_BYTES..=MAX_PACKET_QUEUE_BYTES).contains(&byte_capacity)
        || identity.generation == 0
        || identity.platform == CapturePlatform::Unknown
        || identity.source_id == 0
    {
        return Err(PacketDeviceError::invalid(
            "PACKET_QUEUE_CONFIG_INVALID",
            "packet queue byte budget or runtime identity is invalid",
        ));
    }
    let frame_capacity = (byte_capacity / 1500).clamp(1, MAX_PACKET_QUEUE_FRAMES);
    let (sender, receiver) = mpsc::channel(frame_capacity);
    let budget = Arc::new(Semaphore::new(byte_capacity));
    Ok((
        PacketQueueSender {
            sender,
            budget,
            expected_generation: identity.generation,
            expected_platform: identity.platform,
            source_id: identity.source_id,
        },
        PacketQueueReceiver {
            receiver: Mutex::new(receiver),
            identity,
        },
    ))
}

fn allocate_packet_queue_identity(
    generation: u64,
    platform: CapturePlatform,
) -> Result<PacketQueueIdentity, PacketDeviceError> {
    if generation == 0 || platform == CapturePlatform::Unknown {
        return Err(PacketDeviceError::invalid(
            "PACKET_QUEUE_CONFIG_INVALID",
            "packet queue byte budget or runtime identity is invalid",
        ));
    }
    let source_id = NEXT_PACKET_DEVICE_SOURCE_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            current.checked_add(1)
        })
        .map_err(|_| PacketDeviceError::SourceIdExhausted)?;
    Ok(PacketQueueIdentity {
        generation,
        platform,
        source_id,
    })
}

/// Create the bounded native-to-stack queue.  The sender is non-blocking so a
/// capture adapter can close/drop a packet deterministically under pressure.
pub fn bounded_packet_ingress(
    byte_capacity: usize,
    generation: u64,
    platform: CapturePlatform,
) -> Result<(PacketIngressSender, PacketIngressReceiver), PacketDeviceError> {
    let identity = allocate_packet_queue_identity(generation, platform)?;
    let (sender, receiver) = packet_queue(byte_capacity, identity)?;
    Ok((
        PacketIngressSender { inner: sender },
        PacketIngressReceiver { inner: receiver },
    ))
}

/// Create the bounded stack-to-native queue.
pub fn bounded_packet_egress(
    byte_capacity: usize,
    generation: u64,
    platform: CapturePlatform,
) -> Result<(PacketEgressSender, PacketEgressReceiver), PacketDeviceError> {
    let identity = allocate_packet_queue_identity(generation, platform)?;
    let (sender, receiver) = packet_queue(byte_capacity, identity)?;
    Ok((
        PacketEgressSender { inner: sender },
        PacketEgressReceiver { inner: receiver },
    ))
}

/// Native-facing ends of one bidirectional packet-device pair.
pub struct NativePacketDeviceQueues {
    pub capture: PacketIngressSender,
    pub reinject: PacketEgressReceiver,
}

/// Stack-facing ends paired with [`NativePacketDeviceQueues`] by an opaque,
/// process-local source id. Queues from two devices cannot be cross-wired even
/// when generation and platform are otherwise identical.
pub struct StackPacketDeviceQueues {
    pub ingress: PacketIngressReceiver,
    pub egress: PacketEgressSender,
}

/// Create both directions for one native packet device with a shared,
/// unforgeable-at-the-queue-boundary source identity.
pub fn bounded_packet_device_queues(
    byte_capacity: usize,
    generation: u64,
    platform: CapturePlatform,
) -> Result<(NativePacketDeviceQueues, StackPacketDeviceQueues), PacketDeviceError> {
    let identity = allocate_packet_queue_identity(generation, platform)?;
    let (capture, ingress) = packet_queue(byte_capacity, identity)?;
    let (egress, reinject) = packet_queue(byte_capacity, identity)?;
    Ok((
        NativePacketDeviceQueues {
            capture: PacketIngressSender { inner: capture },
            reinject: PacketEgressReceiver { inner: reinject },
        },
        StackPacketDeviceQueues {
            ingress: PacketIngressReceiver { inner: ingress },
            egress: PacketEgressSender { inner: egress },
        },
    ))
}

/// Stack-facing packet ingress/egress boundary.  Implementations must keep
/// `accept_packet` cancellation-safe and must not turn `emit_packet` into an
/// unbounded wait when the native device is under pressure.
#[async_trait]
pub trait PacketIngress: Send + Sync {
    async fn accept_packet(&self) -> Result<Option<PacketLease<PacketFrame>>, PacketDeviceError>;
}

#[async_trait]
pub trait PacketEgress: Send + Sync {
    async fn emit_packet(&self, packet: PacketEgressFrame) -> Result<(), PacketDeviceError>;
}

#[async_trait]
impl PacketIngress for PacketIngressReceiver {
    async fn accept_packet(&self) -> Result<Option<PacketLease<PacketFrame>>, PacketDeviceError> {
        Ok(PacketIngressReceiver::accept_packet(self).await)
    }
}

#[async_trait]
impl PacketEgress for PacketEgressSender {
    async fn emit_packet(&self, packet: PacketEgressFrame) -> Result<(), PacketDeviceError> {
        self.try_send(packet).map_err(|error| error.error)
    }
}

/// In-memory packet-device pair used by the IP-stack contract tests and later
/// native adapters.  It has the same byte-budget and validation behavior as a
/// production device bridge.
pub struct MemoryPacketStack {
    ingress: PacketIngressReceiver,
    egress: PacketEgressSender,
}

pub struct MemoryPacketAdapter {
    ingress: PacketIngressSender,
    egress: PacketEgressReceiver,
}

impl fmt::Debug for MemoryPacketStack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MemoryPacketStack { bounded: true }")
    }
}

impl fmt::Debug for MemoryPacketAdapter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MemoryPacketAdapter { bounded: true }")
    }
}

pub fn memory_packet_device(
    byte_capacity: usize,
    generation: u64,
    platform: CapturePlatform,
) -> Result<(MemoryPacketAdapter, MemoryPacketStack), PacketDeviceError> {
    let (native, stack) = bounded_packet_device_queues(byte_capacity, generation, platform)?;
    Ok((
        MemoryPacketAdapter {
            ingress: native.capture,
            egress: native.reinject,
        },
        MemoryPacketStack {
            ingress: stack.ingress,
            egress: stack.egress,
        },
    ))
}

impl MemoryPacketAdapter {
    pub fn try_capture(&self, packet: PacketFrame) -> Result<(), PacketTrySendError<PacketFrame>> {
        self.ingress.try_send(packet)
    }

    pub async fn receive_reinjected(&self) -> Option<PacketLease<PacketEgressFrame>> {
        self.egress.receive_packet().await
    }

    pub fn is_closed(&self) -> bool {
        self.ingress.is_closed()
    }
}

#[async_trait]
impl PacketIngress for MemoryPacketStack {
    async fn accept_packet(&self) -> Result<Option<PacketLease<PacketFrame>>, PacketDeviceError> {
        Ok(self.ingress.accept_packet().await)
    }
}

#[async_trait]
impl PacketEgress for MemoryPacketStack {
    async fn emit_packet(&self, packet: PacketEgressFrame) -> Result<(), PacketDeviceError> {
        self.egress.try_send(packet).map_err(|error| error.error)
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;
    use std::time::Duration;

    use super::*;

    fn ipv4_packet(payload_len: usize, protocol: u8) -> Bytes {
        let total = 20 + payload_len;
        assert!(total <= u16::MAX as usize);
        let mut packet = vec![0u8; total];
        packet[0] = 0x45;
        packet[2..4].copy_from_slice(&(total as u16).to_be_bytes());
        packet[8] = 64;
        packet[9] = protocol;
        packet[12..16].copy_from_slice(&Ipv4Addr::LOCALHOST.octets());
        packet[16..20].copy_from_slice(&Ipv4Addr::new(198, 51, 100, 8).octets());
        packet.into()
    }

    fn ipv6_packet(next_header: u8, body: Vec<u8>) -> Bytes {
        assert!(!body.is_empty());
        assert!(body.len() <= u16::MAX as usize);
        let mut packet = vec![0u8; IPV6_FIXED_HEADER_BYTES];
        packet[0] = 0x60;
        packet[4..6].copy_from_slice(&(body.len() as u16).to_be_bytes());
        packet[6] = next_header;
        packet[7] = 64;
        packet[8..24].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
        packet[24..40].copy_from_slice(&Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 8).octets());
        packet.extend_from_slice(&body);
        packet.into()
    }

    fn identity(generation: u64, capture_id: u64) -> PacketIdentity {
        PacketIdentity::global(generation, Some(capture_id), CapturePlatform::Linux)
    }

    fn frame(generation: u64, capture_id: u64) -> PacketFrame {
        PacketFrame {
            identity: identity(generation, capture_id),
            payload: ipv4_packet(8, 6),
        }
    }

    #[test]
    fn validates_l3_envelope_and_rejects_malformed_lengths() {
        let packet = frame(7, 1);
        let info = packet
            .validate_for(7, CapturePlatform::Linux)
            .expect("valid IPv4 packet");
        assert_eq!(info.version, IpVersion::V4);
        assert_eq!(info.transport_protocol, 6);
        assert_eq!(info.source, IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(info.destination, IpAddr::V4(Ipv4Addr::new(198, 51, 100, 8)));
        assert_eq!(info.transport_offset, Some(20));
        let debug = format!("{info:?}");
        assert!(!debug.contains("127.0.0.1"));
        assert!(!debug.contains("198.51.100.8"));

        let mut reserved_flag = packet.clone();
        let mut payload = reserved_flag.payload.to_vec();
        payload[6] |= 0x80;
        reserved_flag.payload = payload.into();
        assert_eq!(
            reserved_flag
                .validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_IPV4_FLAGS_INVALID"
        );

        let mut bad = packet.clone();
        bad.payload = Bytes::from_static(&[0x45, 0, 0, 20]);
        assert_eq!(
            bad.validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_IPV4_HEADER_TRUNCATED"
        );

        let mut ethernet = vec![0u8; 14];
        ethernet.extend_from_slice(&ipv4_packet(0, 6));
        let bad = PacketFrame {
            identity: identity(7, 2),
            payload: ethernet.into(),
        };
        assert_eq!(
            bad.validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_VERSION_INVALID"
        );
    }

    #[test]
    fn ipv6_extension_chain_reports_final_transport_and_fragment() {
        let mut body = Vec::new();
        body.extend_from_slice(&[43, 0, 0, 0, 0, 0, 0, 0]); // Hop-by-Hop
        body.extend_from_slice(&[44, 0, 0, 0, 0, 0, 0, 0]); // Routing
        body.extend_from_slice(&[51, 0, 0, 1, 0, 0, 0, 1]); // First Fragment, M=1
        let mut authentication = vec![0u8; 24];
        authentication[0] = 60;
        authentication[1] = 4;
        body.extend_from_slice(&authentication);
        body.extend_from_slice(&[17, 0, 0, 0, 0, 0, 0, 0]); // Destination
        body.extend_from_slice(&[0; 8]); // UDP header belongs to the stack

        let packet = PacketFrame {
            identity: identity(7, 11),
            payload: ipv6_packet(0, body),
        };
        let info = packet
            .validate_for(7, CapturePlatform::Linux)
            .expect("strict ordered IPv6 extension chain");
        assert_eq!(info.version, IpVersion::V6);
        assert_eq!(info.transport_protocol, 17);
        assert!(info.fragmented);
        assert_eq!(info.transport_offset, None);
    }

    #[test]
    fn ipv6_extension_chain_exposes_only_a_validated_transport_offset() {
        let mut body = Vec::new();
        body.extend_from_slice(&[60, 0, 0, 0, 0, 0, 0, 0]); // Hop-by-Hop
        body.extend_from_slice(&[17, 0, 0, 0, 0, 0, 0, 0]); // Destination
        body.extend_from_slice(&[0; 8]); // UDP header belongs to the stack
        let packet = PacketFrame {
            identity: identity(7, 17),
            payload: ipv6_packet(0, body),
        };

        let info = packet
            .validate_for(7, CapturePlatform::Linux)
            .expect("valid ordered IPv6 extension chain");
        assert_eq!(info.transport_protocol, 17);
        assert_eq!(info.transport_offset, Some(56));
        assert_eq!(info.source, IpAddr::V6(Ipv6Addr::LOCALHOST));
        assert_eq!(
            info.destination,
            IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 8))
        );
    }

    #[test]
    fn ipv6_extension_chain_rejects_truncation_and_malformed_headers() {
        let truncated = PacketFrame {
            identity: identity(7, 12),
            // Hdr Ext Len declares 16 bytes, but only eight are present.
            payload: ipv6_packet(0, vec![6, 1, 0, 0, 0, 0, 0, 0]),
        };
        assert_eq!(
            truncated
                .validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_IPV6_EXTENSION_TRUNCATED"
        );

        let malformed_option = PacketFrame {
            identity: identity(7, 13),
            // Option length escapes the enclosing eight-byte header.
            payload: ipv6_packet(0, vec![6, 0, 2, 5, 0, 0, 0, 0]),
        };
        assert_eq!(
            malformed_option
                .validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_IPV6_OPTIONS_INVALID"
        );

        let malformed_fragment = PacketFrame {
            identity: identity(7, 14),
            payload: ipv6_packet(44, vec![6, 1, 0, 0, 0, 0, 0, 1]),
        };
        assert_eq!(
            malformed_fragment
                .validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_IPV6_FRAGMENT_HEADER_INVALID"
        );
    }

    #[test]
    fn ipv6_extension_chain_enforces_order_and_byte_budget() {
        let mut out_of_order = vec![44, 0, 0, 0, 0, 0, 0, 0]; // Destination
        out_of_order.extend_from_slice(&[6, 0, 0, 0, 0, 0, 0, 1]); // Fragment
        let out_of_order = PacketFrame {
            identity: identity(7, 15),
            payload: ipv6_packet(60, out_of_order),
        };
        assert_eq!(
            out_of_order
                .validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_IPV6_EXTENSION_ORDER_INVALID"
        );

        let mut oversized_chain = vec![0u8; MAX_IPV6_EXTENSION_BYTES];
        oversized_chain[0] = 43;
        oversized_chain[1] = 255;
        oversized_chain.extend_from_slice(&[6, 0, 0, 0, 0, 0, 0, 0]);
        let oversized_chain = PacketFrame {
            identity: identity(7, 16),
            payload: ipv6_packet(0, oversized_chain),
        };
        assert_eq!(
            oversized_chain
                .validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_IPV6_EXTENSION_CHAIN_TOO_LONG"
        );
    }

    #[test]
    fn identity_never_falls_back_when_specific_evidence_is_missing() {
        let mut packet = frame(7, 1);
        packet.identity.capture_intent = CaptureIntent::RequireApplication;
        assert_eq!(
            packet
                .validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_REQUIRED_APP_EVIDENCE_MISSING"
        );
    }

    #[test]
    fn plain_tun_identity_may_defer_flow_id_to_the_stack() {
        let packet = PacketFrame {
            identity: PacketIdentity::global(7, None, CapturePlatform::Linux),
            payload: ipv4_packet(0, 6),
        };
        assert!(packet.validate_for(7, CapturePlatform::Linux).is_ok());
        let mut invalid = packet;
        invalid.identity.capture_id = Some(0);
        assert_eq!(
            invalid
                .validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_CAPTURE_ID_INVALID"
        );
    }

    #[test]
    fn trusted_queue_requires_matching_profile_and_revision() {
        let mut packet = frame(7, 1);
        packet.identity.capture_intent = CaptureIntent::TrustedProfile {
            profile_id: "profile-a".into(),
            inherited_child: false,
        };
        packet.identity.profile_binding = ProfileBinding::TrustedQueue {
            profile_id: "profile-a".into(),
            config_revision: 3,
        };
        assert!(packet.validate_for(7, CapturePlatform::Linux).is_ok());
        packet.identity.profile_binding = ProfileBinding::TrustedQueue {
            profile_id: "profile-b".into(),
            config_revision: 3,
        };
        assert_eq!(
            packet
                .validate_for(7, CapturePlatform::Linux)
                .unwrap_err()
                .code(),
            "PACKET_CAPTURE_INTENT_BINDING_MISMATCH"
        );
    }

    #[tokio::test]
    async fn memory_device_round_trip_preserves_packet_and_bounds_bytes() {
        let (adapter, stack) = memory_packet_device(65_535, 7, CapturePlatform::Linux)
            .expect("minimum bounded packet budget");
        adapter.try_capture(frame(7, 1)).expect("capture packet");
        let lease = stack
            .accept_packet()
            .await
            .expect("receive packet")
            .expect("packet present");
        assert_eq!(lease.as_ref().identity.capture_id, Some(1));
        drop(lease);

        let outgoing = PacketEgressFrame {
            generation: 7,
            packet_id: 9,
            platform: CapturePlatform::Linux,
            payload: ipv4_packet(4, 6),
        };
        stack.emit_packet(outgoing).await.expect("reinject packet");
        let reinjected = adapter
            .receive_reinjected()
            .await
            .expect("outgoing packet present");
        assert_eq!(reinjected.as_ref().packet_id, 9);
    }

    #[tokio::test]
    async fn byte_budget_returns_packet_and_recovers_after_lease_drop() {
        let (adapter, stack) =
            memory_packet_device(65_535, 7, CapturePlatform::Linux).expect("bounded packet budget");
        let packet = PacketFrame {
            identity: identity(7, 1),
            payload: ipv4_packet(65_515, 6),
        };
        adapter
            .try_capture(packet)
            .expect("one maximum packet fits");
        let second = frame(7, 2);
        let rejected = adapter
            .try_capture(second)
            .expect_err("byte budget must reject a second in-flight packet");
        assert_eq!(rejected.error, PacketDeviceError::BudgetExhausted);
        assert_eq!(rejected.packet.identity.capture_id, Some(2));

        let lease = stack.accept_packet().await.unwrap().unwrap();
        assert_eq!(lease.as_ref().payload.len(), 65_535);
        drop(lease);
        adapter.try_capture(frame(7, 3)).expect("permit returned");
    }

    #[tokio::test]
    async fn receive_is_cancellation_safe() {
        let (adapter, stack) =
            memory_packet_device(65_535, 7, CapturePlatform::Linux).expect("bounded packet budget");
        let stack = Arc::new(stack);
        let waiter_stack = Arc::clone(&stack);
        let waiter = tokio::spawn(async move { waiter_stack.accept_packet().await });
        tokio::time::sleep(Duration::from_millis(1)).await;
        waiter.abort();
        let _ = waiter.await;
        adapter
            .try_capture(frame(7, 4))
            .expect("canceled receive must not consume the packet");
        assert_eq!(
            stack
                .accept_packet()
                .await
                .unwrap()
                .unwrap()
                .as_ref()
                .identity
                .capture_id,
            Some(4)
        );
    }

    #[test]
    fn stale_generation_is_rejected_before_queue_admission() {
        let (adapter, _stack) =
            memory_packet_device(65_535, 7, CapturePlatform::Linux).expect("bounded packet budget");
        let rejected = adapter
            .try_capture(frame(8, 1))
            .expect_err("stale packet must fail closed");
        assert_eq!(rejected.error.code(), "PACKET_STALE_GENERATION");
    }

    #[test]
    fn queue_identity_is_explicit_and_equal_on_both_ends() {
        let (native, stack) =
            bounded_packet_device_queues(MIN_PACKET_QUEUE_BYTES, 7, CapturePlatform::Linux)
                .unwrap();
        let identity = native.capture.identity();
        assert_eq!(identity.generation, 7);
        assert_eq!(identity.platform, CapturePlatform::Linux);
        assert_ne!(identity.source_id(), 0);
        assert_eq!(stack.ingress.identity(), identity);
        assert_eq!(stack.egress.identity(), identity);
        assert_eq!(native.reinject.identity(), identity);

        let (_, other_stack) =
            bounded_packet_device_queues(MIN_PACKET_QUEUE_BYTES, 7, CapturePlatform::Linux)
                .unwrap();
        assert_ne!(other_stack.ingress.identity(), identity);
    }
}
