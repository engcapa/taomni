use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

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
    /// Executable paths to always exclude from capture (e.g. an external local
    /// proxy used as a loopback upstream). Matched per-flow, so it survives the
    /// proxy restarting with a new PID — unlike `bypass_pids`.
    pub bypass_paths: Vec<String>,
    pub bypass_endpoints: Vec<Endpoint>,
    pub relay_ip: Ipv4Addr,
    pub relay_port: u16,
    /// Drop in-scope outbound UDP 443 so QUIC falls back to TCP (which capture
    /// can attribute and proxy). Widens the NETWORK filter to also match UDP 443
    /// and enables the UDP-443 arm in the packet loop. See design doc.
    pub block_quic: bool,
}

/// An inert plan: captures nothing. Only used as the initial value of the live
/// plan slot, before `start` publishes a real one.
impl Default for CapturePlan {
    fn default() -> Self {
        Self {
            mode_apps: true,
            app_paths: Vec::new(),
            bypass_cidrs: Vec::new(),
            bypass_pids: Vec::new(),
            bypass_paths: Vec::new(),
            bypass_endpoints: Vec::new(),
            relay_ip: Ipv4Addr::LOCALHOST,
            relay_port: 0,
            block_quic: false,
        }
    }
}
pub(super) type PlanSlot = Arc<Mutex<Arc<CapturePlan>>>;

pub(super) fn read_plan(slot: &PlanSlot) -> Arc<CapturePlan> {
    slot.lock()
        .map(|g| Arc::clone(&g))
        .unwrap_or_else(|_| Arc::new(CapturePlan::default()))
}

/// How often the packet loop picks up a republished plan. Bypass changes are
/// rare and never urgent to the microsecond, so this is cheap to keep coarse.
pub(super) const PLAN_SYNC_INTERVAL: Duration = Duration::from_millis(200);
