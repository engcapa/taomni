//! FLOW (PID map) + NETWORK (IPv4 TCP NAT → loopback relay) capture engine.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::json;
use winapi::um::winnt::HANDLE;

use crate::windivert::{
    self, addr_event, addr_is_outbound, addr_layer, addr_set_loopback, flow_endpoints,
    flow_process_id, WinDivertApi, ADDR_LEN, LAYER_FLOW, LAYER_NETWORK,
};

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub ip: Ipv4Addr,
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
    remote: Ipv4Addr,
    remote_port: u16,
}

#[derive(Debug, Clone)]
struct RedirectMapping {
    orig_dst: Ipv4Addr,
    orig_port: u16,
    pid: u32,
    path: String,
}

pub struct CaptureEngine {
    windivert_dir: Option<PathBuf>,
    api: Option<Arc<WinDivertApi>>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    /// Stored as usize so CaptureEngine is Send (HANDLE is a raw pointer).
    flow_handle: Option<usize>,
    net_handle: Option<usize>,
    /// local_port → flow info (IPv4 TCP)
    flows: Arc<Mutex<HashMap<u16, FlowInfo>>>,
    /// After redirect: client source port → original destination
    redirects: Arc<Mutex<HashMap<u16, RedirectMapping>>>,
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

        // FLOW: all TCP for PID mapping
        let flow_h = api.open("tcp", LAYER_FLOW, 1000, 0)?;
        // NETWORK: IPv4 TCP outbound + return path from relay
        let filter = format!(
            "ip and tcp and (outbound or (inbound and ip.SrcAddr == {rip} and tcp.SrcPort == {rp}))",
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
            );
        }));

        Ok(json!({
            "started": true,
            "filter": filter,
            "relay": relay_desc,
            "modeApps": mode_apps,
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
        let map = self.redirects.lock().ok()?;
        let m = map.get(&src_port)?;
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
    flows: Arc<Mutex<HashMap<u16, FlowInfo>>>,
    stop: Arc<AtomicBool>,
) {
    let mut packet = vec![0u8; 1]; // FLOW layer may deliver empty packet body
    let mut addr = vec![0u8; ADDR_LEN];
    while !stop.load(Ordering::SeqCst) {
        match api.recv(handle, &mut packet, &mut addr) {
            Ok(_) => {
                if addr_layer(&addr) != LAYER_FLOW as u8 {
                    continue;
                }
                // Event 0 = established, 1 = deleted
                let event = addr_event(&addr);
                let pid = flow_process_id(&addr);
                let Some((local, local_port, remote, remote_port, proto)) = flow_endpoints(&addr)
                else {
                    continue;
                };
                if proto != 6 {
                    continue; // TCP
                }
                let _ = local;
                if event == 1 {
                    if let Ok(mut m) = flows.lock() {
                        m.remove(&local_port);
                    }
                    continue;
                }
                if !addr_is_outbound(&addr) {
                    continue;
                }
                let path = process_path(pid).unwrap_or_default();
                if let Ok(mut m) = flows.lock() {
                    m.insert(
                        local_port,
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
    flows: Arc<Mutex<HashMap<u16, FlowInfo>>>,
    redirects: Arc<Mutex<HashMap<u16, RedirectMapping>>>,
    plan: CapturePlan,
    seen: Arc<AtomicU64>,
    redirected: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
) {
    let mut packet = vec![0u8; 0xFFFF];
    let mut addr = vec![0u8; ADDR_LEN];
    let bypass_nets = parse_cidrs(&plan.bypass_cidrs);

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

        if outbound {
            if let Some((_src, sport, dst, dport)) = parse_ipv4_tcp(pkt) {
                // Already rewritten return path or our own traffic?
                if should_bypass(&plan, &bypass_nets, sport, dst, dport, &flows) {
                    let _ = api.send(handle, pkt, &addr);
                    continue;
                }

                // Return path from app? Handle mapping already exists → keep rewriting dst to relay
                let is_known_redirect = redirects
                    .lock()
                    .map(|m| m.contains_key(&sport))
                    .unwrap_or(false);

                let flow = flows.lock().ok().and_then(|m| m.get(&sport).cloned());
                let (pid, path, orig_dst, orig_port) = if is_known_redirect {
                    let m = redirects.lock().ok().and_then(|m| m.get(&sport).cloned());
                    match m {
                        Some(r) => (r.pid, r.path, r.orig_dst, r.orig_port),
                        None => {
                            let _ = api.send(handle, pkt, &addr);
                            continue;
                        }
                    }
                } else {
                    // New flow: require process match
                    let Some(f) = flow else {
                        // Unknown process — pass through (or drop if we want fail-closed global)
                        let _ = api.send(handle, pkt, &addr);
                        continue;
                    };
                    if !process_in_scope(&plan, f.pid, &f.path) {
                        let _ = api.send(handle, pkt, &addr);
                        continue;
                    }
                    // Destination from packet (authoritative for this SYN/data)
                    (f.pid, f.path.clone(), dst, dport)
                };

                // Don't redirect traffic already aimed at the relay.
                if dst == plan.relay_ip && dport == plan.relay_port {
                    let _ = api.send(handle, pkt, &addr);
                    continue;
                }

                if let Ok(mut m) = redirects.lock() {
                    m.insert(
                        sport,
                        RedirectMapping {
                            orig_dst,
                            orig_port,
                            pid,
                            path,
                        },
                    );
                }

                if rewrite_ipv4_tcp_dst(pkt, plan.relay_ip, plan.relay_port) {
                    addr_set_loopback(&mut addr, true);
                    api.calc_checksums(pkt, &mut addr);
                    if api.send(handle, pkt, &addr).is_ok() {
                        redirected.fetch_add(1, Ordering::Relaxed);
                    }
                }
                continue;
            }
        } else {
            // Inbound from relay → restore original source so the app TCP stack matches.
            if let Some((src, sport, dst, dport)) = parse_ipv4_tcp(pkt) {
                let _ = (src, sport);
                if let Some(mapping) = redirects.lock().ok().and_then(|m| m.get(&dport).cloned()) {
                    if rewrite_ipv4_tcp_src(pkt, mapping.orig_dst, mapping.orig_port) {
                        addr_set_loopback(&mut addr, false);
                        api.calc_checksums(pkt, &mut addr);
                        let _ = api.send(handle, pkt, &addr);
                        continue;
                    }
                }
            }
        }

        // Default: reinject unmodified
        let _ = api.send(handle, pkt, &addr);
    }
}

fn should_bypass(
    plan: &CapturePlan,
    bypass_nets: &[(Ipv4Addr, u8)],
    sport: u16,
    dst: Ipv4Addr,
    dport: u16,
    flows: &Arc<Mutex<HashMap<u16, FlowInfo>>>,
) -> bool {
    if let Ok(m) = flows.lock() {
        if let Some(f) = m.get(&sport) {
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
        if ipv4_in_cidr(dst, *net, *prefix) {
            return true;
        }
    }
    false
}

fn process_in_scope(plan: &CapturePlan, pid: u32, path: &str) -> bool {
    if plan.bypass_pids.contains(&pid) {
        return false;
    }
    if !plan.mode_apps {
        return true;
    }
    if path.is_empty() {
        return false;
    }
    let p = path.replace('/', "\\").to_ascii_lowercase();
    plan.app_paths.iter().any(|a| {
        p == *a || p.ends_with(a) || p.ends_with(&a.trim_start_matches('\\').to_string())
    })
}

fn process_path(pid: u32) -> Option<String> {
    use std::os::windows::ffi::OsStringExt;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        // QueryFullProcessImageNameW
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn QueryFullProcessImageNameW(
                h: HANDLE,
                flags: u32,
                buf: *mut u16,
                size: *mut u32,
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

fn parse_cidrs(list: &[String]) -> Vec<(Ipv4Addr, u8)> {
    let mut out = Vec::new();
    for s in list {
        let s = s.trim();
        if let Some((a, p)) = s.split_once('/') {
            if let (Ok(ip), Ok(pref)) = (a.parse::<Ipv4Addr>(), p.parse::<u8>()) {
                out.push((ip, pref.min(32)));
            }
        } else if let Ok(ip) = s.parse::<Ipv4Addr>() {
            out.push((ip, 32));
        }
    }
    out
}

fn ipv4_in_cidr(ip: Ipv4Addr, net: Ipv4Addr, prefix: u8) -> bool {
    let shift = 32u32.saturating_sub(prefix as u32);
    let mask = if shift >= 32 { 0 } else { u32::MAX << shift };
    (u32::from(ip) & mask) == (u32::from(net) & mask)
}

fn parse_ipv4_tcp(pkt: &[u8]) -> Option<(Ipv4Addr, u16, Ipv4Addr, u16)> {
    if pkt.len() < 40 {
        return None;
    }
    if pkt[0] >> 4 != 4 {
        return None;
    }
    let ihl = (pkt[0] & 0x0f) as usize * 4;
    if ihl < 20 || pkt.len() < ihl + 20 {
        return None;
    }
    if pkt[9] != 6 {
        return None; // TCP
    }
    let src = Ipv4Addr::new(pkt[12], pkt[13], pkt[14], pkt[15]);
    let dst = Ipv4Addr::new(pkt[16], pkt[17], pkt[18], pkt[19]);
    let sport = u16::from_be_bytes([pkt[ihl], pkt[ihl + 1]]);
    let dport = u16::from_be_bytes([pkt[ihl + 2], pkt[ihl + 3]]);
    Some((src, sport, dst, dport))
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
    pkt[16] = o[0];
    pkt[17] = o[1];
    pkt[18] = o[2];
    pkt[19] = o[3];
    let pb = dport.to_be_bytes();
    pkt[ihl + 2] = pb[0];
    pkt[ihl + 3] = pb[1];
    // Zero checksums; WinDivertHelperCalcChecksums will fill.
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
    pkt[12] = o[0];
    pkt[13] = o[1];
    pkt[14] = o[2];
    pkt[15] = o[3];
    let pb = sport.to_be_bytes();
    pkt[ihl] = pb[0];
    pkt[ihl + 1] = pb[1];
    pkt[10] = 0;
    pkt[11] = 0;
    pkt[ihl + 16] = 0;
    pkt[ihl + 17] = 0;
    true
}

