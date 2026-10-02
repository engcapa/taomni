//! Screen recording to GIF (`gif` crate) and MP4 (built-in OpenH264 encoder
//! + `mp4` muxer, no external tools).
//!
//! Threads: a capture thread owns the platform frame source (capture
//! backends are not `Send`) and timestamps frames; an encoder thread turns
//! them into the output file. Frames travel over a small bounded channel; a
//! frame that would block is dropped, which lengthens the previous frame's
//! display time instead of distorting the clip's duration. Unchanged frames
//! are never re-encoded: the previous frame simply lasts longer. Every frame
//! duration therefore comes from real capture timestamps, so playback speed
//! matches wall-clock time even when capture or encoding is slow.

use std::collections::HashMap;
use std::io::{BufWriter, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::Context;
use image::RgbaImage;
use tauri::{AppHandle, Emitter};

use super::capture::{DisplayInfo, FrameSource, temp_artifact_path};

/// Event emitted when a recording ends on its own (time limit or failure).
pub const RECORDING_ENDED_EVENT: &str = "screenshot://recording-ended";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordFormat {
    Gif,
    Mp4,
}

impl RecordFormat {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gif" => Ok(Self::Gif),
            "mp4" => Ok(Self::Mp4),
            other => anyhow::bail!("unsupported recording format '{other}' (gif or mp4)"),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Gif => "gif",
            Self::Mp4 => "mp4",
        }
    }

    /// Hard stop so a forgotten recording cannot fill the disk.
    fn max_duration(self) -> Duration {
        match self {
            Self::Gif => Duration::from_secs(60),
            Self::Mp4 => Duration::from_secs(300),
        }
    }

    fn default_fps(self) -> u32 {
        match self {
            Self::Gif => 10,
            Self::Mp4 => 15,
        }
    }

    /// Output width cap (GIFs balloon quickly; H.264 level limits).
    fn max_width(self) -> u32 {
        match self {
            Self::Gif => 960,
            Self::Mp4 => 1920,
        }
    }
}

/// Encoded frames in flight before the capture thread starts dropping.
const FRAME_QUEUE: usize = 4;

struct TimedFrame {
    image: RgbaImage,
    /// Milliseconds since recording start.
    at_ms: u64,
}

#[derive(Default)]
struct FrameQueue {
    previous: Option<Vec<u8>>,
    pending: Option<TimedFrame>,
}

