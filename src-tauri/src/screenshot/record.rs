//! Screen recording to GIF (pure Rust, `gif` crate) and MP4 (piped through a
//! system `ffmpeg` when one is on PATH).
//!
//! A recording runs on its own OS thread: capture backends are not `Send`
//! (see `servers::rdp::capture`), and `Enigo` is not `Send` on macOS either.
//! `start_recording` returns immediately with an id; `stop_recording`
//! finalizes the file. Bounds (fps, duration, GIF width) keep files sane.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::Context;
use image::{GenericImageView, RgbaImage};
use serde::Serialize;

use super::capture::{ScreenshotFile, capture_region_image, list_displays, temp_artifact_path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordFormat {
    Gif,
    Mp4,
}

impl RecordFormat {
    fn parse(value: &str) -> anyhow::Result<Self> {
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
            Self::Mp4 => Duration::from_secs(180),
        }
    }

    fn default_fps(self) -> u32 {
        match self {
            Self::Gif => 10,
            Self::Mp4 => 15,
        }
    }
}

/// GIFs are downscaled to this width; full-res GIFs balloon quickly.
const GIF_MAX_WIDTH: u32 = 960;

pub struct RecordingParams {
    pub display_id: Option<String>,
    pub region: Option<(u32, u32, u32, u32)>,
    pub format: RecordFormat,
    pub fps: u32,
}

enum SessionOutcome {
    Done {
        width: u32,
        height: u32,
        frames: u32,
    },
    Failed(String),
}

