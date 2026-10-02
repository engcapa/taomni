//! Windows console capture for the embedded RDP server.
//!
//! The hot path owns a Windows Graphics Capture (WGC) stream. Only the newest
//! native surface is retained, with its sampling timestamp; CPU readback is
//! paced by the consumer. A GDI
//! screenshot is retained as a compatibility fallback for sessions where WGC
//! is unavailable (for example an older build, a remote/locked desktop, or a
//! driver that rejects the capture session).

use std::time::{Duration, Instant};

use super::{Capturer, Frame};
use crate::servers::engine::LogEmitter;
use scopeguard::guard;
use windows::Win32::Graphics::Gdi::{
    BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDIBits, GetWindowDC, RGBQUAD, ReleaseDC, SRCCOPY,
    SelectObject,
};
use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

const FRAME_WAIT: Duration = Duration::from_millis(250);
const TOPOLOGY_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const RESTART_BACKOFF: Duration = Duration::from_millis(250);
const MAX_CAPTURE_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct MonitorKey {
    id: u32,
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

enum Backend {
    Recorder(super::win_wgc::WgcStream),
    Gdi,
}

impl Backend {
    fn stop(&mut self) {
        // Dropping WGC stops its mailbox/callbacks before closing the session.
        *self = Self::Gdi;
    }
}

pub(crate) struct WindowsCapturer {
    monitor: xcap::Monitor,
    key: MonitorKey,
    requested_display: Option<String>,
    width: u16,
    height: u16,
    backend: Backend,
    /// The first GDI frame proves that the desktop is capturable before the
    /// RDP listener reports ready and also prevents a static desktop from
    /// waiting for a future native frame notification.
    pending: Option<Frame>,
    next_topology_check: Instant,
    next_restart: Instant,
    log: LogEmitter,
}

impl WindowsCapturer {
    pub(crate) fn new(log: &LogEmitter, requested_display: Option<&str>) -> anyhow::Result<Self> {
        let requested_display = requested_display
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let (monitor, key) = select_monitor(requested_display.as_deref())?;

        // A synchronous probe gives the caller a useful startup error instead
        // of reporting a healthy RDP listener that can only produce black
        // frames. The resulting frame is reused as the first display update.
        let initial = capture_gdi(&monitor)?;
        let width = initial.width;
        let height = initial.height;

        let backend = match start_recorder(&monitor) {
            Ok(backend) => {
                log.line(format!(
                    "Windows RDP capture: Windows Graphics Capture ready ({}x{})",
                    width, height
                ));
                backend
            }
            Err(error) => {
                log.line(format!(
                    "Windows RDP capture: WGC unavailable ({error}); using GDI fallback"
                ));
                Backend::Gdi
            }
        };

        Ok(Self {
            monitor,
            key,
            requested_display,
            width,
            height,
            backend,
            pending: Some(initial),
            next_topology_check: Instant::now() + TOPOLOGY_CHECK_INTERVAL,
            next_restart: Instant::now(),
            log: log.clone(),
        })
    }

    fn install_monitor(&mut self, monitor: xcap::Monitor, key: MonitorKey) {
        self.backend.stop();
        self.backend = match start_recorder(&monitor) {
            Ok(backend) => {
                self.log.line(format!(
                    "Windows RDP capture: rebuilt WGC session for {}x{}",
                    key.width, key.height
                ));
                backend
            }
            Err(error) => {
                self.log.line(format!(
                    "Windows RDP capture: WGC rebuild failed ({error}); using GDI"
                ));
                Backend::Gdi
            }
        };
        // A newly selected monitor may be static and therefore produce no
        // Native capture present notification. Seed the next update with
        // a validated snapshot so the client receives the new geometry/frame
        // without waiting for user activity.
        self.pending = match capture_gdi(&monitor) {
            Ok(frame) => Some(frame),
            Err(error) => {
                self.log.line(format!(
                    "Windows display snapshot after topology change failed: {error}"
                ));
                None
            }
        };
        self.width = checked_dimension_u32(key.width).unwrap_or(self.width);
        self.height = checked_dimension_u32(key.height).unwrap_or(self.height);
        self.monitor = monitor;
        self.key = key;
        self.next_restart = Instant::now() + RESTART_BACKOFF;
    }

    fn maybe_refresh_topology(&mut self) -> anyhow::Result<()> {
        if Instant::now() < self.next_topology_check {
            return Ok(());
        }
        self.next_topology_check = Instant::now() + TOPOLOGY_CHECK_INTERVAL;
        let Ok((monitor, key)) = select_monitor(self.requested_display.as_deref()) else {
            return Ok(());
        };
        if key != self.key {
            self.log.line(format!(
                "Windows display topology changed: {}x{} at ({},{}), rebuilding capture",
                key.width, key.height, key.x, key.y
            ));
            self.install_monitor(monitor, key);
        }
        Ok(())
    }

    fn restart_recorder(&mut self) {
        if Instant::now() < self.next_restart {
            return;
        }
        self.backend.stop();
        self.backend = match start_recorder(&self.monitor) {
            Ok(backend) => {
                self.log.line("Windows RDP capture: WGC session recovered");
                backend
            }
            Err(error) => {
                self.log.line(format!(
                    "Windows RDP capture: WGC recovery failed ({error}); retaining GDI fallback"
                ));
                Backend::Gdi
            }
        };
        if self.pending.is_none() {
            self.pending = match capture_gdi(&self.monitor) {
                Ok(frame) => Some(frame),
                Err(error) => {
                    self.log.line(format!(
                        "Windows snapshot after WGC recovery failed: {error}"
                    ));
                    None
                }
            };
        }
        self.next_restart = Instant::now() + RESTART_BACKOFF;
    }

    fn next_recorder_frame(&mut self, wait: Duration) -> anyhow::Result<Option<Frame>> {
        let Backend::Recorder(stream) = &mut self.backend else {
            return Ok(None);
        };
        let frame = stream.next(wait)?;
        if let Some(frame) = &frame {
            self.width = frame.width;
            self.height = frame.height;
        }
        Ok(frame)
    }

    fn fallback_to_gdi(&mut self, reason: &anyhow::Error) {
        self.log.line(format!(
            "Windows RDP capture: WGC frame failed ({reason}); using GDI"
        ));
        self.backend.stop();
        self.backend = Backend::Gdi;
        self.pending = match capture_gdi(&self.monitor) {
            Ok(frame) => Some(frame),
            Err(error) => {
                self.log
                    .line(format!("Windows GDI fallback snapshot failed: {error}"));
                None
            }
        };
        self.next_restart = Instant::now() + RESTART_BACKOFF;
    }
}

impl Capturer for WindowsCapturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        if let Some(frame) = self.pending.take() {
            return Ok(frame);
        }
        if let Some(frame) = self.next_recorder_frame(Duration::from_secs(2))? {
            return Ok(frame);
        }
        let frame = capture_gdi(&self.monitor)?;
        self.width = frame.width;
        self.height = frame.height;
        Ok(frame)
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        self.maybe_refresh_topology()?;
        if let Some(frame) = self.pending.take() {
            return Ok(Some(frame));
        }

        if matches!(self.backend, Backend::Gdi) {
            self.restart_recorder();
        }
        match &self.backend {
            Backend::Recorder(_) => match self.next_recorder_frame(FRAME_WAIT) {
                Ok(frame) => Ok(frame),
                Err(error) => {
                    self.fallback_to_gdi(&error);
                    Ok(self.pending.take())
                }
            },
            Backend::Gdi => {
                // GDI is a compatibility path only. Keep its cadence bounded
                // and let the display layer's hash suppress unchanged pixels.
                std::thread::sleep(FRAME_WAIT);
                let frame = capture_gdi(&self.monitor)?;
                self.width = frame.width;
                self.height = frame.height;
                Ok(Some(frame))
            }
        }
    }

    fn is_self_paced(&self) -> bool {
        matches!(self.backend, Backend::Recorder(_))
    }

    fn needs_frame_deduplication(&self) -> bool {
        matches!(self.backend, Backend::Gdi)
    }
}

