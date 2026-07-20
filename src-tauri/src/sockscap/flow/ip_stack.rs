//! Admission and lifecycle contract for the replaceable, controlled IP stack.
//!
//! The actual TCP/UDP implementation is intentionally behind this boundary.
//! This module owns the invariants that must hold regardless of whether the
//! eventual implementation is an audited embedded stack or a maintained
//! internal fork: pinned provenance, bounded state, generation fencing,
//! identity immutability, and preservation of IPv6 scope ids.

use std::collections::HashMap;
use std::fmt;
use std::net::{IpAddr, SocketAddr};

use serde::{Deserialize, Serialize};

use super::attribution::AttributionHints;
use super::ingress::{FlowDescriptor, FlowTransport, IngressError};
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
pub const MIN_STACK_MTU_BYTES: usize = 1_280;
pub const MAX_STACK_MTU_BYTES: usize = 9_000;
pub const MIN_STACK_PACKET_BYTES: usize = 1_500;
pub const MIN_STACK_TCP_BYTES_PER_FLOW: usize = 4 * 1024;
pub const MAX_STACK_TCP_BYTES_PER_FLOW: usize = 16 * 1024 * 1024;
pub const MIN_STACK_TCP_HANDSHAKE_DEADLINE_MS: u64 = 100;
pub const MAX_STACK_TCP_HANDSHAKE_DEADLINE_MS: u64 = 5 * 60 * 1_000;
pub const MIN_STACK_TCP_GRACEFUL_CLOSE_DEADLINE_MS: u64 = 100;
pub const MAX_STACK_TCP_GRACEFUL_CLOSE_DEADLINE_MS: u64 = 2 * 60 * 1_000;
pub const MIN_STACK_TCP_RESET_DEADLINE_MS: u64 = 1;
pub const MAX_STACK_TCP_RESET_DEADLINE_MS: u64 = 10_000;
pub const MIN_STACK_TOTAL_SOCKET_BYTES: usize = 64 * 1024;
pub const MAX_STACK_TOTAL_SOCKET_BYTES: usize = 2 * 1024 * 1024 * 1024;
pub const MIN_STACK_UDP_DATAGRAM_BYTES: usize = 512;
pub const MAX_STACK_UDP_DATAGRAM_BYTES: usize = 65_507;
pub const MIN_STACK_UDP_QUEUED_DATAGRAMS: usize = 1;
pub const MAX_STACK_UDP_QUEUED_DATAGRAMS: usize = 1_024;
pub const MIN_STACK_UDP_QUEUED_BYTES: usize = MIN_STACK_UDP_DATAGRAM_BYTES;
pub const MAX_STACK_UDP_QUEUED_BYTES: usize = 16 * 1024 * 1024;
/// Conservative accounting floor for the tuple, length, ownership and queue
/// state associated with one UDP payload. A provider whose concrete entry is
/// larger must reserve its concrete size instead of relying on this floor.
pub const MIN_STACK_UDP_METADATA_BYTES_PER_DATAGRAM: usize = 64;
pub const MAX_STACK_UDP_QUEUE_METADATA_BYTES: usize = 4 * 1024 * 1024;
pub const MIN_STACK_UDP_WILDCARD_BINDINGS: usize = 1;
pub const MAX_STACK_UDP_WILDCARD_BINDINGS: usize = MAX_STACK_UDP_ASSOCIATIONS;
pub const MIN_STACK_UDP_IDLE_TIMEOUT_MS: u64 = 1_000;
pub const MAX_STACK_UDP_IDLE_TIMEOUT_MS: u64 = 10 * 60 * 1_000;
pub const MIN_STACK_FRAGMENTS: usize = 1;
pub const MAX_STACK_FRAGMENTS: usize = 4_096;
pub const MIN_STACK_FRAGMENT_TIMEOUT_MS: u64 = 100;
pub const MAX_STACK_FRAGMENT_TIMEOUT_MS: u64 = 60_000;
pub const MIN_STACK_PACKET_WORK_PER_WAKE: usize = 1;
pub const MAX_STACK_PACKET_WORK_PER_WAKE: usize = 4_096;
pub const MIN_STACK_SOCKET_WORK_PER_WAKE: usize = 1;
pub const MAX_STACK_SOCKET_WORK_PER_WAKE: usize = 4_096;
pub const MIN_STACK_TX_STAGING_PACKETS: usize = 1;
pub const MAX_STACK_TX_STAGING_PACKETS: usize = 4_096;
pub const MIN_STACK_TX_STAGING_BYTES: usize = MIN_STACK_PACKET_BYTES;
pub const MAX_STACK_TX_STAGING_BYTES: usize = 256 * 1024 * 1024;
pub const MIN_STACK_TX_BACKPRESSURE_DEADLINE_MS: u64 = 1;
pub const MAX_STACK_TX_BACKPRESSURE_DEADLINE_MS: u64 = 30_000;

/// Checksum work that every selected provider must perform explicitly.
///
/// TUN-like devices normally require full validation. The second policy is
/// reserved for a capture source whose authenticated contract proves inbound
/// transport checksum validation happened before packets reached this stack.
/// IPv4 envelope validation and outbound checksums are never optional.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChecksumPolicy {
    VerifyInboundAndComputeOutbound,
    TrustValidatedInboundAndComputeOutbound,
}

/// Bounded ICMP behavior exposed by the controlled stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IcmpBehavior {
    Drop,
    ErrorsOnly,
    EchoAndErrors,
}

/// TCP timers that the provider actor must enforce even when its peer or the
/// egress bridge stops making progress. These are lifecycle deadlines, not
/// best-effort telemetry thresholds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpLifecycleDeadlines {
    pub handshake_ms: u64,
    pub graceful_close_ms: u64,
    pub reset_ms: u64,
}

impl Default for TcpLifecycleDeadlines {
    fn default() -> Self {
        Self {
            handshake_ms: 30_000,
            graceful_close_ms: 10_000,
            reset_ms: 1_000,
        }
    }
}

/// Memory owned by the asynchronous bridge between the provider's TCP socket
/// and FlowRuntime. These bytes are additional to the provider socket's own
/// `tcp_rx_bytes_per_flow` and `tcp_tx_bytes_per_flow` rings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpBridgeBudget {
    pub rx_bytes_per_flow: usize,
    pub tx_bytes_per_flow: usize,
}

impl Default for TcpBridgeBudget {
    fn default() -> Self {
        Self {
            rx_bytes_per_flow: MIN_STACK_TCP_BYTES_PER_FLOW,
            tx_bytes_per_flow: MIN_STACK_TCP_BYTES_PER_FLOW,
        }
    }
}

/// One bounded UDP queue. `payload_bytes` covers owned payload capacity while
/// `metadata_bytes` covers every occupied queue slot, including endpoints,
/// lengths, ownership state and container overhead. Providers must use the
/// larger of this reservation and their concrete type/layout accounting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpQueueBudget {
    pub datagrams: usize,
    pub payload_bytes: usize,
    pub metadata_bytes: usize,
}

impl UdpQueueBudget {
    pub fn for_full_datagrams(
        datagrams: usize,
        datagram_bytes: usize,
    ) -> Result<Self, IpStackError> {
        let payload_bytes = datagrams.checked_mul(datagram_bytes).ok_or_else(|| {
            IpStackError::invalid(
                "IPSTACK_UDP_QUEUE_BUDGET_OVERFLOW",
                "UDP queue datagram and payload reservation overflow",
            )
        })?;
        let metadata_bytes = datagrams
            .checked_mul(MIN_STACK_UDP_METADATA_BYTES_PER_DATAGRAM)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_UDP_QUEUE_BUDGET_OVERFLOW",
                    "UDP queue datagram and metadata reservation overflow",
                )
            })?;
        Ok(Self {
            datagrams,
            payload_bytes,
            metadata_bytes,
        })
    }

    fn validate(
        &self,
        datagram_bytes: usize,
        invalid_code: &'static str,
        invalid_message: &'static str,
    ) -> Result<usize, IpStackError> {
        let required_payload = self.datagrams.checked_mul(datagram_bytes).ok_or_else(|| {
            IpStackError::invalid(
                "IPSTACK_UDP_QUEUE_BUDGET_OVERFLOW",
                "UDP queue datagram and payload reservation overflow",
            )
        })?;
        let required_metadata = self
            .datagrams
            .checked_mul(MIN_STACK_UDP_METADATA_BYTES_PER_DATAGRAM)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_UDP_QUEUE_BUDGET_OVERFLOW",
                    "UDP queue datagram and metadata reservation overflow",
                )
            })?;
        let reserved = self
            .payload_bytes
            .checked_add(self.metadata_bytes)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_UDP_QUEUE_BUDGET_OVERFLOW",
                    "UDP queue payload and metadata budgets overflow",
                )
            })?;

        if !(MIN_STACK_UDP_QUEUED_DATAGRAMS..=MAX_STACK_UDP_QUEUED_DATAGRAMS)
            .contains(&self.datagrams)
            || !(MIN_STACK_UDP_QUEUED_BYTES..=MAX_STACK_UDP_QUEUED_BYTES)
                .contains(&self.payload_bytes)
            || self.metadata_bytes < required_metadata
            || self.metadata_bytes > MAX_STACK_UDP_QUEUE_METADATA_BYTES
            || self.payload_bytes < required_payload
        {
            return Err(IpStackError::invalid(invalid_code, invalid_message));
        }
        Ok(reserved)
    }
}

/// Per-association bridge queues in both directions. The names are from the
/// controlled stack's perspective and deliberately avoid an ambiguous single
/// "UDP queue" limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpAssociationQueueBudgets {
    pub stack_to_egress: UdpQueueBudget,
    pub egress_to_stack: UdpQueueBudget,
}

/// smoltcp-style UDP sockets bind a local destination and application code
/// demultiplexes remote endpoints. Every possible wildcard binding therefore
/// has independent RX/TX payload rings and metadata rings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpWildcardBindingBudgets {
    pub max_bindings: usize,
    pub rx: UdpQueueBudget,
    pub tx: UdpQueueBudget,
}

