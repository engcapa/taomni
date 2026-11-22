use super::address::ip_in_cidr;
use super::address::is_loopback_ip;
use super::flow_table::FlowAction;
use super::flow_table::FlowKey;
use super::flow_table::FlowTable;
use super::flow_table::FlowVerdict;
use super::flow_table::RedirectMapping;
use super::maintenance::AppIndex;
use super::pid_map::FlowInfo;
use super::pid_map::FlowMap;
use super::plan::CapturePlan;
use super::process_scope::path_bypassed;
use super::process_scope::process_in_scope;
use super::process_scope::process_path;
use crate::proc_info::SharedTree;
use crate::proc_info::tcp_owner_pid;
use crate::proc_info::udp_owner_pid;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;

/// Decide, once per connection, whether to capture it.
///
/// Everything expensive lives here — process-tree walks, TCP-table owner
/// lookups, scope matching. Both outcomes are cached by the caller, so this
/// runs on the first packet of a connection and not again.
#[allow(clippy::too_many_arguments)]
pub(super) fn classify_flow(
    plan: &CapturePlan,
    bypass_nets: &[(IpAddr, u8)],
    flows: &Arc<Mutex<FlowMap>>,
    tree: &SharedTree,
    key: FlowKey,
    dst: IpAddr,
    dport: u16,
    app_index: &AppIndex,
) -> FlowVerdict {
    let (src, sport) = key;

    if should_bypass(plan, bypass_nets, &key, dst, dport, flows) {
        return FlowVerdict::Bypass;
    }
    // Local services are never proxied.
    if is_loopback_ip(dst) {
        return FlowVerdict::Bypass;
    }

    let (pid, path) = if plan.mode_apps {
        // Index hit answers both pid and path with no syscall at all — the old
        // code still went to `GetExtendedTcpTable` here, on the hit path.
        if let Some(&pid) = app_index.ports.get(&sport) {
            let path = app_index.paths.get(&pid).cloned().unwrap_or_default();
            (pid, path)
        } else {
            let Some(f) = resolve_flow(flows, tree, key) else {
                // Unattributable: leave App-mode traffic alone rather than
                // capturing something that may not be in scope.
                return FlowVerdict::Bypass;
            };
            if !app_index.pids.contains(&f.pid) && !process_in_scope(plan, f.pid, &f.path, tree) {
                return FlowVerdict::Bypass;
            }
            (f.pid, f.path.clone())
        }
    } else {
        // Global: everything is in scope unless explicitly excluded.
        let (pid, path) = match resolve_flow(flows, tree, key) {
            Some(f) => (f.pid, f.path),
            None => (0, String::new()),
        };
        if (pid != 0 && plan.bypass_pids.contains(&pid)) || path_bypassed(plan, &path) {
            return FlowVerdict::Bypass;
        }
        (pid, path)
    };

    FlowVerdict::Redirect(RedirectMapping {
        orig_src: src,
        orig_sport: sport,
        orig_dst: dst,
        orig_port: dport,
        pid,
        path,
    })
}

/// Whether an outbound UDP 443 datagram should be dropped to force QUIC→TCP.
///
/// Caches the per-flow verdict in `udp_verdicts` (separate from the TCP table so
/// a shared local port can't clobber it). `Redirect` means "in scope, drop";
/// `Bypass` means "pass". A QUIC connection is many datagrams, so this is one
/// classification then hash lookups; once the app falls back to TCP it stops
/// sending UDP 443 and the load collapses.
#[allow(clippy::too_many_arguments)]
pub(super) fn udp_should_drop(
    plan: &CapturePlan,
    bypass_nets: &[(IpAddr, u8)],
    tree: &SharedTree,
    udp_verdicts: &Arc<Mutex<FlowTable>>,
    key: FlowKey,
    dst: IpAddr,
    dport: u16,
    app_index: &AppIndex,
) -> bool {
    let now = Instant::now();
    let cached = udp_verdicts
        .lock()
        .ok()
        .and_then(|mut t| t.lookup(key, dst, dport, now));
    match cached {
        Some(FlowAction::Redirect) => return true,
        Some(FlowAction::Bypass) => return false,
        None => {}
    }
    let verdict = classify_flow_udp(plan, bypass_nets, tree, key, dst, dport, app_index);
    let drop = matches!(verdict, FlowVerdict::Redirect(_));
    if let Ok(mut t) = udp_verdicts.lock() {
        t.insert(key, dst, dport, verdict, now);
    }
    drop
}

