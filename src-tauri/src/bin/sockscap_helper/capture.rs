//! FLOW (PID map) + NETWORK (IPv4/IPv6 TCP NAT → loopback relay) capture engine.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::json;
use winapi::um::winnt::HANDLE;

use crate::proc_info::{
    path_matches_selector, tcp_owner_pid, SharedTree,
};
use crate::windivert::{
    addr_event, addr_is_outbound, addr_layer, addr_set_loopback, flow_endpoints_ip,
    flow_process_id, WinDivertApi, ADDR_LEN, LAYER_FLOW, LAYER_NETWORK,
};

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub ip: IpAddr,
    pub port: u16,
}

#[derive(Debug, Clone)]
pub struct CapturePlan {
    pub mode_apps: bool,
    pub app_paths: Vec<String>,
    pub bypass_cidrs: Vec<String>,
    pub bypass_pids: Vec<u32>,
    pub bypass_endpoints: Vec<Endpoint>,
    pub relay_ip: Ipv4Addr,
    pub relay_port: u16,
}

#[derive(Debug, Clone)]
struct FlowInfo {
    pid: u32,
    path: String,
    remote: IpAddr,
    remote_port: u16,
}

#[derive(Debug, Clone)]
struct RedirectMapping {
    orig_dst: IpAddr,
    orig_port: u16,
    pid: u32,
    path: String,
}

fn flow_key(ip: IpAddr, port: u16) -> String {
    format!("{ip}:{port}")
}

pub struct CaptureEngine {
    windivert_dir: Option<PathBuf>,
    api: Option<Arc<WinDivertApi>>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    flow_handle: Option<usize>,
    net_handle: Option<usize>,
    /// "local_ip:local_port" → flow info
    flows: Arc<Mutex<HashMap<String, FlowInfo>>>,
    /// "src_ip:src_port" after redirect → original destination
    redirects: Arc<Mutex<HashMap<String, RedirectMapping>>>,
    plan: Option<CapturePlan>,
    packets_seen: Arc<AtomicU64>,
    packets_redirected: Arc<AtomicU64>,
    active: bool,
}

impl CaptureEngine {
    pub fn new(windivert_dir: Option<PathBuf>) -> Self {
        Self {
            windivert_dir,
            api: None,
            stop: Arc::new(AtomicBool::new(false)),
            threads: Vec::new(),
            flow_handle: None,
            net_handle: None,
            flows: Arc::new(Mutex::new(HashMap::new())),
            redirects: Arc::new(Mutex::new(HashMap::new())),
            plan: None,
            packets_seen: Arc::new(AtomicU64::new(0)),
            packets_redirected: Arc::new(AtomicU64::new(0)),
            active: false,
        }
    }

    pub fn status_json(&self) -> serde_json::Value {
        json!({
            "active": self.active,
            "packetsSeen": self.packets_seen.load(Ordering::Relaxed),
            "packetsRedirected": self.packets_redirected.load(Ordering::Relaxed),
            "flowEntries": self.flows.lock().map(|m| m.len()).unwrap_or(0),
            "redirectEntries": self.redirects.lock().map(|m| m.len()).unwrap_or(0),
            "relayPort": self.plan.as_ref().map(|p| p.relay_port),
            "ipv6": true,
        })
    }

    pub fn probe(&mut self, filter: &str) -> Result<serde_json::Value, String> {
        let api = self.ensure_api()?;
        let h = api.open(filter, LAYER_NETWORK, 0, 0)?;
        api.close_handle(h);
        Ok(json!({
            "message": "WinDivert open/close probe succeeded",
            "elevated": true,
            "filter": filter,
        }))
    }

