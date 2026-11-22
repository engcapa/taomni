use super::plan::CapturePlan;
use super::process_scope::path_bypassed;
use std::net::Ipv4Addr;

fn plan_with_bypass_paths(paths: Vec<&str>) -> CapturePlan {
    CapturePlan {
        mode_apps: false,
        app_paths: vec![],
        bypass_cidrs: vec![],
        bypass_pids: vec![],
        bypass_paths: paths.into_iter().map(|s| s.to_string()).collect(),
        bypass_endpoints: vec![],
        relay_ip: Ipv4Addr::LOCALHOST,
        relay_port: 0,
        block_quic: false,
    }
}

#[test]
fn path_bypassed_matches_by_suffix_and_ignores_empty() {
    // Selector normalization is lowercase; store as the helper receives it.
    let plan = plan_with_bypass_paths(vec![r"clash.exe"]);
    assert!(path_bypassed(&plan, r"C:\Program Files\Clash\Clash.exe"));
    assert!(!path_bypassed(&plan, r"C:\Windows\System32\curl.exe"));
    // Empty flow path never matches (don't bypass unknown-path flows).
    assert!(!path_bypassed(&plan, ""));
}

#[test]
fn path_bypassed_empty_list_never_matches() {
    let plan = plan_with_bypass_paths(vec![]);
    assert!(!path_bypassed(&plan, r"C:\anything.exe"));
}
