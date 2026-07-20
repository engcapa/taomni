//! IPv4/TCP packet rewrite for the Windows WinDivert redirect backend
//! (plan §4.1/§8, ADR-0002).
//!
//! The WinDivert transparent-proxy technique redirects a captured SYN's
//! destination to a local transparent port and rewrites the return path back,
//! recovering the original destination from a connection-tracking map. The
//! header rewrite + checksum recomputation is pure, driver-independent logic —
//! implemented and unit-tested here; the WinDivert FFI recv/send loop that uses
//! it is `feature = "sockscap-windivert"`-gated (needs the signed driver + SDK).

use std::net::Ipv4Addr;

/// IPv4 header length in bytes from the IHL nibble.
pub fn ipv4_header_len(pkt: &[u8]) -> Option<usize> {
    if pkt.len() < 20 || (pkt[0] >> 4) != 4 {
        return None;
    }
    let ihl = (pkt[0] & 0x0f) as usize * 4;
    if ihl < 20 || pkt.len() < ihl {
        None
    } else {
        Some(ihl)
    }
}

/// The IPv4 destination address.
pub fn ipv4_dst(pkt: &[u8]) -> Option<Ipv4Addr> {
    if pkt.len() < 20 {
        return None;
    }
    Some(Ipv4Addr::new(pkt[16], pkt[17], pkt[18], pkt[19]))
}

/// True when the L4 protocol is TCP (6).
pub fn is_tcp(pkt: &[u8]) -> bool {
    pkt.len() > 9 && pkt[9] == 6
}

/// The TCP source port (requires a TCP IPv4 packet).
pub fn tcp_src_port(pkt: &[u8]) -> Option<u16> {
    let ihl = ipv4_header_len(pkt)?;
    if !is_tcp(pkt) || pkt.len() < ihl + 2 {
        return None;
    }
    Some(u16::from_be_bytes([pkt[ihl], pkt[ihl + 1]]))
}

/// The TCP destination port (requires a TCP IPv4 packet).
pub fn tcp_dst_port(pkt: &[u8]) -> Option<u16> {
    let ihl = ipv4_header_len(pkt)?;
    if !is_tcp(pkt) || pkt.len() < ihl + 4 {
        return None;
    }
    Some(u16::from_be_bytes([pkt[ihl + 2], pkt[ihl + 3]]))
}

