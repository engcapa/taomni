use anyhow::Context;
use image::RgbaImage;
use std::path::Path;

// ---------------------------------------------------------------------------
// Inspection (QA verification and tests)
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    pub format: &'static str,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub duration_ms: u64,
    /// Distinct decoded pixel hashes; a structural check, not source-content proof.
    pub distinct_frames: u32,
}

pub(super) fn pixel_hash(data: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
}

/// Decode a recorded GIF/MP4 and summarize it.
pub fn inspect_clip(path: &Path) -> anyhow::Result<ClipInfo> {
    inspect_clip_frames(path, &mut |_, _| Ok(()))
}

pub(crate) fn inspect_clip_frames(
    path: &Path,
    observe: &mut dyn FnMut(&RgbaImage, u64) -> anyhow::Result<()>,
) -> anyhow::Result<ClipInfo> {
    let is_mp4 = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    if is_mp4 {
        inspect_mp4(path, observe)
    } else {
        inspect_gif(path, observe)
    }
}

pub(super) fn inspect_gif(
    path: &Path,
    observe: &mut dyn FnMut(&RgbaImage, u64) -> anyhow::Result<()>,
) -> anyhow::Result<ClipInfo> {
    let file = std::fs::File::open(path).context("open gif")?;
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::RGBA);
    let mut decoder = options.read_info(file).context("read gif header")?;
    let (width, height) = (decoder.width() as u32, decoder.height() as u32);
    let mut frames = 0u32;
    let mut delay_cs = 0u64;
    let mut hashes = std::collections::HashSet::new();
    while let Some(frame) = decoder.read_next_frame().context("read gif frame")? {
        if frame.left != 0
            || frame.top != 0
            || u32::from(frame.width) != width
            || u32::from(frame.height) != height
        {
            anyhow::bail!("recorded GIF frame does not cover its canvas");
        }
        let image = RgbaImage::from_raw(width, height, frame.buffer.to_vec())
            .context("GIF decoded pixel dimensions")?;
        observe(&image, delay_cs * 10)?;
        frames += 1;
        delay_cs += frame.delay as u64;
        hashes.insert(pixel_hash(&frame.buffer));
    }
    Ok(ClipInfo {
        format: "gif",
        width,
        height,
        frames,
        duration_ms: delay_cs * 10,
        distinct_frames: hashes.len() as u32,
    })
}

pub(super) fn inspect_mp4(
    path: &Path,
    observe: &mut dyn FnMut(&RgbaImage, u64) -> anyhow::Result<()>,
) -> anyhow::Result<ClipInfo> {
    let file = std::fs::File::open(path).context("open mp4")?;
    let size = file.metadata().context("stat mp4")?.len();
    let mut reader =
        mp4::Mp4Reader::read_header(std::io::BufReader::new(file), size).context("read mp4")?;
    let (track_id, width, height, sps, pps, count) = {
        let (id, track) = reader
            .tracks()
            .iter()
            .find(|(_, t)| matches!(t.media_type(), Ok(mp4::MediaType::H264)))
            .context("mp4 has no H.264 track")?;
        (
            *id,
            track.width() as u32,
            track.height() as u32,
            track.sequence_parameter_set().context("sps")?.to_vec(),
            track.picture_parameter_set().context("pps")?.to_vec(),
            track.sample_count(),
        )
    };
    let duration_ms = reader.duration().as_millis() as u64;
    let mut decoder =
        openh264::decoder::Decoder::new().map_err(|e| anyhow::anyhow!("init decoder: {e}"))?;
    let start_code = [0u8, 0, 0, 1];
    let mut prefix = Vec::new();
    prefix.extend_from_slice(&start_code);
    prefix.extend_from_slice(&sps);
    prefix.extend_from_slice(&start_code);
    prefix.extend_from_slice(&pps);
    let _ = decoder.decode(&prefix);
    let mut hashes = std::collections::HashSet::new();
    let mut decoded = 0u32;
    for sample_id in 1..=count {
        let Some(sample) = reader
            .read_sample(track_id, sample_id)
            .context("read sample")?
        else {
            continue;
        };
        // AVCC length-prefixed -> Annex-B.
        let mut annex_b = Vec::with_capacity(sample.bytes.len() + 8);
        let bytes = &sample.bytes[..];
        let mut i = 0;
        while i + 4 <= bytes.len() {
            let len =
                u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
            i += 4;
            let end = i
                .checked_add(len)
                .filter(|end| *end <= bytes.len())
                .context("truncated AVCC sample")?;
            annex_b.extend_from_slice(&start_code);
            annex_b.extend_from_slice(&bytes[i..end]);
            i = end;
        }
        if i != bytes.len() || annex_b.is_empty() {
            anyhow::bail!("H264 sample {sample_id} has incomplete AVCC data");
        }
        if let Some(yuv) = decoder
            .decode(&annex_b)
            .map_err(|e| anyhow::anyhow!("decode H264 sample {sample_id}: {e}"))?
        {
            use openh264::formats::YUVSource;
            let (w, h) = yuv.dimensions();
            let mut rgb = vec![0u8; w * h * 3];
            yuv.write_rgb8(&mut rgb);
            let mut rgba = Vec::with_capacity(w * h * 4);
            for pixel in rgb.chunks_exact(3) {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
            let image =
                RgbaImage::from_raw(w as u32, h as u32, rgba).context("H264 decoded pixels")?;
            observe(&image, sample.start_time)?;
            // Coarse hash: H.264 noise must not make static frames "distinct".
            let coarse: Vec<u8> = rgb.iter().step_by(97).map(|v| v >> 4).collect();
            hashes.insert(pixel_hash(&coarse));
            decoded += 1;
        }
    }
    if decoded != count {
        anyhow::bail!("only {decoded}/{count} MP4 samples decoded");
    }
    Ok(ClipInfo {
        format: "mp4",
        width,
        height,
        frames: count,
        duration_ms,
        distinct_frames: hashes.len() as u32,
    })
}