/// Classify a UDP flow the same way `classify_flow` does for TCP, but attributing
/// via `udp_owner_pid` / `app_index.udp_ports` (UDP sockets are absent from the
/// FLOW-layer `flows` map, which only tracks TCP). `Redirect` = in scope → drop
/// its QUIC; `Bypass` = pass.
pub(super) fn classify_flow_udp(
    plan: &CapturePlan,
    bypass_nets: &[(IpAddr, u8)],
    tree: &SharedTree,
    key: FlowKey,
    dst: IpAddr,
    dport: u16,
    app_index: &AppIndex,
) -> FlowVerdict {
    let (src, sport) = key;

    // Destination-based bypass (endpoints / CIDRs / loopback). Cannot reuse
    // `should_bypass`: it resolves pid from the TCP `flows` map, which has no
    // UDP entries.
    for e in &plan.bypass_endpoints {
        if e.ip == dst && (e.port == 0 || e.port == dport) {
            return FlowVerdict::Bypass;
        }
    }
    for (net, prefix) in bypass_nets {
        if ip_in_cidr(dst, *net, *prefix) {
            return FlowVerdict::Bypass;
        }
    }
    if is_loopback_ip(dst) {
        return FlowVerdict::Bypass;
    }

    let (pid, path) = if plan.mode_apps {
        if let Some(&pid) = app_index.udp_ports.get(&sport) {
            let path = app_index.paths.get(&pid).cloned().unwrap_or_default();
            (pid, path)
        } else {
            // Miss: attribute directly. Unattributable App-mode traffic is left
            // alone (passed) — never drop something we cannot scope.
            let Some(pid) = udp_owner_pid(src, sport) else {
                return FlowVerdict::Bypass;
            };
            let path = tree
                .with(|t| t.path_of(pid).map(|s| s.to_string()))
                .flatten()
                .or_else(|| process_path(pid))
                .unwrap_or_default();
            if !app_index.pids.contains(&pid) && !process_in_scope(plan, pid, &path, tree) {
                return FlowVerdict::Bypass;
            }
            (pid, path)
        }
    } else {
        // Global: in scope unless explicitly bypassed by pid/path. This protects
        // the bundled xray core's own UDP egress (e.g. a WireGuard upstream),
        // whose pid + path are in the bypass lists. Unattributable → drop (same
        // as TCP global capture); a UDP socket is bound before its first
        // datagram so `udp_owner_pid`'s forced re-read normally resolves it.
        let pid = udp_owner_pid(src, sport).unwrap_or(0);
        let path = if pid != 0 {
            tree.with(|t| t.path_of(pid).map(|s| s.to_string()))
                .flatten()
                .or_else(|| process_path(pid))
                .unwrap_or_default()
        } else {
            String::new()
        };
        if (pid != 0 && plan.bypass_pids.contains(&pid)) || path_bypassed(plan, &path) {
            return FlowVerdict::Bypass;
        }
        (pid, path)
    };

    FlowVerdict::Redirect(RedirectMapping {
        orig_src: src,
        orig_sport: sport,
        orig_dst: dst,
        orig_port: dport,
        pid,
        path,
    })
}

pub(super) fn should_bypass(
    plan: &CapturePlan,
    bypass_nets: &[(IpAddr, u8)],
    flow_key: &FlowKey,
    dst: IpAddr,
    dport: u16,
    flows: &Arc<Mutex<FlowMap>>,
) -> bool {
    if let Ok(m) = flows.lock() {
        if let Some(f) = m.get(flow_key) {
            if plan.bypass_pids.contains(&f.pid) || path_bypassed(plan, &f.path) {
                return true;
            }
        }
    }
    for e in &plan.bypass_endpoints {
        if e.ip == dst && (e.port == 0 || e.port == dport) {
            return true;
        }
    }
    for (net, prefix) in bypass_nets {
        if ip_in_cidr(dst, *net, *prefix) {
            return true;
        }
    }
    false
}

/// FLOW table miss → GetExtendedTcpTable owner PID + process tree path.
///
/// Never sleeps. The previous version slept 1 ms hoping to win a race with the
/// FLOW layer and then, on a miss, another 2 ms before retrying — up to 3 ms of
/// the machine's *entire* outbound TCP path stalled, per unresolved connection.
/// It was also unnecessary: `GetExtendedTcpTable(OWNER_PID_ALL)` lists sockets
/// in `SYN_SENT`, so the row exists by the time the SYN reaches us, and
/// `tcp_owner_pid` already forces one fresh read on a miss.
pub(super) fn resolve_flow(
    flows: &Arc<Mutex<FlowMap>>,
    tree: &SharedTree,
    key: FlowKey,
) -> Option<FlowInfo> {
    let (src, sport) = key;
    if let Some(f) = flows.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Some(f);
    }
    let pid = tcp_owner_pid(src, sport)?;
    let path = tree
        .with(|t| {
            t.path_of(pid)
                .map(|s| s.to_string())
                .or_else(|| process_path(pid))
        })
        .flatten()
        .unwrap_or_else(|| process_path(pid).unwrap_or_default());
    let now = Instant::now();
    let info = FlowInfo {
        pid,
        path,
        remote: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        remote_port: 0,
        expires_at: now,
    };
    if let Ok(mut m) = flows.lock() {
        m.insert(key, info.clone(), now);
    }
    Some(info)
}
