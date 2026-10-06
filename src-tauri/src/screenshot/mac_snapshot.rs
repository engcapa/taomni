//! A cached CoreGraphics region for the macOS recording compatibility path.

use std::time::Instant;

use anyhow::Context;
use image::RgbaImage;
use objc2_core_foundation::CGRect;
use objc2_core_graphics::{
    CGDataProvider, CGDisplayBounds, CGImage, CGWindowImageOption, CGWindowListCreateImage,
    CGWindowListOption,
};

pub(super) struct RegionSnapshot {
    rect: CGRect,
}

impl RegionSnapshot {
    pub(super) fn new(
        display_id: u32,
        physical_size: (u32, u32),
        region: (u32, u32, u32, u32),
    ) -> anyhow::Result<Self> {
        let mut rect = CGDisplayBounds(display_id);
        anyhow::ensure!(
            rect.size.width > 0.0
                && rect.size.height > 0.0
                && physical_size.0 > 0
                && physical_size.1 > 0,
            "recording display has no capture bounds"
        );
        let sx = rect.size.width / f64::from(physical_size.0);
        let sy = rect.size.height / f64::from(physical_size.1);
        rect.origin.x += f64::from(region.0) * sx;
        rect.origin.y += f64::from(region.1) * sy;
        rect.size.width = f64::from(region.2) * sx;
        rect.size.height = f64::from(region.3) * sy;
        Ok(Self { rect })
    }

    pub(super) fn capture(&self) -> anyhow::Result<(RgbaImage, Instant)> {
        // CoreGraphics snapshots the requested screen state. Reading/copying
        // its provider may then block: stamping after conversion assigns old
        // pixels to a later time and stretches the preceding recorded frame.
        let captured_at = Instant::now();
        let image = CGWindowListCreateImage(
            self.rect,
            CGWindowListOption::OptionAll,
            0,
            CGWindowImageOption::Default,
        )
        .context("create recording region snapshot")?;
        let snapshot_elapsed = captured_at.elapsed();
        let provider = CGImage::data_provider(Some(&image)).context("snapshot data provider")?;
        let data = CGDataProvider::data(Some(&provider)).context("read snapshot pixels")?;
        let provider_elapsed = captured_at.elapsed();
        let width = CGImage::width(Some(&image));
        let height = CGImage::height(Some(&image));
        let stride = CGImage::bytes_per_row(Some(&image));
        let row_bytes = width.checked_mul(4).context("snapshot row size overflow")?;
        let byte_count = row_bytes
            .checked_mul(height)
            .context("snapshot buffer size overflow")?;
        let source = data.to_vec();
        anyhow::ensure!(
            width > 0
                && height > 0
                && stride >= row_bytes
                && stride
                    .checked_mul(height)
                    .is_some_and(|n| n <= source.len()),
            "invalid recording snapshot layout"
        );
        let mut pixels = Vec::with_capacity(byte_count);
        for row in source.chunks_exact(stride).take(height) {
            pixels.extend_from_slice(&row[..row_bytes]);
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        let image = RgbaImage::from_raw(
            u32::try_from(width).context("snapshot width overflow")?,
            u32::try_from(height).context("snapshot height overflow")?,
            pixels,
        )
        .context("decode recording snapshot")?;
        if captured_at.elapsed().as_millis() > 250 {
            log::warn!(
                "screenshot: macOS region snapshot took {}ms (snapshot {}ms, provider {}ms, conversion {}ms); retaining its request timestamp",
                captured_at.elapsed().as_millis(),
                snapshot_elapsed.as_millis(),
                (provider_elapsed - snapshot_elapsed).as_millis(),
                (captured_at.elapsed() - provider_elapsed).as_millis()
            );
        }
        Ok((image, captured_at))
    }
}
