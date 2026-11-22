use super::flow_table::FLOW_SWEEP_INTERVAL;
use super::flow_table::FlowKey;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;
use std::time::Instant;

#[derive(Debug, Clone)]
pub(super) struct FlowInfo {
    pub(super) pid: u32,
    pub(super) path: String,
    pub(super) remote: IpAddr,
    pub(super) remote_port: u16,
    pub(super) expires_at: Instant,
}
/// Idle lifetime of a FLOW-layer PID association.
pub(super) const PID_MAP_TTL: Duration = Duration::from_secs(10 * 60);

/// FLOW/SOCKET-layer PID associations, keyed by the socket's local `(ip, port)`.
///
/// Delete events remove entries, but they can be missed (queue overflow, FLOW
/// layer unavailable) and the `GetExtendedTcpTable` fallback inserts entries no
/// event will ever remove — so this expires idle entries as well.
#[derive(Default)]
pub(super) struct FlowMap {
    pub(super) map: HashMap<FlowKey, FlowInfo>,
    pub(super) last_sweep: Option<Instant>,
}

impl FlowMap {
    pub(super) fn get(&self, key: &FlowKey) -> Option<&FlowInfo> {
        self.map.get(key)
    }

    pub(super) fn insert(&mut self, key: FlowKey, mut info: FlowInfo, now: Instant) {
        info.expires_at = now + PID_MAP_TTL;
        self.map.insert(key, info);
    }

    pub(super) fn remove(&mut self, key: &FlowKey) {
        self.map.remove(key);
    }

    pub(super) fn sweep_if_due(&mut self, now: Instant) {
        if let Some(last) = self.last_sweep {
            if now.duration_since(last) < FLOW_SWEEP_INTERVAL {
                return;
            }
        }
        self.last_sweep = Some(now);
        self.map.retain(|_, v| v.expires_at > now);
    }

    pub(super) fn len(&self) -> usize {
        self.map.len()
    }
}
