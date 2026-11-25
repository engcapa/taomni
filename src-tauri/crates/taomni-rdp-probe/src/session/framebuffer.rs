use super::configuration::codec_name;
use super::configuration::compression_name;
use super::model::ProbeSession;
use ironrdp::cliprdr::CliprdrClient;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::rdpsnd::client::Rdpsnd;
use std::collections::HashMap;

impl ProbeSession {
    pub fn width(&self) -> u16 {
        self.image.width()
    }

    pub fn height(&self) -> u16 {
        self.image.height()
    }

    /// Start the RemoteFX statistics over (a scenario's measured window).
    pub fn reset_rfx_stats(&mut self) {
        // A measurement window resets counters, never the live receive history.
        self.rfx.reset_counters();
    }

    /// RGBA of one desktop pixel, or `None` outside the framebuffer.
    pub fn pixel(&self, x: u16, y: u16) -> Option<[u8; 4]> {
        if x >= self.image.width() || y >= self.image.height() {
            return None;
        }
        let stride = usize::from(self.image.width()) * 4;
        let offset = usize::from(y) * stride + usize::from(x) * 4;
        self.image
            .data()
            .get(offset..offset + 4)
            .map(|px| [px[0], px[1], px[2], px[3]])
    }

    /// Cheap fingerprint of a rectangle sampled on a sparse grid; used to count
    /// visible changes without hashing the whole framebuffer per update.
    pub fn region_signature(&self, rect: (u16, u16, u16, u16)) -> u64 {
        let (x, y, w, h) = rect;
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let steps_x = 32u16.min(w.max(1));
        let steps_y = 18u16.min(h.max(1));
        for sy in 0..steps_y {
            for sx in 0..steps_x {
                let px = x.saturating_add(sx.saturating_mul(w) / steps_x);
                let py = y.saturating_add(sy.saturating_mul(h) / steps_y);
                if let Some(value) = self.pixel(px, py) {
                    for byte in &value[..3] {
                        hash ^= u64::from(*byte);
                        hash = hash.wrapping_mul(0x0100_0000_01b3);
                    }
                }
            }
        }
        hash
    }

    /// Coarse statistics of the decoded framebuffer on a 32x24 grid. Untouched
    /// pixels keep alpha 0 (the buffer starts zeroed), so `painted_share`
    /// separates "the server sent a black desktop" from "nothing was decoded".
    pub fn framebuffer_stats(&self) -> serde_json::Value {
        let (w, h) = (self.width(), self.height());
        let mut counts: HashMap<[u8; 3], usize> = HashMap::new();
        let (mut samples, mut painted) = (0usize, 0usize);
        for gy in 0..24u32 {
            for gx in 0..32u32 {
                let x = (u32::from(w) * gx / 32) as u16;
                let y = (u32::from(h) * gy / 24) as u16;
                if let Some(px) = self.pixel(x, y) {
                    samples += 1;
                    if px[3] != 0 {
                        painted += 1;
                    }
                    *counts.entry([px[0], px[1], px[2]]).or_default() += 1;
                }
            }
        }
        let dominant = counts.iter().max_by_key(|(_, n)| **n);
        serde_json::json!({
            "distinct_colors": counts.len(),
            "dominant_rgb": dominant.map(|(rgb, _)| rgb.to_vec()),
            "dominant_share": dominant.map(|(_, n)| *n as f64 / samples.max(1) as f64),
            "painted_share": painted as f64 / samples.max(1) as f64,
        })
    }

    /// Save the framebuffer (alpha dropped) to the `--snapshot` path.
    pub(super) fn write_snapshot(&self) -> Option<serde_json::Value> {
        let path = self.snapshot.as_ref()?;
        let (w, h) = (u32::from(self.width()), u32::from(self.height()));
        let rgb: Vec<u8> = self
            .image
            .data()
            .chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect();
        let result = image::RgbImage::from_raw(w, h, rgb)
            .ok_or_else(|| "framebuffer size does not match its dimensions".to_string())
            .and_then(|img| img.save(path).map_err(|e| e.to_string()));
        Some(match result {
            Ok(()) => serde_json::json!({ "path": path.display().to_string() }),
            Err(error) => serde_json::json!({ "path": path.display().to_string(), "error": error }),
        })
    }

    /// Common facts every report includes.
    pub fn summary(&mut self) -> serde_json::Value {
        serde_json::json!({
            "connect_ms": self.connect_ms,
            "first_graphics_ms": self.first_graphics_ms,
            "desktop": { "width": self.width(), "height": self.height() },
            "bytes_in": self.bytes_in,
            "pdus_in": self.pdus_in,
            "graphics_updates": self.graphics_updates,
            "empty_graphics_updates": self.empty_updates,
            "pointer_updates": self.pointer_updates,
            "framebuffer": self.framebuffer_stats(),
            "snapshot": self.write_snapshot(),
            "server_cert_sha256": self.fingerprint,
            "advertised_codecs": self.advertised_codecs.iter().map(|id| codec_name(*id)).collect::<Vec<_>>(),
            "rfx": self.rfx.report(),
            "requested_channels": self.channels,
            "negotiated": {
                "compression": compression_name(self.compression),
                "cliprdr": self.active_stage.get_svc_processor::<CliprdrClient>().is_some(),
                "rdpsnd": self.active_stage.get_svc_processor::<Rdpsnd>().is_some(),
                "drdynvc": self.active_stage.get_svc_processor::<DrdynvcClient>().is_some(),
            },
            "terminated": self.terminated,
        })
    }
}
