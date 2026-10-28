//! Per-connection planar/RemoteFX selection and its independent estimator.

use core::sync::atomic::Ordering;
use std::time::Instant;

use anyhow::Result;
use ironrdp_bulk::MppcSizeEstimator;

use super::{
    BitmapHandler, BitmapUpdate, BitmapUpdateHandler, EncoderStats, RemoteFxHandler,
    UpdateFragmenter,
};

const PLANAR_BULK_GIVE_UP_RATIO: f64 = 0.25;
pub(super) const PLANAR_ESTIMATE_SAMPLE_SIZE: usize = 1024;

/// Estimate with an independent fresh MPPC-64K history. Never touch the
/// connection's compressor until the selected payload is fragmented and sent.
pub(super) fn estimate_bulk_size(estimator: &mut MppcSizeEstimator, data: &[u8]) -> Result<usize> {
    if data.is_empty() {
        return Ok(0);
    }
    // A prefix can be entirely desktop padding around a noisy photo. Four
    // separated strips retain runs and sample all colour planes.
    let mut strips = [0u8; PLANAR_ESTIMATE_SAMPLE_SIZE];
    let sample = if data.len() <= strips.len() {
        data
    } else {
        let strip_size = strips.len() / 4;
        for index in 0..4 {
            let start = index * (data.len() - strip_size) / 3;
            strips[index * strip_size..(index + 1) * strip_size]
                .copy_from_slice(&data[start..start + strip_size]);
        }
        &strips
    };
    estimate_bulk_sample(estimator, data.len(), sample)
}

pub(super) fn estimate_bulk_sample(
    estimator: &mut MppcSizeEstimator,
    length: usize,
    sample: &[u8],
) -> Result<usize> {
    let encoded = estimator.estimate(sample)?;
    Ok((encoded * length).div_ceil(sample.len()))
}

#[derive(Debug)]
pub(super) struct AdaptiveHandler {
    pub(super) bitmap: BitmapHandler,
    pub(super) rfx: RemoteFxHandler,
    pub(super) estimator: MppcSizeEstimator,
}

impl AdaptiveHandler {
    pub(super) fn handle_with_stats(
        &mut self,
        bitmap: &BitmapUpdate,
        stats: Option<&EncoderStats>,
    ) -> Result<UpdateFragmenter> {
        if bitmap.width.get() > u16::MAX / 4
            || !self.bitmap.bitmap.supports_width(bitmap.width.get())
        {
            return self
                .encode_rfx(bitmap, stats)
                .map(UpdateFragmenter::without_bulk_compression);
        }
        let started = stats.map(|_| Instant::now());
        let (length, estimate, planar) =
            if let Some((length, sample)) = self.bitmap.bitmap.raw_planar_sample(bitmap)? {
                if let Some(stats) = stats {
                    stats.raw_planar_samples.fetch_add(1, Ordering::Relaxed);
                }
                (
                    length,
                    estimate_bulk_sample(&mut self.estimator, length, &sample)?,
                    None,
                )
            } else {
                if let Some(stats) = stats {
                    stats
                        .materialized_planar_candidates
                        .fetch_add(1, Ordering::Relaxed);
                }
                let planar = self.bitmap.handle(bitmap)?;
                (
                    planar.data.len(),
                    estimate_bulk_size(&mut self.estimator, &planar.data)?,
                    Some(planar),
                )
            };
        if let (Some(stats), Some(started)) = (stats, started) {
            stats.selection_time.record(started.elapsed());
        }
        if estimate as f64 <= length as f64 * PLANAR_BULK_GIVE_UP_RATIO {
            return match planar {
                Some(planar) => Ok(planar),
                None => self.bitmap.handle(bitmap),
            };
        }
        // A rejected candidate must not consume first-frame headers or advance
        // RemoteFX state. Only commit the clone when its bytes will be sent.
        let mut candidate = self.rfx.clone();
        let started = stats.map(|_| Instant::now());
        let rfx = candidate.handle_compact(bitmap)?;
        if let (Some(stats), Some(started)) = (stats, started) {
            stats.rfx_time.record(started.elapsed());
        }
        if estimate <= rfx.data.len() {
            match planar {
                Some(planar) => Ok(planar),
                None => self.bitmap.handle(bitmap),
            }
        } else {
            self.rfx = candidate;
            Ok(rfx.without_bulk_compression())
        }
    }

    fn encode_rfx(
        &mut self,
        bitmap: &BitmapUpdate,
        stats: Option<&EncoderStats>,
    ) -> Result<UpdateFragmenter> {
        let started = stats.map(|_| Instant::now());
        let result = self.rfx.handle_compact(bitmap);
        if let (Some(stats), Some(started)) = (stats, started) {
            stats.rfx_time.record(started.elapsed());
        }
        result
    }
}

impl BitmapUpdateHandler for AdaptiveHandler {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        self.handle_with_stats(bitmap, None)
    }
}
