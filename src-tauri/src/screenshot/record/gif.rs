use super::encoding::FrameSink;
use anyhow::Context;
use image::RgbaImage;
use std::io::BufWriter;
use std::io::Write;
use std::path::Path;

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

pub(super) struct GifSink {
    pub(super) file: Option<BufWriter<std::fs::File>>,
    pub(super) encoder: Option<gif::Encoder<BufWriter<std::fs::File>>>,
    pub(super) dims: (u32, u32),
    pub(super) frames: u32,
    /// Accumulated centiseconds written vs. real elapsed ms, so rounding
    /// errors do not drift the clip length.
    pub(super) written_cs: u64,
}

impl GifSink {
    pub(super) fn create(path: &Path) -> anyhow::Result<Self> {
        let file = std::fs::File::create(path).context("create gif file")?;
        Ok(Self {
            file: Some(BufWriter::new(file)),
            encoder: None,
            dims: (0, 0),
            frames: 0,
            written_cs: 0,
        })
    }
}

impl FrameSink for GifSink {
    fn push(&mut self, image: &RgbaImage, at_ms: u64, duration_ms: u64) -> anyhow::Result<()> {
        let (w, h) = image.dimensions();
        if self.encoder.is_none() {
            let file = self.file.take().context("gif file already consumed")?;
            let mut encoder =
                gif::Encoder::new(file, w as u16, h as u16, &[]).context("init gif encoder")?;
            encoder
                .set_repeat(gif::Repeat::Infinite)
                .context("set gif loop")?;
            self.encoder = Some(encoder);
            self.dims = (w, h);
        }
        let end_cs = (at_ms + duration_ms).div_ceil(10);
        // Browsers clamp delays below 2 cs to 10 cs; never emit them.
        let delay = end_cs
            .saturating_sub(self.written_cs)
            .clamp(2, u16::MAX as u64);
        self.written_cs += delay;
        let mut rgba = image.as_raw().clone();
        let mut frame = gif::Frame::from_rgba_speed(w as u16, h as u16, &mut rgba, 10);
        frame.delay = delay as u16;
        self.encoder
            .as_mut()
            .context("gif encoder missing")?
            .write_frame(&frame)
            .context("write gif frame")?;
        self.frames += 1;
        Ok(())
    }

    fn finish(&mut self) -> anyhow::Result<(u32, u32, u32)> {
        if let Some(encoder) = self.encoder.take() {
            // into_inner writes the trailer.
            let mut file = encoder.into_inner().context("finish gif")?;
            file.flush().context("flush gif")?;
        }
        Ok((self.dims.0, self.dims.1, self.frames))
    }
}
