//! A dedicated thread creates, stops and drops cpal streams on the same thread.
//! No unsafe Send/Sync overrides; callbacks only copy bounded mono samples.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
pub const MAX_SECONDS: usize = 120;
pub struct Capture {
    pub stop: mpsc::Sender<()>,
    pub result: tokio::sync::oneshot::Receiver<Result<Vec<f32>, String>>,
    /// Source-rate chunks emitted approximately every 100 ms. The batch
    /// result remains available for the legacy Whisper path; realtime engines
    /// consume this channel while recording is still active.
    pub chunks: Arc<Mutex<Option<tokio::sync::mpsc::Receiver<Vec<f32>>>>>,
}
pub async fn start(streaming: bool) -> Result<Capture, String> {
    let (stop, rx) = mpsc::channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (result_tx, result) = tokio::sync::oneshot::channel();
    let (chunk_tx, chunk_rx) = tokio::sync::mpsc::channel(32);
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
                    let deadline =
                        std::time::Instant::now() + Duration::from_secs(MAX_SECONDS as u64);
                    let mut cursor = 0usize;
                    let mut realtime_resampler = StreamingResampler::new(sr);
                    loop {
                        match rx.recv_timeout(Duration::from_millis(100)) {
                            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                let snapshot = buffer.lock().unwrap();
                                if streaming && snapshot.len() > cursor {
                                    let chunk = realtime_resampler.push(&snapshot[cursor..]);
                                    cursor = snapshot.len();
                                    if !chunk.is_empty() && chunk_tx.blocking_send(chunk).is_err() {
                                        break;
                                    }
                                }
                                if std::time::Instant::now() >= deadline {
                                    break;
                                }
                            }
                        }
                    }
                    drop(stream);
                    let pcm = std::mem::take(&mut *buffer.lock().unwrap());
                    if streaming && pcm.len() > cursor {
                        let chunk = realtime_resampler.push(&pcm[cursor..]);
                        if !chunk.is_empty() {
                            let _ = chunk_tx.blocking_send(chunk);
                        }
                    }
                    let tail = realtime_resampler.finish(pcm.len());
                    if streaming && !tail.is_empty() {
                        let _ = chunk_tx.blocking_send(tail);
                    }
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
    Ok(Capture {
        stop,
        result,
        chunks: Arc::new(Mutex::new(Some(chunk_rx))),
    })
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

struct StreamingResampler {
    sr: u32,
    input: Vec<f32>,
    next_output: usize,
    ratio: f64,
    cutoff: f64,
    radius: i64,
}
impl StreamingResampler {
    fn new(sr: u32) -> Self {
        let ratio = sr as f64 / 16_000.0;
        let cutoff = (1.0 / ratio).min(1.0) * 0.9;
        let radius = (32.0 / cutoff).ceil() as i64;
        Self {
            sr,
            input: Vec::new(),
            next_output: 0,
            ratio,
            cutoff,
            radius,
        }
    }
    fn sample(&self, n: usize) -> f32 {
        if self.sr == 16_000 {
            return self.input.get(n).copied().unwrap_or_default();
        }
        let t = n as f64 * self.ratio;
        let center = t.floor() as i64;
        let mut sum = 0.0;
        let mut weight = 0.0;
        for i in center - self.radius..=center + self.radius {
            if i < 0 || i >= self.input.len() as i64 {
                continue;
            }
            let d = t - i as f64;
            let x = std::f64::consts::PI * d * self.cutoff;
            let sinc = if x.abs() < 1e-9 { 1.0 } else { x.sin() / x };
            let window = 0.5 + 0.5 * (std::f64::consts::PI * d / self.radius as f64).cos();
            let w = sinc * window;
            sum += self.input[i as usize] as f64 * w;
            weight += w;
        }
        (sum / weight.max(1e-9)) as f32
    }
    fn push(&mut self, chunk: &[f32]) -> Vec<f32> {
        self.input.extend_from_slice(chunk);
        let mut output = Vec::new();
        while self.next_output as f64 * self.ratio + (self.radius as f64) < self.input.len() as f64
        {
            output.push(self.sample(self.next_output));
            self.next_output += 1;
        }
        output
    }
    fn finish(&mut self, input_len: usize) -> Vec<f32> {
        let count = (input_len as f64 / self.ratio).round() as usize;
        let mut output = Vec::new();
        while self.next_output < count {
            output.push(self.sample(self.next_output));
            self.next_output += 1;
        }
        output
    }
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
    #[test]
    fn streaming_resampler_matches_batch_length() {
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.01).sin()).collect();
        let mut streaming = StreamingResampler::new(48_000);
        let mut output = Vec::new();
        for chunk in input.chunks(1_600) {
            output.extend(streaming.push(chunk));
        }
        output.extend(streaming.finish(input.len()));
        assert_eq!(output.len(), 16_000);
    }
}