    pub fn start(&mut self, plan: CapturePlan) -> Result<serde_json::Value, String> {
        self.stop();
        let api = self.ensure_api()?;
        self.stop = Arc::new(AtomicBool::new(false));
        self.plan = Some(plan.clone());
        self.packets_seen.store(0, Ordering::Relaxed);
        self.packets_redirected.store(0, Ordering::Relaxed);

        let flow_h = api.open("tcp", LAYER_FLOW, 1000, 0)?;
        // IPv4 + IPv6 TCP; return path from v4/v6 loopback relay.
        let filter = format!(
            "tcp and (outbound or (inbound and tcp.SrcPort == {rp} and \
             (ip.SrcAddr == {rip} or ipv6.SrcAddr == ::1)))",
            rip = plan.relay_ip,
            rp = plan.relay_port
        );
        let net_h = api.open(&filter, LAYER_NETWORK, 0, 0)?;
        let relay_desc = format!("{}:{}", plan.relay_ip, plan.relay_port);
        let mode_apps = plan.mode_apps;

        self.flow_handle = Some(flow_h as usize);
        self.net_handle = Some(net_h as usize);
        self.active = true;

        let stop = Arc::clone(&self.stop);
        let flows = Arc::clone(&self.flows);
        let api_flow = Arc::clone(&api);
        let flow_handle = flow_h as usize;
        self.threads.push(std::thread::spawn(move || {
            flow_loop(api_flow, flow_handle as HANDLE, flows, stop);
        }));

        let stop = Arc::clone(&self.stop);
        let flows = Arc::clone(&self.flows);
        let redirects = Arc::clone(&self.redirects);
        let api_net = Arc::clone(&api);
        let net_handle = net_h as usize;
        let seen = Arc::clone(&self.packets_seen);
        let redirected = Arc::clone(&self.packets_redirected);
        let tree = Arc::new(SharedTree::new());
        self.threads.push(std::thread::spawn(move || {
            network_loop(
                api_net,
                net_handle as HANDLE,
                flows,
                redirects,
                plan,
                seen,
                redirected,
                stop,
                tree,
            );
        }));

        Ok(json!({
            "started": true,
            "filter": filter,
            "relay": relay_desc,
            "modeApps": mode_apps,
            "ipv6": true,
        }))
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(api) = &self.api {
            if let Some(h) = self.flow_handle.take() {
                api.close_handle(h as HANDLE);
            }
            if let Some(h) = self.net_handle.take() {
                api.close_handle(h as HANDLE);
            }
        }
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
        if let Ok(mut m) = self.flows.lock() {
            m.clear();
        }
        if let Ok(mut m) = self.redirects.lock() {
            m.clear();
        }
        self.active = false;
        self.plan = None;
    }

    pub fn lookup_orig(&self, src_port: u16) -> Option<serde_json::Value> {
        // Prefer exact key match ending with :port (first hit).
        let map = self.redirects.lock().ok()?;
        let suffix = format!(":{src_port}");
        let m = map
            .iter()
            .find(|(k, _)| k.ends_with(&suffix))
            .map(|(_, v)| v.clone())?;
        Some(json!({
            "dstIp": m.orig_dst.to_string(),
            "dstPort": m.orig_port,
            "pid": m.pid,
            "path": m.path,
        }))
    }

    pub fn lookup_orig_ip_port(&self, src_ip: &str, src_port: u16) -> Option<serde_json::Value> {
        let key = if src_ip.is_empty() {
            return self.lookup_orig(src_port);
        } else {
            format!("{src_ip}:{src_port}")
        };
        let map = self.redirects.lock().ok()?;
        let m = map.get(&key).cloned().or_else(|| {
            // Fallback: any entry with this port.
            let suffix = format!(":{src_port}");
            map.iter()
                .find(|(k, _)| k.ends_with(&suffix))
                .map(|(_, v)| v.clone())
        })?;
        Some(json!({
            "dstIp": m.orig_dst.to_string(),
            "dstPort": m.orig_port,
            "pid": m.pid,
            "path": m.path,
        }))
    }

    fn ensure_api(&mut self) -> Result<Arc<WinDivertApi>, String> {
        if let Some(api) = &self.api {
            return Ok(Arc::clone(api));
        }
        let api = Arc::new(WinDivertApi::load(self.windivert_dir.as_deref())?);
        self.api = Some(Arc::clone(&api));
        Ok(api)
    }
}

impl Drop for CaptureEngine {
    fn drop(&mut self) {
        self.stop();
    }
}

