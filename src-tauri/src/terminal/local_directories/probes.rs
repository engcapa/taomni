use super::limits::PROBE_BUDGET;
use super::limits::PROBE_MAX_WORKERS;
use super::model::Availability;
use std::cmp::Ordering;
use std::path::Path;

/// Bounded background availability probe: at most `PROBE_MAX_WORKERS`
/// threads, overall `PROBE_BUDGET` deadline. Unfinished paths stay `unknown`
/// and never poison the next refresh.
/// In-flight probe worker guard so repeated refreshes never accumulate
/// unbounded blocked threads (design §4.1.4).
pub(super) static PROBE_WORKERS_IN_FLIGHT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

pub fn probe_availability(paths: &[String]) -> Vec<Availability> {
    let mut results = vec![Availability::Unknown; paths.len()];
    if paths.is_empty() {
        return results;
    }
    use std::sync::atomic::{AtomicUsize, Ordering};
    if PROBE_WORKERS_IN_FLIGHT.load(Ordering::Acquire) >= PROBE_MAX_WORKERS {
        return results; // previous probes still blocked: report unknown
    }
    let (tx, rx) = std::sync::mpsc::channel::<(usize, Availability)>();
    let chunk = (paths.len() + PROBE_MAX_WORKERS - 1) / PROBE_MAX_WORKERS;
    let mut handles = Vec::new();
    for (worker, slice) in paths.chunks(chunk.max(1)).enumerate() {
        let tx = tx.clone();
        let slice = slice.to_vec();
        let base = worker * chunk.max(1);
        PROBE_WORKERS_IN_FLIGHT.fetch_add(1, Ordering::AcqRel);
        handles.push(std::thread::spawn(move || {
            for (offset, path) in slice.iter().enumerate() {
                let availability = probe_single(Path::new(path));
                if tx.send((base + offset, availability)).is_err() {
                    break;
                }
            }
            PROBE_WORKERS_IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
        }));
    }
    drop(tx);
    let deadline = std::time::Instant::now() + PROBE_BUDGET;
    while let Ok((index, availability)) = rx.recv_timeout(PROBE_BUDGET) {
        if let Some(slot) = results.get_mut(index) {
            *slot = availability;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
    }
    // Detach: blocked workers release their slots when the OS call returns.
    drop(handles);
    results
}

pub(super) fn probe_single(path: &Path) -> Availability {
    match std::fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                Availability::Available
            } else {
                Availability::Missing
            }
        }
        Err(e) => match e.kind() {
            std::io::ErrorKind::PermissionDenied => Availability::PermissionDenied,
            std::io::ErrorKind::NotFound => Availability::Missing,
            _ => Availability::Unavailable,
        },
    }
}