struct Session {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<SessionOutcome>>,
    output_path: PathBuf,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether `ffmpeg` resolves on PATH. MP4 recording needs it.
pub fn ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Start a recording; returns the recording id immediately.
pub fn start_recording(
    app: &tauri::AppHandle,
    display_id: Option<String>,
    region: Option<(u32, u32, u32, u32)>,
    format: &str,
    fps: Option<u32>,
) -> anyhow::Result<String> {
    start_recording_with_overlay(app, display_id, region, format, fps, false)
}

/// Start a recording, with optional test overlay (moving red dot drawn on
/// each frame for visual verification in CI artifacts).
pub fn start_recording_with_overlay(
    app: &tauri::AppHandle,
    display_id: Option<String>,
    region: Option<(u32, u32, u32, u32)>,
    format: &str,
    fps: Option<u32>,
    test_overlay: bool,
) -> anyhow::Result<String> {
    let format = RecordFormat::parse(format)?;
    if format == RecordFormat::Mp4 && !ffmpeg_available() {
        anyhow::bail!(
            "ffmpeg was not found on PATH, so MP4 recording is unavailable. \
             Install ffmpeg or record as GIF instead."
        );
    }
    let fps = fps.unwrap_or_else(|| format.default_fps()).clamp(1, 30);

    let (rx, ry, rw, rh) = match region {
        Some(r) => r,
        None => {
            let displays = list_displays(app)?;
            let d = pick_display(&displays, display_id.as_deref())?;
            (0, 0, d.width, d.height)
        }
    };
    if rw == 0 || rh == 0 {
        anyhow::bail!("recording region must not be empty");
    }

    let output_path = temp_artifact_path("rec", format.extension())?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let app = app.clone();
    let display_id = display_id.clone();

    let handle = {
        let thread_output = output_path.clone();
        thread::spawn(move || {
            run_capture_loop(
                &app,
                display_id.as_deref(),
                (rx, ry, rw, rh),
                format,
                fps,
                &thread_output,
                &stop_flag,
                test_overlay,
            )
        })
    };

    let id = format!("rec-{}-{}", std::process::id(), nano_id());
    sessions().lock().unwrap().insert(
        id.clone(),
        Session {
            stop,
            handle: Some(handle),
            output_path,
        },
    );
    Ok(id)
}

/// Stop a recording and finalize the file.
pub fn stop_recording(recording_id: &str) -> anyhow::Result<ScreenshotFile> {
    let mut session = sessions()
        .lock()
        .unwrap()
        .remove(recording_id)
        .context("unknown recording id")?;
    session.stop.store(true, Ordering::SeqCst);
    let handle = session.handle.take().context("recording already stopped")?;
    match handle.join() {
        Ok(SessionOutcome::Done {
            width,
            height,
            frames,
        }) => {
            if frames == 0 {
                anyhow::bail!("no frames were captured")
            }
            Ok(ScreenshotFile {
                path: session.output_path.to_string_lossy().into_owned(),
                width,
                height,
            })
        }
        Ok(SessionOutcome::Failed(e)) => Err(anyhow::anyhow!(e)),
        Err(_) => anyhow::bail!("recording thread panicked"),
    }
}

/// Stop a recording and delete the partial file.
pub fn cancel_recording(recording_id: &str) -> anyhow::Result<()> {
    let mut session = sessions()
        .lock()
        .unwrap()
        .remove(recording_id)
        .context("unknown recording id")?;
    session.stop.store(true, Ordering::SeqCst);
    if let Some(handle) = session.handle.take() {
        let _ = handle.join();
    }
    std::fs::remove_file(&session.output_path).ok();
    Ok(())
}

fn nano_id() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn pick_display(
    displays: &[super::capture::DisplayInfo],
    display_id: Option<&str>,
) -> anyhow::Result<super::capture::DisplayInfo> {
    if let Some(want) = display_id.filter(|v| !v.trim().is_empty()) {
        if let Some(d) = displays.iter().find(|d| d.id == want) {
            return Ok(d.clone());
        }
        anyhow::bail!("display '{want}' is no longer available")
    }
    displays
        .iter()
        .find(|d| d.primary)
        .or_else(|| displays.first())
        .cloned()
        .context("no active displays found")
}

fn run_capture_loop(
    app: &tauri::AppHandle,
    display_id: Option<&str>,
    region: (u32, u32, u32, u32),
    format: RecordFormat,
    fps: u32,
    output_path: &PathBuf,
    stop: &AtomicBool,
    test_overlay: bool,
) -> SessionOutcome {
    match capture_loop(
        app,
        display_id,
        region,
        format,
        fps,
        output_path,
        stop,
        test_overlay,
    ) {
        Ok(outcome) => outcome,
        Err(e) => SessionOutcome::Failed(format!("{e:#}")),
    }
}

fn capture_loop(
    app: &tauri::AppHandle,
    display_id: Option<&str>,
    region: (u32, u32, u32, u32),
    format: RecordFormat,
    fps: u32,
    output_path: &PathBuf,
    stop: &AtomicBool,
    test_overlay: bool,
) -> anyhow::Result<SessionOutcome> {
    let (x, y, w, h) = region;
    let frame_interval = Duration::from_secs_f64(1.0 / fps as f64);
    let deadline = Instant::now() + format.max_duration();

    let mut sink: FrameSink = match format {
        RecordFormat::Gif => FrameSink::gif(output_path, fps)?,
        RecordFormat::Mp4 => FrameSink::mp4(output_path, w, h, fps)?,
    };

    let mut frames = 0u32;
    let (mut out_w, mut out_h) = (0u32, 0u32);
    while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
        let tick = Instant::now();
        match capture_region_image(app, display_id, x, y, w, h) {
            Ok(mut frame) => {
                // Test overlay: draw a moving red dot for visual verification.
                if test_overlay {
                    let t = frames as f32 / fps as f32;
                    // Move in a circle: center (w/2, h/2), radius min(w,h)/3
                    let cx = w as f32 / 2.0;
                    let cy = h as f32 / 2.0;
                    let r = (w.min(h) as f32 / 3.0).max(20.0);
                    let dot_x = (cx + r * (t * 2.0).cos()) as u32;
                    let dot_y = (cy + r * (t * 2.0).sin()) as u32;
                    // Draw 8x8 red square
                    let rgb = frame.to_rgb8();
                    let mut rgb = rgb;
                    for ox in 0..8 {
                        for oy in 0..8 {
                            let px = dot_x.saturating_sub(4) + ox;
                            let py = dot_y.saturating_sub(4) + oy;
                            if px < w && py < h {
                                rgb.put_pixel(px, py, image::Rgb([255, 0, 0]));
                            }
                        }
                    }
                    frame = image::DynamicImage::ImageRgb8(rgb);
                }
                let (fw, fh) = sink.push(frame)?;
                out_w = fw;
                out_h = fh;
                frames += 1;
            }
            Err(e) => {
                // A transient capture failure should not kill the recording;
                // a persistently broken backend surfaces at stop time via the
                // zero-frame guard.
                log::warn!("screenshot recording: frame capture failed: {e:#}");
            }
        }
        let elapsed = tick.elapsed();
        if elapsed < frame_interval {
            thread::sleep(frame_interval - elapsed);
        }
    }
    sink.finish()?;
    Ok(SessionOutcome::Done {
        width: out_w,
        height: out_h,
        frames,
    })
}

/// Incremental frame consumer: GIF encoder or ffmpeg stdin pipe.
enum FrameSink {
    Gif {
        /// Created on the first frame, once dimensions are known.
        file: Option<std::fs::File>,
        encoder: Option<gif::Encoder<std::fs::File>>,
        delay_cs: u16,
    },
    Mp4 {
        child: Child,
        width: u32,
        height: u32,
    },
}

impl FrameSink {
    fn gif(path: &PathBuf, fps: u32) -> anyhow::Result<Self> {
        let file = std::fs::File::create(path).context("create gif file")?;
        Ok(Self::Gif {
            file: Some(file),
            encoder: None,
            delay_cs: (100 / fps.max(1)) as u16,
        })
    }

