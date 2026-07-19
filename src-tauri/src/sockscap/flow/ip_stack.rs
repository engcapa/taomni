//! Admission and lifecycle contract for the replaceable, controlled IP stack.
//!
//! The actual TCP/UDP implementation is intentionally behind this boundary.
//! This module owns the invariants that must hold regardless of whether the
//! eventual implementation is an audited embedded stack or a maintained
//! internal fork: pinned provenance, bounded state, generation fencing,
//! identity immutability, and preservation of IPv6 scope ids.

use std::collections::HashMap;
use std::fmt;
use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use super::attribution::AttributionHints;
use super::ingress::{FlowDescriptor, IngressError};
use crate::sockscap::capture::packet_device::{
    IpPacketInfo, IpVersion, MAX_IP_PACKET_BYTES, PacketDeviceError, PacketFrame, PacketIdentity,
};
use crate::sockscap::types::{AppSelectorKind, CapturePlatform};

const MAX_PROVIDER_NAME_BYTES: usize = 128;
const MAX_PROVIDER_VERSION_BYTES: usize = 64;
const MAX_PROVIDER_HASH_BYTES: usize = 64;
pub const MAX_STACK_TCP_FLOWS: usize = 65_536;
pub const MAX_STACK_UDP_ASSOCIATIONS: usize = 65_536;
pub const MAX_STACK_REASSEMBLY_BYTES: usize = 64 * 1024 * 1024;

/// Exact source pin required before a provider can be selected in a release
/// build.  A package manager's floating version or an unreviewed git branch is
/// not a valid provider identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpStackProviderPin {
    pub name: String,
    pub version: String,
    pub source_sha256: String,
}

impl IpStackProviderPin {
    pub fn validate(&self) -> Result<(), IpStackError> {
        if self.name.is_empty()
            || self.name.len() > MAX_PROVIDER_NAME_BYTES
            || !self
                .name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(IpStackError::invalid(
                "IPSTACK_PROVIDER_NAME_INVALID",
                "IP stack provider name is empty or contains unsupported characters",
            ));
        }
        if self.version.is_empty()
            || self.version.len() > MAX_PROVIDER_VERSION_BYTES
            || self.version.contains('\0')
        {
            return Err(IpStackError::invalid(
                "IPSTACK_PROVIDER_VERSION_INVALID",
                "IP stack provider version is empty or unbounded",
            ));
        }
        if self.source_sha256.len() != MAX_PROVIDER_HASH_BYTES
            || !self
                .source_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(IpStackError::invalid(
                "IPSTACK_PROVIDER_HASH_INVALID",
                "IP stack provider source pin must be a 64-character SHA-256",
            ));
        }
        Ok(())
    }
}

/// Hard resource limits passed to the selected stack implementation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpStackConfig {
    pub generation: u64,
    pub platform: CapturePlatform,
    pub provider: IpStackProviderPin,
    pub max_tcp_flows: usize,
    pub max_udp_associations: usize,
    pub max_reassembly_bytes: usize,
    pub max_packet_bytes: usize,
}

