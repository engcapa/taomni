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
    #[cfg(debug_assertions)]
    qa_stages: Option<serde_json::Value>,
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
        Ok(Self {
            rect,
            #[cfg(debug_assertions)]
            qa_stages: None,
        })
    }

    #[cfg(debug_assertions)]
    pub(super) fn qa_stages(&self) -> Option<&serde_json::Value> {
        self.qa_stages.as_ref()
    }

    pub(super) fn capture(&mut self) -> anyhow::Result<(RgbaImage, Instant)> {
        // CoreGraphics snapshots the requested screen state. Reading/copying
        // its provider may then block: stamping after conversion assigns old
        // pixels to a later time and stretches the preceding recorded frame.
        let captured_at = Instant::now();
        #[cfg(debug_assertions)]
        {
            self.qa_stages = None;
        }
        let image = CGWindowListCreateImage(
            self.rect,
            CGWindowListOption::OptionAll,
            0,
            CGWindowImageOption::Default,
        )
        .context("create recording region snapshot")?;
        #[cfg(debug_assertions)]
        let snapshot_returned = Instant::now();
        let provider = CGImage::data_provider(Some(&image)).context("snapshot data provider")?;
        let data = CGDataProvider::data(Some(&provider)).context("read snapshot pixels")?;
        #[cfg(debug_assertions)]
        let provider_returned = Instant::now();
        let width = CGImage::width(Some(&image));
        let height = CGImage::height(Some(&image));
        let stride = CGImage::bytes_per_row(Some(&image));
        let bytes = data.to_vec();
        #[cfg(debug_assertions)]
        let copied = Instant::now();
        let rgba = super::rgba_from_bgra_rows(&bytes, width, height, stride)?;
        #[cfg(debug_assertions)]
        {
            let converted = Instant::now();
            // Bounded per-frame metadata only. No screen read, PNG encoding,
            // pixel filtering or timestamp changes enter the capture path.
            self.qa_stages = Some(serde_json::json!({
                "snapshotUs": snapshot_returned.duration_since(captured_at).as_micros() as u64,
                "providerUs": provider_returned.duration_since(snapshot_returned).as_micros() as u64,
                "copyUs": copied.duration_since(provider_returned).as_micros() as u64,
                "convertUs": converted.duration_since(copied).as_micros() as u64,
                "totalUs": converted.duration_since(captured_at).as_micros() as u64,
                "width": width, "height": height, "stride": stride,
                "dataBytes": bytes.len(),
                "bitsPerComponent": CGImage::bits_per_component(Some(&image)),
                "bitsPerPixel": CGImage::bits_per_pixel(Some(&image)),
            }));
        }
        if captured_at.elapsed().as_millis() > 250 {
            log::warn!(
                "screenshot: macOS region snapshot took {}ms; retaining its request timestamp",
                captured_at.elapsed().as_millis()
            );
        }
        Ok((rgba, captured_at))
    }
}
