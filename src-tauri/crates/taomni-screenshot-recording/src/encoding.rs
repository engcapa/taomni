use super::TimedFrame;
use super::gif::GifSink;
use super::model::{ClipMetadata, RecordFormat, RecordingInfo};
use super::mp4::Mp4Sink;
use anyhow::Context;
use image::RgbaImage;
use std::fs::File;
use std::path::Path;
use std::sync::mpsc::Receiver;

/// Consume frames until the end marker (a 0x0 frame) or disconnect.
pub fn encode_loop(
    rx: Receiver<TimedFrame>,
    format: RecordFormat,
    fps: u32,
    path: &Path,
) -> anyhow::Result<RecordingInfo> {
    let file = File::create(path).context("create recording file")?;
    let clip = encode_file(rx.iter().map(Ok), format, fps, file)?;
    Ok(RecordingInfo::from_clip(path.to_path_buf(), clip))
}

pub fn encode_file(
    input: impl Iterator<Item = anyhow::Result<TimedFrame>>,
    format: RecordFormat,
    fps: u32,
    file: File,
) -> anyhow::Result<ClipMetadata> {
    let mut sink: Box<dyn FrameSink> = match format {
        RecordFormat::Gif => Box::new(GifSink::new(file)),
        RecordFormat::Mp4 => Box::new(Mp4Sink::new(file, fps)),
    };
    let mut pending: Option<TimedFrame> = None;
    let mut end_ms = 0u64;
    for frame in input {
        let frame = frame?;
        let is_end = frame.image.width() == 0;
        if let Some(prev) = pending.take() {
            let duration = frame.at_ms.saturating_sub(prev.at_ms).max(1);
            sink.push(&prev.image, prev.at_ms, duration)?;
        }
        end_ms = frame.at_ms;
        if is_end {
            break;
        }
        pending = Some(frame);
    }
    if let Some(prev) = pending.take() {
        // Disconnected without an end marker (capture failure).
        sink.push(
            &prev.image,
            prev.at_ms,
            end_ms.saturating_sub(prev.at_ms).max(100),
        )?;
    }
    let (width, height, frames) = sink.finish()?;
    if frames == 0 {
        anyhow::bail!("no frames were captured");
    }
    Ok(ClipMetadata {
        width,
        height,
        frames,
        duration_ms: end_ms,
    })
}

pub(super) trait FrameSink {
    /// Write one frame shown at `at_ms` for `duration_ms`.
    fn push(&mut self, image: &RgbaImage, at_ms: u64, duration_ms: u64) -> anyhow::Result<()>;
    /// Finalize; returns `(width, height, frames)`.
    fn finish(&mut self) -> anyhow::Result<(u32, u32, u32)>;
}
