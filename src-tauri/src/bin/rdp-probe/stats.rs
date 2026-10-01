//! Small numeric helpers: percentiles and tone analysis.

use serde_json::{Value, json};

/// Nearest-rank percentile of an unsorted sample set (`p` in 0..=100).
pub(crate) fn percentile(samples: &[f64], p: f64) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let rank = ((p / 100.0) * sorted.len() as f64).ceil().max(1.0) as usize;
    Some(sorted[rank.min(sorted.len()) - 1])
}

pub(crate) fn summary(samples: &[f64]) -> Value {
    let mean = if samples.is_empty() {
        None
    } else {
        Some(samples.iter().sum::<f64>() / samples.len() as f64)
    };
    json!({
        "count": samples.len(),
        "p50": percentile(samples, 50.0),
        "p95": percentile(samples, 95.0),
        "max": samples.iter().copied().reduce(f64::max),
        "min": samples.iter().copied().reduce(f64::min),
        "mean": mean,
    })
}

/// Goertzel power of `freq` in `samples` (mono, normalized to -1..1).
fn goertzel(samples: &[f32], rate: f64, freq: f64) -> f64 {
    let omega = 2.0 * std::f64::consts::PI * freq / rate;
    let coeff = 2.0 * omega.cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for &x in samples {
        let s0 = f64::from(x) + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    s1 * s1 + s2 * s2 - coeff * s1 * s2
}

fn hann(samples: &[f32]) -> Vec<f32> {
    let n = samples.len().max(2) as f32;
    samples
        .iter()
        .enumerate()
        .map(|(i, s)| s * (0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1.0)).cos()))
        .collect()
}

/// Dominant frequency between 50 Hz and 5 kHz.
///
/// A rectangular one-second window has exact nulls at every integer-Hz
/// offset, so a coarse grid can step straight over the tone. Scan instead
/// with a short Hann window (main lobe ≈ 4·rate/N wide) and refine the peak
/// with a long Hann window in 0.5 Hz steps.
pub(crate) fn dominant_frequency(samples: &[f32], rate: u32) -> Option<f64> {
    if samples.len() < (rate / 10) as usize {
        return None;
    }
    let fs = f64::from(rate);
    let coarse = hann(&samples[..samples.len().min(2048)]);
    let mut best = (0.0, 0.0);
    let mut f = 50.0;
    while f <= 5000.0 {
        let power = goertzel(&coarse, fs, f);
        if power > best.1 {
            best = (f, power);
        }
        f += 10.0;
    }
    let fine = hann(&samples[..samples.len().min(rate as usize)]);
    let mut refined = (best.0, 0.0);
    let mut f = (best.0 - 40.0).max(40.0);
    while f <= best.0 + 40.0 {
        let power = goertzel(&fine, fs, f);
        if power > refined.1 {
            refined = (f, power);
        }
        f += 0.5;
    }
    (refined.1 > 0.0).then_some(refined.0)
}

/// RMS level in dBFS (0 dB = full scale sine peak 1.0).
pub(crate) fn rms_dbfs(samples: &[f32]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mean_square = samples
        .iter()
        .map(|s| f64::from(*s) * f64::from(*s))
        .sum::<f64>()
        / samples.len() as f64;
    Some(10.0 * mean_square.max(1e-12).log10())
}

/// Down-mix interleaved i16 samples to normalized mono f32.
pub(crate) fn mono_from_i16(interleaved: &[i16], channels: u16) -> Vec<f32> {
    let channels = usize::from(channels.max(1));
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().map(|s| f32::from(*s) / 32768.0).sum::<f32>() / channels as f32)
        .collect()
}

/// Generate interleaved 16-bit PCM for a sine tone at -6 dBFS.
pub(crate) fn sine_pcm(
    freq: f64,
    rate: u32,
    channels: u16,
    frames: usize,
    phase: &mut f64,
) -> Vec<u8> {
    let step = 2.0 * std::f64::consts::PI * freq / f64::from(rate);
    let mut out = Vec::with_capacity(frames * usize::from(channels) * 2);
    for _ in 0..frames {
        let value = (phase.sin() * 0.5 * 32767.0) as i16;
        for _ in 0..channels {
            out.extend_from_slice(&value.to_le_bytes());
        }
        *phase += step;
        if *phase > 2.0 * std::f64::consts::PI {
            *phase -= 2.0 * std::f64::consts::PI;
        }
    }
    out
}

/// Tone analysis object shared by the audio scenarios.
pub(crate) fn tone_report(mono: &[f32], rate: u32, expected: Option<f64>) -> Value {
    // Skip leading silence so the analysis window holds the tone.
    let start = mono
        .iter()
        .position(|s| s.abs() > 0.02)
        .unwrap_or(mono.len());
    let audible = &mono[start..];
    let frequency = dominant_frequency(audible, rate);
    let matches = match (expected, frequency) {
        (Some(want), Some(got)) => Some((got - want).abs() <= want * 0.02),
        _ => None,
    };
    json!({
        "rate": rate,
        "samples": mono.len(),
        "leading_silence_samples": start,
        "dominant_hz": frequency,
        "rms_dbfs": rms_dbfs(audible),
        "expected_hz": expected,
        "frequency_matches": matches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_uses_nearest_rank() {
        let samples = [5.0, 1.0, 3.0, 2.0, 4.0];
        assert_eq!(percentile(&samples, 50.0), Some(3.0));
        assert_eq!(percentile(&samples, 95.0), Some(5.0));
        assert_eq!(percentile(&[], 50.0), None);
    }

    #[test]
    fn detects_generated_tone() {
        let mut phase = 0.0;
        let pcm = sine_pcm(440.0, 48_000, 2, 48_000, &mut phase);
        let samples: Vec<i16> = pcm
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        let mono = mono_from_i16(&samples, 2);
        let hz = dominant_frequency(&mono, 48_000).unwrap();
        assert!((hz - 440.0).abs() <= 2.0, "detected {hz}");
    }
}
