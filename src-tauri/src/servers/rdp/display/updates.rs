use super::mailbox::LatestFrameMailbox;
use super::mailbox::PendingFrames;
use crate::servers::rdp::capture::Frame;
#[cfg(target_os = "macos")]
use crate::servers::rdp::gfx::EncodedFrame;
#[cfg(target_os = "macos")]
use crate::servers::rdp::gfx::GfxReadiness;
#[cfg(target_os = "macos")]
use crate::servers::rdp::gfx::GfxSubmit;
#[cfg(target_os = "macos")]
use crate::servers::rdp::gfx::GfxTransport;
#[cfg(target_os = "macos")]
use crate::servers::rdp::gfx::H264Encoder;
use crate::servers::rdp::metrics::RdpMetrics;
use async_trait::async_trait;
use core::num::NonZeroU16;
use core::num::NonZeroUsize;
use ironrdp::server::BitmapUpdate;
use ironrdp::server::DesktopSize;
use ironrdp::server::DisplayUpdate;
use ironrdp::server::PixelFormat;
use ironrdp::server::RdpServerDisplayUpdates;
use std::collections::VecDeque;
use std::sync::Arc;

/// Per-client update producer that drains the native capture thread.
pub(crate) struct DisplayUpdatesImpl {
    pub(super) mailbox: Arc<LatestFrameMailbox>,
    pub(super) active_damage: VecDeque<Frame>,
    pub(super) metrics: RdpMetrics,
    pub(super) current_size: DesktopSize,
    pub(super) deferred_full: Option<Frame>,
    #[cfg(target_os = "macos")]
    pub(super) gfx: GfxTransport,
    #[cfg(target_os = "macos")]
    pub(super) h264: Option<H264Encoder>,
}

#[cfg(target_os = "macos")]
pub(super) enum MacUpdateEvent {
    Capture(Option<PendingFrames>),
    Encoded(Option<EncodedFrame>),
    EncodeFlush,
    EncodeTimeout,
}

