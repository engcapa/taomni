//! Screenshot overlay startup timing (P0-0 / P0-0b).
//!
//! Recording only: the marks never change capture, hiding or window
//! behaviour. Release builds record the snapshot (and log one line per
//! stage) but never read it back; only the debug QA startup scenarios read
//! it. A dedicated mutex keeps marks callable from capture worker threads
//! and from code that already holds the tool state lock.

use serde_json::Value;
use std::sync::Mutex;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[derive(Default)]
struct Timing {
    /// Entry point that requested the latest open, recorded before the open
    /// itself starts (`screenshot_open_overlay` or the global shortcut).
    entry: Option<(Instant, &'static str)>,
    started: Option<Instant>,
    start_wall_ms: u64,
    entry_origin: Option<&'static str>,
    entry_lead_ms: Option<u64>,
    stages: Vec<(String, u64)>,
    notes: serde_json::Map<String, Value>,
}

static TIMING: Mutex<Option<Timing>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut Timing) -> R) -> R {
    let mut guard = TIMING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(guard.get_or_insert_with(Timing::default))
}

pub(super) fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// B_entry: an entry point is about to open the overlay.
pub(super) fn begin_entry(origin: &'static str) {
    with(|timing| timing.entry = Some((Instant::now(), origin)));
}

/// Reset the snapshot at the start of an overlay open.
pub(super) fn reset() {
    with(|timing| {
        let now = Instant::now();
        // An entry that did not start an open (an overlay was already up)
        // must not be attributed to a much later one.
        let entry = timing
            .entry
            .take()
            .filter(|(at, _)| now.saturating_duration_since(*at).as_secs() < 5);
        *timing = Timing {
            entry: None,
            started: Some(now),
            start_wall_ms: wall_clock_ms(),
            entry_origin: entry.map(|(_, origin)| origin),
            entry_lead_ms: entry
                .map(|(at, _)| now.saturating_duration_since(at).as_millis() as u64),
            stages: vec![("start".to_string(), 0)],
            notes: serde_json::Map::new(),
        };
    });
}

/// Record one stage of the current open. A no-op before the first open.
pub(super) fn mark(stage: &str) {
    let elapsed = with(|timing| {
        let started = timing.started?;
        let elapsed = started.elapsed().as_millis() as u64;
        timing.stages.push((stage.to_string(), elapsed));
        Some(elapsed)
    });
    if let Some(elapsed) = elapsed {
        log::info!("[screenshot-startup-timing] stage={stage} elapsed_ms={elapsed}");
    }
}

/// Attach a fact to the current open (chosen isolation path, bytes read...).
pub(super) fn note(key: &str, value: Value) {
    with(|timing| {
        if timing.started.is_some() {
            timing.notes.insert(key.to_string(), value);
        }
    });
}

#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub(super) struct Snapshot {
    pub(super) stages: Vec<(String, u64)>,
    pub(super) notes: serde_json::Map<String, Value>,
    pub(super) start_wall_ms: u64,
    pub(super) entry_origin: Option<&'static str>,
    pub(super) entry_lead_ms: Option<u64>,
}

/// Snapshot of the latest open, stages in record order.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub(super) fn snapshot() -> Snapshot {
    with(|timing| Snapshot {
        stages: timing.stages.clone(),
        notes: timing.notes.clone(),
        start_wall_ms: timing.start_wall_ms,
        entry_origin: timing.entry_origin,
        entry_lead_ms: timing.entry_lead_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_cumulative_and_reset_clears_previous_open() {
        begin_entry("command");
        reset();
        mark("permission");
        note("isolation", Value::String("hide".into()));
        let first = snapshot();
        assert_eq!(first.stages[0], ("start".to_string(), 0));
        assert_eq!(first.stages[1].0, "permission");
        assert_eq!(first.entry_origin, Some("command"));
        assert!(first.entry_lead_ms.is_some());
        assert_eq!(first.notes["isolation"], Value::String("hide".into()));
        reset();
        let second = snapshot();
        assert_eq!(second.stages.len(), 1);
        assert!(second.notes.is_empty());
        // The entry is consumed by the open that followed it.
        assert_eq!(second.entry_origin, None);
    }
}
