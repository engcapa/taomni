//! A cached CoreGraphics region for the macOS recording compatibility path.

use std::time::Instant;

use anyhow::Context;
use image::RgbaImage;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGDataProvider, CGDisplayBounds, CGDisplayCreateImageForRect, CGImage};

pub(super) struct RegionSnapshot {
    display_id: u32,
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
        let bounds = CGDisplayBounds(display_id);
        anyhow::ensure!(
            bounds.size.width > 0.0
                && bounds.size.height > 0.0
                && physical_size.0 > 0
                && physical_size.1 > 0,
            "recording display has no capture bounds"
        );
        // Display images take physical, display-relative coordinates. Avoid
        // a window-list composite whose deferred provider has returned empty
        // pixels and blocked during recorder control/window transitions.
        let rect = CGRect {
            origin: CGPoint {
                x: f64::from(region.0),
                y: f64::from(region.1),
            },
            size: CGSize {
                width: f64::from(region.2),
                height: f64::from(region.3),
            },
        };
        Ok(Self {
            display_id,
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
        let image = CGDisplayCreateImageForRect(self.display_id, self.rect)
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
                "source": "coregraphics-display-region",
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
