use anyhow::Context;
use image::RgbaImage;
use std::sync::mpsc::SyncSender;
use std::sync::mpsc::TrySendError;

/// Encoded frames in flight before the capture thread starts dropping.
pub(super) const FRAME_QUEUE: usize = 4;

pub(super) struct TimedFrame {
    pub(super) image: RgbaImage,
    /// Milliseconds since recording start.
    pub(super) at_ms: u64,
}

#[derive(Default)]
pub(super) struct FrameQueue {
    pub(super) previous: Option<Vec<u8>>,
    pub(super) pending: Option<TimedFrame>,
}

impl FrameQueue {
    pub(super) fn update(&mut self, image: RgbaImage, at_ms: u64) {
        if self.previous.as_deref() == Some(image.as_raw().as_slice()) {
            self.pending = None;
        } else if self
            .pending
            .as_ref()
            .is_none_or(|frame| frame.image != image)
        {
            self.pending = Some(TimedFrame { image, at_ms });
        }
    }

    pub(super) fn try_flush(&mut self, tx: &SyncSender<TimedFrame>) -> anyhow::Result<()> {
        if let Some(frame) = self.pending.take() {
            let pixels = frame.image.as_raw().clone();
            match tx.try_send(frame) {
                Ok(()) => self.previous = Some(pixels),
                Err(TrySendError::Full(frame)) => self.pending = Some(frame),
                Err(TrySendError::Disconnected(_)) => {
                    anyhow::bail!("recording encoder stopped unexpectedly")
                }
            }
        }
        Ok(())
    }

    pub(super) fn finish(
        &mut self,
        tx: &SyncSender<TimedFrame>,
        end_ms: u64,
    ) -> anyhow::Result<()> {
        // Do not lose the final changed image if the user stops while the
        // encoder is busy. Its original timestamp is retained on retries.
        if let Some(frame) = self.pending.take() {
            tx.send(frame)
                .context("recording encoder stopped unexpectedly")?;
        }
        tx.send(TimedFrame {
            image: RgbaImage::new(0, 0),
            at_ms: end_ms,
        })
        .context("recording encoder stopped unexpectedly")
    }
}
