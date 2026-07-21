//! In-memory traffic counters.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct StatsCounters {
    pub flows_total: AtomicU64,
    pub flows_proxy: AtomicU64,
    pub flows_direct: AtomicU64,
    pub flows_block: AtomicU64,
    pub bytes_up: AtomicU64,
    pub bytes_down: AtomicU64,
}

impl StatsCounters {
    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            flows_total: self.flows_total.load(Ordering::Relaxed),
            flows_proxy: self.flows_proxy.load(Ordering::Relaxed),
            flows_direct: self.flows_direct.load(Ordering::Relaxed),
            flows_block: self.flows_block.load(Ordering::Relaxed),
            bytes_up: self.bytes_up.load(Ordering::Relaxed),
            bytes_down: self.bytes_down.load(Ordering::Relaxed),
        }
    }

    pub fn record_decision(&self, proxy: bool, block: bool) {
        self.flows_total.fetch_add(1, Ordering::Relaxed);
        if block {
            self.flows_block.fetch_add(1, Ordering::Relaxed);
        } else if proxy {
            self.flows_proxy.fetch_add(1, Ordering::Relaxed);
        } else {
            self.flows_direct.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn reset(&self) {
        self.flows_total.store(0, Ordering::Relaxed);
        self.flows_proxy.store(0, Ordering::Relaxed);
        self.flows_direct.store(0, Ordering::Relaxed);
        self.flows_block.store(0, Ordering::Relaxed);
        self.bytes_up.store(0, Ordering::Relaxed);
        self.bytes_down.store(0, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub flows_total: u64,
    pub flows_proxy: u64,
    pub flows_direct: u64,
    pub flows_block: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
}
