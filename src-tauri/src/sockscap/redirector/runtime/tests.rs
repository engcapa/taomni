use super::capture_loop::relay_flow_capacity;
use super::flow::process_path;
use super::recovery::connectivity_probe_warning;
use super::recovery::parse_recovery_probe_targets;
use super::udp::should_block_udp;
use crate::sockscap::redirector::ipc::TunnelInfo;
use crate::sockscap::relay::MAX_ACTIVE_RELAY_FLOWS;
use std::net::SocketAddr;

#[test]
fn udp_443_is_blocked_only_for_in_scope_flows_when_enabled() {
    let quic: SocketAddr = "1.1.1.1:443".parse().unwrap();
    let dns: SocketAddr = "1.1.1.1:53".parse().unwrap();
    assert!(should_block_udp(true, true, quic));
    assert!(!should_block_udp(false, true, quic));
    assert!(!should_block_udp(true, false, quic));
    assert!(!should_block_udp(true, true, dns));
}

#[test]
fn process_path_ignores_empty_metadata() {
    let empty = TunnelInfo {
        pid: Some(1),
        process_name: Some("  ".into()),
    };
    assert_eq!(process_path(Some(&empty)), None);
}

#[test]
fn recovery_probe_targets_require_numeric_socket_addresses() {
    let targets = parse_recovery_probe_targets("127.0.0.1:80,[::1]:443").unwrap();
    assert_eq!(targets.len(), 2);
    assert!(parse_recovery_probe_targets("example.com:443").is_err());
    assert!(parse_recovery_probe_targets("  ").is_err());
}

#[test]
fn failed_connectivity_probe_is_advisory_after_inert_recovery() {
    let warning = connectivity_probe_warning(Err("host is offline".into()));
    assert_eq!(warning.as_deref(), Some("host is offline"));
    assert!(connectivity_probe_warning(Ok(())).is_none());
}

#[test]
fn relay_capacity_reserves_descriptors_for_the_desktop_app() {
    assert_eq!(relay_flow_capacity(256), 64);
    assert_eq!(relay_flow_capacity(1_024), 448);
    assert_eq!(relay_flow_capacity(4_096), MAX_ACTIVE_RELAY_FLOWS);
    assert_eq!(relay_flow_capacity(u64::MAX), MAX_ACTIVE_RELAY_FLOWS);
}