fn flow_loop(
    api: Arc<WinDivertApi>,
    handle: HANDLE,
    flows: Arc<Mutex<HashMap<String, FlowInfo>>>,
    stop: Arc<AtomicBool>,
) {
    let mut packet = vec![0u8; 1];
    let mut addr = vec![0u8; ADDR_LEN];
    while !stop.load(Ordering::SeqCst) {
        match api.recv(handle, &mut packet, &mut addr) {
            Ok(_) => {
                if addr_layer(&addr) != LAYER_FLOW as u8 {
                    continue;
                }
                let event = addr_event(&addr);
                let pid = flow_process_id(&addr);
                let Some((local, local_port, remote, remote_port, proto)) =
                    flow_endpoints_ip(&addr)
                else {
                    continue;
                };
                if proto != 6 {
                    continue;
                }
                let key = flow_key(local, local_port);
                if event == 1 {
                    if let Ok(mut m) = flows.lock() {
                        m.remove(&key);
                    }
                    continue;
                }
                if !addr_is_outbound(&addr) {
                    continue;
                }
                let path = process_path(pid).unwrap_or_default();
                if let Ok(mut m) = flows.lock() {
                    m.insert(
                        key,
                        FlowInfo {
                            pid,
                            path,
                            remote,
                            remote_port,
                        },
                    );
                }
            }
            Err(_) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }
}

fn network_loop(
    api: Arc<WinDivertApi>,
    handle: HANDLE,
    flows: Arc<Mutex<HashMap<String, FlowInfo>>>,
    redirects: Arc<Mutex<HashMap<String, RedirectMapping>>>,
    plan: CapturePlan,
    seen: Arc<AtomicU64>,
    redirected: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    tree: Arc<SharedTree>,
) {
    let mut packet = vec![0u8; 0xFFFF];
    let mut addr = vec![0u8; ADDR_LEN];
    let bypass_nets = parse_cidrs(&plan.bypass_cidrs);
    let relay_v4 = IpAddr::V4(plan.relay_ip);
    let relay_v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);

    while !stop.load(Ordering::SeqCst) {
        let len = match api.recv(handle, &mut packet, &mut addr) {
            Ok(n) => n,
            Err(_) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                continue;
            }
        };
        seen.fetch_add(1, Ordering::Relaxed);
        let pkt = &mut packet[..len];
        let outbound = addr_is_outbound(&addr);

        let Some((src, sport, dst, dport, is_v6)) = parse_ip_tcp(pkt) else {
            let _ = api.send(handle, pkt, &addr);
            continue;
        };

        if outbound {
            let key = flow_key(src, sport);
            if should_bypass(&plan, &bypass_nets, &key, dst, dport, &flows) {
                let _ = api.send(handle, pkt, &addr);
                continue;
            }

            let is_known = redirects
                .lock()
                .map(|m| m.contains_key(&key))
                .unwrap_or(false);

            let (pid, path, orig_dst, orig_port) = if is_known {
                match redirects.lock().ok().and_then(|m| m.get(&key).cloned()) {
                    Some(r) => (r.pid, r.path, r.orig_dst, r.orig_port),
                    None => {
                        let _ = api.send(handle, pkt, &addr);
                        continue;
                    }
                }
            } else {
                // Resolve flow info: FLOW table, short retry, then TCP table PID fallback.
                let f = resolve_flow(&flows, &tree, &key, src, sport);
                let Some(f) = f else {
                    // Unknown owner — pass through (fail-open).
                    let _ = api.send(handle, pkt, &addr);
                    continue;
                };
                if !process_in_scope(&plan, f.pid, &f.path, &tree) {
                    let _ = api.send(handle, pkt, &addr);
                    continue;
                }
                (f.pid, f.path.clone(), dst, dport)
            };

            // Already aimed at relay?
            if (dst == relay_v4 || dst == relay_v6) && dport == plan.relay_port {
                let _ = api.send(handle, pkt, &addr);
                continue;
            }

            if let Ok(mut m) = redirects.lock() {
                m.insert(
                    key,
                    RedirectMapping {
                        orig_dst,
                        orig_port,
                        pid,
                        path,
                    },
                );
            }

            let ok = if is_v6 {
                rewrite_ipv6_tcp_dst(pkt, Ipv6Addr::LOCALHOST, plan.relay_port)
            } else {
                rewrite_ipv4_tcp_dst(pkt, plan.relay_ip, plan.relay_port)
            };
            if ok {
                addr_set_loopback(&mut addr, true);
                api.calc_checksums(pkt, &mut addr);
                if api.send(handle, pkt, &addr).is_ok() {
                    redirected.fetch_add(1, Ordering::Relaxed);
                }
            }
        } else {
            // Inbound from relay → restore original source.
            let key = flow_key(dst, dport); // client is destination of return path
            if let Some(mapping) = redirects.lock().ok().and_then(|m| m.get(&key).cloned()) {
                let ok = match mapping.orig_dst {
                    IpAddr::V4(v4) => rewrite_ipv4_tcp_src(pkt, v4, mapping.orig_port),
                    IpAddr::V6(v6) => rewrite_ipv6_tcp_src(pkt, v6, mapping.orig_port),
                };
                if ok {
                    addr_set_loopback(&mut addr, false);
                    api.calc_checksums(pkt, &mut addr);
                    let _ = api.send(handle, pkt, &addr);
                    continue;
                }
            }
            let _ = api.send(handle, pkt, &addr);
        }
    }
}

