use super::encoding::FrameSink;
use anyhow::Context;
use image::RgbaImage;
use std::io::BufWriter;
use std::io::Seek;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// MP4 (H.264 via OpenH264, muxed with the `mp4` crate)
// ---------------------------------------------------------------------------

pub(super) struct Mp4Sink {
    pub(super) path: PathBuf,
    pub(super) fps: u32,
    pub(super) encoder: Option<openh264::encoder::Encoder>,
    pub(super) writer: Option<mp4::Mp4Writer<BufWriter<std::fs::File>>>,
    pub(super) dims: (u32, u32),
    pub(super) frames: u32,
}

/// NAL units of an Annex-B bitstream (start codes removed).
pub(crate) fn annex_b_nals(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut nals = Vec::with_capacity(starts.len());
    for (k, &s) in starts.iter().enumerate() {
        let mut e = starts.get(k + 1).map(|&n| n - 3).unwrap_or(data.len());
        // A 4-byte start code leaves one extra zero before the next NAL.
        while e > s && data[e - 1] == 0 && k + 1 < starts.len() {
            e -= 1;
        }
        if e > s {
            nals.push(&data[s..e]);
        }
    }
    nals
}

impl Mp4Sink {
    pub(super) fn create(path: &Path, fps: u32) -> anyhow::Result<Self> {
        Ok(Self {
            path: path.to_path_buf(),
            fps,
            encoder: None,
            writer: None,
            dims: (0, 0),
            frames: 0,
        })
    }

    pub(super) fn make_encoder(
        &self,
        w: u32,
        h: u32,
    ) -> anyhow::Result<openh264::encoder::Encoder> {
        use openh264::encoder::{
            BitRate, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, UsageType,
        };
        // ~0.1 bit per pixel per frame is plenty for screen content.
        let bps = ((w as u64 * h as u64 * self.fps as u64) / 10).clamp(400_000, 12_000_000) as u32;
        let config = EncoderConfig::new()
            .usage_type(UsageType::ScreenContentRealTime)
            .bitrate(BitRate::from_bps(bps))
            .max_frame_rate(FrameRate::from_hz(self.fps as f32))
            .skip_frames(false)
            .intra_frame_period(IntraFramePeriod::from_num_frames(self.fps * 2));
        Encoder::with_api_config(openh264::OpenH264API::from_source(), config)
            .map_err(|e| anyhow::anyhow!("init H.264 encoder: {e}"))
    }
}

impl FrameSink for Mp4Sink {
    fn push(&mut self, image: &RgbaImage, at_ms: u64, duration_ms: u64) -> anyhow::Result<()> {
        use openh264::formats::{RgbaSliceU8, YUVBuffer};
        let (w, h) = image.dimensions();
        if self.encoder.is_none() {
            self.encoder = Some(self.make_encoder(w, h)?);
            self.dims = (w, h);
        }
        if (w, h) != self.dims {
            anyhow::bail!("recording frame size changed mid-stream");
        }
        let yuv =
            YUVBuffer::from_rgb8_source(RgbaSliceU8::new(image.as_raw(), (w as usize, h as usize)));
        let encoder = self.encoder.as_mut().context("encoder missing")?;
        if self.frames == 0 {
            encoder.force_intra_frame();
        }
        let bitstream = encoder
            .encode_at(&yuv, openh264::Timestamp::from_millis(at_ms))
            .map_err(|e| anyhow::anyhow!("encode H.264 frame: {e}"))?;
        let annex_b = bitstream.to_vec();

        let mut sps: Option<Vec<u8>> = None;
        let mut pps: Option<Vec<u8>> = None;
        let mut sample = Vec::with_capacity(annex_b.len() + 16);
        let mut is_sync = false;
        for nal in annex_b_nals(&annex_b) {
            match nal[0] & 0x1f {
                7 => sps = Some(nal.to_vec()),
                8 => pps = Some(nal.to_vec()),
                t => {
                    if t == 5 {
                        is_sync = true;
                    }
                    sample.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                    sample.extend_from_slice(nal);
                }
            }
        }
        if sample.is_empty() {
            return Ok(()); // encoder produced parameter sets only
        }
        if self.writer.is_none() {
            let (Some(sps), Some(pps)) = (sps, pps) else {
                anyhow::bail!("H.264 encoder did not emit SPS/PPS with the first frame");
            };
            let file = std::fs::File::create(&self.path).context("create mp4 file")?;
            let config = mp4::Mp4Config {
                major_brand: "isom".parse().expect("fourcc"),
                minor_version: 512,
                compatible_brands: ["isom", "iso2", "avc1", "mp41"]
                    .iter()
                    .map(|b| b.parse().expect("fourcc"))
                    .collect(),
                timescale: 1000,
            };
            let mut writer =
                mp4::Mp4Writer::write_start(BufWriter::new(file), &config).context("start mp4")?;
            writer
                .add_track(&mp4::TrackConfig {
                    track_type: mp4::TrackType::Video,
                    timescale: 1000,
                    language: "und".to_string(),
                    media_conf: mp4::MediaConfig::AvcConfig(mp4::AvcConfig {
                        width: w as u16,
                        height: h as u16,
                        seq_param_set: sps,
                        pic_param_set: pps,
                    }),
                })
                .context("add mp4 video track")?;
            self.writer = Some(writer);
        }
        let writer = self.writer.as_mut().context("mp4 writer missing")?;
        writer
            .write_sample(
                1,
                &mp4::Mp4Sample {
                    start_time: at_ms,
                    duration: duration_ms.min(u32::MAX as u64) as u32,
                    rendering_offset: 0,
                    is_sync,
                    bytes: bytes::Bytes::from(sample),
                },
            )
            .context("write mp4 sample")?;
        self.frames += 1;
        Ok(())
    }

    fn finish(&mut self) -> anyhow::Result<(u32, u32, u32)> {
        if let Some(mut writer) = self.writer.take() {
            writer.write_end().context("finish mp4")?;
            let mut inner = writer.into_writer();
            inner.flush().context("flush mp4")?;
            inner.rewind().ok();
        }
        Ok((self.dims.0, self.dims.1, self.frames))
    }
}
