use super::address::ip_in_cidr;
use super::address::parse_cidrs;
use super::filter::NETWORK_FILTER;
use super::filter::NETWORK_FILTER_WITH_QUIC;
use super::filter::build_network_filter;
use super::filter::cidr_range;
use super::flow_table::FLOW_CLOSE_GRACE;
use super::flow_table::FLOW_SWEEP_INTERVAL;
use super::flow_table::FlowAction;
use super::flow_table::FlowKey;
use super::flow_table::FlowTable;
use super::flow_table::FlowVerdict;
use super::flow_table::MAX_FLOW_ENTRIES;
use super::flow_table::RedirectMapping;
use super::packet::TCP_ACK;
use super::packet::TCP_FIN;
use super::packet::TCP_SYN;
use super::packet::is_syn_open;
use super::packet::parse_ip_tcp;
use super::packet::parse_ip_udp;
use super::pid_map::FlowInfo;
use super::pid_map::FlowMap;
use super::pid_map::PID_MAP_TTL;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::time::Duration;
use std::time::Instant;

fn client(port: u16) -> FlowKey {
    (IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)), port)
}

fn remote(last: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(93, 184, 216, last))
}

fn redirect_to(key: FlowKey, dst: IpAddr, dport: u16) -> FlowVerdict {
    FlowVerdict::Redirect(RedirectMapping {
        orig_src: key.0,
        orig_sport: key.1,
        orig_dst: dst,
        orig_port: dport,
        pid: 4242,
        path: r"c:\app.exe".into(),
    })
}

#[test]
fn recycled_port_to_a_new_destination_is_not_reused() {
    // The long-uptime failure: Windows hands out only ~16k ephemeral ports,
    // so a busy host reuses one within hours. Matching on the key alone made
    // the new connection inherit the old destination.
    let mut t = FlowTable::default();
    let now = Instant::now();
    let key = client(52_000);
    t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);

    assert_eq!(
        t.lookup(key, remote(1), 443, now),
        Some(FlowAction::Redirect)
    );
    // Same local port, different peer → previous verdict must not apply.
    assert_eq!(t.lookup(key, remote(2), 443, now), None);
    assert_eq!(t.len(), 0, "stale entry should be dropped, not kept");
}

#[test]
fn recycled_port_to_a_new_port_on_the_same_host_is_not_reused() {
    let mut t = FlowTable::default();
    let now = Instant::now();
    let key = client(52_001);
    t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);
    assert_eq!(t.lookup(key, remote(1), 8443, now), None);
}

#[test]
fn bypass_verdicts_expire_by_the_same_rule_as_redirects() {
    // Caching "leave this flow alone" is what stops the packet path from
    // re-enumerating processes per packet — but it has to be invalidated
    // exactly like a redirect, or it just moves the staleness bug.
    let mut t = FlowTable::default();
    let now = Instant::now();
    let key = client(52_002);
    t.insert(key, remote(1), 80, FlowVerdict::Bypass, now);

    assert_eq!(t.lookup(key, remote(1), 80, now), Some(FlowAction::Bypass));
    assert_eq!(t.lookup(key, remote(3), 80, now), None);
    assert_eq!(t.len(), 0);
}

#[test]
fn peer_lookup_recovers_the_original_destination_port() {
    let mut t = FlowTable::default();
    let now = Instant::now();
    let key = client(52_003);
    t.insert(key, remote(1), 8443, redirect_to(key, remote(1), 8443), now);

    // Proxy→client packets arrive as `relay → orig_remote:client_port`.
    assert_eq!(t.peer_lookup((remote(1), 52_003), now), Some((key, 8443)));
    assert_eq!(t.peer_lookup((remote(9), 52_003), now), None);
}

#[test]
fn removal_clears_every_index() {
    let mut t = FlowTable::default();
    let now = Instant::now();
    let key = client(52_004);
    t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);
    t.remove(&key);

    assert_eq!(t.len(), 0);
    assert!(t.peer_index.is_empty(), "peer index leaked");
    assert!(t.sport_index.is_empty(), "sport index leaked");
    assert!(t.mapping_by_sport(52_004).is_none());
}

#[test]
fn reinserting_a_key_does_not_leak_the_previous_peer_index() {
    let mut t = FlowTable::default();
    let now = Instant::now();
    let key = client(52_005);
    t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);
    t.insert(key, remote(2), 443, redirect_to(key, remote(2), 443), now);

    assert_eq!(t.peer_index.len(), 1);
    assert_eq!(t.peer_lookup((remote(2), 52_005), now), Some((key, 443)));
    assert_eq!(t.peer_lookup((remote(1), 52_005), now), None);
}