impl IpStackConfig {
    pub fn validate(&self) -> Result<(), IpStackError> {
        if self.generation == 0 || self.platform == CapturePlatform::Unknown {
            return Err(IpStackError::invalid(
                "IPSTACK_CONFIG_IDENTITY_INVALID",
                "stack generation and platform must be explicit",
            ));
        }
        self.provider.validate()?;
        if self.max_tcp_flows == 0 || self.max_tcp_flows > MAX_STACK_TCP_FLOWS {
            return Err(IpStackError::invalid(
                "IPSTACK_TCP_LIMIT_INVALID",
                "TCP flow limit is outside the bounded stack range",
            ));
        }
        if self.max_udp_associations == 0 || self.max_udp_associations > MAX_STACK_UDP_ASSOCIATIONS
        {
            return Err(IpStackError::invalid(
                "IPSTACK_UDP_LIMIT_INVALID",
                "UDP association limit is outside the bounded stack range",
            ));
        }
        if self.max_reassembly_bytes == 0 || self.max_reassembly_bytes > MAX_STACK_REASSEMBLY_BYTES
        {
            return Err(IpStackError::invalid(
                "IPSTACK_REASSEMBLY_LIMIT_INVALID",
                "fragment reassembly byte limit is outside the bounded range",
            ));
        }
        if self.max_packet_bytes < 1500 || self.max_packet_bytes > MAX_IP_PACKET_BYTES {
            return Err(IpStackError::invalid(
                "IPSTACK_PACKET_LIMIT_INVALID",
                "stack packet limit must cover an MTU and fit the L3 contract",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IpTransport {
    Tcp,
    Udp,
}

impl TryFrom<u8> for IpTransport {
    type Error = IpStackError;

    fn try_from(protocol: u8) -> Result<Self, Self::Error> {
        match protocol {
            6 => Ok(Self::Tcp),
            17 => Ok(Self::Udp),
            _ => Err(IpStackError::UnsupportedTransport { protocol }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpFlowKey {
    pub transport: IpTransport,
    pub source: SocketAddr,
    pub destination: SocketAddr,
}

impl IpFlowKey {
    pub fn validate(&self) -> Result<(), IpStackError> {
        if self.source.port() == 0 || self.destination.port() == 0 {
            return Err(IpStackError::invalid(
                "IPSTACK_FLOW_PORT_INVALID",
                "TCP/UDP flow ports must be non-zero",
            ));
        }
        if self.source.ip().is_unspecified()
            || self.destination.ip().is_unspecified()
            || self.destination.ip().is_multicast()
        {
            return Err(IpStackError::invalid(
                "IPSTACK_FLOW_ADDRESS_INVALID",
                "flow addresses must be concrete and destination must be unicast",
            ));
        }
        if matches!(self.source.ip(), std::net::IpAddr::V4(_))
            != matches!(self.destination.ip(), std::net::IpAddr::V4(_))
        {
            return Err(IpStackError::invalid(
                "IPSTACK_FLOW_FAMILY_MISMATCH",
                "flow source and destination families must match",
            ));
        }
        Ok(())
    }

    pub fn version(&self) -> IpVersion {
        match self.source.ip() {
            std::net::IpAddr::V4(_) => IpVersion::V4,
            std::net::IpAddr::V6(_) => IpVersion::V6,
        }
    }
}

/// Identity dimensions that must remain stable for the lifetime of a tuple.
/// Hostname hints are intentionally excluded: TLS/HTTP attribution may become
/// more precise after the first packet without changing the capture owner.
#[derive(Clone, PartialEq, Eq)]
pub struct FlowIdentityBinding {
    pub generation: u64,
    pub capture_id: Option<u64>,
    pub pid: Option<u32>,
    pub process_start_time: Option<u64>,
    pub app_kind: Option<AppSelectorKind>,
    pub app_identity: Option<String>,
    pub capture_intent: super::ingress::CaptureIntent,
    pub profile_binding: super::ingress::ProfileBinding,
}

impl fmt::Debug for FlowIdentityBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FlowIdentityBinding")
            .field("generation", &self.generation)
            .field("capture_id", &self.capture_id)
            .field("has_pid", &self.pid.is_some())
            .field("app_kind", &self.app_kind)
            .field("has_app_identity", &self.app_identity.is_some())
            .finish()
    }
}

impl From<&PacketIdentity> for FlowIdentityBinding {
    fn from(identity: &PacketIdentity) -> Self {
        Self {
            generation: identity.generation,
            capture_id: identity.capture_id,
            pid: identity.pid,
            process_start_time: identity.process_start_time,
            app_kind: identity.app_kind,
            app_identity: identity.app_identity.clone(),
            capture_intent: identity.capture_intent.clone(),
            profile_binding: identity.profile_binding.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowAdmission {
    New { flow_id: u64 },
    Existing { flow_id: u64 },
}

#[derive(Debug, Clone)]
struct FlowRecord {
    flow_id: u64,
    identity: FlowIdentityBinding,
}

/// Bounded tuple table shared by the selected IP stack and FlowRuntime bridge.
/// It rejects stale generations, identity races, unsupported transports and
/// table exhaustion before the stack allocates per-flow TCP/UDP state.
pub struct PacketFlowRegistry {
    config: IpStackConfig,
    flows: HashMap<IpFlowKey, FlowRecord>,
    active_tcp_flows: usize,
    active_udp_associations: usize,
    next_flow_id: u64,
}

impl fmt::Debug for PacketFlowRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketFlowRegistry")
            .field("generation", &self.config.generation)
            .field("platform", &self.config.platform)
            .field("active_flows", &self.flows.len())
            .field("active_tcp_flows", &self.active_tcp_flows)
            .field("active_udp_associations", &self.active_udp_associations)
            .finish()
    }
}

impl PacketFlowRegistry {
    pub fn new(config: IpStackConfig) -> Result<Self, IpStackError> {
        config.validate()?;
        Ok(Self {
            config,
            flows: HashMap::new(),
            active_tcp_flows: 0,
            active_udp_associations: 0,
            next_flow_id: 1,
        })
    }

    pub fn config(&self) -> &IpStackConfig {
        &self.config
    }

    pub fn len(&self) -> usize {
        self.flows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.flows.is_empty()
    }

    pub fn admit(
        &mut self,
        packet: &PacketFrame,
        key: IpFlowKey,
    ) -> Result<FlowAdmission, IpStackError> {
        let info = packet
            .validate_for(self.config.generation, self.config.platform)
            .map_err(IpStackError::Packet)?;
        if info.total_len > self.config.max_packet_bytes {
            return Err(IpStackError::PacketExceedsStackLimit {
                actual: info.total_len,
                limit: self.config.max_packet_bytes,
            });
        }
        validate_packet_key(&info, &key)?;
        key.validate()?;

        let identity = FlowIdentityBinding::from(&packet.identity);
        if let Some(existing) = self.flows.get(&key) {
            if existing.identity != identity {
                return Err(IpStackError::IdentityChanged);
            }
            return Ok(FlowAdmission::Existing {
                flow_id: existing.flow_id,
            });
        }

        let (active_for_key_transport, flow_limit) = match key.transport {
            IpTransport::Tcp => (self.active_tcp_flows, self.config.max_tcp_flows),
            IpTransport::Udp => (
                self.active_udp_associations,
                self.config.max_udp_associations,
            ),
        };
        // The table is intentionally bounded globally as well as by the
        // configured per-transport limit. Maintain explicit counters so an
        // attacker cannot turn admission into a linear scan of the flow table.
        if self.flows.len() >= self.config.max_tcp_flows + self.config.max_udp_associations
            || active_for_key_transport >= flow_limit
        {
            return Err(IpStackError::FlowTableFull);
        }

        let flow_id = self.allocate_flow_id()?;
        let transport = key.transport;
        self.flows.insert(key, FlowRecord { flow_id, identity });
        self.increment_transport(transport);
        Ok(FlowAdmission::New { flow_id })
    }

    pub fn remove(&mut self, key: &IpFlowKey) -> bool {
        if self.flows.remove(key).is_none() {
            return false;
        }
        self.decrement_transport(key.transport);
        true
    }

    pub fn clear(&mut self) {
        self.flows.clear();
        self.active_tcp_flows = 0;
        self.active_udp_associations = 0;
    }

    /// Convert a TCP table entry into the one canonical decoded-flow
    /// descriptor.  The IP stack supplies only the authoritative tuple and
    /// attribution hints; capture identity comes from the admitted record.
    pub fn tcp_descriptor(
        &self,
        key: &IpFlowKey,
        attribution: AttributionHints,
    ) -> Result<FlowDescriptor, IpStackError> {
        if key.transport != IpTransport::Tcp {
            return Err(IpStackError::invalid(
                "IPSTACK_TCP_DESCRIPTOR_REQUIRED",
                "only TCP table entries can become decoded TCP flows",
            ));
        }
        let record = self.flows.get(key).ok_or(IpStackError::FlowNotFound)?;
        let descriptor = FlowDescriptor {
            generation: record.identity.generation,
            flow_id: record.flow_id,
            platform: self.config.platform,
            source: key.source,
            destination: key.destination,
            attribution,
            pid: record.identity.pid,
            process_start_time: record.identity.process_start_time,
            app_kind: record.identity.app_kind,
            app_identity: record.identity.app_identity.clone(),
            capture_intent: record.identity.capture_intent.clone(),
            profile_binding: record.identity.profile_binding.clone(),
        };
        descriptor
            .validate_for(self.config.generation)
            .map_err(IpStackError::Descriptor)
            .map(|_| descriptor)
    }

    fn allocate_flow_id(&mut self) -> Result<u64, IpStackError> {
        let id = self.next_flow_id;
        self.next_flow_id = self
            .next_flow_id
            .checked_add(1)
            .ok_or(IpStackError::FlowIdExhausted)?;
        Ok(id)
    }

    fn increment_transport(&mut self, transport: IpTransport) {
        match transport {
            IpTransport::Tcp => self.active_tcp_flows += 1,
            IpTransport::Udp => self.active_udp_associations += 1,
        }
    }

    fn decrement_transport(&mut self, transport: IpTransport) {
        let active = match transport {
            IpTransport::Tcp => &mut self.active_tcp_flows,
            IpTransport::Udp => &mut self.active_udp_associations,
        };
        *active = active
            .checked_sub(1)
            .expect("flow registry transport count must match its tuple table");
    }
}

fn validate_packet_key(info: &IpPacketInfo, key: &IpFlowKey) -> Result<(), IpStackError> {
    let expected_version = key.version();
    if info.version != expected_version {
        return Err(IpStackError::invalid(
            "IPSTACK_PACKET_FAMILY_MISMATCH",
            "packet IP family does not match its decoded flow key",
        ));
    }
    // Fragmented packets do not carry an authoritative tuple until the
    // bounded reassembly layer has completed. Reject them before trusting a
    // caller-supplied TCP/UDP discriminator or decoded port/address fields.
    if info.fragmented {
        return Err(IpStackError::FragmentNeedsReassembly);
    }
    let expected_protocol = match key.transport {
        IpTransport::Tcp => 6,
        IpTransport::Udp => 17,
    };
    if info.transport_protocol != expected_protocol {
        return Err(IpStackError::invalid(
            "IPSTACK_PACKET_PROTOCOL_MISMATCH",
            "packet protocol does not match its decoded flow key",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IpStackError {
    #[error("{code}: {message}")]
    Invalid {
        code: &'static str,
        message: &'static str,
    },
    #[error("IPSTACK_UNSUPPORTED_TRANSPORT: protocol {protocol} is not TCP/UDP")]
    UnsupportedTransport { protocol: u8 },
    #[error("IPSTACK_PACKET_INVALID: packet did not satisfy the L3 contract")]
    Packet(PacketDeviceError),
    #[error("IPSTACK_DESCRIPTOR_INVALID: decoded TCP descriptor is invalid")]
    Descriptor(IngressError),
    #[error("IPSTACK_FLOW_TABLE_FULL: bounded flow table is exhausted")]
    FlowTableFull,
    #[error("IPSTACK_FLOW_ID_EXHAUSTED: flow id counter exhausted")]
    FlowIdExhausted,
    #[error("IPSTACK_IDENTITY_CHANGED: one tuple changed capture identity")]
    IdentityChanged,
    #[error("IPSTACK_FLOW_NOT_FOUND: tuple is not admitted")]
    FlowNotFound,
    #[error("IPSTACK_FRAGMENT_REASSEMBLY_REQUIRED: fragments need the bounded reassembly layer")]
    FragmentNeedsReassembly,
    #[error("IPSTACK_PACKET_LIMIT_EXCEEDED: packet is larger than the configured stack limit")]
    PacketExceedsStackLimit { actual: usize, limit: usize },
}

impl IpStackError {
    fn invalid(code: &'static str, message: &'static str) -> Self {
        Self::Invalid { code, message }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid { code, .. } => code,
            Self::UnsupportedTransport { .. } => "IPSTACK_UNSUPPORTED_TRANSPORT",
            Self::Packet(error) => error.code(),
            Self::Descriptor(error) => error.code(),
            Self::FlowTableFull => "IPSTACK_FLOW_TABLE_FULL",
            Self::FlowIdExhausted => "IPSTACK_FLOW_ID_EXHAUSTED",
            Self::IdentityChanged => "IPSTACK_IDENTITY_CHANGED",
            Self::FlowNotFound => "IPSTACK_FLOW_NOT_FOUND",
            Self::FragmentNeedsReassembly => "IPSTACK_FRAGMENT_REASSEMBLY_REQUIRED",
            Self::PacketExceedsStackLimit { .. } => "IPSTACK_PACKET_LIMIT_EXCEEDED",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};

    use bytes::Bytes;

    use super::*;
    use crate::sockscap::flow::ingress::{CaptureIntent, ProfileBinding};

    fn provider() -> IpStackProviderPin {
        IpStackProviderPin {
            name: "taomni-controlled-stack".into(),
            version: "0.1.0".into(),
            source_sha256: "a".repeat(64),
        }
    }

    fn config(max_tcp_flows: usize) -> IpStackConfig {
        IpStackConfig {
            generation: 7,
            platform: CapturePlatform::Linux,
            provider: provider(),
            max_tcp_flows,
            max_udp_associations: 4,
            max_reassembly_bytes: 1 << 20,
            max_packet_bytes: 1500,
        }
    }

    fn ipv4_packet(protocol: u8) -> Bytes {
        let mut packet = vec![0u8; 20];
        packet[0] = 0x45;
        packet[2..4].copy_from_slice(&20u16.to_be_bytes());
        packet[8] = 64;
        packet[9] = protocol;
        packet[12..16].copy_from_slice(&Ipv4Addr::LOCALHOST.octets());
        packet[16..20].copy_from_slice(&Ipv4Addr::new(198, 51, 100, 8).octets());
        packet.into()
    }

    fn ipv6_packet(next_header: u8, body: Vec<u8>) -> Bytes {
        let mut packet = vec![0u8; 40];
        packet[0] = 0x60;
        packet[4..6].copy_from_slice(&(body.len() as u16).to_be_bytes());
        packet[6] = next_header;
        packet[7] = 64;
        packet[8..24].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
        packet[24..40].copy_from_slice(&Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 8).octets());
        packet.extend_from_slice(&body);
        packet.into()
    }

    fn key(port: u16, transport: IpTransport) -> IpFlowKey {
        IpFlowKey {
            transport,
            source: SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            destination: SocketAddr::from((Ipv4Addr::new(198, 51, 100, 8), 443)),
        }
    }

    fn ipv6_key(port: u16, transport: IpTransport) -> IpFlowKey {
        IpFlowKey {
            transport,
            source: SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, port, 0, 0)),
            destination: SocketAddr::V6(SocketAddrV6::new(
                Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 8),
                443,
                0,
                0,
            )),
        }
    }

    fn packet(capture_id: u64, protocol: u8) -> PacketFrame {
        PacketFrame {
            identity: PacketIdentity::global(7, Some(capture_id), CapturePlatform::Linux),
            payload: ipv4_packet(protocol),
        }
    }

    fn tun_packet(protocol: u8) -> PacketFrame {
        PacketFrame {
            identity: PacketIdentity::global(7, None, CapturePlatform::Linux),
            payload: ipv4_packet(protocol),
        }
    }

    #[test]
    fn provider_pin_and_limits_are_fail_closed() {
        assert!(PacketFlowRegistry::new(config(2)).is_ok());
        let mut bad = config(2);
        bad.provider.source_sha256 = "not-a-hash".into();
        assert_eq!(
            PacketFlowRegistry::new(bad).unwrap_err().code(),
            "IPSTACK_PROVIDER_HASH_INVALID"
        );
        let mut bad = config(2);
        bad.max_packet_bytes = 1400;
        assert_eq!(
            PacketFlowRegistry::new(bad).unwrap_err().code(),
            "IPSTACK_PACKET_LIMIT_INVALID"
        );
    }

    #[test]
    fn tuple_admission_is_bounded_and_identity_is_immutable() {
        let mut registry = PacketFlowRegistry::new(config(1)).unwrap();
        assert_eq!(
            registry.admit(&packet(1, 6), key(40_000, IpTransport::Tcp)),
            Ok(FlowAdmission::New { flow_id: 1 })
        );
        assert_eq!(
            registry.admit(&packet(1, 6), key(40_000, IpTransport::Tcp)),
            Ok(FlowAdmission::Existing { flow_id: 1 })
        );
        assert_eq!(
            registry
                .admit(&packet(2, 6), key(40_000, IpTransport::Tcp))
                .unwrap_err()
                .code(),
            "IPSTACK_IDENTITY_CHANGED"
        );
        assert_eq!(
            registry
                .admit(&packet(3, 6), key(40_001, IpTransport::Tcp))
                .unwrap_err()
                .code(),
            "IPSTACK_FLOW_TABLE_FULL"
        );
    }

    #[test]
    fn tun_packets_without_native_flow_id_reuse_the_stack_flow() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let flow = key(40_000, IpTransport::Tcp);
        assert_eq!(
            registry.admit(&tun_packet(6), flow.clone()),
            Ok(FlowAdmission::New { flow_id: 1 })
        );
        assert_eq!(
            registry.admit(&tun_packet(6), flow),
            Ok(FlowAdmission::Existing { flow_id: 1 })
        );
    }

    #[test]
    fn protocol_and_family_mismatches_are_rejected() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        assert_eq!(
            registry
                .admit(&packet(1, 17), key(40_000, IpTransport::Tcp))
                .unwrap_err()
                .code(),
            "IPSTACK_PACKET_PROTOCOL_MISMATCH"
        );
        let ipv6_key = IpFlowKey {
            transport: IpTransport::Tcp,
            source: SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, 40_000, 0, 7)),
            destination: SocketAddr::V6(SocketAddrV6::new(
                Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 8),
                443,
                0,
                7,
            )),
        };
        assert_eq!(
            registry.admit(&packet(2, 6), ipv6_key).unwrap_err().code(),
            "IPSTACK_PACKET_FAMILY_MISMATCH"
        );
    }

    #[test]
    fn ipv6_extensions_use_the_final_transport_for_admission() {
        let mut body = Vec::new();
        body.extend_from_slice(&[60, 0, 0, 0, 0, 0, 0, 0]); // Hop-by-Hop
        body.extend_from_slice(&[6, 0, 0, 0, 0, 0, 0, 0]); // Destination
        body.extend_from_slice(&[0; 20]); // TCP header belongs to the provider
        let packet = PacketFrame {
            identity: PacketIdentity::global(7, Some(21), CapturePlatform::Linux),
            payload: ipv6_packet(0, body),
        };

        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        assert_eq!(
            registry.admit(&packet, ipv6_key(40_000, IpTransport::Tcp)),
            Ok(FlowAdmission::New { flow_id: 1 })
        );
    }

    #[test]
    fn ipv6_fragments_require_reassembly_before_tuple_or_transport_checks() {
        let mut body = Vec::new();
        body.extend_from_slice(&[44, 0, 0, 0, 0, 0, 0, 0]); // Hop-by-Hop
        body.extend_from_slice(&[17, 0, 0, 1, 0, 0, 0, 9]); // First Fragment, UDP
        body.extend_from_slice(&[0; 8]);
        let packet = PacketFrame {
            identity: PacketIdentity::global(7, Some(22), CapturePlatform::Linux),
            payload: ipv6_packet(0, body),
        };

        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        // This key has both the wrong transport and an invalid zero port. The
        // fragment must still be routed to reassembly before either is trusted.
        assert_eq!(
            registry
                .admit(&packet, ipv6_key(0, IpTransport::Tcp))
                .unwrap_err()
                .code(),
            "IPSTACK_FRAGMENT_REASSEMBLY_REQUIRED"
        );
        assert!(registry.is_empty());
    }

    #[test]
    fn ipv6_scope_id_is_part_of_the_flow_key() {
        let scoped_a = IpFlowKey {
            transport: IpTransport::Tcp,
            source: SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, 40_000, 0, 3)),
            destination: SocketAddr::V6(SocketAddrV6::new(
                Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 8),
                443,
                0,
                3,
            )),
        };
        let mut scoped_b = scoped_a.clone();
        if let SocketAddr::V6(addr) = &mut scoped_b.destination {
            *addr = SocketAddrV6::new(*addr.ip(), addr.port(), addr.flowinfo(), 4);
        }
        assert_ne!(scoped_a, scoped_b);
        assert!(scoped_a.validate().is_ok());
        assert!(scoped_b.validate().is_ok());
    }