impl Drop for WindowsCapturer {
    fn drop(&mut self) {
        self.backend.stop();
    }
}

fn checked_dimension(value: u32) -> anyhow::Result<u16> {
    checked_dimension_u32(value)
        .ok_or_else(|| anyhow::anyhow!("Windows capture exceeds RDP limits"))
}

fn checked_dimension_u32(value: u32) -> Option<u16> {
    u16::try_from(value).ok().filter(|value| *value > 0)
}

fn checked_frame_bytes(width: u16, height: u16) -> anyhow::Result<usize> {
    let bytes = usize::from(width)
        .checked_mul(usize::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| anyhow::anyhow!("WGC frame size overflow"))?;
    if bytes > MAX_CAPTURE_BYTES {
        anyhow::bail!(
            "WGC frame is too large ({} bytes; limit {} bytes)",
            bytes,
            MAX_CAPTURE_BYTES
        );
    }
    Ok(bytes)
}

fn capture_gdi(monitor: &xcap::Monitor) -> anyhow::Result<Frame> {
    let x = monitor
        .x()
        .map_err(|error| anyhow::anyhow!("GDI monitor x: {error}"))?;
    let y = monitor
        .y()
        .map_err(|error| anyhow::anyhow!("GDI monitor y: {error}"))?;
    let monitor_width = monitor
        .width()
        .map_err(|error| anyhow::anyhow!("GDI monitor width: {error}"))?;
    let monitor_height = monitor
        .height()
        .map_err(|error| anyhow::anyhow!("GDI monitor height: {error}"))?;
    let width = checked_dimension(monitor_width)?;
    let height = checked_dimension(monitor_height)?;
    let width_i32 = i32::from(width);
    let height_i32 = i32::from(height);

    let pixel_bytes = checked_frame_bytes(width, height)?;
    let mut pixels = vec![0u8; pixel_bytes];
    unsafe {
        let desktop = GetDesktopWindow();
        let desktop_dc = GetWindowDC(Some(desktop));
        if desktop_dc.is_invalid() {
            anyhow::bail!("GDI GetWindowDC failed");
        }
        let desktop_dc = guard(desktop_dc, |dc| {
            let _ = ReleaseDC(Some(desktop), dc);
        });

        let memory_dc = CreateCompatibleDC(Some(*desktop_dc));
        if memory_dc.is_invalid() {
            anyhow::bail!("GDI CreateCompatibleDC failed");
        }
        let memory_dc = guard(memory_dc, |dc| {
            let _ = DeleteDC(dc);
        });

        let bitmap = CreateCompatibleBitmap(*desktop_dc, width_i32, height_i32);
        if bitmap.is_invalid() {
            anyhow::bail!("GDI CreateCompatibleBitmap failed");
        }
        let bitmap = guard(bitmap, |bitmap| {
            let _ = DeleteObject(bitmap.into());
        });
        let previous = SelectObject(*memory_dc, (*bitmap).into());
        if previous.is_invalid() {
            anyhow::bail!("GDI SelectObject failed");
        }
        let _restore = guard(previous, |previous| {
            let _ = SelectObject(*memory_dc, previous);
        });

        BitBlt(
            *memory_dc,
            0,
            0,
            width_i32,
            height_i32,
            Some(*desktop_dc),
            x,
            y,
            SRCCOPY,
        )
        .map_err(|error| anyhow::anyhow!("GDI BitBlt failed: {error}"))?;

        let mut bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width_i32,
                biHeight: -height_i32,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: pixels.len() as u32,
                ..Default::default()
            },
            bmiColors: [RGBQUAD::default(); 1],
        };
        if GetDIBits(
            *memory_dc,
            *bitmap,
            0,
            u32::from(height),
            Some(pixels.as_mut_ptr().cast()),
            &mut bitmap_info,
            DIB_RGB_COLORS,
        ) == 0
        {
            anyhow::bail!("GDI GetDIBits failed");
        }
    }

    let stride = usize::from(width)
        .checked_mul(4)
        .ok_or_else(|| anyhow::anyhow!("Windows frame stride overflow"))?;
    Ok(Frame::bgra(pixels, 0, 0, width, height, stride))
}

