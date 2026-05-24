//! Performance baseline persistence (Layer 2 §16.9 metrics).
//!
//! Implements a tiny structured-log layer that JSON-serializes a
//! `LatencyMetric` to `<config>/newmob/perf-baseline.jsonl` so consumers
//! (CI dashboards, manual review) can plot regressions over time. The shape
//! is borrowed from vLLM/Anyscale conventions:
//!
//!   { feature, provider, ttft_ms?, tpot_ms?, e2e_ms, queue_ms?, trace_id }
//!
//! Writes are append-only. Failure to write is non-fatal — perf telemetry
//! must never break user flows.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencyMetric {
    pub feature: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tpot_ms: Option<u64>,
    pub e2e_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_ms: Option<u64>,
    pub trace_id: String,
    pub recorded_at: i64,
}

/// Where the baseline lives. `<cache>/newmob/perf-baseline.jsonl`. The cache
/// dir is the right home — this file is regenerable telemetry, not user data.
pub fn baseline_path() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("newmob")
        .join("perf-baseline.jsonl")
}

/// Append a single metric. Best-effort; swallows IO errors with a warn log.
pub fn record(metric: &LatencyMetric) {
    let path = baseline_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = match serde_json::to_string(metric) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(?e, "perf metric serialise failed");
            return;
        }
    };
    let result = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| {
            writeln!(f, "{}", line)
        });
    if let Err(e) = result {
        tracing::warn!(?e, path = %path.display(), "perf metric write failed");
    }
}

/// Read the most recent N entries (newest first) for the dashboard UI.
pub fn read_recent(limit: usize) -> Vec<LatencyMetric> {
    let path = baseline_path();
    let Ok(content) = std::fs::read_to_string(&path) else { return Vec::new(); };
    let mut out: Vec<LatencyMetric> = content
        .lines()
        .filter_map(|l| serde_json::from_str::<LatencyMetric>(l).ok())
        .collect();
    out.sort_by_key(|m| std::cmp::Reverse(m.recorded_at));
    out.truncate(limit);
    out
}

#[tauri::command]
pub async fn perf_baseline_recent(limit: Option<usize>) -> Result<Vec<LatencyMetric>, String> {
    Ok(read_recent(limit.unwrap_or(200)))
}

/// Caller-friendly helper that captures `now()` for `recorded_at`.
pub fn record_now(
    feature: &str,
    provider: &str,
    e2e_ms: u64,
    ttft_ms: Option<u64>,
    trace_id: &str,
) {
    record(&LatencyMetric {
        feature: feature.into(),
        provider: provider.into(),
        ttft_ms,
        tpot_ms: None,
        e2e_ms,
        queue_ms: None,
        trace_id: trace_id.into(),
        recorded_at: chrono::Utc::now().timestamp(),
    });
}