fn should_bypass(
    plan: &CapturePlan,
    bypass_nets: &[(IpAddr, u8)],
    flow_key: &str,
    dst: IpAddr,
    dport: u16,
    flows: &Arc<Mutex<HashMap<String, FlowInfo>>>,
) -> bool {
    if let Ok(m) = flows.lock() {
        if let Some(f) = m.get(flow_key) {
            if plan.bypass_pids.contains(&f.pid) {
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

/// FLOW table miss → brief spin → GetExtendedTcpTable owner PID + process tree path.
fn resolve_flow(
    flows: &Arc<Mutex<HashMap<String, FlowInfo>>>,
    tree: &SharedTree,
    key: &str,
    src: IpAddr,
    sport: u16,
) -> Option<FlowInfo> {
    if let Some(f) = flows.lock().ok().and_then(|m| m.get(key).cloned()) {
        return Some(f);
    }
    // Race: NETWORK packet can arrive before FLOW event is processed.
    for _ in 0..3 {
        std::thread::sleep(std::time::Duration::from_millis(1));
        if let Some(f) = flows.lock().ok().and_then(|m| m.get(key).cloned()) {
            return Some(f);
        }
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
    let info = FlowInfo {
        pid,
        path,
        remote: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        remote_port: 0,
    };
    if let Ok(mut m) = flows.lock() {
        m.insert(key.to_string(), info.clone());
    }
    Some(info)
}

fn process_in_scope(plan: &CapturePlan, pid: u32, path: &str, tree: &SharedTree) -> bool {
    if plan.bypass_pids.contains(&pid) {
        return false;
    }
    if !plan.mode_apps {
        return true;
    }
    // Match this process path or any ancestor's path (child process of selected app).
    let mut candidates: Vec<String> = Vec::new();
    if !path.is_empty() {
        candidates.push(path.to_string());
    }
    if let Some(anc) = tree.with(|t| t.ancestor_paths(pid)) {
        candidates.extend(anc);
    }
    if candidates.is_empty() {
        return false;
    }
    plan.app_paths.iter().any(|sel| {
        candidates
            .iter()
            .any(|p| path_matches_selector(p, sel))
    })
}

fn process_path(pid: u32) -> Option<String> {
    use std::os::windows::ffi::OsStringExt;
    use winapi::shared::minwindef::{DWORD, FALSE, MAX_PATH};
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; MAX_PATH as usize * 4];
        let mut size = buf.len() as DWORD;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn QueryFullProcessImageNameW(
                h: HANDLE,
                flags: DWORD,
                buf: *mut u16,
                size: *mut DWORD,
            ) -> i32;
        }
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        let os = std::ffi::OsString::from_wide(&buf[..size as usize]);
        Some(os.to_string_lossy().to_string())
    }
}

fn parse_cidrs(list: &[String]) -> Vec<(IpAddr, u8)> {
    let mut out = Vec::new();
    for s in list {
        let s = s.trim();
        if let Some((a, p)) = s.split_once('/') {
            if let (Ok(ip), Ok(pref)) = (a.parse::<IpAddr>(), p.parse::<u8>()) {
                let max = match ip {
                    IpAddr::V4(_) => 32,
                    IpAddr::V6(_) => 128,
                };
                out.push((ip, pref.min(max)));
            }
        } else if let Ok(ip) = s.parse::<IpAddr>() {
            let pref = match ip {
                IpAddr::V4(_) => 32,
                IpAddr::V6(_) => 128,
            };
            out.push((ip, pref));
        }
    }
    out
}

fn ip_in_cidr(ip: IpAddr, net: IpAddr, prefix: u8) -> bool {
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let shift = 32u32.saturating_sub(prefix as u32);
            let mask = if shift >= 32 { 0 } else { u32::MAX << shift };
            (u32::from(a) & mask) == (u32::from(n) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let shift = 128u32.saturating_sub(prefix as u32);
            let mask = if shift >= 128 {
                0u128
            } else {
                u128::MAX << shift
            };
            (u128::from(a) & mask) == (u128::from(n) & mask)
        }
        _ => false,
    }
}

/// Returns (src, sport, dst, dport, is_v6)
fn parse_ip_tcp(pkt: &[u8]) -> Option<(IpAddr, u16, IpAddr, u16, bool)> {
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
        let src = IpAddr::V4(Ipv4Addr::new(pkt[12], pkt[13], pkt[14], pkt[15]));
        let dst = IpAddr::V4(Ipv4Addr::new(pkt[16], pkt[17], pkt[18], pkt[19]));
        let sport = u16::from_be_bytes([pkt[ihl], pkt[ihl + 1]]);
        let dport = u16::from_be_bytes([pkt[ihl + 2], pkt[ihl + 3]]);
        Some((src, sport, dst, dport, false))
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
        let src = IpAddr::V6(Ipv6Addr::from(s));
        let dst = IpAddr::V6(Ipv6Addr::from(d));
        let sport = u16::from_be_bytes([pkt[40], pkt[41]]);
        let dport = u16::from_be_bytes([pkt[42], pkt[43]]);
        Some((src, sport, dst, dport, true))
    } else {
        None
    }
}