    fn mp4(path: &PathBuf, width: u32, height: u32, fps: u32) -> anyhow::Result<Self> {
        // yuv420p needs even dimensions.
        let width = width & !1;
        let height = height & !1;
        if width < 2 || height < 2 {
            anyhow::bail!("recording region is too small for mp4");
        }
        let child = Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-s",
                &format!("{width}x{height}"),
                "-framerate",
                &fps.to_string(),
                "-i",
                "pipe:0",
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                &path.to_string_lossy(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("spawn ffmpeg")?;
        Ok(Self::Mp4 {
            child,
            width,
            height,
        })
    }

    /// Push one frame; returns the output dimensions.
    fn push(&mut self, frame: RgbaImage) -> anyhow::Result<(u32, u32)> {
        match self {
            Self::Gif {
                file,
                encoder,
                delay_cs,
            } => {
                let (w, h) = frame.dimensions();
                let (sw, sh) = downscaled_dims(w, h, GIF_MAX_WIDTH);
                let small = if (sw, sh) == (w, h) {
                    frame
                } else {
                    image::imageops::resize(&frame, sw, sh, image::imageops::FilterType::Triangle)
                };
                let (w16, h16) = (small.width() as u16, small.height() as u16);
                if encoder.is_none() {
                    let f = file.take().context("gif file already consumed")?;
                    let mut enc =
                        gif::Encoder::new(f, w16, h16, &[]).context("init gif encoder")?;
                    enc.set_repeat(gif::Repeat::Infinite).ok();
                    *encoder = Some(enc);
                }
                let encoder = encoder.as_mut().context("gif encoder missing")?;
                let mut rgba = small.into_raw();
                let mut gif_frame = gif::Frame::from_rgba_speed(w16, h16, &mut rgba, 10);
                gif_frame.delay = *delay_cs;
                encoder.write_frame(&gif_frame).context("write gif frame")?;
                Ok((w16 as u32, h16 as u32))
            }
            Self::Mp4 {
                child,
                width,
                height,
            } => {
                let frame = if frame.dimensions() == (*width, *height) {
                    frame
                } else {
                    // Crop to even dimensions (top-left anchored).
                    frame.view(0, 0, *width, *height).to_image()
                };
                let stdin = child.stdin.as_mut().context("ffmpeg stdin closed")?;
                stdin
                    .write_all(&frame.into_raw())
                    .context("write frame to ffmpeg")?;
                Ok((*width, *height))
            }
        }
    }

    fn finish(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Gif { encoder, .. } => {
                // Dropping the encoder writes the GIF trailer.
                *encoder = None;
                Ok(())
            }
            Self::Mp4 { child, .. } => {
                drop(child.stdin.take());
                let status = child.wait().context("wait for ffmpeg")?;
                if !status.success() {
                    anyhow::bail!("ffmpeg exited with {status}");
                }
                Ok(())
            }
        }
    }
}

fn downscaled_dims(w: u32, h: u32, max_w: u32) -> (u32, u32) {
    if w <= max_w {
        return (w, h);
    }
    let sh = ((h as f64 * max_w as f64 / w as f64).round() as u32).max(1);
    (max_w, sh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gif_encoder_roundtrip_on_synthetic_frames() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("taomni-gif-test-{}.gif", nano_id()));
        let file = std::fs::File::create(&path).unwrap();
        let mut encoder = gif::Encoder::new(file, 4, 4, &[]).unwrap();
        encoder.set_repeat(gif::Repeat::Infinite).unwrap();
        for shade in [0u8, 128, 255] {
            let mut rgba = vec![0u8; 4 * 4 * 4];
            for px in rgba.chunks_exact_mut(4) {
                px[0] = shade;
                px[1] = shade;
                px[2] = shade;
                px[3] = 255;
            }
            let mut frame = gif::Frame::from_rgba_speed(4, 4, &mut rgba, 10);
            frame.delay = 10;
            encoder.write_frame(&frame).unwrap();
        }
        drop(encoder);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"GIF89a"), "expected a GIF file");
        assert!(bytes.len() > 64, "expected multiple frames encoded");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn record_format_parsing() {
        assert_eq!(RecordFormat::parse("gif").unwrap(), RecordFormat::Gif);
        assert_eq!(RecordFormat::parse("MP4").unwrap(), RecordFormat::Mp4);
        assert!(RecordFormat::parse("avi").is_err());
    }

    #[test]
    fn downscale_keeps_aspect() {
        assert_eq!(downscaled_dims(1920, 1080, 960), (960, 540));
        assert_eq!(downscaled_dims(800, 600, 960), (800, 600));
    }
}
