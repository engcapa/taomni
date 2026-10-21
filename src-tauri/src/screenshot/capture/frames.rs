use super::displays::DisplayInfo;
use super::permissions::ensure_capture_permission;
use super::pixels::crop;
use super::pixels::frame_region_to_rgba;
use super::pixels::frame_to_rgba;
use super::pixels::map_region;
use super::snapshot::capture_one_shot;
#[cfg(target_os = "linux")]
use super::snapshot::crop_desktop_to_display;
use super::source::Backend;
use super::source::FrameSource;
#[cfg(all(debug_assertions, target_os = "macos"))]
use super::source::QA_SNAPSHOT_READS;
use crate::servers::rdp::capture::Frame;
use anyhow::Context;
use image::RgbaImage;
use std::time::Instant;
use tauri::AppHandle;

impl FrameSource {
    pub(super) fn decode_frame(&self, frame: &Frame) -> anyhow::Result<RgbaImage> {
        let Some(region) = self.region else {
            return Ok(self.crop_desktop(frame_to_rgba(frame)?));
        };
        let (width, height) = (u32::from(frame.width), u32::from(frame.height));
        #[cfg(target_os = "linux")]
        let rect = {
            if crate::servers::rdp::capture::wayland::is_wayland_session() {
                map_region(
                    region,
                    (self.display.width, self.display.height),
                    (width, height),
                )
            } else {
                let x = (self.display.x - self.desktop_origin.0).max(0) as u32;
                let y = (self.display.y - self.desktop_origin.1).max(0) as u32;
                (
                    x.saturating_add(region.0),
                    y.saturating_add(region.1),
                    region.2,
                    region.3,
                )
            }
        };
        #[cfg(not(target_os = "linux"))]
        let rect = map_region(
            region,
            (self.display.width, self.display.height),
            (width, height),
        );
        frame_region_to_rgba(frame, rect)
    }

    pub(super) fn decode_one_shot(&self) -> anyhow::Result<RgbaImage> {
        #[cfg(all(debug_assertions, target_os = "macos"))]
        QA_SNAPSHOT_READS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let full = capture_one_shot(&self.app, &self.display)?;
        match self.region {
            None => Ok(full),
            Some(region) => {
                let (x, y, w, h) = map_region(
                    region,
                    (self.display.width, self.display.height),
                    full.dimensions(),
                );
                Ok(crop(&full, x, y, w, h))
            }
        }
    }

    /// One-shot source for stills and macOS scrolling. Windows scrolling uses
    /// a persistent stream and retains the last frame when the screen is idle.
    pub fn one_shot(app: &AppHandle, display: DisplayInfo) -> Self {
        #[cfg(target_os = "linux")]
        {
            Self::open(app, display)
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self {
                app: app.clone(),
                display,
                backend: Backend::OneShot,
                last: None,
                captured_at: None,
                region: None,
                #[cfg(target_os = "windows")]
                poll_without_wait: false,
            }
        }
    }

    /// Next frame of the display: `Some` when the backend produced a new one,
    /// `None` when the screen is unchanged since the previous call.
    pub fn poll(&mut self) -> anyhow::Result<Option<&RgbaImage>> {
        let image = match &mut self.backend {
            Backend::Persistent(capturer) => match {
                #[cfg(target_os = "windows")]
                if self.poll_without_wait {
                    capturer.poll_frame_now()
                } else {
                    capturer.poll_frame()
                }
                #[cfg(not(target_os = "windows"))]
                capturer.poll_frame()
            }? {
                Some(frame) => {
                    self.captured_at = Some(frame.captured_at);
                    Some(self.decode_frame(&frame)?)
                }
                None => None,
            },
            Backend::OneShot => {
                let image = self.decode_one_shot()?;
                self.captured_at = Some(Instant::now());
                Some(image)
            }
            #[cfg(target_os = "linux")]
            Backend::Unavailable(error) => anyhow::bail!("{error}"),
            #[cfg(target_os = "macos")]
            Backend::MacRegion(snapshot) => {
                ensure_capture_permission()?;
                #[cfg(debug_assertions)]
                QA_SNAPSHOT_READS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let (image, captured_at) = snapshot
                    .as_ref()
                    .map_err(|error| anyhow::anyhow!("{error:#}"))?
                    .capture()?;
                self.captured_at = Some(captured_at);
                Some(image)
            }
        };
        match image {
            Some(image) => {
                self.last = Some(image);
                Ok(self.last.as_ref())
            }
            None if self.last.is_none() => {
                // Event-driven backends may idle before the first frame;
                // a full capture establishes the baseline.
                let image = match &mut self.backend {
                    Backend::Persistent(capturer) => {
                        let frame = capturer.capture()?;
                        self.captured_at = Some(frame.captured_at);
                        self.decode_frame(&frame)?
                    }
                    Backend::OneShot => {
                        let image = self.decode_one_shot()?;
                        self.captured_at = Some(Instant::now());
                        image
                    }
                    #[cfg(target_os = "linux")]
                    Backend::Unavailable(error) => anyhow::bail!("{error}"),
                    #[cfg(target_os = "macos")]
                    Backend::MacRegion(_) => {
                        unreachable!("region snapshots always return an image")
                    }
                };
                self.last = Some(image);
                Ok(self.last.as_ref())
            }
            None => Ok(None),
        }
    }

    /// Timestamp of the native pixels, before conversion/resizing/encoding.
    pub fn captured_at(&self) -> Option<Instant> {
        self.captured_at
    }

    /// Latest frame (new or unchanged).
    pub fn grab(&mut self) -> anyhow::Result<RgbaImage> {
        self.poll()?;
        self.last.clone().context("no frame captured")
    }

    /// Linux backends capture the virtual desktop; keep only this display.
    pub(super) fn crop_desktop(&self, desktop: RgbaImage) -> RgbaImage {
        #[cfg(target_os = "linux")]
        {
            if crate::servers::rdp::capture::wayland::is_wayland_session() {
                desktop
            } else {
                crop_desktop_to_display(&self.app, desktop, &self.display)
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            desktop
        }
    }
}
