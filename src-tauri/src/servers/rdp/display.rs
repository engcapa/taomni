//! RDP server display handler: produces [`DisplayUpdate`] frames for connected
//! clients.
//!
//! Real screen capture runs on a dedicated OS thread (native capture backends
//! hold non-`Send`, thread-affine handles — see [`super::capture`]). That thread
//! pushes BGRA frames over an `mpsc` channel; [`DisplayUpdatesImpl::next_update`]
//! awaits the channel, keeping the protocol runtime free and the await point
//! cancel-safe. If no capture backend is available (unimplemented platform, no
//! X11), we fall back to a synthetic cycling-color frame source so the server
//! still runs and the failure is visible rather than fatal.
//!
//! Phase 3 will add dirty-rect diffing on top of the full frames produced here.

use core::num::{NonZeroU16, NonZeroUsize};

use async_trait::async_trait;
use ironrdp::server::{
    BitmapUpdate, DesktopSize, DisplayUpdate, PixelFormat, RdpServerDisplay,
    RdpServerDisplayUpdates,
};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

use super::capture::{create_capturer, Capturer, Frame};
use crate::servers::engine::LogEmitter;

/// Display handler handed to the IronRDP builder. Probes the capture backend to
/// learn the real desktop size, falling back to the configured default.
pub(crate) struct RdpDisplay {
    log: LogEmitter,
    /// Desktop size reported to the client. Set from the capture backend when
    /// available, else the fallback size passed in at construction.
    size: DesktopSize,
    /// Whether a real capture backend initialized successfully.
    have_capture: bool,
}

impl RdpDisplay {
    pub(crate) fn new(log: LogEmitter, fallback: DesktopSize) -> Self {
        // Probe once up front (on this caller's thread) only to learn the size;
        // the real capturer is created again inside the capture thread, which is
        // where it must live. Probing here keeps `size()` honest for the client.
        let (size, have_capture) = match create_capturer(&log) {
            Ok(cap) => {
                let (w, h) = cap.desktop_size();
                match (NonZeroU16::new(w), NonZeroU16::new(h)) {
                    (Some(_), Some(_)) => (DesktopSize { width: w, height: h }, true),
                    _ => (fallback, false),
                }
            }
            Err(e) => {
                let msg =
                    format!("screen capture unavailable: {} — serving placeholder", e);
                log.line(msg.clone());
                tracing::warn!("RDP display: {}", msg);
                (fallback, false)
            }
        };

        Self {
            log,
            size,
            have_capture,
        }
    }
}

#[async_trait]
impl RdpServerDisplay for RdpDisplay {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        self.log.line("client requested display stream");
        if self.have_capture {
            Ok(Box::new(DisplayUpdatesImpl::with_capture(
                self.log.clone(),
                self.size,
            )))
        } else {
            Ok(Box::new(DisplayUpdatesImpl::synthetic(self.size)))
        }
    }
}

/// Per-client update producer. Either drains a capture thread or, in fallback
/// mode, emits a synthetic cycling-color frame.
pub(crate) struct DisplayUpdatesImpl {
    size: DesktopSize,
    /// Receiver of captured frames; `None` in synthetic mode.
    rx: Option<mpsc::Receiver<Frame>>,
    /// Demo color index (synthetic mode only).
    tick: u8,
}

impl DisplayUpdatesImpl {
    /// Spawn the capture thread and return an updater draining its frames.
    fn with_capture(log: LogEmitter, size: DesktopSize) -> Self {
        // Bounded channel: capacity 1 keeps only the freshest frame in flight,
        // applying natural backpressure (slow client → capture thread blocks on
        // send rather than building an unbounded backlog of stale frames).
        let (tx, rx) = mpsc::channel::<Frame>(1);

        std::thread::Builder::new()
            .name("rdp-capture".to_string())
            .spawn(move || capture_loop(log, tx))
            .ok();

        Self {
            size,
            rx: Some(rx),
            tick: 0,
        }
    }

    fn synthetic(size: DesktopSize) -> Self {
        Self {
            size,
            rx: None,
            tick: 0,
        }
    }

    /// Wrap a captured BGRA frame (full screen or a cropped damage region) into
    /// a [`BitmapUpdate`] placed at the region's origin. The IronRDP encoder
    /// diffs it against its framebuffer at that offset and encodes only the
    /// changed tiles, so a small region costs O(region), not O(screen).
    fn frame_to_bitmap(frame: Frame) -> Option<BitmapUpdate> {
        let width = NonZeroU16::new(frame.width)?;
        let height = NonZeroU16::new(frame.height)?;
        let stride = NonZeroUsize::new(frame.stride)?;
        Some(BitmapUpdate {
            x: frame.x,
            y: frame.y,
            width,
            height,
            format: PixelFormat::BgrA32,
            data: frame.data.into(),
            stride,
        })
    }