/// Capabilities are facts attested by the exact provider pin/build. They are
/// kept separate from requested policy so a permissive policy cannot silently
/// enable a feature missing from the provider.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpStackProviderCapabilities {
    pub bounded_fragment_reassembly: bool,
    pub validated_ipv6_extension_headers: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FragmentationPolicy {
    #[default]
    RejectAll,
    ProviderBoundedReassembly,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ipv6ExtensionHeaderPolicy {
    #[default]
    RejectAll,
    /// The pinned provider has been proven to accept the bounded Phase-1
    /// extension chain emitted by `PacketFrame` validation. Fragment headers
    /// remain governed independently by `FragmentationPolicy`.
    ProviderValidatedUnfragmented,
}

/// Provider-specific resources and protocol compatibility selected by the
/// product configuration builder. A runnable provider must consume every
/// field; defining this contract does not claim that the provider actor is
/// already implemented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpStackProviderResources {
    pub tcp_lifecycle: TcpLifecycleDeadlines,
    pub tcp_bridge: TcpBridgeBudget,
    pub udp_association_queues: UdpAssociationQueueBudgets,
    pub udp_wildcard_bindings: UdpWildcardBindingBudgets,
    pub capabilities: IpStackProviderCapabilities,
    pub fragmentation_policy: FragmentationPolicy,
    pub ipv6_extension_header_policy: Ipv6ExtensionHeaderPolicy,
}

impl IpStackProviderResources {
    /// Mechanical source-migration helper for pre-provider config literals.
    /// It selects symmetric queues, minimum bridge buffers and fail-closed
    /// protocol capabilities. Product builders should spell out reviewed
    /// values instead of treating these migration defaults as production
    /// tuning.
    pub fn source_compatibility_defaults(
        max_udp_associations: usize,
        udp_datagram_bytes: usize,
        queued_datagrams: usize,
        queued_payload_bytes: usize,
    ) -> Result<Self, IpStackError> {
        let metadata_bytes = queued_datagrams
            .checked_mul(MIN_STACK_UDP_METADATA_BYTES_PER_DATAGRAM)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_UDP_QUEUE_BUDGET_OVERFLOW",
                    "UDP queue compatibility metadata reservation overflow",
                )
            })?;
        let queue = UdpQueueBudget {
            datagrams: queued_datagrams,
            payload_bytes: queued_payload_bytes,
            metadata_bytes,
        };
        // Validate the derived queue immediately so this helper cannot create
        // a plausibly configured but under-reserved value.
        queue.validate(
            udp_datagram_bytes,
            "IPSTACK_UDP_ASSOCIATION_QUEUE_INVALID",
            "UDP association queue migration defaults are outside the bounded range",
        )?;
        Ok(Self {
            tcp_lifecycle: TcpLifecycleDeadlines::default(),
            tcp_bridge: TcpBridgeBudget::default(),
            udp_association_queues: UdpAssociationQueueBudgets {
                stack_to_egress: queue,
                egress_to_stack: queue,
            },
            udp_wildcard_bindings: UdpWildcardBindingBudgets {
                max_bindings: max_udp_associations,
                rx: queue,
                tx: queue,
            },
            capabilities: IpStackProviderCapabilities::default(),
            fragmentation_policy: FragmentationPolicy::RejectAll,
            ipv6_extension_header_policy: Ipv6ExtensionHeaderPolicy::RejectAll,
        })
    }
}

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
    pub mtu_bytes: usize,
    /// Provider-owned TCP socket RX ring. The bridge has a separate budget in
    /// `provider_resources.tcp_bridge`.
    pub tcp_rx_bytes_per_flow: usize,
    /// Provider-owned TCP socket TX ring. The bridge has a separate budget in
    /// `provider_resources.tcp_bridge`.
    pub tcp_tx_bytes_per_flow: usize,
    /// Ceiling for provider TCP rings, TCP bridge rings, both UDP association
    /// directions and every wildcard binding's RX/TX payload and metadata.
    pub total_socket_bytes: usize,
    pub udp_datagram_bytes: usize,
    pub provider_resources: IpStackProviderResources,
    pub udp_idle_timeout_ms: u64,
    pub max_fragments: usize,
    pub fragment_timeout_ms: u64,
    pub packet_work_per_wake: usize,
    pub socket_work_per_wake: usize,
    pub tx_staging_packets: usize,
    pub tx_staging_bytes: usize,
    pub tx_backpressure_deadline_ms: u64,
    pub checksum_policy: ChecksumPolicy,
    pub icmp_behavior: IcmpBehavior,
}

