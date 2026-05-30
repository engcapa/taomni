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

use super::capture::{create_capturer, Frame};
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
                log.line(format!("screen capture unavailable: {} — serving placeholder", e));
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

    /// Wrap a captured BGRA frame into a full-screen [`BitmapUpdate`].
    fn frame_to_bitmap(frame: Frame) -> Option<BitmapUpdate> {
        let width = NonZeroU16::new(frame.width)?;
        let height = NonZeroU16::new(frame.height)?;
        let stride = NonZeroUsize::new(frame.stride)?;
        Some(BitmapUpdate {
            x: 0,
            y: 0,
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

/// Capture-thread body: create the backend on this thread, then loop capturing
/// frames and sending them to the display task. Exits when the receiver is
/// dropped (client disconnected) or capture errors out.
///
/// Phase 3 frame-suppression: an unchanged frame (same FNV-1a hash as the last
/// one sent) is dropped here rather than forwarded, so a static desktop costs
/// nothing downstream. The ironrdp-server encoder still diffs the frames we DO
/// send and only encodes changed rectangles, so we don't crop here.
fn capture_loop(log: LogEmitter, tx: mpsc::Sender<Frame>) {
    let mut capturer = match create_capturer(&log) {
        Ok(c) => c,
        Err(e) => {
            log.line(format!("capture thread: {}", e));
            return;
        }
    };

    // ~30 fps ceiling. The idle case is cheap because identical frames are
    // suppressed below; only changed frames traverse the channel and encoder.
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
                log.line(format!("capture error: {}", e));
                break;
            }
        }
        if let Some(rem) = frame_interval.checked_sub(start.elapsed()) {
            std::thread::sleep(rem);
        }
    }
    log.line("capture thread stopped");
}
