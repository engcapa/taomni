// PTT capture state machine.
//
// Holds an in-process buffer of mono 16-kHz f32 PCM samples. cpal devices
// often deliver float samples at the device's native sample rate (typically
// 44.1 / 48 kHz); we resample to 16 kHz before pushing to the buffer using
// a simple linear interpolator (good enough for ASR; see voice-input-plan.md
// for the rationale on not pulling in rubato yet).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use std::sync::{Arc, Mutex, OnceLock};

const TARGET_SAMPLE_RATE: u32 = 16_000;

struct CaptureSession {
    /// Active cpal stream (held alive while the user is pressing PTT).
    /// Boxed because Stream is !Send on some hosts but we only ever touch it
    /// behind the Mutex from the Tauri command thread.
    _stream: Stream,
    pcm: Arc<Mutex<Vec<f32>>>,
}

unsafe impl Send for CaptureSession {}
unsafe impl Sync for CaptureSession {}

fn current() -> &'static Mutex<Option<CaptureSession>> {
    static INSTANCE: OnceLock<Mutex<Option<CaptureSession>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(None))
}

/// Start capturing from the system default microphone.
/// Returns the device sample rate so the frontend can show it (debug).
pub fn start() -> Result<u32, String> {
    let mut guard = current().lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Capture already in progress".into());
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No input device available")?;

    let supported = device
        .default_input_config()
        .map_err(|e| format!("default_input_config: {e}"))?;
    let device_sr = supported.sample_rate().0;
    let channels = supported.channels();

    let config: StreamConfig = supported.clone().into();
    let pcm: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::with_capacity(TARGET_SAMPLE_RATE as usize * 30)));

    let pcm_capture = pcm.clone();
    let mut downsample_acc: f64 = 0.0;
    let downsample_step: f64 = device_sr as f64 / TARGET_SAMPLE_RATE as f64;

    let err_fn = |e| tracing::warn!(?e, "cpal stream error");

    let stream = match supported.sample_format() {
        SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| {
                push_resampled(data, channels, &mut downsample_acc, downsample_step, &pcm_capture);
            },
            err_fn,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| {
                let buf: Vec<f32> = data.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
                push_resampled(&buf, channels, &mut downsample_acc, downsample_step, &pcm_capture);
            },
            err_fn,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _| {
                let buf: Vec<f32> = data
                    .iter()
                    .map(|s| (*s as f32 - 32768.0) / 32768.0)
                    .collect();
                push_resampled(&buf, channels, &mut downsample_acc, downsample_step, &pcm_capture);
            },
            err_fn,
            None,
        ),
        other => return Err(format!("Unsupported sample format: {other:?}")),
    }
    .map_err(|e| format!("build_input_stream: {e}"))?;

    stream.play().map_err(|e| format!("stream.play: {e}"))?;

    *guard = Some(CaptureSession { _stream: stream, pcm });
    Ok(device_sr)
}

/// Stop the current capture session and return the captured 16 kHz mono PCM.
pub fn stop() -> Result<Vec<f32>, String> {
    let mut guard = current().lock().map_err(|e| e.to_string())?;
    let session = guard.take().ok_or("No capture in progress")?;
    let pcm = std::mem::take(&mut *session.pcm.lock().unwrap());
    drop(session);
    Ok(pcm)
}

/// Linear-interpolation downsample + channel mixdown to mono.
fn push_resampled(
    input: &[f32],
    channels: u16,
    acc: &mut f64,
    step: f64,
    out: &Arc<Mutex<Vec<f32>>>,
) {
    let frames = input.len() / channels as usize;
    let mut mixed = Vec::with_capacity(frames);
    if channels == 1 {
        mixed.extend_from_slice(input);
    } else {
        for f in 0..frames {
            let mut s = 0.0;
            for c in 0..channels as usize {
                s += input[f * channels as usize + c];
            }
            mixed.push(s / channels as f32);
        }
    }

    let mut buf = out.lock().unwrap();
    for (i, sample) in mixed.iter().enumerate() {
        if (*acc - i as f64).abs() < 0.5 || *acc <= i as f64 {
            buf.push(*sample);
            *acc += step;
        }
    }
    // Compensate when acc has drifted past the buffer boundary.
    if *acc >= mixed.len() as f64 {
        *acc -= mixed.len() as f64;
    }
}