fn start_recorder(monitor: &xcap::Monitor) -> anyhow::Result<Backend> {
    Ok(Backend::Recorder(super::win_wgc::WgcStream::start(
        monitor,
    )?))
}

fn select_monitor(requested: Option<&str>) -> anyhow::Result<(xcap::Monitor, MonitorKey)> {
    let monitors = xcap::Monitor::all()
        .map_err(|error| anyhow::anyhow!("cannot enumerate Windows monitors: {error}"))?;
    if monitors.is_empty() {
        anyhow::bail!(
            "Windows reported no active monitors; an interactive console session is required"
        )
    }

    let selected = requested
        .and_then(|requested| {
            monitors.iter().find(|monitor| {
                monitor
                    .id()
                    .ok()
                    .is_some_and(|id| id.to_string() == requested)
                    || monitor.name().ok().is_some_and(|name| name == requested)
            })
        })
        .or_else(|| {
            monitors
                .iter()
                .find(|monitor| monitor.is_primary().unwrap_or(false))
        })
        .unwrap_or(&monitors[0]);
    let monitor = selected.clone();
    let key = monitor_key(&monitor)?;
    Ok((monitor, key))
}

fn monitor_key(monitor: &xcap::Monitor) -> anyhow::Result<MonitorKey> {
    Ok(MonitorKey {
        id: monitor
            .id()
            .map_err(|error| anyhow::anyhow!("monitor id: {error}"))?,
        name: monitor
            .name()
            .map_err(|error| anyhow::anyhow!("monitor name: {error}"))?,
        x: monitor
            .x()
            .map_err(|error| anyhow::anyhow!("monitor x: {error}"))?,
        y: monitor
            .y()
            .map_err(|error| anyhow::anyhow!("monitor y: {error}"))?,
        width: monitor
            .width()
            .map_err(|error| anyhow::anyhow!("monitor width: {error}"))?,
        height: monitor
            .height()
            .map_err(|error| anyhow::anyhow!("monitor height: {error}"))?,
    })
}

pub(crate) fn probe_displays() -> anyhow::Result<Vec<super::CaptureDisplay>> {
    let monitors = xcap::Monitor::all()
        .map_err(|error| anyhow::anyhow!("cannot enumerate Windows monitors: {error}"))?;
    monitors
        .into_iter()
        .map(|monitor| {
            Ok(super::CaptureDisplay {
                id: monitor
                    .id()
                    .map_err(|error| anyhow::anyhow!("monitor id: {error}"))?
                    .to_string(),
                name: monitor
                    .friendly_name()
                    .or_else(|_| monitor.name())
                    .map_err(|error| anyhow::anyhow!("monitor name: {error}"))?,
                width: monitor
                    .width()
                    .map_err(|error| anyhow::anyhow!("monitor width: {error}"))?,
                height: monitor
                    .height()
                    .map_err(|error| anyhow::anyhow!("monitor height: {error}"))?,
                primary: monitor
                    .is_primary()
                    .map_err(|error| anyhow::anyhow!("monitor primary state: {error}"))?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_capture_frames_over_memory_budget() {
        assert!(checked_frame_bytes(16384, 16384).is_err());
        assert_eq!(checked_frame_bytes(1920, 1080).unwrap(), 1920 * 1080 * 4);
    }
}
