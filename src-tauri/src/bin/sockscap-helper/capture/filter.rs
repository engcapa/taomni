use super::address::parse_cidrs;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;

/// Base NETWORK-layer capture filter. Outbound TCP only: the streamdump
/// reflection reinjects packets as *inbound*, so an inbound clause would only
/// re-feed our own rewrites back into this loop.
pub(super) const NETWORK_FILTER: &str = "tcp and outbound";

/// Base filter when QUIC blocking is on: also pull in outbound UDP 443 so the
/// packet loop can drop in-scope QUIC and force a TCP fallback. UDP is only ever
/// dropped or passed, never reflected, so there is no inbound-recapture concern.
pub(super) const NETWORK_FILTER_WITH_QUIC: &str =
    "outbound and (tcp or (udp and udp.DstPort == 443))";

/// The base filter for the current plan (before per-CIDR exclusions).
pub(super) fn base_network_filter(block_quic: bool) -> &'static str {
    if block_quic {
        NETWORK_FILTER_WITH_QUIC
    } else {
        NETWORK_FILTER
    }
}

/// Kernel filter excluding destinations the packet loop would unconditionally
/// pass through anyway.
///
/// Every packet matching the filter costs a kernel↔user transition on the one
/// thread that owns the machine's entire outbound TCP path, so the cheapest
/// packet is one the driver never hands us. `bypass_cidrs` destinations qualify
/// exactly: `should_bypass` passes them through unmodified with no other
/// condition, so excluding them here is behaviour-preserving. On default
/// settings that is loopback plus every RFC1918 and link-local range — local
/// IPC, dev servers, containers, SMB, printers, VM traffic.
///
/// Note what is deliberately *not* narrowed: the selected applications' ports.
/// Sockets open and close constantly, so a port-based filter would need
/// reopening continuously, and a WinDivert filter cannot be changed on a live
/// handle — the handle must be reopened, dropping whatever is queued. Worse,
/// packets sent between a socket opening and the filter catching up would escape
/// uncaptured, silently sending a connection direct that should have been
/// proxied. With per-connection classification cached, an unselected flow now
/// costs one hash lookup, so there is nothing left worth that risk.
///
/// Mixed address families are fine: an `ip.` test on an IPv6 packet (and vice
/// versa) is simply false, so `not (…)` leaves the packet matched.
pub(super) fn build_network_filter(bypass_cidrs: &[String], block_quic: bool) -> String {
    let mut filter = String::from(base_network_filter(block_quic));
    for (net, prefix) in parse_cidrs(bypass_cidrs) {
        let (lo, hi) = cidr_range(net, prefix);
        let field = match net {
            IpAddr::V4(_) => "ip.DstAddr",
            IpAddr::V6(_) => "ipv6.DstAddr",
        };
        filter.push_str(&format!(" and not ({field} >= {lo} and {field} <= {hi})"));
    }
    filter
}

/// First and last address of a CIDR block.
pub(super) fn cidr_range(net: IpAddr, prefix: u8) -> (IpAddr, IpAddr) {
    match net {
        IpAddr::V4(v4) => {
            let bits = u32::from(v4);
            let shift = 32u32.saturating_sub(prefix as u32);
            let mask = if shift >= 32 { 0 } else { u32::MAX << shift };
            (
                IpAddr::V4(Ipv4Addr::from(bits & mask)),
                IpAddr::V4(Ipv4Addr::from((bits & mask) | !mask)),
            )
        }
        IpAddr::V6(v6) => {
            let bits = u128::from(v6);
            let shift = 128u32.saturating_sub(prefix as u32);
            let mask = if shift >= 128 { 0 } else { u128::MAX << shift };
            (
                IpAddr::V6(Ipv6Addr::from(bits & mask)),
                IpAddr::V6(Ipv6Addr::from((bits & mask) | !mask)),
            )
        }
    }
}
