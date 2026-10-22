use super::filter::base_network_filter;
use super::filter::build_network_filter;
use super::flow_table::FlowTable;
use super::flow_table::mapping_json;
use super::maintenance::AppIndex;
use super::maintenance::IndexSlot;
use super::maintenance::compute_app_index;
use super::maintenance::maintenance_loop;
use super::packet_loop::flow_loop;
use super::packet_loop::network_loop;
use super::pid_map::FlowMap;
use super::plan::CapturePlan;
use super::plan::PlanSlot;
use super::plan::read_plan;
use crate::proc_info::SharedTree;
use crate::windivert::LAYER_FLOW;
use crate::windivert::LAYER_NETWORK;
use crate::windivert::LAYER_SOCKET;
use crate::windivert::WinDivertApi;
use serde_json::json;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU16;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use winapi::um::winnt::HANDLE;

pub struct CaptureEngine {
    windivert_dir: Option<PathBuf>,
    api: Option<Arc<WinDivertApi>>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    flow_handle: Option<usize>,
    net_handle: Option<usize>,
    /// Socket local `(ip, port)` → owning process.
    flows: Arc<Mutex<FlowMap>>,
    /// Client `(ip, port)` → the capture/bypass decision for its connection.
    redirects: Arc<Mutex<FlowTable>>,
    /// UDP 443 (QUIC) drop/pass verdicts, keyed by client `(ip, sport)`. Kept
    /// separate from `redirects` so a UDP and a TCP flow sharing a local port
    /// cannot clobber each other's verdict. Only used when `block_quic` is on.
    udp_verdicts: Arc<Mutex<FlowTable>>,
    /// Live plan shared with the divert threads. Published as a whole `Arc` so
    /// bypass lists can change mid-session (an xray core respawning with a new
    /// pid, a local proxy restarting) without tearing capture down.
    plan_live: PlanSlot,
    packets_seen: Arc<AtomicU64>,
    packets_redirected: Arc<AtomicU64>,
    active: bool,
    /// Hot-swappable relay port shared with the running network thread.
    relay_port_live: Arc<AtomicU16>,
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
            flows: Arc::new(Mutex::new(FlowMap::default())),
            redirects: Arc::new(Mutex::new(FlowTable::default())),
            udp_verdicts: Arc::new(Mutex::new(FlowTable::default())),
            plan_live: Arc::new(Mutex::new(Arc::new(CapturePlan::default()))),
            packets_seen: Arc::new(AtomicU64::new(0)),
            packets_redirected: Arc::new(AtomicU64::new(0)),
            active: false,
            relay_port_live: Arc::new(AtomicU16::new(0)),
        }
    }

    /// Hot-swap parts of the running plan. Every argument is optional; `None`
    /// leaves that part alone. Errors if capture is not currently active.
    ///
    /// Bypass lists have to be updatable because the set of processes that must
    /// not be captured changes while capture runs: an xray core respawns after
    /// a crash with a **new pid**, and a local proxy can be restarted by the
    /// user. With a start-time snapshot, the respawned core's connection to its
    /// node got captured and reflected into the relay, which dialled the core's
    /// own SOCKS inbound — a loop that wedges all proxied traffic.
    ///
    /// Cached flow verdicts are intentionally *not* discarded here. A process
    /// that has just been added to the bypass list is new, so it has no prior
    /// connections to re-judge, and dropping live redirect mappings would leave
    /// established flows' reply packets untranslated.
    pub fn update_plan(
        &mut self,
        relay_port: Option<u16>,
        bypass_pids: Option<Vec<u32>>,
        bypass_paths: Option<Vec<String>>,
    ) -> Result<serde_json::Value, String> {
        if !self.active {
            return Err("capture not active".into());
        }
        let mut plan = (*read_plan(&self.plan_live)).clone();
        if let Some(port) = relay_port.filter(|p| *p != 0) {
            self.relay_port_live.store(port, Ordering::SeqCst);
            plan.relay_port = port;
        }
        if let Some(mut pids) = bypass_pids {
            // The helper must never capture itself.
            if !pids.contains(&std::process::id()) {
                pids.push(std::process::id());
            }
            plan.bypass_pids = pids;
        }
        if let Some(paths) = bypass_paths {
            plan.bypass_paths = paths
                .into_iter()
                .map(|p| p.replace('/', "\\").to_ascii_lowercase())
                .collect();
        }
        let out = json!({
            "relayPort": plan.relay_port,
            "bypassPids": plan.bypass_pids.len(),
            "bypassPaths": plan.bypass_paths.len(),
        });
        if let Ok(mut slot) = self.plan_live.lock() {
            *slot = Arc::new(plan);
        }
        Ok(out)
    }

    pub fn status_json(&self) -> serde_json::Value {
        let plan = read_plan(&self.plan_live);
        json!({
            "active": self.active,
            "packetsSeen": self.packets_seen.load(Ordering::Relaxed),
            "packetsRedirected": self.packets_redirected.load(Ordering::Relaxed),
            "flowEntries": self.flows.lock().map(|m| m.len()).unwrap_or(0),
            "redirectEntries": self.redirects.lock().map(|m| m.len()).unwrap_or(0),
            "relayPort": self.active.then(|| plan.relay_port),
            "bypassPids": plan.bypass_pids.len(),
            "bypassPaths": plan.bypass_paths.len(),
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
            "dll": api.dll_path.display().to_string(),
        }))
    }

    pub fn start(&mut self, plan: CapturePlan) -> Result<serde_json::Value, String> {
        self.stop();
        let api = self.ensure_api()?;
        self.stop = Arc::new(AtomicBool::new(false));
        self.relay_port_live = Arc::new(AtomicU16::new(plan.relay_port));
        self.plan_live = Arc::new(Mutex::new(Arc::new(plan.clone())));
        self.packets_seen.store(0, Ordering::Relaxed);
        self.packets_redirected.store(0, Ordering::Relaxed);

        // FLOW/SOCKET layers: never use packet aliases like "tcp" (ERROR 87).
        // WinDivert 1.x has no FLOW/SOCKET — open will fail; we fall back to
        // GetExtendedTcpTable owner-PID matching for App mode.
        let mut flow_note = String::new();
        let flow_h = match api.open("true", LAYER_FLOW, 0, 0) {
            Ok(h) => Some(h),
            Err(e_flow) => match api.open("true", LAYER_SOCKET, 0, 0) {
                Ok(h) => {
                    flow_note = format!(
                        "FLOW unavailable ({e_flow}); using SOCKET layer for process events"
                    );
                    Some(h)
                }
                Err(e_sock) => {
                    flow_note = format!(
                        "FLOW/SOCKET unavailable (flow={e_flow}; socket={e_sock}); TCP-table PID only"
                    );
                    tracing::warn!("sockscap-helper: {flow_note}");
                    None
                }
            },
        };

        // NETWORK: outbound TCP only (streamdump). Reflected packets are
        // reinjected as inbound and are not recaptured by the same handle
        // (Impostor left clear, matching the official sample).
        //
        // Narrowed filter first, plain outbound TCP as a fallback. The fallback
        // is a strict *superset*: it only means more packets reach the loop,
        // which still classifies them correctly — unlike the bare `"tcp"`
        // fallback this replaced, which also pulled in every inbound packet on
        // the machine for no benefit at all.
        let narrowed = build_network_filter(&plan.bypass_cidrs, plan.block_quic);
        let base_filter = base_network_filter(plan.block_quic);
        let (net_h, filter_used) = match api.open(&narrowed, LAYER_NETWORK, 0, 0) {
            Ok(h) => (h, narrowed),
            Err(narrow_err) => {
                tracing::warn!(
                    "sockscap-helper: narrowed filter rejected ({narrow_err}); \
                     falling back to {base_filter:?}"
                );
                let h = api.open(base_filter, LAYER_NETWORK, 0, 0).map_err(|e| {
                    format!(
                        "WinDivert NETWORK open failed for filter {base_filter:?}: {e}. \
                         Ensure WinDivert.dll/sys match (2.2+ x64) and the helper is elevated."
                    )
                })?;
                (h, base_filter.to_string())
            }
        };

        // Deepen the kernel queues before any traffic arrives. The NETWORK queue
        // holds real packets so it gets the byte-size bump too; FLOW events are
        // zero-length, so only its length matters.
        let net_queue = api.tune_queue(net_h, true);
        if let Some(h) = flow_h {
            let _ = api.tune_queue(h, false);
        }
        tracing::info!(
            "sockscap-helper: NETWORK queue length={} size={} time={}ms",
            net_queue.length,
            net_queue.size,
            net_queue.time_ms
        );

        // streamdump reflection delivers to client_lan:relay, not necessarily 127.0.0.1
        let relay_desc = format!("*:{}", plan.relay_port);
        let mode_apps = plan.mode_apps;

        self.flow_handle = flow_h.map(|h| h as usize);
        self.net_handle = Some(net_h as usize);
        self.active = true;

        if let Some(flow_h) = flow_h {
            let stop = Arc::clone(&self.stop);
            let flows = Arc::clone(&self.flows);
            let redirects = Arc::clone(&self.redirects);
            let api_flow = Arc::clone(&api);
            let flow_handle = flow_h as usize;
            self.threads.push(std::thread::spawn(move || {
                flow_loop(api_flow, flow_handle as HANDLE, flows, redirects, stop);
            }));
        }

        let tree = Arc::new(SharedTree::new());
        let index_slot: IndexSlot = Arc::new(Mutex::new(Arc::new(AppIndex::default())));

        // Build the first App-mode index before any packet arrives, so the very
        // first connection of an in-scope app is not missed while the
        // maintenance thread is still spinning up.
        if plan.mode_apps {
            if let Ok(mut slot) = index_slot.lock() {
                *slot = Arc::new(compute_app_index(&tree, &plan));
            }
        }

        {
            let stop = Arc::clone(&self.stop);
            let flows = Arc::clone(&self.flows);
            let redirects = Arc::clone(&self.redirects);
            let tree = Arc::clone(&tree);
            let index_slot = Arc::clone(&index_slot);
            let plan_slot = Arc::clone(&self.plan_live);
            self.threads.push(std::thread::spawn(move || {
                maintenance_loop(plan_slot, tree, index_slot, flows, redirects, stop);
            }));
        }

        let stop = Arc::clone(&self.stop);
        let flows = Arc::clone(&self.flows);
        let redirects = Arc::clone(&self.redirects);
        let udp_verdicts = Arc::clone(&self.udp_verdicts);
        let api_net = Arc::clone(&api);
        let net_handle = net_h as usize;
        let seen = Arc::clone(&self.packets_seen);
        let redirected = Arc::clone(&self.packets_redirected);
        let relay_port_live = Arc::clone(&self.relay_port_live);
        let plan_slot = Arc::clone(&self.plan_live);
        self.threads.push(std::thread::spawn(move || {
            network_loop(
                api_net,
                net_handle as HANDLE,
                flows,
                redirects,
                udp_verdicts,
                plan_slot,
                relay_port_live,
                seen,
                redirected,
                stop,
                tree,
                index_slot,
            );
        }));

        Ok(json!({
            "started": true,
            "filter": filter_used,
            "relay": relay_desc,
            "modeApps": mode_apps,
            "ipv6": true,
            "flowNote": flow_note,
            "flowLayer": self.flow_handle.is_some(),
            "dll": api.dll_path.display().to_string(),
            "queue": {
                "length": net_queue.length,
                "size": net_queue.size,
                "timeMs": net_queue.time_ms,
            },
        }))
    }

    /// Drop every cached decision. Used when the plan changes, so a stale
    /// verdict cannot outlive the configuration that produced it.
    fn clear_tables(&self) {
        if let Ok(mut m) = self.flows.lock() {
            *m = FlowMap::default();
        }
        if let Ok(mut m) = self.redirects.lock() {
            *m = FlowTable::default();
        }
        if let Ok(mut m) = self.udp_verdicts.lock() {
            *m = FlowTable::default();
        }
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
        // Join divert threads with a short timeout so capture_stop RPC cannot
        // block the control plane indefinitely if WinDivertRecv never unblocks.
        for t in self.threads.drain(..) {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = t.join();
                let _ = tx.send(());
            });
            if rx
                .recv_timeout(std::time::Duration::from_millis(750))
                .is_err()
            {
                tracing::warn!("sockscap-helper: capture thread join timed out; detaching");
            }
        }
        self.clear_tables();
        self.active = false;
        self.plan_live = Arc::new(Mutex::new(Arc::new(CapturePlan::default())));
    }

    pub fn lookup_orig(&self, src_port: u16) -> Option<serde_json::Value> {
        let map = self.redirects.lock().ok()?;
        Some(mapping_json(&map.mapping_by_sport(src_port)?))
    }

    pub fn lookup_orig_ip_port(&self, src_ip: &str, src_port: u16) -> Option<serde_json::Value> {
        if src_ip.is_empty() {
            return self.lookup_orig(src_port);
        }
        let Ok(ip) = src_ip.parse::<IpAddr>() else {
            return self.lookup_orig(src_port);
        };
        let map = self.redirects.lock().ok()?;
        // The relay's peer address is `orig_remote:client_port`, which is
        // exactly the peer index key.
        let m = map
            .mapping_by_peer((ip, src_port))
            .or_else(|| map.mapping_by_sport(src_port))?;
        Some(mapping_json(&m))
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
