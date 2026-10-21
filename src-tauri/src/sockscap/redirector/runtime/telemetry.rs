use serde::Deserialize;
use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedirectorTelemetrySnapshot {
    pub session_id: String,
    pub scope_hash: String,
    pub bridge_pid: u32,
    pub provider_pid: u32,
    pub bridge_healthy: bool,
    pub started_at: u64,
    pub last_heartbeat_at: Option<u64>,
    pub last_error: Option<String>,
    pub file_descriptor_limit: u64,
    pub flow_capacity: usize,
}

pub(super) struct RuntimeTelemetry {
    pub(super) session_id: String,
    pub(super) scope_hash: String,
    pub(super) bridge_pid: u32,
    pub(super) provider_pid: u32,
    pub(super) bridge_healthy: AtomicBool,
    pub(super) started_at: u64,
    pub(super) last_heartbeat_at: AtomicU64,
    pub(super) last_error: Mutex<Option<String>>,
    pub(super) file_descriptor_limit: u64,
    pub(super) flow_capacity: usize,
}

impl RuntimeTelemetry {
    pub(super) fn snapshot(&self) -> RedirectorTelemetrySnapshot {
        let heartbeat = self.last_heartbeat_at.load(Ordering::Relaxed);
        RedirectorTelemetrySnapshot {
            session_id: self.session_id.clone(),
            scope_hash: self.scope_hash.clone(),
            bridge_pid: self.bridge_pid,
            provider_pid: self.provider_pid,
            bridge_healthy: self.bridge_healthy.load(Ordering::Acquire),
            started_at: self.started_at,
            last_heartbeat_at: (heartbeat > 0).then_some(heartbeat),
            last_error: self
                .last_error
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            file_descriptor_limit: self.file_descriptor_limit,
            flow_capacity: self.flow_capacity,
        }
    }

    pub(super) fn heartbeat(&self) {
        self.last_heartbeat_at.store(now_unix(), Ordering::Relaxed);
    }

    pub(super) fn failed(&self, error: String) {
        self.bridge_healthy.store(false, Ordering::Release);
        *self
            .last_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
    }
}

pub(super) fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}