fn rewrite_ipv4_tcp_dst(pkt: &mut [u8], dst: Ipv4Addr, dport: u16) -> bool {
    if pkt.len() < 40 || pkt[0] >> 4 != 4 {
        return false;
    }
    let ihl = (pkt[0] & 0x0f) as usize * 4;
    if pkt.len() < ihl + 20 {
        return false;
    }
    let o = dst.octets();
    pkt[16..20].copy_from_slice(&o);
    let pb = dport.to_be_bytes();
    pkt[ihl + 2] = pb[0];
    pkt[ihl + 3] = pb[1];
    pkt[10] = 0;
    pkt[11] = 0;
    pkt[ihl + 16] = 0;
    pkt[ihl + 17] = 0;
    true
}

fn rewrite_ipv4_tcp_src(pkt: &mut [u8], src: Ipv4Addr, sport: u16) -> bool {
    if pkt.len() < 40 || pkt[0] >> 4 != 4 {
        return false;
    }
    let ihl = (pkt[0] & 0x0f) as usize * 4;
    if pkt.len() < ihl + 20 {
        return false;
    }
    let o = src.octets();
    pkt[12..16].copy_from_slice(&o);
    let pb = sport.to_be_bytes();
    pkt[ihl] = pb[0];
    pkt[ihl + 1] = pb[1];
    pkt[10] = 0;
    pkt[11] = 0;
    pkt[ihl + 16] = 0;
    pkt[ihl + 17] = 0;
    true
}

fn rewrite_ipv6_tcp_dst(pkt: &mut [u8], dst: Ipv6Addr, dport: u16) -> bool {
    if pkt.len() < 60 || pkt[0] >> 4 != 6 || pkt[6] != 6 {
        return false;
    }
    pkt[24..40].copy_from_slice(&dst.octets());
    let pb = dport.to_be_bytes();
    pkt[42] = pb[0];
    pkt[43] = pb[1];
    pkt[40 + 16] = 0; // TCP checksum
    pkt[40 + 17] = 0;
    true
}

fn rewrite_ipv6_tcp_src(pkt: &mut [u8], src: Ipv6Addr, sport: u16) -> bool {
    if pkt.len() < 60 || pkt[0] >> 4 != 6 || pkt[6] != 6 {
        return false;
    }
    pkt[8..24].copy_from_slice(&src.octets());
    let pb = sport.to_be_bytes();
    pkt[40] = pb[0];
    pkt[41] = pb[1];
    pkt[40 + 16] = 0;
    pkt[40 + 17] = 0;
    true
}