#[test]
fn close_grace_then_sweep_reclaims_the_entry() {
    let mut t = FlowTable::default();
    let now = Instant::now();
    let key = client(52_006);
    t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);

    // FIN/RST brings expiry forward without breaking the rest of the
    // close handshake.
    t.mark_closing(&key, now);
    assert_eq!(
        t.lookup(key, remote(1), 443, now),
        Some(FlowAction::Redirect)
    );

    // `lookup` refreshed the entry, so close again and sweep past the grace.
    t.mark_closing(&key, now);
    t.sweep_if_due(now + FLOW_CLOSE_GRACE + Duration::from_secs(1));
    assert_eq!(t.len(), 0);
    assert!(t.sport_index.is_empty());
}

#[test]
fn sweeping_is_rate_limited_so_the_packet_path_pays_it_rarely() {
    let mut t = FlowTable::default();
    let now = Instant::now();
    let key = client(52_007);
    t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);
    t.mark_closing(&key, now); // expires at now + FLOW_CLOSE_GRACE

    t.sweep_if_due(now); // primes last_sweep

    // Expired, but within the sweep interval — deliberately left alone so
    // the packet loop does not walk the table on every packet.
    let too_soon = now + FLOW_CLOSE_GRACE + Duration::from_secs(1);
    assert!(too_soon < now + FLOW_SWEEP_INTERVAL);
    t.sweep_if_due(too_soon);
    assert_eq!(t.len(), 1);

    t.sweep_if_due(now + FLOW_SWEEP_INTERVAL + Duration::from_secs(1));
    assert_eq!(t.len(), 0);
}

#[test]
fn table_stays_bounded_when_eviction_signals_are_missed() {
    // No FLOW delete events, no FIN/RST: memory must still not run away.
    let mut t = FlowTable::default();
    let now = Instant::now();
    for i in 0..(MAX_FLOW_ENTRIES + 2_000) {
        let key = (
            IpAddr::V4(Ipv4Addr::new(10, (i >> 16) as u8, (i >> 8) as u8, i as u8)),
            1024 + (i % 60_000) as u16,
        );
        t.insert(
            key,
            remote(1),
            443,
            redirect_to(key, remote(1), 443),
            now + Duration::from_millis(i as u64),
        );
    }
    assert!(t.len() <= MAX_FLOW_ENTRIES);
    assert!(t.peer_index.len() <= MAX_FLOW_ENTRIES);
    assert!(t.sport_index.len() <= MAX_FLOW_ENTRIES);
}

#[test]
fn network_filter_excludes_bypassed_destinations() {
    let f = build_network_filter(
        &[
            "127.0.0.0/8".into(),
            "192.168.0.0/16".into(),
            "::1/128".into(),
        ],
        false,
    );
    assert!(f.starts_with("tcp and outbound"));
    assert!(f.contains("not (ip.DstAddr >= 127.0.0.0 and ip.DstAddr <= 127.255.255.255)"));
    assert!(f.contains("not (ip.DstAddr >= 192.168.0.0 and ip.DstAddr <= 192.168.255.255)"));
    assert!(f.contains("ipv6.DstAddr >= ::1 and ipv6.DstAddr <= ::1"));
}

#[test]
fn network_filter_without_bypasses_is_the_base_filter() {
    // block_quic off must be byte-identical to the pre-QUIC behaviour.
    assert_eq!(build_network_filter(&[], false), NETWORK_FILTER);
    // Unparseable entries are skipped rather than producing broken syntax
    // that would make WinDivertOpen fail.
    assert_eq!(
        build_network_filter(&["not-an-address".into()], false),
        NETWORK_FILTER
    );
}

#[test]
fn network_filter_widens_to_udp_443_when_blocking_quic() {
    let f = build_network_filter(&[], true);
    assert_eq!(f, NETWORK_FILTER_WITH_QUIC);
    assert!(f.contains("udp.DstPort == 443"));
    // TCP is still captured alongside UDP 443.
    assert!(f.contains("tcp"));
    // CIDR exclusions still append (and apply to both families via DstAddr).
    let g = build_network_filter(&["10.0.0.0/8".into()], true);
    assert!(g.starts_with(NETWORK_FILTER_WITH_QUIC));
    assert!(g.contains("not (ip.DstAddr >= 10.0.0.0 and ip.DstAddr <= 10.255.255.255)"));
}

