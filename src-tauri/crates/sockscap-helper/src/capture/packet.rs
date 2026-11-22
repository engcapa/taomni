use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;

pub(super) const TCP_FIN: u8 = 0x01;
pub(super) const TCP_SYN: u8 = 0x02;
pub(super) const TCP_RST: u8 = 0x04;
pub(super) const TCP_ACK: u8 = 0x10;

/// SYN without ACK: a new connection is being opened on this 4-tuple.
pub(super) fn is_syn_open(flags: u8) -> bool {
    flags & TCP_SYN != 0 && flags & TCP_ACK == 0
}

/// Streamdump PORT→PROXY:
/// `C:sp → R:dp`  ⇒  `R:sp → C:relay` (caller sets Outbound=false).
pub(super) fn reflect_towards_proxy(pkt: &mut [u8], relay_port: u16) -> bool {
    let ver = pkt.first().map(|b| b >> 4).unwrap_or(0);
    if ver == 4 {
        if pkt.len() < 40 {
            return false;
        }
        let ihl = (pkt[0] & 0x0f) as usize * 4;
        if ihl < 20 || pkt.len() < ihl + 20 || pkt[9] != 6 {
            return false;
        }
        let mut src = [0u8; 4];
        let mut dst = [0u8; 4];
        src.copy_from_slice(&pkt[12..16]);
        dst.copy_from_slice(&pkt[16..20]);
        pkt[12..16].copy_from_slice(&dst); // src = old dst (remote)
        pkt[16..20].copy_from_slice(&src); // dst = old src (client)
        let pb = relay_port.to_be_bytes();
        pkt[ihl + 2] = pb[0];
        pkt[ihl + 3] = pb[1];
        // sport unchanged (client ephemeral)
        pkt[10] = 0;
        pkt[11] = 0;
        pkt[ihl + 16] = 0;
        pkt[ihl + 17] = 0;
        true
    } else if ver == 6 {
        if pkt.len() < 60 || pkt[6] != 6 {
            return false;
        }
        let mut src = [0u8; 16];
        let mut dst = [0u8; 16];
        src.copy_from_slice(&pkt[8..24]);
        dst.copy_from_slice(&pkt[24..40]);
        pkt[8..24].copy_from_slice(&dst);
        pkt[24..40].copy_from_slice(&src);
        let pb = relay_port.to_be_bytes();
        pkt[42] = pb[0];
        pkt[43] = pb[1];
        pkt[40 + 16] = 0;
        pkt[40 + 17] = 0;
        true
    } else {
        false
    }
}

/// Streamdump PROXY→PORT:
/// `C:relay → R:sp`  ⇒  `R:orig_port → C:sp`.
pub(super) fn reflect_from_proxy(pkt: &mut [u8], orig_port: u16) -> bool {
    let ver = pkt.first().map(|b| b >> 4).unwrap_or(0);
    if ver == 4 {
        if pkt.len() < 40 {
            return false;
        }
        let ihl = (pkt[0] & 0x0f) as usize * 4;
        if ihl < 20 || pkt.len() < ihl + 20 || pkt[9] != 6 {
            return false;
        }
        let mut src = [0u8; 4];
        let mut dst = [0u8; 4];
        src.copy_from_slice(&pkt[12..16]);
        dst.copy_from_slice(&pkt[16..20]);
        pkt[12..16].copy_from_slice(&dst); // src = old dst (remote)
        pkt[16..20].copy_from_slice(&src); // dst = old src (client)
        let pb = orig_port.to_be_bytes();
        pkt[ihl] = pb[0];
        pkt[ihl + 1] = pb[1];
        // dport stays client ephemeral
        pkt[10] = 0;
        pkt[11] = 0;
        pkt[ihl + 16] = 0;
        pkt[ihl + 17] = 0;
        true
    } else if ver == 6 {
        if pkt.len() < 60 || pkt[6] != 6 {
            return false;
        }
        let mut src = [0u8; 16];
        let mut dst = [0u8; 16];
        src.copy_from_slice(&pkt[8..24]);
        dst.copy_from_slice(&pkt[24..40]);
        pkt[8..24].copy_from_slice(&dst);
        pkt[24..40].copy_from_slice(&src);
        let pb = orig_port.to_be_bytes();
        pkt[40] = pb[0];
        pkt[41] = pb[1];
        pkt[40 + 16] = 0;
        pkt[40 + 17] = 0;
        true
    } else {
        false
    }
}