/// The standard one's-complement internet checksum over `bytes`.
pub fn internet_checksum(bytes: &[u8]) -> u16 {
    let mut sum: u32 = 0;
    let mut i = 0;
    while i + 1 < bytes.len() {
        sum += u16::from_be_bytes([bytes[i], bytes[i + 1]]) as u32;
        i += 2;
    }
    if i < bytes.len() {
        sum += (bytes[i] as u32) << 8;
    }
    while (sum >> 16) != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

/// Recompute the IPv4 header checksum in place.
pub fn fix_ipv4_checksum(pkt: &mut [u8]) -> Option<()> {
    let ihl = ipv4_header_len(pkt)?;
    pkt[10] = 0;
    pkt[11] = 0;
    let cs = internet_checksum(&pkt[..ihl]);
    pkt[10..12].copy_from_slice(&cs.to_be_bytes());
    Some(())
}

/// Recompute the TCP checksum in place (over the pseudo-header + segment).
pub fn fix_tcp_checksum(pkt: &mut [u8]) -> Option<()> {
    let ihl = ipv4_header_len(pkt)?;
    if !is_tcp(pkt) {
        return None;
    }
    let tcp_len = pkt.len() - ihl;
    // Zero the checksum field first.
    pkt[ihl + 16] = 0;
    pkt[ihl + 17] = 0;
    // Pseudo-header: src(4) dst(4) zero(1) proto(1) tcp_len(2).
    let mut pseudo = Vec::with_capacity(12 + tcp_len);
    pseudo.extend_from_slice(&pkt[12..20]); // src + dst
    pseudo.push(0);
    pseudo.push(6); // TCP
    pseudo.extend_from_slice(&(tcp_len as u16).to_be_bytes());
    pseudo.extend_from_slice(&pkt[ihl..]);
    let cs = internet_checksum(&pseudo);
    pkt[ihl + 16..ihl + 18].copy_from_slice(&cs.to_be_bytes());
    Some(())
}

/// Rewrite the destination IP + TCP port of an outbound packet (redirect to the
/// local transparent port) and fix both checksums.
pub fn redirect_ipv4_tcp(pkt: &mut [u8], new_ip: Ipv4Addr, new_port: u16) -> Option<()> {
    let ihl = ipv4_header_len(pkt)?;
    if !is_tcp(pkt) || pkt.len() < ihl + 4 {
        return None;
    }
    pkt[16..20].copy_from_slice(&new_ip.octets());
    pkt[ihl + 2..ihl + 4].copy_from_slice(&new_port.to_be_bytes());
    fix_ipv4_checksum(pkt)?;
    fix_tcp_checksum(pkt)?;
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal IPv4+TCP SYN packet (20-byte IP header, 20-byte TCP header).
    fn syn_packet(dst: Ipv4Addr, dport: u16) -> Vec<u8> {
        let mut p = vec![0u8; 40];
        p[0] = 0x45; // version 4, IHL 5
        p[3] = 40; // total length
        p[9] = 6; // TCP
        p[12..16].copy_from_slice(&[10, 0, 0, 1]); // src
        p[16..20].copy_from_slice(&dst.octets()); // dst
        p[20..22].copy_from_slice(&40000u16.to_be_bytes()); // src port
        p[22..24].copy_from_slice(&dport.to_be_bytes()); // dst port
        p[32] = 0x50; // data offset 5
        p[33] = 0x02; // SYN
        fix_ipv4_checksum(&mut p).unwrap();
        fix_tcp_checksum(&mut p).unwrap();
        p
    }

    #[test]
    fn parses_dst_and_port() {
        let p = syn_packet("93.184.216.34".parse().unwrap(), 443);
        assert_eq!(ipv4_dst(&p).unwrap(), "93.184.216.34".parse::<Ipv4Addr>().unwrap());
        assert_eq!(tcp_dst_port(&p).unwrap(), 443);
        assert!(is_tcp(&p));
    }

    #[test]
    fn checksums_are_valid_after_build() {
        let p = syn_packet("1.2.3.4".parse().unwrap(), 80);
        // A correct IPv4 header checksums to zero.
        let ihl = ipv4_header_len(&p).unwrap();
        assert_eq!(internet_checksum(&p[..ihl]), 0);
    }

    #[test]
    fn redirect_rewrites_dst_and_keeps_valid_checksums() {
        let mut p = syn_packet("93.184.216.34".parse().unwrap(), 443);
        redirect_ipv4_tcp(&mut p, Ipv4Addr::LOCALHOST, 1080).unwrap();
        assert_eq!(ipv4_dst(&p).unwrap(), Ipv4Addr::LOCALHOST);
        assert_eq!(tcp_dst_port(&p).unwrap(), 1080);
        // IP header still checksums to zero after rewrite.
        let ihl = ipv4_header_len(&p).unwrap();
        assert_eq!(internet_checksum(&p[..ihl]), 0);
        // TCP checksum valid: pseudo-header + segment checksums to zero.
        let tcp_len = p.len() - ihl;
        let mut pseudo = Vec::new();
        pseudo.extend_from_slice(&p[12..20]);
        pseudo.push(0);
        pseudo.push(6);
        pseudo.extend_from_slice(&(tcp_len as u16).to_be_bytes());
        pseudo.extend_from_slice(&p[ihl..]);
        assert_eq!(internet_checksum(&pseudo), 0);
    }

    #[test]
    fn rejects_non_ipv4_or_non_tcp() {
        assert!(ipv4_header_len(&[0u8; 10]).is_none());
        let mut udp = syn_packet("1.2.3.4".parse().unwrap(), 80);
        udp[9] = 17; // UDP
        assert!(tcp_dst_port(&udp).is_none());
        assert!(redirect_ipv4_tcp(&mut udp, Ipv4Addr::LOCALHOST, 1).is_none());
    }
}