#[test]
fn parses_udp_443_from_ipv4() {
    let mut pkt = vec![0u8; 28];
    pkt[0] = 0x45; // IPv4, ihl=5
    pkt[9] = 17; // UDP
    pkt[12..16].copy_from_slice(&[192, 168, 1, 10]);
    pkt[16..20].copy_from_slice(&[93, 184, 216, 34]);
    pkt[20..22].copy_from_slice(&54_000u16.to_be_bytes());
    pkt[22..24].copy_from_slice(&443u16.to_be_bytes());

    let meta = parse_ip_udp(&pkt).expect("valid IPv4 UDP packet");
    assert_eq!(meta.sport, 54_000);
    assert_eq!(meta.dport, 443);
    assert_eq!(meta.dst, remote(34));
    // A TCP parse of the same packet must fail (proto mismatch).
    assert!(parse_ip_tcp(&pkt).is_none());
}

#[test]
fn cidr_ranges_cover_exactly_the_block() {
    let (lo, hi) = cidr_range(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 0)), 12);
    assert_eq!(lo, IpAddr::V4(Ipv4Addr::new(172, 16, 0, 0)));
    assert_eq!(hi, IpAddr::V4(Ipv4Addr::new(172, 31, 255, 255)));

    // A host route is a single address.
    let (lo, hi) = cidr_range(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), 32);
    assert_eq!(lo, hi);

    // /0 covers everything.
    let (lo, hi) = cidr_range(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);
    assert_eq!(lo, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    assert_eq!(hi, IpAddr::V4(Ipv4Addr::new(255, 255, 255, 255)));
}

#[test]
fn filter_exclusions_agree_with_the_runtime_bypass_check() {
    // The kernel filter is only safe because it excludes exactly what
    // `should_bypass` would have passed through anyway.
    let cidrs = vec!["10.0.0.0/8".to_string(), "fc00::/7".to_string()];
    let nets = parse_cidrs(&cidrs);
    for (net, prefix) in &nets {
        let (lo, hi) = cidr_range(*net, *prefix);
        for probe in [lo, hi] {
            assert!(
                ip_in_cidr(probe, *net, *prefix),
                "{probe} should be inside {net}/{prefix}"
            );
        }
    }
    // And a public address is outside every one of them.
    let public: IpAddr = "93.184.216.34".parse().unwrap();
    assert!(!nets.iter().any(|(n, p)| ip_in_cidr(public, *n, *p)));
}

#[test]
fn syn_without_ack_marks_a_new_connection() {
    assert!(is_syn_open(TCP_SYN));
    // SYN-ACK is the peer answering an existing handshake.
    assert!(!is_syn_open(TCP_SYN | TCP_ACK));
    assert!(!is_syn_open(TCP_ACK));
    assert!(!is_syn_open(TCP_FIN | TCP_ACK));
}

#[test]
fn parses_tcp_flags_from_ipv4() {
    let mut pkt = vec![0u8; 60];
    pkt[0] = 0x45; // IPv4, ihl=5
    pkt[9] = 6; // TCP
    pkt[12..16].copy_from_slice(&[192, 168, 1, 10]);
    pkt[16..20].copy_from_slice(&[93, 184, 216, 34]);
    pkt[20..22].copy_from_slice(&50_000u16.to_be_bytes());
    pkt[22..24].copy_from_slice(&443u16.to_be_bytes());
    pkt[20 + 13] = TCP_SYN;

    let meta = parse_ip_tcp(&pkt).expect("valid IPv4 TCP packet");
    assert_eq!(meta.sport, 50_000);
    assert_eq!(meta.dport, 443);
    assert_eq!(meta.dst, remote(34));
    assert!(is_syn_open(meta.flags));
}

#[test]
fn pid_map_expires_entries_the_tcp_table_fallback_inserted() {
    // FLOW delete events remove what FLOW inserted, but nothing ever
    // removed the GetExtendedTcpTable fallback's entries.
    let mut m = FlowMap::default();
    let now = Instant::now();
    let key = client(52_008);
    m.insert(
        key,
        FlowInfo {
            pid: 7,
            path: "x".into(),
            remote: remote(1),
            remote_port: 443,
            expires_at: now,
        },
        now,
    );
    assert!(m.get(&key).is_some());

    m.sweep_if_due(now + PID_MAP_TTL + Duration::from_secs(1));
    assert_eq!(m.len(), 0);
}