impl DisplayUpdatesImpl {
    #[cfg(target_os = "macos")]
    pub(super) fn from_warmed_capture(
        mailbox: Arc<LatestFrameMailbox>,
        size: DesktopSize,
        metrics: RdpMetrics,
        gfx: GfxTransport,
    ) -> Self {
        Self {
            mailbox,
            active_damage: VecDeque::new(),
            metrics,
            current_size: size,
            deferred_full: None,
            gfx,
            h264: None,
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) fn from_warmed_linux_capture(
        mailbox: Arc<LatestFrameMailbox>,
        size: DesktopSize,
        metrics: RdpMetrics,
    ) -> Self {
        Self {
            mailbox,
            active_damage: VecDeque::new(),
            metrics,
            current_size: size,
            deferred_full: None,
        }
    }

    #[cfg(target_os = "windows")]
    pub(super) fn from_warmed_windows_capture(
        mailbox: Arc<LatestFrameMailbox>,
        size: DesktopSize,
        metrics: RdpMetrics,
    ) -> Self {
        Self {
            mailbox,
            active_damage: VecDeque::new(),
            metrics,
            current_size: size,
            deferred_full: None,
        }
    }

    /// Wrap a captured BGRA frame (full screen or a cropped damage region) into
    /// a [`BitmapUpdate`] placed at the region's origin. The IronRDP encoder
    /// diffs it against its framebuffer at that offset and encodes only the
    /// changed tiles, so a small region costs O(region), not O(screen).
    pub(super) fn frame_to_bitmap(frame: Frame) -> Option<BitmapUpdate> {
        let width = NonZeroU16::new(frame.width)?;
        let height = NonZeroU16::new(frame.height)?;
        let stride = NonZeroUsize::new(frame.stride)?;
        Some(BitmapUpdate {
            x: frame.x,
            y: frame.y,
            width,
            height,
            format: PixelFormat::BgrA32,
            data: match frame.bgra_bytes() {
                Ok(data) => data,
                Err(error) => {
                    tracing::warn!("RDP bitmap pixel readback failed: {error}");
                    return None;
                }
            },
            stride,
        })
    }

    /// Prefer the negotiated EGFX/AVC420 path on macOS. The decision is made
    /// after capture and before turning pixels into a regular RDP bitmap so a
    /// slow client can drop a current frame instead of queuing stale work.
    #[cfg(target_os = "macos")]
    pub(super) fn try_queue_gfx(&mut self, frame: &Frame) -> bool {
        match self.gfx.readiness() {
            GfxReadiness::Backpressured => return true,
            GfxReadiness::Unavailable => {
                self.h264 = None;
                return false;
            }
            GfxReadiness::Ready => {}
        }
        let needs_new_encoder = self
            .h264
            .as_ref()
            .is_none_or(|encoder| !encoder.matches(frame));
        if needs_new_encoder {
            match H264Encoder::new(frame.width, frame.height) {
                Ok(encoder) => self.h264 = Some(encoder),
                Err(error) => {
                    tracing::warn!(
                        "RDP EGFX hardware encoder unavailable; using bitmap updates: {error}"
                    );
                    self.h264 = None;
                    self.gfx.disable_after_failure();
                    return false;
                }
            }
        }
        let Some(encoder) = self.h264.as_mut() else {
            return false;
        };
        if !encoder.can_submit() {
            return true;
        }
        match encoder.submit(frame) {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!("RDP EGFX hardware submit failed; using bitmap update: {error}");
                self.h264 = None;
                self.gfx.disable_after_failure();
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    pub(super) fn finish_gfx_encode(&mut self, encoded: EncodedFrame) -> Option<Frame> {
        let frame = encoded.frame;
        match encoded.result {
            Ok(h264) => {
                let submit = self.gfx.send_avc420(&frame, &h264);
                if matches!(submit, GfxSubmit::Unavailable) {
                    self.h264 = None;
                    self.gfx.disable_after_failure();
                    Some(frame)
                } else {
                    None
                }
            }
            Err(error) => {
                tracing::warn!("RDP EGFX hardware frame failed; using bitmap update: {error}");
                self.h264 = None;
                self.gfx.disable_after_failure();
                Some(frame)
            }
        }
    }

    #[cfg(target_os = "macos")]
    pub(super) async fn next_macos_event(&mut self) -> MacUpdateEvent {
        let Some(encoder) = self.h264.as_mut() else {
            return MacUpdateEvent::Capture(self.mailbox.take().await);
        };
        let deadline = encoder.oldest_deadline();
        let flush_deadline = encoder.flush_deadline();
        let timeout = async move {
            match deadline {
                Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                None => std::future::pending().await,
            }
        };
        let flush = async move {
            match flush_deadline {
                Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(timeout);
        tokio::pin!(flush);
        tokio::select! {
            encoded = encoder.next_output() => MacUpdateEvent::Encoded(encoded),
            capture = self.mailbox.take() => MacUpdateEvent::Capture(capture),
            () = &mut flush => MacUpdateEvent::EncodeFlush,
            () = &mut timeout => MacUpdateEvent::EncodeTimeout,
        }
    }
}

#[async_trait]
impl RdpServerDisplayUpdates for DisplayUpdatesImpl {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        loop {
            if !self.active_damage.is_empty() && self.mailbox.full_refresh_waiting() {
                self.active_damage.clear();
                self.mailbox.finish_damage();
            }

            if let Some(frame) = self.deferred_full.take() {
                self.metrics.record_frame_handoff(frame.captured_at);
                self.metrics.report_if_due();
                #[cfg(target_os = "macos")]
                {
                    if self.try_queue_gfx(&frame) {
                        continue;
                    }
                }
                return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
            }

            if let Some(frame) = self.active_damage.pop_front() {
                if self.active_damage.is_empty() {
                    self.mailbox.finish_damage();
                }
                self.metrics.record_frame_handoff(frame.captured_at);
                self.metrics.report_if_due();
                #[cfg(target_os = "macos")]
                {
                    if self.try_queue_gfx(&frame) {
                        continue;
                    }
                    return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                }
                #[cfg(not(target_os = "macos"))]
                return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
            }

            #[cfg(target_os = "macos")]
            let pending = match self.next_macos_event().await {
                MacUpdateEvent::Capture(pending) => pending,
                MacUpdateEvent::Encoded(Some(encoded)) => {
                    if let Some(frame) = self.finish_gfx_encode(encoded) {
                        return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                    }
                    continue;
                }
                MacUpdateEvent::Encoded(None) => {
                    tracing::warn!("RDP EGFX hardware output channel closed; using bitmap updates");
                    self.h264 = None;
                    self.gfx.disable_after_failure();
                    self.mailbox.replay_latest_full();
                    continue;
                }
                MacUpdateEvent::EncodeFlush => {
                    let flush_result = self
                        .h264
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("H.264 encoder disappeared before flush"))
                        .and_then(H264Encoder::flush_pending);
                    if let Err(error) = flush_result {
                        tracing::warn!(
                            "RDP EGFX idle hardware flush failed; using bitmap updates: {error}"
                        );
                        self.h264 = None;
                        self.gfx.disable_after_failure();
                        self.mailbox.replay_latest_full();
                    }
                    continue;
                }
                MacUpdateEvent::EncodeTimeout => {
                    tracing::warn!(
                        "RDP EGFX hardware frame exceeded the {}ms latency budget; using bitmap updates",
                        super::super::gfx::ENCODE_TIMEOUT.as_millis()
                    );
                    self.h264 = None;
                    self.gfx.disable_after_failure();
                    self.mailbox.replay_latest_full();
                    continue;
                }
            };

            #[cfg(not(target_os = "macos"))]
            let pending = self.mailbox.take().await;

            match pending {
                Some(PendingFrames::Full(frame)) => {
                    let frame_size = DesktopSize {
                        width: frame.width,
                        height: frame.height,
                    };
                    if frame_size != self.current_size {
                        self.current_size = frame_size;
                        self.deferred_full = Some(frame);
                        return Ok(Some(DisplayUpdate::Resize(frame_size)));
                    }
                    self.metrics.record_frame_handoff(frame.captured_at);
                    self.metrics.report_if_due();
                    #[cfg(target_os = "macos")]
                    {
                        if self.try_queue_gfx(&frame) {
                            continue;
                        }
                        return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                    }
                    #[cfg(not(target_os = "macos"))]
                    return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                }
                Some(PendingFrames::Damage(frames)) => {
                    self.active_damage = frames;
                }
                None => return Ok(None),
            }
        }
    }
}