impl FrameQueue {
    fn update(&mut self, image: RgbaImage, at_ms: u64) {
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

    fn try_flush(&mut self, tx: &SyncSender<TimedFrame>) -> anyhow::Result<()> {
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

    fn finish(&mut self, tx: &SyncSender<TimedFrame>, end_ms: u64) -> anyhow::Result<()> {
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

pub struct RecordingInfo {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub duration_ms: u64,
}

struct Session {
    stop: Arc<AtomicBool>,
    capture: Option<JoinHandle<anyhow::Result<()>>>,
    encoder: Option<JoinHandle<anyhow::Result<RecordingInfo>>>,
    output_path: PathBuf,
    _lease: RecordingLease,
}

// Includes startup and timed-out startup cleanup, not just inserted sessions.
static RECORDING_ACTIVE: AtomicBool = AtomicBool::new(false);

struct RecordingLease;

impl RecordingLease {
    fn acquire() -> anyhow::Result<Self> {
        RECORDING_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| anyhow::anyhow!("another screen recording is already active"))?;
        Ok(Self)
    }
}

impl Drop for RecordingLease {
    fn drop(&mut self) {
        RECORDING_ACTIVE.store(false, Ordering::SeqCst);
    }
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start a recording of `region` (display-relative physical pixels, `None`
/// = whole display). Returns the recording id once the capture backend is
/// ready, so backend failures surface to the caller.
pub fn start_recording(
    app: &AppHandle,
    display: DisplayInfo,
    region: Option<(u32, u32, u32, u32)>,
    format: RecordFormat,
    fps: Option<u32>,
) -> anyhow::Result<String> {
    let fps = fps.unwrap_or_else(|| format.default_fps()).clamp(1, 30);
    let region = region.unwrap_or((0, 0, display.width, display.height));
    let region = super::capture::clamp_region(display.width, display.height, region);
    if region.2 < 2 || region.3 < 2 {
        anyhow::bail!("recording region must be at least 2x2 pixels");
    }
    let lease = RecordingLease::acquire()?;
    let id = format!("rec-{}", nano_id());
    let output_path = temp_artifact_path("rec", format.extension())?;
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = sync_channel::<TimedFrame>(FRAME_QUEUE);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<anyhow::Result<()>>();

    let encoder = {
        let path = output_path.clone();
        thread::Builder::new()
            .name("screenshot-record-encode".into())
            .spawn(move || encode_loop(rx, format, fps, &path))
            .context("spawn encoder thread")?
    };
    let capture = {
        let app = app.clone();
        let stop = stop.clone();
        let id = id.clone();
        thread::Builder::new()
            .name("screenshot-record-capture".into())
            .spawn(move || {
                let result = capture_loop(&app, display, region, format, fps, &stop, tx, ready_tx);
                if !stop.load(Ordering::SeqCst) {
                    // Ended without a stop request: time limit or failure.
                    let _ = app.emit(
                        RECORDING_ENDED_EVENT,
                        serde_json::json!({
                            "recordingId": id,
                            "error": result.as_ref().err().map(|e| format!("{e:#}")),
                        }),
                    );
                }
                result
            })
    };
    let capture = match capture {
        Ok(capture) => capture,
        Err(e) => {
            // A failed spawn drops the sender, allowing the encoder to exit.
            let _ = encoder.join();
            std::fs::remove_file(&output_path).ok();
            return Err(e).context("spawn capture thread");
        }
    };

    match ready_rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            stop.store(true, Ordering::SeqCst);
            let _ = capture.join();
            let _ = encoder.join();
            std::fs::remove_file(&output_path).ok();
            return Err(e);
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            // A platform capture API may still be blocked. Reap it without
            // blocking the UI and keep the lease until both threads exit.
            thread::spawn(move || {
                let _lease = lease;
                let _ = capture.join();
                let _ = encoder.join();
                std::fs::remove_file(output_path).ok();
            });
            anyhow::bail!("screen capture did not start within 15 s");
        }
    }

    sessions().lock().unwrap().insert(
        id.clone(),
        Session {
            stop,
            capture: Some(capture),
            encoder: Some(encoder),
            output_path,
            _lease: lease,
        },
    );
    Ok(id)
}

pub(crate) fn output_path(recording_id: &str) -> Option<PathBuf> {
    sessions()
        .lock()
        .unwrap()
        .get(recording_id)
        .map(|s| s.output_path.clone())
}

/// Stop a recording and finalize the file.
pub fn stop_recording(recording_id: &str) -> anyhow::Result<RecordingInfo> {
    let mut session = sessions()
        .lock()
        .unwrap()
        .remove(recording_id)
        .context("unknown recording id")?;
    session.stop.store(true, Ordering::SeqCst);
    let capture_result = session.capture.take().map(|h| {
        h.join()
            .unwrap_or_else(|_| Err(anyhow::anyhow!("capture thread panicked")))
    });
    let info = session
        .encoder
        .take()
        .context("recording already stopped")?
        .join()
        .unwrap_or_else(|_| Err(anyhow::anyhow!("encoder thread panicked")));
    match (capture_result, info) {
        (Some(Err(capture_error)), _) => {
            std::fs::remove_file(&session.output_path).ok();
            Err(capture_error)
        }
        (_, Ok(info)) => Ok(info),
        (_, Err(e)) => {
            std::fs::remove_file(&session.output_path).ok();
            Err(e)
        }
    }
}

/// Stop a recording and delete the partial file.
pub fn cancel_recording(recording_id: &str) -> anyhow::Result<()> {
    let path = sessions()
        .lock()
        .unwrap()
        .get(recording_id)
        .map(|s| s.output_path.clone())
        .context("unknown recording id")?;
    let _ = stop_recording(recording_id);
    std::fs::remove_file(path).ok();
    Ok(())
}

/// Stop every recording (app exit / overlay teardown).
pub fn cancel_all() {
    let ids: Vec<String> = sessions().lock().unwrap().keys().cloned().collect();
    for id in ids {
        let _ = cancel_recording(&id);
    }
}

fn nano_id() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Output size for a region: even (H.264 4:2:0) and width-capped.
fn output_dims(w: u32, h: u32, max_w: u32) -> (u32, u32) {
    let (w, h) = if w > max_w {
        (
            max_w,
            ((h as f64 * max_w as f64 / w as f64).round() as u32).max(2),
        )
    } else {
        (w, h)
    };
    ((w & !1).max(2), (h & !1).max(2))
}

#[allow(clippy::too_many_arguments)]
fn capture_loop(
    app: &AppHandle,
    display: DisplayInfo,
    region: (u32, u32, u32, u32),
    format: RecordFormat,
    fps: u32,
    stop: &AtomicBool,
    tx: SyncSender<TimedFrame>,
    ready: std::sync::mpsc::Sender<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    let mut source = FrameSource::for_region(app, display, region);
    // Reuse the readiness frame; a second read can block on a static screen.
    let mut initial = match source.grab() {
        Ok(image) => Some(image),
        Err(e) => {
            let _ = ready.send(Err(e.context("start screen capture")));
            return Ok(());
        }
    };
    let _ = ready.send(Ok(()));

    let interval = Duration::from_secs_f64(1.0 / fps as f64);
    let start = source.captured_at().unwrap_or_else(Instant::now);
    let deadline = start + format.max_duration();
    let (out_w, out_h) = output_dims(region.2, region.3, format.max_width());
    let mut queue = FrameQueue::default();
    let mut failures = 0u32;

    while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
        let tick = Instant::now();
        let polled = if let Some(image) = initial.take() {
            Ok(Some(image))
        } else {
            source.poll().map(|f| f.cloned())
        };
        match polled {
            Ok(Some(mut image)) => {
                failures = 0;
                if image.dimensions() != (out_w, out_h) {
                    image = image::imageops::resize(
                        &image,
                        out_w,
                        out_h,
                        image::imageops::FilterType::Triangle,
                    );
                }
                let at_ms = if queue.previous.is_none() {
                    0
                } else {
                    source
                        .captured_at()
                        .unwrap_or_else(Instant::now)
                        .saturating_duration_since(start)
                        .as_millis() as u64
                };
                queue.update(image, at_ms);
            }
            Ok(None) => {}
            Err(e) => {
                failures += 1;
                log::warn!("screenshot recording: frame capture failed: {e:#}");
                if failures >= 20 {
                    return Err(e.context("screen capture keeps failing"));
                }
            }
        }
        queue.try_flush(&tx)?;
        let elapsed = tick.elapsed();
        if elapsed < interval {
            thread::sleep(interval - elapsed);
        }
    }
    // The end timestamp closes the last frame's duration.
    let end_ms = start.elapsed().as_millis() as u64;
    queue.finish(&tx, end_ms)
}

/// Consume frames until the end marker (a 0x0 frame) or disconnect.
fn encode_loop(
    rx: Receiver<TimedFrame>,
    format: RecordFormat,
    fps: u32,
    path: &Path,
) -> anyhow::Result<RecordingInfo> {
    let mut sink: Box<dyn FrameSink> = match format {
        RecordFormat::Gif => Box::new(GifSink::create(path)?),
        RecordFormat::Mp4 => Box::new(Mp4Sink::create(path, fps)?),
    };
    let mut pending: Option<TimedFrame> = None;
    let mut end_ms = 0u64;
    for frame in rx.iter() {
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
    Ok(RecordingInfo {
        path: path.to_path_buf(),
        width,
        height,
        frames,
        duration_ms: end_ms,
    })
}

trait FrameSink {
    /// Write one frame shown at `at_ms` for `duration_ms`.
    fn push(&mut self, image: &RgbaImage, at_ms: u64, duration_ms: u64) -> anyhow::Result<()>;
    /// Finalize; returns `(width, height, frames)`.
    fn finish(&mut self) -> anyhow::Result<(u32, u32, u32)>;
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

struct GifSink {
    file: Option<BufWriter<std::fs::File>>,
    encoder: Option<gif::Encoder<BufWriter<std::fs::File>>>,
    dims: (u32, u32),
    frames: u32,
    /// Accumulated centiseconds written vs. real elapsed ms, so rounding
    /// errors do not drift the clip length.
    written_cs: u64,
}

impl GifSink {
    fn create(path: &Path) -> anyhow::Result<Self> {
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

// ---------------------------------------------------------------------------
// MP4 (H.264 via OpenH264, muxed with the `mp4` crate)
// ---------------------------------------------------------------------------

struct Mp4Sink {
    path: PathBuf,
    fps: u32,
    encoder: Option<openh264::encoder::Encoder>,
    writer: Option<mp4::Mp4Writer<BufWriter<std::fs::File>>>,
    dims: (u32, u32),
    frames: u32,
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
    fn create(path: &Path, fps: u32) -> anyhow::Result<Self> {
        Ok(Self {
            path: path.to_path_buf(),
            fps,
            encoder: None,
            writer: None,
            dims: (0, 0),
            frames: 0,
        })
    }

    fn make_encoder(&self, w: u32, h: u32) -> anyhow::Result<openh264::encoder::Encoder> {
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

fn pixel_hash(data: &[u8]) -> u64 {
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

fn inspect_gif(
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

fn inspect_mp4(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: u32, h: u32, shift: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            let v = ((x + shift * 7) / 8 + y / 8) % 2;
            if v == 0 {
                image::Rgba([230, 40, 40, 255])
            } else {
                image::Rgba([30, 60, 220, 255])
            }
        })
    }

    fn encode(format: RecordFormat, frames: &[(RgbaImage, u64)], end_ms: u64) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "taomni-rec-test-{}.{}",
            nano_id(),
            format.extension()
        ));
        let (tx, rx) = sync_channel(frames.len() + 1);
        for (image, at_ms) in frames {
            tx.send(TimedFrame {
                image: image.clone(),
                at_ms: *at_ms,
            })
            .unwrap();
        }
        tx.send(TimedFrame {
            image: RgbaImage::new(0, 0),
            at_ms: end_ms,
        })
        .unwrap();
        let info = encode_loop(rx, format, 10, &path).unwrap();
        assert_eq!(info.frames as usize, frames.len());
        assert_eq!(info.duration_ms, end_ms);
        path
    }

    #[test]
    fn queue_retries_static_changes_without_losing_original_timestamp() {
        let (tx, rx) = sync_channel(1);
        let mut queue = FrameQueue::default();
        queue.update(frame(16, 16, 0), 0);
        queue.try_flush(&tx).unwrap();
        queue.update(frame(16, 16, 1), 120);
        queue.try_flush(&tx).unwrap(); // Queue full: changed frame must survive.
        queue.update(frame(16, 16, 1), 220); // Same capture must not reset its timestamp.
        assert_eq!(rx.recv().unwrap().at_ms, 0);
        queue.try_flush(&tx).unwrap(); // Source may idle between these retries.
        let changed = rx.recv().unwrap();
        assert_eq!(changed.at_ms, 120);
        assert_eq!(changed.image, frame(16, 16, 1));
        assert!(queue.pending.is_none());
        queue.update(frame(16, 16, 1), 300);
        queue.try_flush(&tx).unwrap();
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn queue_finishes_with_latest_change_and_discards_obsolete_change() {
        let (tx, rx) = sync_channel(4);
        let mut queue = FrameQueue::default();
        queue.update(frame(16, 16, 0), 0);
        queue.try_flush(&tx).unwrap();
        queue.update(frame(16, 16, 1), 100);
        queue.update(frame(16, 16, 0), 200); // Reverted before it was sent.
        assert!(queue.pending.is_none());
        queue.update(frame(16, 16, 2), 300);
        queue.finish(&tx, 500).unwrap();
        assert_eq!(rx.recv().unwrap().at_ms, 0);
        let last = rx.recv().unwrap();
        assert_eq!(last.image, frame(16, 16, 2));
        assert_eq!(last.at_ms, 300);
        let end = rx.recv().unwrap();
        assert_eq!(end.image.width(), 0);
        assert_eq!(end.at_ms, 500);
    }

    #[test]
    fn capture_failure_is_not_a_successful_partial_recording_and_releases_lease() {
        let lease = RecordingLease::acquire().unwrap();
        assert!(RecordingLease::acquire().is_err());
        let path = std::env::temp_dir().join(format!("taomni-failed-recording-{}.gif", nano_id()));
        std::fs::write(&path, b"partial").unwrap();
        let encoded_path = path.clone();
        let id = format!("qa-failed-{}", nano_id());
        sessions().lock().unwrap().insert(
            id.clone(),
            Session {
                stop: Arc::new(AtomicBool::new(false)),
                capture: Some(thread::spawn(|| {
                    anyhow::bail!("capture device disconnected")
                })),
                encoder: Some(thread::spawn(move || {
                    Ok(RecordingInfo {
                        path: encoded_path,
                        width: 16,
                        height: 16,
                        frames: 1,
                        duration_ms: 100,
                    })
                })),
                output_path: path.clone(),
                _lease: lease,
            },
        );
        let error = stop_recording(&id).err().unwrap().to_string();
        assert!(error.contains("capture device disconnected"));
        assert!(!path.exists());
        assert!(RecordingLease::acquire().is_ok());
    }

    #[test]
    fn gif_durations_follow_timestamps() {
        // Irregular capture times (slow encoder / dropped frames).
        let frames = vec![
            (frame(64, 48, 0), 0),
            (frame(64, 48, 1), 130),
            (frame(64, 48, 2), 170),
            (frame(64, 48, 3), 900),
        ];
        let path = encode(RecordFormat::Gif, &frames, 2000);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"GIF89a"));
        let info = inspect_clip(&path).unwrap();
        assert_eq!((info.width, info.height, info.frames), (64, 48, 4));
        assert!(
            (1990..=2030).contains(&info.duration_ms),
            "{}",
            info.duration_ms
        );
        assert_eq!(info.distinct_frames, 4);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn changing_gif_or_mp4_frames_do_not_prove_they_recorded_the_original() {
        for format in [RecordFormat::Gif, RecordFormat::Mp4] {
            let original: Vec<_> = (0..12).map(|i| frame(160, 96, i)).collect();
            let unrelated: Vec<_> = original
                .iter()
                .enumerate()
                .map(|(i, image)| {
                    let swapped = RgbaImage::from_fn(160, 96, |x, y| {
                        let p = image.get_pixel(x, y);
                        image::Rgba([p[2], p[1], p[0], 255])
                    });
                    (swapped, i as u64 * 100)
                })
                .collect();
            let path = encode(format, &unrelated, 1500);
            let mut matched = 0;
            let mut decoded = 0usize;
            let clip = inspect_clip_frames(&path, &mut |image, _| {
                if super::super::qa_oracle::compare(image, &original[decoded], true).passed {
                    matched += 1;
                }
                decoded += 1;
                Ok(())
            })
            .unwrap();
            assert_eq!(clip.frames, 12);
            assert!(clip.distinct_frames >= 4);
            assert_eq!(
                matched, 0,
                "changing {:?} pixels must still match the source",
                format
            );
            std::fs::remove_file(path).ok();
        }
    }

    #[test]
    fn mp4_roundtrip_decodes_with_real_duration() {
        let frames: Vec<_> = (0..12)
            .map(|i| (frame(160, 96, i), i as u64 * 100))
            .collect();
        let path = encode(RecordFormat::Mp4, &frames, 1500);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[4..8], b"ftyp");
        let info = inspect_clip(&path).unwrap();
        assert_eq!((info.width, info.height, info.frames), (160, 96, 12));
        assert!(
            (1450..=1550).contains(&info.duration_ms),
            "{}",
            info.duration_ms
        );
        assert!(info.distinct_frames >= 6, "{}", info.distinct_frames);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn annex_b_splitting_handles_3_and_4_byte_start_codes() {
        let data = [
            0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 9,
        ];
        let nals = annex_b_nals(&data);
        assert_eq!(
            nals,
            vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 9][..]]
        );
    }

    #[test]
    fn output_dims_are_even_and_capped() {
        assert_eq!(output_dims(1921, 1081, 1920), (1920, 1080));
        assert_eq!(output_dims(3840, 2160, 960), (960, 540));
        assert_eq!(output_dims(301, 201, 960), (300, 200));
    }

    #[test]
    fn record_format_parsing() {
        assert_eq!(RecordFormat::parse("gif").unwrap(), RecordFormat::Gif);
        assert_eq!(RecordFormat::parse("MP4").unwrap(), RecordFormat::Mp4);
        assert!(RecordFormat::parse("avi").is_err());
    }
}