    /// Build a full-frame solid-color BgrA32 bitmap (synthetic mode).
    fn solid_frame(&self, bgr: [u8; 3]) -> Option<BitmapUpdate> {
        let width = NonZeroU16::new(self.size.width)?;
        let height = NonZeroU16::new(self.size.height)?;
        let w = usize::from(self.size.width);
        let h = usize::from(self.size.height);
        let stride = NonZeroUsize::new(w.checked_mul(4)?)?;

        let mut data = Vec::with_capacity(stride.get().checked_mul(h)?);
        for _ in 0..(w * h) {
            data.push(bgr[0]);
            data.push(bgr[1]);
            data.push(bgr[2]);
            data.push(255);
        }
        Some(BitmapUpdate {
            x: 0,
            y: 0,
            width,
            height,
            format: PixelFormat::BgrA32,
            data: data.into(),
            stride,
        })
    }

    async fn next_synthetic(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        sleep(Duration::from_millis(500)).await;
        let palette: [[u8; 3]; 4] = [
            [0xC0, 0x40, 0x40],
            [0x40, 0xC0, 0x40],
            [0x40, 0x40, 0xC0],
            [0x40, 0xC0, 0xC0],
        ];
        let color = palette[usize::from(self.tick % 4)];
        self.tick = self.tick.wrapping_add(1);
        Ok(self.solid_frame(color).map(DisplayUpdate::Bitmap))
    }
}

#[async_trait]
impl RdpServerDisplayUpdates for DisplayUpdatesImpl {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        match self.rx.as_mut() {
            Some(rx) => {
                // Await the next captured frame. `recv` is cancel-safe; if the
                // capture thread ends (channel closed) we end the stream.
                match rx.recv().await {
                    Some(frame) => Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap)),
                    None => Ok(None),
                }
            }
            None => self.next_synthetic().await,
        }
    }
}

/// Capture-thread body: create the backend on this thread, then loop producing
/// updates and sending them to the display task. Exits when the receiver is
/// dropped (client disconnected) or capture errors out.
///
/// Two regimes, chosen by the backend:
///
/// - **Event-driven** (X11 XDamage): the backend blocks until the screen
///   actually changes and returns only the changed regions (the first frame is
///   full, to seed the encoder framebuffer). No interval, no hashing — idle
///   costs nothing and a small change sends a small region.
/// - **Polling fallback** (synthetic, or X11 without DAMAGE, or other
///   platforms): capture a full frame on a ~30 fps interval and suppress
///   byte-identical frames with a cheap FNV-1a hash so a static desktop still
///   costs near-zero downstream. The IronRDP encoder diffs the frames we DO
///   send and only encodes changed rectangles.
fn capture_loop(log: LogEmitter, tx: mpsc::Sender<Frame>) {
    let mut capturer = match create_capturer(&log) {
        Ok(c) => c,
        Err(e) => {
            log.line(format!("capture thread: {}", e));
            return;
        }
    };

    if capturer.is_event_driven() {
        capture_loop_event_driven(capturer.as_mut(), &tx);
    } else {
        capture_loop_polling(capturer.as_mut(), &tx);
    }
    log.line("capture thread stopped");
}

/// Damage-driven loop: forward whatever regions the backend reports. The
/// backend internally blocks on change notifications and caps the frame rate,
/// so this loop adds no interval of its own. An empty result is an idle tick;
/// we use it to notice a disconnected client (closed channel) promptly.
fn capture_loop_event_driven(capturer: &mut dyn Capturer, tx: &mpsc::Sender<Frame>) {
    let mut first = true;
    loop {
        match capturer.next_updates(first) {
            Ok(frames) => {
                first = false;
                if frames.is_empty() {
                    // Idle tick: nothing changed within the wait budget. Bail
                    // out if the client went away, otherwise keep waiting.
                    if tx.is_closed() {
                        break;
                    }
                    continue;
                }
                for frame in frames {
                    if tx.blocking_send(frame).is_err() {
                        return;
                    }
                }
            }
            Err(e) => {
                let _ = tx; // nothing to send; surface and stop
                tracing::warn!("RDP capture (damage): {}", e);
                break;
            }
        }
    }
}

/// Fixed-interval full-frame loop with FNV-1a dedup (used when the backend is
/// not event-driven). ~30 fps ceiling; identical frames are suppressed so a
/// static desktop costs nothing downstream.
fn capture_loop_polling(capturer: &mut dyn Capturer, tx: &mpsc::Sender<Frame>) {
    let frame_interval = std::time::Duration::from_millis(33);
    let mut last_hash: Option<u64> = None;
    let mut first = true;
    loop {
        let start = std::time::Instant::now();
        match capturer.capture() {
            Ok(frame) => {
                let hash = super::diff::frame_hash(&frame.data);
                // Always send the first frame so the client gets an initial
                // image; thereafter suppress byte-identical frames.
                if first || last_hash != Some(hash) {
                    first = false;
                    last_hash = Some(hash);
                    if tx.blocking_send(frame).is_err() {
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::warn!("RDP capture (polling): {}", e);
                break;
            }
        }
        if let Some(rem) = frame_interval.checked_sub(start.elapsed()) {
            std::thread::sleep(rem);
        }
    }
}
