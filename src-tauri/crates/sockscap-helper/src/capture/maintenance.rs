use super::flow_table::FlowTable;
use super::pid_map::FlowMap;
use super::plan::CapturePlan;
use super::plan::PlanSlot;
use super::plan::read_plan;
use super::process_scope::process_in_scope_tree;
use crate::proc_info::SharedTree;
use crate::proc_info::port_owners_for_pids;
use crate::proc_info::udp_port_owners_for_pids;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

/// Snapshot of which local TCP ports belong to in-scope applications.
///
/// Rebuilt on the maintenance thread and published wholesale, so the packet
/// path only ever clones an `Arc`. Previously the packet path rebuilt this
/// itself — enumerating every process on the machine (an `OpenProcess` +
/// `QueryFullProcessImageNameW` each) and then the whole TCP table — while
/// holding up every other packet on the host.
#[derive(Debug, Default)]
pub(super) struct AppIndex {
    /// local TCP port → owning pid, for in-scope processes only.
    pub(super) ports: HashMap<u16, u32>,
    /// local UDP port → owning pid, for in-scope processes only. Populated only
    /// when `block_quic` is on; used to attribute UDP 443 (QUIC) to an in-scope
    /// app so its QUIC is dropped while other apps' QUIC passes untouched.
    pub(super) udp_ports: HashMap<u16, u32>,
    /// pid → executable path, for in-scope processes only.
    pub(super) paths: HashMap<u32, String>,
    pub(super) pids: HashSet<u32>,
}

pub(super) type IndexSlot = Arc<Mutex<Arc<AppIndex>>>;

pub(super) fn read_index(slot: &IndexSlot) -> Arc<AppIndex> {
    slot.lock()
        .map(|g| Arc::clone(&g))
        .unwrap_or_else(|_| Arc::new(AppIndex::default()))
}

/// Everything periodic that used to run inline on the packet path.
///
/// The divert loop handles every outbound TCP packet on the machine one at a
/// time, so any work done there is charged to the whole host's throughput —
/// including traffic SocksCap has no interest in. Process enumeration, TCP
/// table reads and table sweeps all live here instead, and the packet path only
/// reads their results.
pub(super) fn maintenance_loop(
    plan_slot: PlanSlot,
    tree: Arc<SharedTree>,
    index: IndexSlot,
    flows: Arc<Mutex<FlowMap>>,
    redirects: Arc<Mutex<FlowTable>>,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::SeqCst) {
        let plan = read_plan(&plan_slot);
        if plan.mode_apps {
            let idx = Arc::new(compute_app_index(&tree, &plan));
            if let Ok(mut slot) = index.lock() {
                *slot = idx;
            }
        }
        let now = Instant::now();
        if let Ok(mut t) = redirects.lock() {
            t.sweep_if_due(now);
        }
        if let Ok(mut m) = flows.lock() {
            m.sweep_if_due(now);
        }
        // ~100 ms cadence, but notice `stop` promptly so `capture_stop` is not
        // held up waiting for this thread to join.
        for _ in 0..10 {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Ports and paths of every process currently in scope for App mode.
pub(super) fn compute_app_index(tree: &SharedTree, plan: &CapturePlan) -> AppIndex {
    let mut idx = AppIndex::default();
    // `with` refreshes the process tree only when it is older than its staleness
    // window. The previous code forced a full re-enumeration on every call,
    // ~10x more often than the data actually changes.
    tree.with(|t| {
        for (&pid, path) in t.path.iter() {
            if plan.bypass_pids.contains(&pid) {
                continue;
            }
            if process_in_scope_tree(plan, pid, path, t) {
                idx.pids.insert(pid);
            }
        }
        // Also include descendants of matched pids (a launcher's child may live
        // at a different path).
        for _ in 0..8 {
            let mut changed = false;
            for (&pid, &ppid) in t.parent.iter() {
                if idx.pids.contains(&ppid)
                    && !idx.pids.contains(&pid)
                    && !plan.bypass_pids.contains(&pid)
                {
                    idx.pids.insert(pid);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        for &pid in &idx.pids {
            if let Some(p) = t.path_of(pid) {
                idx.paths.insert(pid, p.to_string());
            }
        }
    });
    idx.ports = port_owners_for_pids(&idx.pids);
    if plan.block_quic {
        idx.udp_ports = udp_port_owners_for_pids(&idx.pids);
    }
    idx
}
