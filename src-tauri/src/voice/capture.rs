//! A dedicated thread creates, stops and drops cpal streams on the same thread.
//! No unsafe Send/Sync overrides; callbacks only copy bounded mono samples.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
pub const MAX_SECONDS: usize = 120;
pub struct Capture {
    pub stop: mpsc::Sender<()>,
    pub result: tokio::sync::oneshot::Receiver<Result<Vec<f32>, String>>,
}
pub async fn start() -> Result<Capture, String> {
    let (stop, rx) = mpsc::channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (result_tx, result) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("voice-capture".into())
        .spawn(move || {
            let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
            let error = Arc::new(Mutex::new(None::<String>));
            let capture = open(buffer.clone(), error.clone());
            match capture {
                Ok((stream, sr)) => {
                    if ready_tx.send(Ok(())).is_err() {
                        return;
                    }
                    let _ = rx.recv_timeout(Duration::from_secs(MAX_SECONDS as u64));
                    drop(stream);
                    let pcm = std::mem::take(&mut *buffer.lock().unwrap());
                    let result = if let Some(e) = error.lock().unwrap().take() {
                        Err(e)
                    } else {
                        resample(&pcm, sr)
                    };
                    let _ = result_tx.send(result);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    ready_rx.await.map_err(|e| e.to_string())??;
    Ok(Capture { stop, result })
}
fn open(
    pcm: Arc<Mutex<Vec<f32>>>,
    error: Arc<Mutex<Option<String>>>,
) -> Result<(cpal::Stream, u32), String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or("MIC_MISSING: No microphone available")?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("MIC_CONFIG: {e}"))?;
    let sr = supported.sample_rate();
    let channels = supported.channels() as usize;
    if channels == 0 || !(8000..=192000).contains(&sr) {
        return Err("Unsupported microphone format".into());
    }
    // Allocate before the realtime callback and impose a hard memory ceiling.
    *pcm.lock().unwrap() = Vec::with_capacity(sr as usize * MAX_SECONDS);
    let config = supported.clone().into();
    let err_fn = move |e| {
        *error.lock().unwrap() = Some(format!("MIC_STREAM: {e}"));
    };
    macro_rules! stream {
        ($ty:ty, $convert:expr) => {{
            device.build_input_stream(
                &config,
                move |data: &[$ty], _| {
                    if let Ok(mut buffer) = pcm.lock() {
                        for frame in data.chunks_exact(channels) {
                            if buffer.len() >= sr as usize * MAX_SECONDS {
                                break;
                            }
                            let sample = frame.iter().map($convert).sum::<f32>() / channels as f32;
                            buffer.push(if sample.is_finite() {
                                sample.clamp(-1.0, 1.0)
                            } else {
                                0.0
                            });
                        }
                    }
                },
                err_fn,
                None,
            )
        }};
    }
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => stream!(f32, |s: &f32| *s),
        cpal::SampleFormat::I16 => stream!(i16, |s: &i16| *s as f32 / 32768.0),
        cpal::SampleFormat::U16 => stream!(u16, |s: &u16| (*s as f32 - 32768.0) / 32768.0),
        format => return Err(format!("Unsupported microphone format: {format:?}")),
    }
    .map_err(|e| format!("MIC_PERMISSION_OR_DEVICE: {e}"))?;
    stream.play().map_err(|e| format!("MIC_START: {e}"))?;
    Ok((stream, sr))
}
/// Windowed-sinc conversion after capture, including anti-aliasing for downsampling.
/// Offline PTT avoids running allocation/resampling on the device callback.
pub fn resample(input: &[f32], sr: u32) -> Result<Vec<f32>, String> {
    if sr == 0 {
        return Err("Invalid sample rate".into());
    }
    if sr == 16000 {
        return Ok(input.to_vec());
    }
    let ratio = sr as f64 / 16000.0;
    let cutoff = (1.0 / ratio).min(1.0) * 0.9;
    let radius = (32.0 / cutoff).ceil() as i64;
    let count = (input.len() as f64 / ratio).round() as usize;
    let mut output = Vec::with_capacity(count);
    for n in 0..count {
        let t = n as f64 * ratio;
        let center = t.floor() as i64;
        let mut sum = 0.0;
        let mut weight = 0.0;
        for i in center - radius..=center + radius {
            if i < 0 || i >= input.len() as i64 {
                continue;
            }
            let d = t - i as f64;
            let x = std::f64::consts::PI * d * cutoff;
            let sinc = if x.abs() < 1e-9 { 1.0 } else { x.sin() / x };
            let window = 0.5 + 0.5 * (std::f64::consts::PI * d / radius as f64).cos();
            let w = sinc * window;
            sum += input[i as usize] as f64 * w;
            weight += w;
        }
        output.push((sum / weight.max(1e-9)) as f32);
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resampler_preserves_duration_and_rejects_aliasing() {
        for sr in [8000, 16000, 44100, 48000] {
            let tone: Vec<f32> = (0..sr)
                .map(|i| (i as f32 * 1000.0 * std::f32::consts::TAU / sr as f32).sin())
                .collect();
            let out = resample(&tone, sr).unwrap();
            assert_eq!(out.len(), 16000);
            let rms = (out[100..15900].iter().map(|v| v * v).sum::<f32>() / 15800.0).sqrt();
            assert!((rms - 0.707).abs() < 0.02, "{sr}: {rms}");
        }
        let high: Vec<f32> = (0..48000)
            .map(|i| (i as f32 * 12000.0 * std::f32::consts::TAU / 48000.0).sin())
            .collect();
        let out = resample(&high, 48000).unwrap();
        let rms = (out[100..15900].iter().map(|v| v * v).sum::<f32>() / 15800.0).sqrt();
        assert!(rms < 0.01, "Aliased energy: {rms}");
    }
}
