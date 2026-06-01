use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Public SearXNG instances to probe on startup.
/// Ordered by historical reliability. Taomni probes all concurrently and picks the fastest.
pub const PUBLIC_INSTANCES: &[&str] = &[
    "https://searx.be",
    "https://search.inetol.net",
    "https://searxng.world",
    "https://paulgo.io",
    "https://search.bus-hit.me",
];

/// Per-instance success / failure counters within a 30-day rolling window.
/// Tracked in-memory only — restart-cold-start is acceptable; the cost of
/// disk persistence is not worth the synchronization complexity for a hint
/// signal that probe will refresh within seconds anyway.
#[derive(Clone, Copy, Debug, Default)]
struct InstanceStats {
    /// Total probes recorded inside the rolling window.
    probes: u64,
    /// Successful probes inside the window.
    successes: u64,
    /// Last sample wall-clock seconds (for rolling-window pruning).
    last_sample: u64,
}

static STATS: Mutex<Option<HashMap<String, InstanceStats>>> = Mutex::new(None);

const WINDOW_SECS: u64 = 30 * 86_400;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn record(url: &str, succeeded: bool) {
    let now = now_secs();
    let mut guard = STATS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    let entry = map.entry(url.to_string()).or_default();
    // Coarse rolling reset: if the last sample was > window ago, zero the
    // counters so a previously-bad instance can recover.
    if entry.last_sample > 0 && now.saturating_sub(entry.last_sample) > WINDOW_SECS {
        *entry = InstanceStats::default();
    }
    entry.probes += 1;
    if succeeded {
        entry.successes += 1;
    }
    entry.last_sample = now;
}

/// Returns the per-instance availability ratio in [0.0, 1.0]. New / unknown
/// instances default to 1.0 so they get a fair shot on first contact.
fn availability(url: &str) -> f64 {
    let guard = STATS.lock().unwrap();
    let Some(map) = guard.as_ref() else {
        return 1.0;
    };
    map.get(url)
        .filter(|s| s.probes > 0)
        .map(|s| s.successes as f64 / s.probes as f64)
        .unwrap_or(1.0)
}

/// Snapshot of availability ratios per instance, useful for the UI / debugging.
pub fn availability_snapshot() -> Vec<(String, f64, u64)> {
    let guard = STATS.lock().unwrap();
    let Some(map) = guard.as_ref() else {
        return Vec::new();
    };
    let mut out: Vec<(String, f64, u64)> = map
        .iter()
        .map(|(k, v)| {
            let ratio = if v.probes == 0 {
                1.0
            } else {
                v.successes as f64 / v.probes as f64
            };
            (k.clone(), ratio, v.probes)
        })
        .collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Probe all instances concurrently with a 2s timeout, return the first that responds 200.
/// Updates rolling availability counters so future probes can prefer healthier instances.
pub async fn probe_best_instance(client: &reqwest::Client) -> Option<String> {
    use futures::future::select_ok;
    use tokio::time::timeout;

    // Sort the candidate list by historical availability (higher first), so
    // ties in latency break toward the more reliable mirror.
    let mut candidates: Vec<&str> = PUBLIC_INSTANCES.to_vec();
    candidates.sort_by(|a, b| {
        availability(b)
            .partial_cmp(&availability(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let futures: Vec<_> = candidates
        .iter()
        .map(|&url| {
            let client = client.clone();
            let url = url.to_string();
            Box::pin(async move {
                let probe_url = format!("{}/search?q=test&format=json", url);
                let result = timeout(Duration::from_secs(2), client.get(&probe_url).send()).await;
                match result {
                    Ok(Ok(resp)) if resp.status().is_success() => {
                        record(&url, true);
                        Ok(url)
                    }
                    _ => {
                        record(&url, false);
                        Err(format!("unreachable: {}", url))
                    }
                }
            })
        })
        .collect();

    select_ok(futures).await.ok().map(|(url, _)| url)
}
