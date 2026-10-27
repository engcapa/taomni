//! Bounded, optional counters at the encoder's ownership boundaries.
//!
//! No pixels or per-frame records are retained. A server can distinguish
//! blocking-pool queueing from codec work without changing encoder decisions.

use core::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Optional aggregate counters. Compression history remains per connection.
#[derive(Debug, Default)]
pub struct EncoderStats {
    pub planar_rects: AtomicU64,
    pub rfx_rects: AtomicU64,
    pub bytes_before_bulk: AtomicU64,
    pub bytes_after_bulk: AtomicU64,
    pub diff_time: EncoderTiming,
    pub queue_time: EncoderTiming,
    pub codec_time: EncoderTiming,
    pub blocking_roundtrip_time: EncoderTiming,
    pub selection_time: EncoderTiming,
    pub rfx_time: EncoderTiming,
    pub fragment_time: EncoderTiming,
    pub raw_planar_samples: AtomicU64,
    pub materialized_planar_candidates: AtomicU64,
}

/// Constant-space timings, including slow samples in the sum and maximum.
#[derive(Debug, Default)]
pub struct EncoderTiming {
    count: AtomicU64,
    total_ns: AtomicU64,
    max_ns: AtomicU64,
}

impl EncoderTiming {
    pub(super) fn record(&self, elapsed: Duration) {
        let ns = u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX);
        self.total_ns.fetch_add(ns, Ordering::Relaxed);
        self.max_ns.fetch_max(ns, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
    }

    /// `(count, total nanoseconds, maximum nanoseconds)`. Counters are
    /// cumulative; an in-flight record can straddle a telemetry snapshot.
    pub fn snapshot(&self) -> (u64, u64, u64) {
        (
            self.count.load(Ordering::Relaxed),
            self.total_ns.load(Ordering::Relaxed),
            self.max_ns.load(Ordering::Relaxed),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timing_keeps_slow_samples_and_sub_microsecond_work() {
        let timing = EncoderTiming::default();
        assert_eq!(timing.snapshot(), (0, 0, 0));
        for nanos in [200, 800, 100_000_000, 400] {
            timing.record(Duration::from_nanos(nanos));
        }
        assert_eq!(timing.snapshot(), (4, 100_001_400, 100_000_000));
    }

    #[test]
    fn concurrent_recorders_share_counters_without_losing_samples() {
        let timing = EncoderTiming::default();
        std::thread::scope(|scope| {
            for nanos in [100, 700] {
                let timing = &timing;
                scope.spawn(move || {
                    for _ in 0..100 {
                        timing.record(Duration::from_nanos(nanos));
                    }
                });
            }
        });
        assert_eq!(timing.snapshot(), (200, 80_000, 700));
    }
}