impl IpStackConfig {
    /// Exact provider-resident socket/bridge memory implied by this config.
    /// This excludes packet TX staging and optional fragment reassembly, which
    /// have independent hard ceilings, but includes every payload and metadata
    /// ring named in `provider_resources`.
    pub fn required_socket_bytes(&self) -> Result<usize, IpStackError> {
        let stack_tcp_bytes_per_flow = self
            .tcp_rx_bytes_per_flow
            .checked_add(self.tcp_tx_bytes_per_flow)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_SOCKET_BUDGET_OVERFLOW",
                    "TCP provider receive and transmit byte budgets overflow",
                )
            })?;
        let bridge_tcp_bytes_per_flow = self
            .provider_resources
            .tcp_bridge
            .rx_bytes_per_flow
            .checked_add(self.provider_resources.tcp_bridge.tx_bytes_per_flow)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_SOCKET_BUDGET_OVERFLOW",
                    "TCP bridge receive and transmit byte budgets overflow",
                )
            })?;
        let tcp_bytes_per_flow = stack_tcp_bytes_per_flow
            .checked_add(bridge_tcp_bytes_per_flow)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_SOCKET_BUDGET_OVERFLOW",
                    "combined TCP provider and bridge byte budgets overflow",
                )
            })?;
        let tcp_socket_bytes = self
            .max_tcp_flows
            .checked_mul(tcp_bytes_per_flow)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_SOCKET_BUDGET_OVERFLOW",
                    "aggregate TCP provider and bridge byte budgets overflow",
                )
            })?;

        let association_stack_to_egress = self
            .provider_resources
            .udp_association_queues
            .stack_to_egress
            .validate(
                self.udp_datagram_bytes,
                "IPSTACK_UDP_ASSOCIATION_QUEUE_INVALID",
                "stack-to-egress UDP association queue is outside the bounded range",
            )?;
        let association_egress_to_stack = self
            .provider_resources
            .udp_association_queues
            .egress_to_stack
            .validate(
                self.udp_datagram_bytes,
                "IPSTACK_UDP_ASSOCIATION_QUEUE_INVALID",
                "egress-to-stack UDP association queue is outside the bounded range",
            )?;
        let udp_bytes_per_association = association_stack_to_egress
            .checked_add(association_egress_to_stack)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_UDP_QUEUE_BUDGET_OVERFLOW",
                    "combined UDP association queue budgets overflow",
                )
            })?;
        let udp_association_bytes = self
            .max_udp_associations
            .checked_mul(udp_bytes_per_association)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_SOCKET_BUDGET_OVERFLOW",
                    "aggregate UDP association queue budgets overflow",
                )
            })?;

        let wildcard_rx = self.provider_resources.udp_wildcard_bindings.rx.validate(
            self.udp_datagram_bytes,
            "IPSTACK_UDP_WILDCARD_QUEUE_INVALID",
            "UDP wildcard binding RX queue is outside the bounded range",
        )?;
        let wildcard_tx = self.provider_resources.udp_wildcard_bindings.tx.validate(
            self.udp_datagram_bytes,
            "IPSTACK_UDP_WILDCARD_QUEUE_INVALID",
            "UDP wildcard binding TX queue is outside the bounded range",
        )?;
        let udp_bytes_per_binding = wildcard_rx.checked_add(wildcard_tx).ok_or_else(|| {
            IpStackError::invalid(
                "IPSTACK_UDP_WILDCARD_BUDGET_OVERFLOW",
                "combined UDP wildcard binding queue budgets overflow",
            )
        })?;
        let udp_wildcard_bytes = self
            .provider_resources
            .udp_wildcard_bindings
            .max_bindings
            .checked_mul(udp_bytes_per_binding)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_SOCKET_BUDGET_OVERFLOW",
                    "aggregate UDP wildcard binding budgets overflow",
                )
            })?;

        tcp_socket_bytes
            .checked_add(udp_association_bytes)
            .and_then(|bytes| bytes.checked_add(udp_wildcard_bytes))
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_SOCKET_BUDGET_OVERFLOW",
                    "combined TCP and UDP provider byte budgets overflow",
                )
            })
    }

    pub fn validate(&self) -> Result<(), IpStackError> {
        if self.generation == 0 || self.platform == CapturePlatform::Unknown {
            return Err(IpStackError::invalid(
                "IPSTACK_CONFIG_IDENTITY_INVALID",
                "stack generation and platform must be explicit",
            ));
        }
        self.provider.validate()?;

        // The packet queue carries the full L3 packet. Reserve the larger
        // IPv6 base header plus UDP header even though the common ingress
        // datagram ceiling is also valid for IPv4. When fragmentation is
        // disabled the complete datagram must fit the configured MTU too.
        let udp_packet_bytes = self.udp_datagram_bytes.checked_add(40 + 8).ok_or_else(|| {
            IpStackError::invalid(
                "IPSTACK_UDP_PACKET_BUDGET_OVERFLOW",
                "UDP payload and IPv6/UDP headers overflow the packet budget",
            )
        })?;
        let fragment_bytes = self
            .max_fragments
            .checked_mul(self.max_packet_bytes)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_FRAGMENT_BUDGET_OVERFLOW",
                    "fragment count and packet byte budget overflow",
                )
            })?;
        let tx_staging_packet_bytes = self
            .tx_staging_packets
            .checked_mul(self.max_packet_bytes)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_TX_STAGING_BUDGET_OVERFLOW",
                    "TX staging packet and packet byte budget overflow",
                )
            })?;
        self.max_tcp_flows
            .checked_add(self.max_udp_associations)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_FLOW_LIMIT_OVERFLOW",
                    "combined TCP and UDP flow limits overflow",
                )
            })?;
        // Compute the full provider memory reservation before rejecting
        // individual out-of-range fields. Malicious deserialized values must
        // never reach unchecked addition or multiplication merely because a
        // different validation branch would also reject them.
        let socket_bytes = self.required_socket_bytes()?;

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
        if self.max_packet_bytes < MIN_STACK_PACKET_BYTES
            || self.max_packet_bytes > MAX_IP_PACKET_BYTES
        {
            return Err(IpStackError::invalid(
                "IPSTACK_PACKET_LIMIT_INVALID",
                "stack packet limit must cover an MTU and fit the L3 contract",
            ));
        }
        if self.mtu_bytes < MIN_STACK_MTU_BYTES
            || self.mtu_bytes > MAX_STACK_MTU_BYTES
            || self.mtu_bytes > self.max_packet_bytes
        {
            return Err(IpStackError::invalid(
                "IPSTACK_MTU_INVALID",
                "MTU is outside the bounded range or exceeds the packet limit",
            ));
        }
        if self.tcp_rx_bytes_per_flow < MIN_STACK_TCP_BYTES_PER_FLOW
            || self.tcp_rx_bytes_per_flow > MAX_STACK_TCP_BYTES_PER_FLOW
            || self.tcp_tx_bytes_per_flow < MIN_STACK_TCP_BYTES_PER_FLOW
            || self.tcp_tx_bytes_per_flow > MAX_STACK_TCP_BYTES_PER_FLOW
        {
            return Err(IpStackError::invalid(
                "IPSTACK_TCP_BUFFER_LIMIT_INVALID",
                "per-flow TCP receive/transmit budgets are outside the bounded range",
            ));
        }
        let tcp_lifecycle = self.provider_resources.tcp_lifecycle;
        if !(MIN_STACK_TCP_HANDSHAKE_DEADLINE_MS..=MAX_STACK_TCP_HANDSHAKE_DEADLINE_MS)
            .contains(&tcp_lifecycle.handshake_ms)
            || !(MIN_STACK_TCP_GRACEFUL_CLOSE_DEADLINE_MS
                ..=MAX_STACK_TCP_GRACEFUL_CLOSE_DEADLINE_MS)
                .contains(&tcp_lifecycle.graceful_close_ms)
            || !(MIN_STACK_TCP_RESET_DEADLINE_MS..=MAX_STACK_TCP_RESET_DEADLINE_MS)
                .contains(&tcp_lifecycle.reset_ms)
            || tcp_lifecycle.reset_ms > tcp_lifecycle.graceful_close_ms
        {
            return Err(IpStackError::invalid(
                "IPSTACK_TCP_LIFECYCLE_DEADLINE_INVALID",
                "TCP handshake, graceful-close, and reset deadlines are outside the bounded lifecycle contract",
            ));
        }
        let tcp_bridge = self.provider_resources.tcp_bridge;
        if !(MIN_STACK_TCP_BYTES_PER_FLOW..=MAX_STACK_TCP_BYTES_PER_FLOW)
            .contains(&tcp_bridge.rx_bytes_per_flow)
            || !(MIN_STACK_TCP_BYTES_PER_FLOW..=MAX_STACK_TCP_BYTES_PER_FLOW)
                .contains(&tcp_bridge.tx_bytes_per_flow)
        {
            return Err(IpStackError::invalid(
                "IPSTACK_TCP_BRIDGE_BUFFER_LIMIT_INVALID",
                "per-flow TCP bridge receive/transmit budgets are outside the bounded range",
            ));
        }
        if self.total_socket_bytes < MIN_STACK_TOTAL_SOCKET_BYTES
            || self.total_socket_bytes > MAX_STACK_TOTAL_SOCKET_BYTES
        {
            return Err(IpStackError::invalid(
                "IPSTACK_TOTAL_SOCKET_BUDGET_INVALID",
                "total socket byte budget is outside the bounded range",
            ));
        }
        if self.udp_datagram_bytes < MIN_STACK_UDP_DATAGRAM_BYTES
            || self.udp_datagram_bytes > MAX_STACK_UDP_DATAGRAM_BYTES
            || udp_packet_bytes > self.max_packet_bytes
        {
            return Err(IpStackError::invalid(
                "IPSTACK_UDP_DATAGRAM_LIMIT_INVALID",
                "UDP datagram and mandatory headers do not fit the bounded packet range",
            ));
        }
        if self.provider_resources.udp_wildcard_bindings.max_bindings
            < MIN_STACK_UDP_WILDCARD_BINDINGS
            || self.provider_resources.udp_wildcard_bindings.max_bindings
                > MAX_STACK_UDP_WILDCARD_BINDINGS
            || self.provider_resources.udp_wildcard_bindings.max_bindings
                > self.max_udp_associations
        {
            return Err(IpStackError::invalid(
                "IPSTACK_UDP_WILDCARD_BINDING_LIMIT_INVALID",
                "UDP wildcard binding limit must be bounded by the association limit",
            ));
        }
        if self.provider_resources.fragmentation_policy
            == FragmentationPolicy::ProviderBoundedReassembly
            && !self
                .provider_resources
                .capabilities
                .bounded_fragment_reassembly
        {
            return Err(IpStackError::invalid(
                "IPSTACK_FRAGMENT_CAPABILITY_REQUIRED",
                "fragment reassembly policy requires an attested bounded provider capability",
            ));
        }
        if self.provider_resources.ipv6_extension_header_policy
            == Ipv6ExtensionHeaderPolicy::ProviderValidatedUnfragmented
            && !self
                .provider_resources
                .capabilities
                .validated_ipv6_extension_headers
        {
            return Err(IpStackError::invalid(
                "IPSTACK_IPV6_EXTENSION_CAPABILITY_REQUIRED",
                "IPv6 extension compatibility requires an attested provider capability",
            ));
        }
        match self.provider_resources.fragmentation_policy {
            FragmentationPolicy::RejectAll => {
                if self.max_reassembly_bytes != 0
                    || self.max_fragments != 0
                    || self.fragment_timeout_ms != 0
                {
                    return Err(IpStackError::invalid(
                        "IPSTACK_FRAGMENT_REJECT_BUDGET_INVALID",
                        "fragment rejection must not advertise unused reassembly resources",
                    ));
                }
                if udp_packet_bytes > self.mtu_bytes {
                    return Err(IpStackError::invalid(
                        "IPSTACK_UDP_MTU_FRAGMENTATION_REQUIRED",
                        "UDP payload plus IPv6/UDP headers exceeds MTU while fragmentation is disabled",
                    ));
                }
            }
            FragmentationPolicy::ProviderBoundedReassembly => {
                if self.max_reassembly_bytes == 0
                    || self.max_reassembly_bytes > MAX_STACK_REASSEMBLY_BYTES
                {
                    return Err(IpStackError::invalid(
                        "IPSTACK_REASSEMBLY_LIMIT_INVALID",
                        "fragment reassembly byte limit is outside the bounded range",
                    ));
                }
                if self.max_fragments < MIN_STACK_FRAGMENTS
                    || self.max_fragments > MAX_STACK_FRAGMENTS
                    || fragment_bytes > self.max_reassembly_bytes
                {
                    return Err(IpStackError::invalid(
                        "IPSTACK_FRAGMENT_LIMIT_INVALID",
                        "fragment count cannot fit within the reassembly byte budget",
                    ));
                }
                if !(MIN_STACK_FRAGMENT_TIMEOUT_MS..=MAX_STACK_FRAGMENT_TIMEOUT_MS)
                    .contains(&self.fragment_timeout_ms)
                {
                    return Err(IpStackError::invalid(
                        "IPSTACK_FRAGMENT_TIMEOUT_INVALID",
                        "fragment timeout is outside the bounded range",
                    ));
                }
            }
        }
        if !(MIN_STACK_UDP_IDLE_TIMEOUT_MS..=MAX_STACK_UDP_IDLE_TIMEOUT_MS)
            .contains(&self.udp_idle_timeout_ms)
        {
            return Err(IpStackError::invalid(
                "IPSTACK_UDP_IDLE_TIMEOUT_INVALID",
                "UDP idle timeout is outside the bounded range",
            ));
        }
        if self.packet_work_per_wake < MIN_STACK_PACKET_WORK_PER_WAKE
            || self.packet_work_per_wake > MAX_STACK_PACKET_WORK_PER_WAKE
        {
            return Err(IpStackError::invalid(
                "IPSTACK_PACKET_WORK_QUOTA_INVALID",
                "per-wake packet work quota is outside the bounded range",
            ));
        }
        if self.socket_work_per_wake < MIN_STACK_SOCKET_WORK_PER_WAKE
            || self.socket_work_per_wake > MAX_STACK_SOCKET_WORK_PER_WAKE
        {
            return Err(IpStackError::invalid(
                "IPSTACK_SOCKET_WORK_QUOTA_INVALID",
                "per-wake socket work quota is outside the bounded range",
            ));
        }
        if self.tx_staging_packets < MIN_STACK_TX_STAGING_PACKETS
            || self.tx_staging_packets > MAX_STACK_TX_STAGING_PACKETS
        {
            return Err(IpStackError::invalid(
                "IPSTACK_TX_STAGING_PACKET_LIMIT_INVALID",
                "TX staging packet limit is outside the bounded range",
            ));
        }
        if self.tx_staging_bytes < MIN_STACK_TX_STAGING_BYTES
            || self.tx_staging_bytes > MAX_STACK_TX_STAGING_BYTES
            || tx_staging_packet_bytes > self.tx_staging_bytes
        {
            return Err(IpStackError::invalid(
                "IPSTACK_TX_STAGING_BYTES_INVALID",
                "TX staging bytes cannot contain the staged packet budget",
            ));
        }
        if !(MIN_STACK_TX_BACKPRESSURE_DEADLINE_MS..=MAX_STACK_TX_BACKPRESSURE_DEADLINE_MS)
            .contains(&self.tx_backpressure_deadline_ms)
        {
            return Err(IpStackError::invalid(
                "IPSTACK_TX_BACKPRESSURE_DEADLINE_INVALID",
                "TX backpressure deadline is outside the bounded range",
            ));
        }
        if socket_bytes > self.total_socket_bytes {
            return Err(IpStackError::invalid(
                "IPSTACK_TOTAL_SOCKET_BUDGET_EXCEEDED",
                "TCP provider/bridge buffers and UDP payload/metadata queues exceed the total socket byte budget",
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

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpFlowKey {
    pub transport: IpTransport,
    pub source: SocketAddr,
    pub destination: SocketAddr,
}

impl fmt::Debug for IpFlowKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IpFlowKey")
            .field("transport", &self.transport)
            .field("version", &self.version())
            .field("has_source", &true)
            .field("has_destination", &true)
            .finish()
    }
}

impl IpFlowKey {
    pub fn validate(&self) -> Result<(), IpStackError> {
        if self.source.port() == 0 || self.destination.port() == 0 {
            return Err(IpStackError::invalid(
                "IPSTACK_FLOW_PORT_INVALID",
                "TCP/UDP flow ports must be non-zero",
            ));
        }
        let source_ip = self.source.ip();
        let destination_ip = self.destination.ip();
        if source_ip.is_unspecified()
            || destination_ip.is_unspecified()
            || source_ip.is_multicast()
            || destination_ip.is_multicast()
            || is_ipv4_limited_broadcast(source_ip)
            || is_ipv4_limited_broadcast(destination_ip)
        {
            return Err(IpStackError::invalid(
                "IPSTACK_FLOW_ADDRESS_INVALID",
                "flow addresses must be concrete unicast addresses",
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
        if socket_has_unscoped_ipv6_link_local(&self.source)
            || socket_has_unscoped_ipv6_link_local(&self.destination)
        {
            return Err(IpStackError::Ipv6ScopeRequired);
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

/// Authoritative tuple and table outcome derived from one validated packet.
/// Callers cannot provide a second, independently forgeable tuple.
#[derive(Clone, PartialEq, Eq)]
pub struct PacketFlowAdmission {
    pub key: IpFlowKey,
    pub admission: FlowAdmission,
}

impl fmt::Debug for PacketFlowAdmission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PacketFlowAdmission")
            .field("key", &self.key)
            .field("admission", &self.admission)
            .finish()
    }
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

    pub fn admit(&mut self, packet: &PacketFrame) -> Result<PacketFlowAdmission, IpStackError> {
        let info = packet
            .validate_for(self.config.generation, self.config.platform)
            .map_err(IpStackError::Packet)?;
        if info.total_len > self.config.max_packet_bytes {
            return Err(IpStackError::PacketExceedsStackLimit {
                actual: info.total_len,
                limit: self.config.max_packet_bytes,
            });
        }
        if info.version == IpVersion::V6
            && info.transport_offset.is_some_and(|offset| offset > 40)
            && self.config.provider_resources.ipv6_extension_header_policy
                == Ipv6ExtensionHeaderPolicy::RejectAll
        {
            return Err(IpStackError::invalid(
                "IPSTACK_IPV6_EXTENSION_HEADER_UNSUPPORTED",
                "the selected provider rejects IPv6 extension headers fail-closed",
            ));
        }
        let DerivedPacketFlow { key, tcp_control } =
            derive_packet_flow_key(packet, &info, self.config.checksum_policy)?;

        let identity = FlowIdentityBinding::from(&packet.identity);
        if let Some(existing) = self.flows.get(&key) {
            if existing.identity != identity {
                return Err(IpStackError::IdentityChanged);
            }
            return Ok(PacketFlowAdmission {
                key,
                admission: FlowAdmission::Existing {
                    flow_id: existing.flow_id,
                },
            });
        }

        if key.transport == IpTransport::Tcp
            && !tcp_control.is_some_and(TcpControlFacts::can_create_flow)
        {
            return Err(IpStackError::invalid(
                "IPSTACK_TCP_INITIAL_PACKET_INVALID",
                "a new TCP flow must start with SYN and without ACK, RST, or FIN",
            ));
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
        let table_limit = self
            .config
            .max_tcp_flows
            .checked_add(self.config.max_udp_associations)
            .ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_FLOW_LIMIT_OVERFLOW",
                    "combined TCP and UDP flow limits overflow",
                )
            })?;
        if self.flows.len() >= table_limit || active_for_key_transport >= flow_limit {
            return Err(IpStackError::FlowTableFull);
        }

        let flow_id = self.allocate_flow_id()?;
        let transport = key.transport;
        self.increment_transport(transport)?;
        self.flows
            .insert(key.clone(), FlowRecord { flow_id, identity });
        Ok(PacketFlowAdmission {
            key,
            admission: FlowAdmission::New { flow_id },
        })
    }

    pub fn remove(&mut self, key: &IpFlowKey) -> bool {
        if !self.flows.contains_key(key) || !self.decrement_transport(key.transport) {
            return false;
        }
        self.flows.remove(key).is_some()
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
        self.descriptor(key, IpTransport::Tcp, attribution)
    }

    /// Convert a UDP table entry into the canonical decoded-flow descriptor.
    pub fn udp_descriptor(
        &self,
        key: &IpFlowKey,
        attribution: AttributionHints,
    ) -> Result<FlowDescriptor, IpStackError> {
        self.descriptor(key, IpTransport::Udp, attribution)
    }

    fn descriptor(
        &self,
        key: &IpFlowKey,
        expected_transport: IpTransport,
        attribution: AttributionHints,
    ) -> Result<FlowDescriptor, IpStackError> {
        if key.transport != expected_transport {
            let (code, message) = match expected_transport {
                IpTransport::Tcp => (
                    "IPSTACK_TCP_DESCRIPTOR_REQUIRED",
                    "only TCP table entries can become decoded TCP flows",
                ),
                IpTransport::Udp => (
                    "IPSTACK_UDP_DESCRIPTOR_REQUIRED",
                    "only UDP table entries can become decoded UDP flows",
                ),
            };
            return Err(IpStackError::invalid(code, message));
        }
        let record = self.flows.get(key).ok_or(IpStackError::FlowNotFound)?;
        let descriptor = FlowDescriptor {
            generation: record.identity.generation,
            flow_id: record.flow_id,
            platform: self.config.platform,
            transport: match expected_transport {
                IpTransport::Tcp => FlowTransport::Tcp,
                IpTransport::Udp => FlowTransport::Udp,
            },
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

    fn increment_transport(&mut self, transport: IpTransport) -> Result<(), IpStackError> {
        let active = match transport {
            IpTransport::Tcp => &mut self.active_tcp_flows,
            IpTransport::Udp => &mut self.active_udp_associations,
        };
        *active = active.checked_add(1).ok_or_else(|| {
            IpStackError::invalid(
                "IPSTACK_FLOW_COUNT_OVERFLOW",
                "active transport flow count overflowed",
            )
        })?;
        Ok(())
    }

    fn decrement_transport(&mut self, transport: IpTransport) -> bool {
        let active = match transport {
            IpTransport::Tcp => &mut self.active_tcp_flows,
            IpTransport::Udp => &mut self.active_udp_associations,
        };
        let Some(updated) = active.checked_sub(1) else {
            return false;
        };
        *active = updated;
        true
    }
}

#[derive(Clone, Copy)]
struct TcpControlFacts {
    flags: u8,
}

impl TcpControlFacts {
    fn can_create_flow(self) -> bool {
        const FIN: u8 = 0x01;
        const SYN: u8 = 0x02;
        const RST: u8 = 0x04;
        const ACK: u8 = 0x10;

        self.flags & SYN != 0 && self.flags & (FIN | RST | ACK) == 0
    }
}

struct DerivedPacketFlow {
    key: IpFlowKey,
    tcp_control: Option<TcpControlFacts>,
}

fn derive_packet_flow_key(
    packet: &PacketFrame,
    info: &IpPacketInfo,
    checksum_policy: ChecksumPolicy,
) -> Result<DerivedPacketFlow, IpStackError> {
    // A fragment's bytes cannot authorize a tuple before bounded reassembly,
    // even when its first bytes resemble a valid transport header.
    if info.fragmented {
        return Err(IpStackError::FragmentNeedsReassembly);
    }
    let transport_offset = info.transport_offset.ok_or_else(|| {
        IpStackError::invalid(
            "IPSTACK_TRANSPORT_OFFSET_UNTRUSTED",
            "packet has no validated transport-header offset",
        )
    })?;
    let transport = IpTransport::try_from(info.transport_protocol)?;
    let segment = packet
        .payload
        .get(transport_offset..info.total_len)
        .ok_or_else(|| {
            IpStackError::invalid(
                "IPSTACK_TRANSPORT_OFFSET_INVALID",
                "transport-header offset exceeds the validated packet",
            )
        })?;

    if info.version == IpVersion::V4 {
        let header = packet.payload.get(..transport_offset).ok_or_else(|| {
            IpStackError::invalid(
                "IPSTACK_IPV4_HEADER_INVALID",
                "validated IPv4 header offset exceeds the packet",
            )
        })?;
        if !checksum_is_valid(checksum_accumulate(0, header)) {
            return Err(IpStackError::invalid(
                "IPSTACK_IPV4_HEADER_CHECKSUM_INVALID",
                "IPv4 header checksum is invalid",
            ));
        }
    }

    let (source_port, destination_port, udp_checksum_is_zero, tcp_control) = match transport {
        IpTransport::Tcp => {
            let header = segment.get(..20).ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_TCP_HEADER_INVALID",
                    "TCP segment is shorter than its minimum header",
                )
            })?;
            let header_words = usize::from(header[12] >> 4);
            let header_len = header_words.checked_mul(4).ok_or_else(|| {
                IpStackError::invalid("IPSTACK_TCP_HEADER_INVALID", "TCP data offset overflowed")
            })?;
            if header_len < 20 || header_len > segment.len() {
                return Err(IpStackError::invalid(
                    "IPSTACK_TCP_HEADER_INVALID",
                    "TCP data offset is smaller than the minimum or exceeds the segment",
                ));
            }
            let (source_port, destination_port) = read_transport_ports(header)?;
            (
                source_port,
                destination_port,
                false,
                Some(TcpControlFacts { flags: header[13] }),
            )
        }
        IpTransport::Udp => {
            let header = segment.get(..8).ok_or_else(|| {
                IpStackError::invalid(
                    "IPSTACK_UDP_HEADER_INVALID",
                    "UDP datagram is shorter than its header",
                )
            })?;
            let declared_len = usize::from(u16::from_be_bytes([header[4], header[5]]));
            if declared_len < 8 || declared_len != segment.len() {
                return Err(IpStackError::invalid(
                    "IPSTACK_UDP_LENGTH_INVALID",
                    "UDP length must cover the header and exactly match the IP payload",
                ));
            }
            let checksum_is_zero = header[6] == 0 && header[7] == 0;
            let (source_port, destination_port) = read_transport_ports(header)?;
            (source_port, destination_port, checksum_is_zero, None)
        }
    };

    validate_packet_address_family(info)?;
    if ip_requires_scope_id(info.source) || ip_requires_scope_id(info.destination) {
        // PacketIdentity currently carries no authenticated interface index.
        // Do not invent scope 0: native adapters must add a trusted scope
        // contract before link-local flows can be admitted.
        return Err(IpStackError::Ipv6ScopeRequired);
    }
    let key = IpFlowKey {
        transport,
        source: SocketAddr::new(info.source, source_port),
        destination: SocketAddr::new(info.destination, destination_port),
    };
    key.validate()?;

    if transport == IpTransport::Udp && info.version == IpVersion::V6 && udp_checksum_is_zero {
        return Err(IpStackError::invalid(
            "IPSTACK_IPV6_UDP_CHECKSUM_REQUIRED",
            "IPv6 UDP datagrams must carry a non-zero checksum",
        ));
    }
    let may_skip_transport_checksum = checksum_policy
        == ChecksumPolicy::TrustValidatedInboundAndComputeOutbound
        || (transport == IpTransport::Udp && info.version == IpVersion::V4 && udp_checksum_is_zero);
    if !may_skip_transport_checksum {
        let sum = transport_pseudo_header_sum(info, segment.len())?;
        if !checksum_is_valid(checksum_accumulate(sum, segment)) {
            return Err(IpStackError::invalid(
                "IPSTACK_TRANSPORT_CHECKSUM_INVALID",
                "TCP/UDP pseudo-header checksum is invalid",
            ));
        }
    }
    Ok(DerivedPacketFlow { key, tcp_control })
}

fn read_transport_ports(header: &[u8]) -> Result<(u16, u16), IpStackError> {
    let ports = header.get(..4).ok_or_else(|| {
        IpStackError::invalid(
            "IPSTACK_TRANSPORT_HEADER_INVALID",
            "transport header does not contain both ports",
        )
    })?;
    Ok((
        u16::from_be_bytes([ports[0], ports[1]]),
        u16::from_be_bytes([ports[2], ports[3]]),
    ))
}

fn validate_packet_address_family(info: &IpPacketInfo) -> Result<(), IpStackError> {
    let matches = matches!(
        (info.version, info.source, info.destination),
        (IpVersion::V4, IpAddr::V4(_), IpAddr::V4(_))
            | (IpVersion::V6, IpAddr::V6(_), IpAddr::V6(_))
    );
    if matches {
        Ok(())
    } else {
        Err(IpStackError::invalid(
            "IPSTACK_PACKET_FAMILY_MISMATCH",
            "parsed packet addresses do not match its IP version",
        ))
    }
}

fn ip_requires_scope_id(address: IpAddr) -> bool {
    matches!(address, IpAddr::V6(address) if address.is_unicast_link_local())
}

fn is_ipv4_limited_broadcast(address: IpAddr) -> bool {
    matches!(address, IpAddr::V4(address) if address == std::net::Ipv4Addr::BROADCAST)
}

fn socket_has_unscoped_ipv6_link_local(address: &SocketAddr) -> bool {
    matches!(
        address,
        SocketAddr::V6(address)
            if address.ip().is_unicast_link_local() && address.scope_id() == 0
    )
}

fn transport_pseudo_header_sum(
    info: &IpPacketInfo,
    segment_len: usize,
) -> Result<u64, IpStackError> {
    let mut sum = 0u64;
    match (info.version, info.source, info.destination) {
        (IpVersion::V4, IpAddr::V4(source), IpAddr::V4(destination)) => {
            let length = u16::try_from(segment_len).map_err(|_| {
                IpStackError::invalid(
                    "IPSTACK_TRANSPORT_LENGTH_INVALID",
                    "IPv4 transport segment exceeds its pseudo-header length field",
                )
            })?;
            sum = checksum_accumulate(sum, &source.octets());
            sum = checksum_accumulate(sum, &destination.octets());
            sum = checksum_accumulate(sum, &[0, info.transport_protocol]);
            sum = checksum_accumulate(sum, &length.to_be_bytes());
        }
        (IpVersion::V6, IpAddr::V6(source), IpAddr::V6(destination)) => {
            let length = u32::try_from(segment_len).map_err(|_| {
                IpStackError::invalid(
                    "IPSTACK_TRANSPORT_LENGTH_INVALID",
                    "IPv6 transport segment exceeds its pseudo-header length field",
                )
            })?;
            sum = checksum_accumulate(sum, &source.octets());
            sum = checksum_accumulate(sum, &destination.octets());
            sum = checksum_accumulate(sum, &length.to_be_bytes());
            sum = checksum_accumulate(sum, &[0, 0, 0, info.transport_protocol]);
        }
        _ => {
            return Err(IpStackError::invalid(
                "IPSTACK_PACKET_FAMILY_MISMATCH",
                "parsed packet addresses do not match its IP version",
            ));
        }
    }
    Ok(sum)
}

fn checksum_accumulate(mut sum: u64, bytes: &[u8]) -> u64 {
    let mut words = bytes.chunks_exact(2);
    for word in &mut words {
        sum += u64::from(u16::from_be_bytes([word[0], word[1]]));
    }
    if let Some(last) = words.remainder().first() {
        sum += u64::from(*last) << 8;
    }
    sum
}

fn checksum_fold(mut sum: u64) -> u16 {
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    sum as u16
}

fn checksum_is_valid(sum: u64) -> bool {
    checksum_fold(sum) == u16::MAX
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
    #[error("IPSTACK_DESCRIPTOR_INVALID: decoded transport descriptor is invalid")]
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
    #[error("IPSTACK_IPV6_SCOPE_REQUIRED: IPv6 link-local flow has no trusted interface scope")]
    Ipv6ScopeRequired,
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
            Self::Ipv6ScopeRequired => "IPSTACK_IPV6_SCOPE_REQUIRED",
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
        let udp_queue = UdpQueueBudget {
            datagrams: 2,
            payload_bytes: 2400,
            metadata_bytes: 2 * MIN_STACK_UDP_METADATA_BYTES_PER_DATAGRAM,
        };
        IpStackConfig {
            generation: 7,
            platform: CapturePlatform::Linux,
            provider: provider(),
            max_tcp_flows,
            max_udp_associations: 4,
            max_reassembly_bytes: 0,
            max_packet_bytes: 1500,
            mtu_bytes: 1500,
            tcp_rx_bytes_per_flow: 8 * 1024,
            tcp_tx_bytes_per_flow: 8 * 1024,
            total_socket_bytes: 128 * 1024,
            udp_datagram_bytes: 1200,
            provider_resources: IpStackProviderResources {
                tcp_lifecycle: TcpLifecycleDeadlines::default(),
                tcp_bridge: TcpBridgeBudget::default(),
                udp_association_queues: UdpAssociationQueueBudgets {
                    stack_to_egress: udp_queue,
                    egress_to_stack: udp_queue,
                },
                udp_wildcard_bindings: UdpWildcardBindingBudgets {
                    max_bindings: 4,
                    rx: udp_queue,
                    tx: udp_queue,
                },
                capabilities: IpStackProviderCapabilities::default(),
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

    fn set_full_udp_queues(config: &mut IpStackConfig, datagram_bytes: usize) {
        config.udp_datagram_bytes = datagram_bytes;
        let queue = UdpQueueBudget::for_full_datagrams(2, datagram_bytes).unwrap();
        config.provider_resources.udp_association_queues = UdpAssociationQueueBudgets {
            stack_to_egress: queue,
            egress_to_stack: queue,
        };
        config.provider_resources.udp_wildcard_bindings.rx = queue;
        config.provider_resources.udp_wildcard_bindings.tx = queue;
    }

    const IPV4_SOURCE: Ipv4Addr = Ipv4Addr::LOCALHOST;
    const IPV4_DESTINATION: Ipv4Addr = Ipv4Addr::new(198, 51, 100, 8);
    const IPV6_SOURCE: Ipv6Addr = Ipv6Addr::LOCALHOST;
    const IPV6_DESTINATION: Ipv6Addr = Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 8);

    #[derive(Clone, Copy)]
    enum TestTransportChecksum {
        Compute,
        Zero,
    }

    fn test_packet_info(
        source: IpAddr,
        destination: IpAddr,
        protocol: u8,
        segment_len: usize,
    ) -> IpPacketInfo {
        IpPacketInfo {
            version: if source.is_ipv4() {
                IpVersion::V4
            } else {
                IpVersion::V6
            },
            total_len: segment_len,
            transport_protocol: protocol,
            fragmented: false,
            source,
            destination,
            transport_offset: Some(0),
        }
    }

    fn write_transport_checksum(
        source: IpAddr,
        destination: IpAddr,
        protocol: u8,
        segment: &mut [u8],
        checksum_offset: usize,
    ) {
        segment[checksum_offset..checksum_offset + 2].fill(0);
        let info = test_packet_info(source, destination, protocol, segment.len());
        let pseudo = transport_pseudo_header_sum(&info, segment.len()).unwrap();
        let checksum = !checksum_fold(checksum_accumulate(pseudo, segment));
        // A computed all-zero UDP checksum is transmitted as all ones. This
        // keeps zero reserved for IPv4's explicit "checksum omitted" form.
        let checksum = if checksum == 0 { u16::MAX } else { checksum };
        segment[checksum_offset..checksum_offset + 2].copy_from_slice(&checksum.to_be_bytes());
    }

    fn tcp_segment(source_port: u16, destination_port: u16, payload: &[u8]) -> Vec<u8> {
        tcp_segment_with_flags(source_port, destination_port, 0x02, payload)
    }

    fn tcp_segment_with_flags(
        source_port: u16,
        destination_port: u16,
        flags: u8,
        payload: &[u8],
    ) -> Vec<u8> {
        let mut segment = vec![0u8; 20 + payload.len()];
        segment[0..2].copy_from_slice(&source_port.to_be_bytes());
        segment[2..4].copy_from_slice(&destination_port.to_be_bytes());
        segment[4..8].copy_from_slice(&1u32.to_be_bytes());
        segment[12] = 5 << 4;
        segment[13] = flags;
        segment[14..16].copy_from_slice(&16_384u16.to_be_bytes());
        segment[20..].copy_from_slice(payload);
        segment
    }

    fn udp_segment(source_port: u16, destination_port: u16, payload: &[u8]) -> Vec<u8> {
        let length = 8usize.checked_add(payload.len()).unwrap();
        let mut segment = vec![0u8; length];
        segment[0..2].copy_from_slice(&source_port.to_be_bytes());
        segment[2..4].copy_from_slice(&destination_port.to_be_bytes());
        segment[4..6].copy_from_slice(&u16::try_from(length).unwrap().to_be_bytes());
        segment[8..].copy_from_slice(payload);
        segment
    }

    fn write_ipv4_header_checksum(packet: &mut [u8]) {
        let header_len = usize::from(packet[0] & 0x0f) * 4;
        packet[10..12].fill(0);
        let checksum = !checksum_fold(checksum_accumulate(0, &packet[..header_len]));
        packet[10..12].copy_from_slice(&checksum.to_be_bytes());
    }

    fn ipv4_transport_packet(
        source: Ipv4Addr,
        destination: Ipv4Addr,
        protocol: u8,
        mut segment: Vec<u8>,
        checksum: TestTransportChecksum,
    ) -> Bytes {
        if matches!(checksum, TestTransportChecksum::Compute) {
            let checksum_offset = match protocol {
                6 => 16,
                17 => 6,
                _ => unreachable!(),
            };
            write_transport_checksum(
                IpAddr::V4(source),
                IpAddr::V4(destination),
                protocol,
                &mut segment,
                checksum_offset,
            );
        }
        let total_len = 20usize.checked_add(segment.len()).unwrap();
        let mut packet = vec![0u8; total_len];
        packet[0] = 0x45;
        packet[2..4].copy_from_slice(&u16::try_from(total_len).unwrap().to_be_bytes());
        packet[4..6].copy_from_slice(&1u16.to_be_bytes());
        packet[8] = 64;
        packet[9] = protocol;
        packet[12..16].copy_from_slice(&source.octets());
        packet[16..20].copy_from_slice(&destination.octets());
        packet[20..].copy_from_slice(&segment);
        write_ipv4_header_checksum(&mut packet);
        packet.into()
    }

    fn ipv6_transport_packet(
        source: Ipv6Addr,
        destination: Ipv6Addr,
        first_next_header: u8,
        extension_bytes: &[u8],
        protocol: u8,
        mut segment: Vec<u8>,
        checksum: TestTransportChecksum,
    ) -> Bytes {
        if matches!(checksum, TestTransportChecksum::Compute) {
            let checksum_offset = match protocol {
                6 => 16,
                17 => 6,
                _ => unreachable!(),
            };
            write_transport_checksum(
                IpAddr::V6(source),
                IpAddr::V6(destination),
                protocol,
                &mut segment,
                checksum_offset,
            );
        }
        let payload_len = extension_bytes.len().checked_add(segment.len()).unwrap();
        let mut packet = vec![0u8; 40 + payload_len];
        packet[0] = 0x60;
        packet[4..6].copy_from_slice(&u16::try_from(payload_len).unwrap().to_be_bytes());
        packet[6] = first_next_header;
        packet[7] = 64;
        packet[8..24].copy_from_slice(&source.octets());
        packet[24..40].copy_from_slice(&destination.octets());
        packet[40..40 + extension_bytes.len()].copy_from_slice(extension_bytes);
        packet[40 + extension_bytes.len()..].copy_from_slice(&segment);
        packet.into()
    }

    fn raw_ipv6_packet(next_header: u8, body: &[u8]) -> Bytes {
        let mut packet = vec![0u8; 40 + body.len()];
        packet[0] = 0x60;
        packet[4..6].copy_from_slice(&u16::try_from(body.len()).unwrap().to_be_bytes());
        packet[6] = next_header;
        packet[7] = 64;
        packet[8..24].copy_from_slice(&IPV6_SOURCE.octets());
        packet[24..40].copy_from_slice(&IPV6_DESTINATION.octets());
        packet[40..].copy_from_slice(body);
        packet.into()
    }

    fn tcp4(source_port: u16) -> Bytes {
        tcp4_with_flags(source_port, 0x02)
    }

    fn tcp4_with_flags(source_port: u16, flags: u8) -> Bytes {
        ipv4_transport_packet(
            IPV4_SOURCE,
            IPV4_DESTINATION,
            6,
            tcp_segment_with_flags(source_port, 443, flags, b"tcp"),
            TestTransportChecksum::Compute,
        )
    }

    fn udp4(source_port: u16) -> Bytes {
        ipv4_transport_packet(
            IPV4_SOURCE,
            IPV4_DESTINATION,
            17,
            udp_segment(source_port, 443, b"udp"),
            TestTransportChecksum::Compute,
        )
    }

    fn key(port: u16, transport: IpTransport) -> IpFlowKey {
        IpFlowKey {
            transport,
            source: SocketAddr::from((IPV4_SOURCE, port)),
            destination: SocketAddr::from((IPV4_DESTINATION, 443)),
        }
    }

    fn ipv6_key(port: u16, transport: IpTransport) -> IpFlowKey {
        IpFlowKey {
            transport,
            source: SocketAddr::V6(SocketAddrV6::new(IPV6_SOURCE, port, 0, 0)),
            destination: SocketAddr::V6(SocketAddrV6::new(IPV6_DESTINATION, 443, 0, 0)),
        }
    }

    fn packet(capture_id: u64, payload: Bytes) -> PacketFrame {
        PacketFrame {
            identity: PacketIdentity::global(7, Some(capture_id), CapturePlatform::Linux),
            payload,
        }
    }

    fn tun_packet(payload: Bytes) -> PacketFrame {
        PacketFrame {
            identity: PacketIdentity::global(7, None, CapturePlatform::Linux),
            payload,
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
        let mut bad = config(2);
        set_full_udp_queues(&mut bad, 1_453);
        assert_eq!(
            PacketFlowRegistry::new(bad).unwrap_err().code(),
            "IPSTACK_UDP_DATAGRAM_LIMIT_INVALID"
        );
    }

    #[test]
    fn aggregate_budgets_accept_exact_boundaries_and_reject_one_byte_overcommit() {
        let mut exact = config(2);
        exact.tcp_rx_bytes_per_flow = 14 * 1024;
        exact.tcp_tx_bytes_per_flow = 14 * 1024;
        exact.total_socket_bytes = exact.required_socket_bytes().unwrap();
        exact.tx_staging_bytes = exact.tx_staging_packets * exact.max_packet_bytes;
        assert!(exact.validate().is_ok());

        let mut bad = exact.clone();
        bad.total_socket_bytes -= 1;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_TOTAL_SOCKET_BUDGET_EXCEEDED"
        );

        let mut bad = exact.clone();
        bad.provider_resources.tcp_bridge.rx_bytes_per_flow += 1;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_TOTAL_SOCKET_BUDGET_EXCEEDED"
        );

        let mut bad = exact.clone();
        bad.provider_resources
            .udp_association_queues
            .egress_to_stack
            .metadata_bytes += 1;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_TOTAL_SOCKET_BUDGET_EXCEEDED"
        );

        let mut bad = exact.clone();
        bad.provider_resources
            .udp_wildcard_bindings
            .tx
            .metadata_bytes += 1;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_TOTAL_SOCKET_BUDGET_EXCEEDED"
        );

        let mut bad = exact.clone();
        bad.provider_resources
            .udp_association_queues
            .stack_to_egress
            .payload_bytes -= 1;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_UDP_ASSOCIATION_QUEUE_INVALID"
        );

        let mut bad = exact.clone();
        bad.provider_resources
            .udp_wildcard_bindings
            .rx
            .metadata_bytes -= 1;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_UDP_WILDCARD_QUEUE_INVALID"
        );

        let mut bad = exact;
        bad.tx_staging_bytes -= 1;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_TX_STAGING_BYTES_INVALID"
        );
    }

    #[test]
    fn aggregate_budget_arithmetic_overflow_is_fail_closed() {
        let mut bad = config(2);
        bad.tcp_rx_bytes_per_flow = usize::MAX;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_SOCKET_BUDGET_OVERFLOW"
        );

        let mut bad = config(2);
        bad.provider_resources
            .udp_association_queues
            .stack_to_egress
            .datagrams = usize::MAX;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_UDP_QUEUE_BUDGET_OVERFLOW"
        );

        let mut bad = config(2);
        bad.provider_resources.tcp_bridge.rx_bytes_per_flow = usize::MAX;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_SOCKET_BUDGET_OVERFLOW"
        );

        let mut bad = config(2);
        bad.max_fragments = usize::MAX;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_FRAGMENT_BUDGET_OVERFLOW"
        );

        let mut bad = config(2);
        bad.tx_staging_packets = usize::MAX;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_TX_STAGING_BUDGET_OVERFLOW"
        );
    }

    #[test]
    fn lifecycle_and_source_compatibility_defaults_are_explicit_and_fail_closed() {
        let deadlines = TcpLifecycleDeadlines::default();
        assert_eq!(deadlines.handshake_ms, 30_000);
        assert_eq!(deadlines.graceful_close_ms, 10_000);
        assert_eq!(deadlines.reset_ms, 1_000);

        let resources =
            IpStackProviderResources::source_compatibility_defaults(4, 1200, 2, 2400).unwrap();
        assert_eq!(resources.tcp_bridge, TcpBridgeBudget::default());
        assert_eq!(resources.udp_wildcard_bindings.max_bindings, 4);
        assert_eq!(
            resources
                .udp_association_queues
                .stack_to_egress
                .metadata_bytes,
            2 * MIN_STACK_UDP_METADATA_BYTES_PER_DATAGRAM
        );
        assert_eq!(
            resources.fragmentation_policy,
            FragmentationPolicy::RejectAll
        );
        assert_eq!(
            resources.ipv6_extension_header_policy,
            Ipv6ExtensionHeaderPolicy::RejectAll
        );
        assert!(!resources.capabilities.bounded_fragment_reassembly);
        assert!(!resources.capabilities.validated_ipv6_extension_headers);

        assert_eq!(
            IpStackProviderResources::source_compatibility_defaults(4, 1200, usize::MAX, 2400,)
                .unwrap_err()
                .code(),
            "IPSTACK_UDP_QUEUE_BUDGET_OVERFLOW"
        );
    }

    #[test]
    fn tcp_lifecycle_deadlines_are_bounded_and_ordered() {
        let mut bad = config(2);
        bad.provider_resources.tcp_lifecycle.handshake_ms = MIN_STACK_TCP_HANDSHAKE_DEADLINE_MS - 1;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_TCP_LIFECYCLE_DEADLINE_INVALID"
        );

        let mut bad = config(2);
        bad.provider_resources.tcp_lifecycle.reset_ms = 2_000;
        bad.provider_resources.tcp_lifecycle.graceful_close_ms = 1_999;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_TCP_LIFECYCLE_DEADLINE_INVALID"
        );

        let mut exact = config(2);
        exact.provider_resources.tcp_lifecycle = TcpLifecycleDeadlines {
            handshake_ms: MAX_STACK_TCP_HANDSHAKE_DEADLINE_MS,
            graceful_close_ms: MAX_STACK_TCP_GRACEFUL_CLOSE_DEADLINE_MS,
            reset_ms: MAX_STACK_TCP_RESET_DEADLINE_MS,
        };
        assert!(exact.validate().is_ok());
    }

    #[test]
    fn fragmentation_policy_requires_capability_and_udp_fit_without_it() {
        let mut exact = config(2);
        exact.max_packet_bytes = 2_000;
        exact.tx_staging_bytes = exact.tx_staging_packets * exact.max_packet_bytes;
        let exact_datagram_bytes = exact.mtu_bytes - 48;
        set_full_udp_queues(&mut exact, exact_datagram_bytes);
        exact.total_socket_bytes = exact.required_socket_bytes().unwrap();
        assert!(exact.validate().is_ok());

        let mut bad = exact.clone();
        set_full_udp_queues(&mut bad, exact_datagram_bytes + 1);
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "IPSTACK_UDP_MTU_FRAGMENTATION_REQUIRED"
        );

        let mut misleading_reject = config(2);
        misleading_reject.max_reassembly_bytes = 1;
        assert_eq!(
            misleading_reject.validate().unwrap_err().code(),
            "IPSTACK_FRAGMENT_REJECT_BUDGET_INVALID"
        );

        let mut missing_capability = config(2);
        missing_capability.provider_resources.fragmentation_policy =
            FragmentationPolicy::ProviderBoundedReassembly;
        missing_capability.max_reassembly_bytes = 48_000;
        missing_capability.max_fragments = 32;
        missing_capability.fragment_timeout_ms = 30_000;
        assert_eq!(
            missing_capability.validate().unwrap_err().code(),
            "IPSTACK_FRAGMENT_CAPABILITY_REQUIRED"
        );

        missing_capability
            .provider_resources
            .capabilities
            .bounded_fragment_reassembly = true;
        assert!(missing_capability.validate().is_ok());

        missing_capability.max_reassembly_bytes -= 1;
        assert_eq!(
            missing_capability.validate().unwrap_err().code(),
            "IPSTACK_FRAGMENT_LIMIT_INVALID"
        );
    }

    #[test]
    fn tuple_admission_is_bounded_and_identity_is_immutable() {
        let mut registry = PacketFlowRegistry::new(config(1)).unwrap();
        let first = registry.admit(&packet(1, tcp4(40_000))).unwrap();
        assert_eq!(first.key, key(40_000, IpTransport::Tcp));
        assert_eq!(first.admission, FlowAdmission::New { flow_id: 1 });
        let existing = registry.admit(&packet(1, tcp4(40_000))).unwrap();
        assert_eq!(existing.key, first.key);
        assert_eq!(existing.admission, FlowAdmission::Existing { flow_id: 1 });
        assert_eq!(
            registry.admit(&packet(2, tcp4(40_000))).unwrap_err().code(),
            "IPSTACK_IDENTITY_CHANGED"
        );
        assert_eq!(
            registry.admit(&packet(3, tcp4(40_001))).unwrap_err().code(),
            "IPSTACK_FLOW_TABLE_FULL"
        );
    }

    #[test]
    fn tun_packets_without_native_flow_id_reuse_the_stack_flow() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let first = registry.admit(&tun_packet(tcp4(40_000))).unwrap();
        assert_eq!(first.key, key(40_000, IpTransport::Tcp));
        assert_eq!(first.admission, FlowAdmission::New { flow_id: 1 });
        let existing = registry.admit(&tun_packet(tcp4(40_000))).unwrap();
        assert_eq!(existing.key, first.key);
        assert_eq!(existing.admission, FlowAdmission::Existing { flow_id: 1 });
    }

    #[test]
    fn new_tcp_flow_requires_an_initial_syn_but_existing_accepts_ack() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        for (capture_id, port, flags) in [
            (1, 40_010, 0x10), // ACK with data
            (2, 40_011, 0x12), // SYN + ACK
            (3, 40_012, 0x04), // RST
        ] {
            assert_eq!(
                registry
                    .admit(&packet(capture_id, tcp4_with_flags(port, flags)))
                    .unwrap_err()
                    .code(),
                "IPSTACK_TCP_INITIAL_PACKET_INVALID"
            );
        }
        assert!(registry.is_empty());

        let initial = registry.admit(&packet(4, tcp4(40_020))).unwrap();
        assert_eq!(initial.admission, FlowAdmission::New { flow_id: 1 });
        let ack = registry
            .admit(&packet(4, tcp4_with_flags(40_020, 0x10)))
            .unwrap();
        assert_eq!(ack.key, initial.key);
        assert_eq!(ack.admission, FlowAdmission::Existing { flow_id: 1 });
    }

    #[test]
    fn tuple_comes_only_from_the_packet_and_debug_output_is_redacted() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let admitted = registry.admit(&packet(1, udp4(40_007))).unwrap();
        assert_eq!(admitted.key, key(40_007, IpTransport::Udp));
        assert_eq!(admitted.admission, FlowAdmission::New { flow_id: 1 });
        let debug = format!("{admitted:?}");
        assert!(!debug.contains("127.0.0.1"));
        assert!(!debug.contains("198.51.100.8"));
        assert!(!debug.contains("40007"));

        let unsupported = ipv4_transport_packet(
            IPV4_SOURCE,
            IPV4_DESTINATION,
            1,
            vec![0; 8],
            TestTransportChecksum::Zero,
        );
        assert_eq!(
            registry.admit(&packet(2, unsupported)).unwrap_err().code(),
            "IPSTACK_UNSUPPORTED_TRANSPORT"
        );
    }

    #[test]
    fn address_port_and_transport_lengths_are_fail_closed() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let unspecified = ipv4_transport_packet(
            IPV4_SOURCE,
            Ipv4Addr::UNSPECIFIED,
            6,
            tcp_segment(40_000, 443, b"tcp"),
            TestTransportChecksum::Compute,
        );
        assert_eq!(
            registry.admit(&packet(1, unspecified)).unwrap_err().code(),
            "IPSTACK_FLOW_ADDRESS_INVALID"
        );

        for (capture_id, source, destination) in [
            (6, Ipv4Addr::new(224, 0, 0, 1), IPV4_DESTINATION),
            (7, Ipv4Addr::BROADCAST, IPV4_DESTINATION),
            (8, IPV4_SOURCE, Ipv4Addr::BROADCAST),
        ] {
            let invalid_address = ipv4_transport_packet(
                source,
                destination,
                6,
                tcp_segment(40_000, 443, b"invalid-address"),
                TestTransportChecksum::Compute,
            );
            assert_eq!(
                registry
                    .admit(&packet(capture_id, invalid_address))
                    .unwrap_err()
                    .code(),
                "IPSTACK_FLOW_ADDRESS_INVALID"
            );
        }

        let ipv6_multicast_source = ipv6_transport_packet(
            Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 1),
            IPV6_DESTINATION,
            6,
            &[],
            6,
            tcp_segment(40_000, 443, b"multicast-source"),
            TestTransportChecksum::Compute,
        );
        assert_eq!(
            registry
                .admit(&packet(9, ipv6_multicast_source))
                .unwrap_err()
                .code(),
            "IPSTACK_FLOW_ADDRESS_INVALID"
        );

        let zero_port = ipv4_transport_packet(
            IPV4_SOURCE,
            IPV4_DESTINATION,
            6,
            tcp_segment(0, 443, b"tcp"),
            TestTransportChecksum::Compute,
        );
        assert_eq!(
            registry.admit(&packet(2, zero_port)).unwrap_err().code(),
            "IPSTACK_FLOW_PORT_INVALID"
        );

        let mut bad_tcp_offset = tcp4(40_000).to_vec();
        bad_tcp_offset[32] = 4 << 4;
        assert_eq!(
            registry
                .admit(&packet(3, bad_tcp_offset.into()))
                .unwrap_err()
                .code(),
            "IPSTACK_TCP_HEADER_INVALID"
        );

        let mut bad_udp_len = udp4(40_001).to_vec();
        bad_udp_len[24..26].copy_from_slice(&8u16.to_be_bytes());
        assert_eq!(
            registry
                .admit(&packet(4, bad_udp_len.into()))
                .unwrap_err()
                .code(),
            "IPSTACK_UDP_LENGTH_INVALID"
        );

        let mut bad_ip_len = tcp4(40_002).to_vec();
        bad_ip_len[2..4].copy_from_slice(&20u16.to_be_bytes());
        assert_eq!(
            registry
                .admit(&packet(5, bad_ip_len.into()))
                .unwrap_err()
                .code(),
            "PACKET_IPV4_LENGTH_INVALID"
        );
        assert!(registry.is_empty());
    }

    #[test]
    fn strict_checksum_policy_verifies_ipv4_and_transport_checksums() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let mut bad_ipv4 = tcp4(40_000).to_vec();
        bad_ipv4[8] ^= 1;
        assert_eq!(
            registry
                .admit(&packet(1, bad_ipv4.into()))
                .unwrap_err()
                .code(),
            "IPSTACK_IPV4_HEADER_CHECKSUM_INVALID"
        );

        let mut bad_tcp = tcp4(40_001).to_vec();
        bad_tcp[33] ^= 1;
        assert_eq!(
            registry
                .admit(&packet(2, bad_tcp.into()))
                .unwrap_err()
                .code(),
            "IPSTACK_TRANSPORT_CHECKSUM_INVALID"
        );
        assert!(registry.is_empty());
    }

    #[test]
    fn trusted_inbound_policy_skips_only_transport_checksum_validation() {
        let mut trusted_config = config(2);
        trusted_config.checksum_policy = ChecksumPolicy::TrustValidatedInboundAndComputeOutbound;
        let mut registry = PacketFlowRegistry::new(trusted_config).unwrap();

        let mut bad_tcp_checksum = tcp4(40_000).to_vec();
        bad_tcp_checksum[24] ^= 1;
        let admitted = registry.admit(&packet(1, bad_tcp_checksum.into())).unwrap();
        assert_eq!(admitted.key, key(40_000, IpTransport::Tcp));

        let mut bad_udp_len = udp4(40_001).to_vec();
        bad_udp_len[24..26].copy_from_slice(&8u16.to_be_bytes());
        assert_eq!(
            registry
                .admit(&packet(2, bad_udp_len.into()))
                .unwrap_err()
                .code(),
            "IPSTACK_UDP_LENGTH_INVALID"
        );

        let mut bad_ipv4 = tcp4(40_002).to_vec();
        bad_ipv4[8] ^= 1;
        assert_eq!(
            registry
                .admit(&packet(3, bad_ipv4.into()))
                .unwrap_err()
                .code(),
            "IPSTACK_IPV4_HEADER_CHECKSUM_INVALID"
        );
    }

    #[test]
    fn udp_checksum_zero_is_ipv4_only() {
        let ipv4_zero = ipv4_transport_packet(
            IPV4_SOURCE,
            IPV4_DESTINATION,
            17,
            udp_segment(40_000, 443, b"udp-zero"),
            TestTransportChecksum::Zero,
        );
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let admitted = registry.admit(&packet(1, ipv4_zero)).unwrap();
        assert_eq!(admitted.key, key(40_000, IpTransport::Udp));

        let ipv6_zero = ipv6_transport_packet(
            IPV6_SOURCE,
            IPV6_DESTINATION,
            17,
            &[],
            17,
            udp_segment(40_001, 443, b"udp6-zero"),
            TestTransportChecksum::Zero,
        );
        assert_eq!(
            registry.admit(&packet(2, ipv6_zero)).unwrap_err().code(),
            "IPSTACK_IPV6_UDP_CHECKSUM_REQUIRED"
        );
    }

    #[test]
    fn ipv6_extensions_require_an_attested_phase1_provider_capability() {
        let mut extensions = Vec::new();
        extensions.extend_from_slice(&[60, 0, 0, 0, 0, 0, 0, 0]); // Hop-by-Hop
        extensions.extend_from_slice(&[6, 0, 0, 0, 0, 0, 0, 0]); // Destination
        let packet = PacketFrame {
            identity: PacketIdentity::global(7, Some(21), CapturePlatform::Linux),
            payload: ipv6_transport_packet(
                IPV6_SOURCE,
                IPV6_DESTINATION,
                0,
                &extensions,
                6,
                tcp_segment(40_000, 443, b"extension-tcp"),
                TestTransportChecksum::Compute,
            ),
        };
        let info = packet.validate_for(7, CapturePlatform::Linux).unwrap();
        assert_eq!(info.transport_offset, Some(56));
        assert_eq!(info.transport_protocol, 6);

        let mut fail_closed = PacketFlowRegistry::new(config(2)).unwrap();
        assert_eq!(
            fail_closed.admit(&packet).unwrap_err().code(),
            "IPSTACK_IPV6_EXTENSION_HEADER_UNSUPPORTED"
        );
        assert!(fail_closed.is_empty());

        let mut enabled = config(2);
        enabled.provider_resources.ipv6_extension_header_policy =
            Ipv6ExtensionHeaderPolicy::ProviderValidatedUnfragmented;
        assert_eq!(
            enabled.validate().unwrap_err().code(),
            "IPSTACK_IPV6_EXTENSION_CAPABILITY_REQUIRED"
        );
        enabled
            .provider_resources
            .capabilities
            .validated_ipv6_extension_headers = true;
        let mut registry = PacketFlowRegistry::new(enabled).unwrap();
        let admitted = registry.admit(&packet).unwrap();
        assert_eq!(admitted.key, ipv6_key(40_000, IpTransport::Tcp));
        assert_eq!(admitted.admission, FlowAdmission::New { flow_id: 1 });
    }

    #[test]
    fn ipv6_fragments_require_reassembly_before_tuple_or_transport_checks() {
        let mut body = vec![6, 0, 0, 1, 0, 0, 0, 9]; // First Fragment, M=1
        body.extend_from_slice(&[0; 8]); // Deliberately not a legal TCP header.
        let packet = PacketFrame {
            identity: PacketIdentity::global(7, Some(22), CapturePlatform::Linux),
            payload: raw_ipv6_packet(44, &body),
        };
        let info = packet.validate_for(7, CapturePlatform::Linux).unwrap();
        assert!(info.fragmented);
        assert_eq!(info.transport_offset, None);

        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        assert_eq!(
            registry.admit(&packet).unwrap_err().code(),
            "IPSTACK_FRAGMENT_REASSEMBLY_REQUIRED"
        );
        assert!(registry.is_empty());
    }

    #[test]
    fn ipv6_link_local_requires_a_trusted_scope_id() {
        let unscoped_packet = ipv6_transport_packet(
            IPV6_SOURCE,
            Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 8),
            6,
            &[],
            6,
            tcp_segment(40_000, 443, b"link-local"),
            TestTransportChecksum::Compute,
        );
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        assert_eq!(
            registry
                .admit(&packet(1, unscoped_packet))
                .unwrap_err()
                .code(),
            "IPSTACK_IPV6_SCOPE_REQUIRED"
        );

        let scoped_a = IpFlowKey {
            transport: IpTransport::Tcp,
            source: SocketAddr::V6(SocketAddrV6::new(IPV6_SOURCE, 40_000, 0, 0)),
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
        let mut unscoped = scoped_a;
        if let SocketAddr::V6(addr) = &mut unscoped.destination {
            *addr = SocketAddrV6::new(*addr.ip(), addr.port(), addr.flowinfo(), 0);
        }
        assert_eq!(
            unscoped.validate().unwrap_err().code(),
            "IPSTACK_IPV6_SCOPE_REQUIRED"
        );
    }

    #[test]
    fn tcp_descriptor_keeps_identity_and_typed_tuple() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let flow_key = registry.admit(&packet(9, tcp4(40_000))).unwrap().key;
        let descriptor = registry
            .tcp_descriptor(&flow_key, AttributionHints::default())
            .unwrap();
        assert_eq!(descriptor.flow_id, 1);
        assert_eq!(descriptor.transport, FlowTransport::Tcp);
        assert_eq!(descriptor.destination.port(), 443);
        assert_eq!(
            descriptor.capture_intent,
            CaptureIntent::AllowGlobalFallback
        );
        assert_eq!(descriptor.profile_binding, ProfileBinding::AutoSelect);
    }

    #[test]
    fn udp_descriptor_keeps_identity_and_sets_udp_transport() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let flow_key = registry.admit(&packet(10, udp4(40_001))).unwrap().key;
        let descriptor = registry
            .udp_descriptor(&flow_key, AttributionHints::default())
            .unwrap();
        assert_eq!(descriptor.flow_id, 1);
        assert_eq!(descriptor.transport, FlowTransport::Udp);
        assert_eq!(descriptor.destination.port(), 443);
        assert_eq!(
            descriptor.capture_intent,
            CaptureIntent::AllowGlobalFallback
        );
        assert_eq!(descriptor.profile_binding, ProfileBinding::AutoSelect);
        assert_eq!(
            registry
                .tcp_descriptor(&flow_key, AttributionHints::default())
                .unwrap_err()
                .code(),
            "IPSTACK_TCP_DESCRIPTOR_REQUIRED"
        );
    }

    #[test]
    fn udp_association_limit_is_independent_from_tcp_limit() {
        let mut registry = PacketFlowRegistry::new(config(1)).unwrap();
        for index in 0..4 {
            let port = 40_000 + index;
            assert!(
                registry
                    .admit(&packet(index as u64 + 1, udp4(port)))
                    .is_ok()
            );
        }
        assert_eq!(
            registry.admit(&packet(9, udp4(40_004))).unwrap_err().code(),
            "IPSTACK_FLOW_TABLE_FULL"
        );
    }

    #[test]
    fn transport_counts_follow_remove_clear_and_readmission() {
        let mut registry = PacketFlowRegistry::new(config(2)).unwrap();
        let tcp_a = key(40_000, IpTransport::Tcp);
        let udp_a = key(41_000, IpTransport::Udp);

        assert_eq!(
            registry.admit(&packet(1, tcp4(40_000))).unwrap().admission,
            FlowAdmission::New { flow_id: 1 }
        );
        assert_eq!(
            registry.admit(&packet(2, udp4(41_000))).unwrap().admission,
            FlowAdmission::New { flow_id: 2 }
        );
        assert_eq!(
            registry.admit(&packet(3, tcp4(40_001))).unwrap().admission,
            FlowAdmission::New { flow_id: 3 }
        );
        assert_eq!(
            registry.admit(&packet(4, udp4(41_001))).unwrap().admission,
            FlowAdmission::New { flow_id: 4 }
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
            registry.admit(&packet(5, tcp4(40_000))).unwrap().admission,
            FlowAdmission::New { flow_id: 5 }
        );
        assert_eq!(
            registry.admit(&packet(6, udp4(41_000))).unwrap().admission,
            FlowAdmission::New { flow_id: 6 }
        );
        assert_eq!(registry.active_tcp_flows, 2);
        assert_eq!(registry.active_udp_associations, 2);
        assert_eq!(registry.len(), 4);

        registry.clear();
        assert!(registry.is_empty());
        assert_eq!(registry.active_tcp_flows, 0);
        assert_eq!(registry.active_udp_associations, 0);
        assert_eq!(
            registry.admit(&packet(7, udp4(41_001))).unwrap().admission,
            FlowAdmission::New { flow_id: 7 }
        );
        assert_eq!(registry.active_tcp_flows, 0);
        assert_eq!(registry.active_udp_associations, 1);
    }
}