    #[test]
    fn tcp_descriptor_keeps_identity_and_typed_tuple() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let flow_key = key(40_000, IpTransport::Tcp);
        registry.admit(&packet(9, 6), flow_key.clone()).unwrap();
        let descriptor = registry
            .tcp_descriptor(&flow_key, AttributionHints::default())
            .unwrap();
        assert_eq!(descriptor.flow_id, 1);
        assert_eq!(descriptor.destination.port(), 443);
        assert_eq!(
            descriptor.capture_intent,
            CaptureIntent::AllowGlobalFallback
        );
        assert_eq!(descriptor.profile_binding, ProfileBinding::AutoSelect);
    }

    #[test]
    fn udp_association_limit_is_independent_from_tcp_limit() {
        let mut registry = PacketFlowRegistry::new(config(1)).unwrap();
        for index in 0..4 {
            let port = 40_000 + index;
            assert!(
                registry
                    .admit(&packet(index as u64 + 1, 17), key(port, IpTransport::Udp))
                    .is_ok()
            );
        }
        assert_eq!(
            registry
                .admit(&packet(9, 17), key(40_004, IpTransport::Udp))
                .unwrap_err()
                .code(),
            "IPSTACK_FLOW_TABLE_FULL"
        );
    }

    #[test]
    fn transport_counts_follow_remove_clear_and_readmission() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let tcp_a = key(40_000, IpTransport::Tcp);
        let tcp_b = key(40_001, IpTransport::Tcp);
        let udp_a = key(41_000, IpTransport::Udp);
        let udp_b = key(41_001, IpTransport::Udp);

        assert_eq!(
            registry.admit(&packet(1, 6), tcp_a.clone()),
            Ok(FlowAdmission::New { flow_id: 1 })
        );
        assert_eq!(
            registry.admit(&packet(2, 17), udp_a.clone()),
            Ok(FlowAdmission::New { flow_id: 2 })
        );
        assert_eq!(
            registry.admit(&packet(3, 6), tcp_b.clone()),
            Ok(FlowAdmission::New { flow_id: 3 })
        );
        assert_eq!(
            registry.admit(&packet(4, 17), udp_b.clone()),
            Ok(FlowAdmission::New { flow_id: 4 })
        );
        assert_eq!(registry.active_tcp_flows, 2);
        assert_eq!(registry.active_udp_associations, 2);
        assert_eq!(registry.len(), 4);

        assert!(registry.remove(&tcp_a));
        assert!(registry.remove(&udp_a));
        assert!(!registry.remove(&tcp_a));
        assert_eq!(registry.active_tcp_flows, 1);
        assert_eq!(registry.active_udp_associations, 1);
        assert_eq!(registry.len(), 2);

        assert_eq!(
            registry.admit(&packet(5, 6), tcp_a.clone()),
            Ok(FlowAdmission::New { flow_id: 5 })
        );
        assert_eq!(
            registry.admit(&packet(6, 17), udp_a),
            Ok(FlowAdmission::New { flow_id: 6 })
        );
        assert_eq!(registry.active_tcp_flows, 2);
        assert_eq!(registry.active_udp_associations, 2);
        assert_eq!(registry.len(), 4);

        registry.clear();
        assert!(registry.is_empty());
        assert_eq!(registry.active_tcp_flows, 0);
        assert_eq!(registry.active_udp_associations, 0);
        assert_eq!(
            registry.admit(&packet(7, 17), udp_b),
            Ok(FlowAdmission::New { flow_id: 7 })
        );
        assert_eq!(registry.active_tcp_flows, 0);
        assert_eq!(registry.active_udp_associations, 1);
    }
}