/// Addresses, ports and TCP flags of an IPv4/IPv6 TCP packet.
#[derive(Debug, Clone, Copy)]
pub(super) struct TcpMeta {
    pub(super) src: IpAddr,
    pub(super) sport: u16,
    pub(super) dst: IpAddr,
    pub(super) dport: u16,
    /// TCP control bits; FIN/SYN/RST drive flow-table lifetime.
    pub(super) flags: u8,
}

pub(super) fn parse_ip_tcp(pkt: &[u8]) -> Option<TcpMeta> {
    if pkt.is_empty() {
        return None;
    }
    let ver = pkt[0] >> 4;
    if ver == 4 {
        if pkt.len() < 40 {
            return None;
        }
        let ihl = (pkt[0] & 0x0f) as usize * 4;
        if ihl < 20 || pkt.len() < ihl + 20 || pkt[9] != 6 {
            return None;
        }
        Some(TcpMeta {
            src: IpAddr::V4(Ipv4Addr::new(pkt[12], pkt[13], pkt[14], pkt[15])),
            sport: u16::from_be_bytes([pkt[ihl], pkt[ihl + 1]]),
            dst: IpAddr::V4(Ipv4Addr::new(pkt[16], pkt[17], pkt[18], pkt[19])),
            dport: u16::from_be_bytes([pkt[ihl + 2], pkt[ihl + 3]]),
            flags: pkt[ihl + 13],
        })
    } else if ver == 6 {
        // Fixed header only (no extension headers).
        if pkt.len() < 40 + 20 {
            return None;
        }
        if pkt[6] != 6 {
            return None; // next header must be TCP
        }
        let mut s = [0u8; 16];
        let mut d = [0u8; 16];
        s.copy_from_slice(&pkt[8..24]);
        d.copy_from_slice(&pkt[24..40]);
        Some(TcpMeta {
            src: IpAddr::V6(Ipv6Addr::from(s)),
            sport: u16::from_be_bytes([pkt[40], pkt[41]]),
            dst: IpAddr::V6(Ipv6Addr::from(d)),
            dport: u16::from_be_bytes([pkt[42], pkt[43]]),
            flags: pkt[40 + 13],
        })
    } else {
        None
    }
}

/// Addresses and ports of an IPv4/IPv6 UDP packet (QUIC blocking path).
#[derive(Debug, Clone, Copy)]
pub(super) struct UdpMeta {
    pub(super) src: IpAddr,
    pub(super) sport: u16,
    pub(super) dst: IpAddr,
    pub(super) dport: u16,
}

/// Parse UDP header addressing. IPv6 with extension headers is not chased: a
/// non-UDP next-header returns `None`, so the datagram passes (safe side —
/// worst case a QUIC packet leaks rather than an unrelated one being dropped).
pub(super) fn parse_ip_udp(pkt: &[u8]) -> Option<UdpMeta> {
    if pkt.is_empty() {
        return None;
    }
    let ver = pkt[0] >> 4;
    if ver == 4 {
        if pkt.len() < 28 {
            return None;
        }
        let ihl = (pkt[0] & 0x0f) as usize * 4;
        if ihl < 20 || pkt.len() < ihl + 8 || pkt[9] != 17 {
            return None;
        }
        Some(UdpMeta {
            src: IpAddr::V4(Ipv4Addr::new(pkt[12], pkt[13], pkt[14], pkt[15])),
            sport: u16::from_be_bytes([pkt[ihl], pkt[ihl + 1]]),
            dst: IpAddr::V4(Ipv4Addr::new(pkt[16], pkt[17], pkt[18], pkt[19])),
            dport: u16::from_be_bytes([pkt[ihl + 2], pkt[ihl + 3]]),
        })
    } else if ver == 6 {
        if pkt.len() < 40 + 8 {
            return None;
        }
        if pkt[6] != 17 {
            return None; // next header must be UDP (no extension-header walk)
        }
        let mut s = [0u8; 16];
        let mut d = [0u8; 16];
        s.copy_from_slice(&pkt[8..24]);
        d.copy_from_slice(&pkt[24..40]);
        Some(UdpMeta {
            src: IpAddr::V6(Ipv6Addr::from(s)),
            sport: u16::from_be_bytes([pkt[40], pkt[41]]),
            dst: IpAddr::V6(Ipv6Addr::from(d)),
            dport: u16::from_be_bytes([pkt[42], pkt[43]]),
        })
    } else {
        None
    }
}
