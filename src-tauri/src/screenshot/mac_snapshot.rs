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
        let provider = CGImage::data_provider(Some(&image)).context("snapshot data provider")?;
        let data = CGDataProvider::data(Some(&provider)).context("read snapshot pixels")?;
        let width = CGImage::width(Some(&image));
        let height = CGImage::height(Some(&image));
        let stride = CGImage::bytes_per_row(Some(&image));
        let image = super::rgba_from_bgra_rows(&data.to_vec(), width, height, stride)?;
        if captured_at.elapsed().as_millis() > 250 {
            log::warn!(
                "screenshot: macOS region snapshot took {}ms; retaining its request timestamp",
                captured_at.elapsed().as_millis()
            );
        }
        Ok((image, captured_at))
    }
}
