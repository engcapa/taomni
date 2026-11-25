//! Probe-side RDPSND client: offers PCM formats and records every wave.

use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ironrdp::rdpsnd::client::RdpsndClientHandler;
use ironrdp::rdpsnd::pdu::{AudioFormat, AudioFormatFlags, PitchPdu, VolumePdu, WaveFormat};

pub(crate) fn pcm(rate: u32, channels: u16) -> AudioFormat {
    let block_align = channels * 2;
    AudioFormat {
        format: WaveFormat::PCM,
        n_channels: channels,
        n_samples_per_sec: rate,
        n_avg_bytes_per_sec: rate * u32::from(block_align),
        n_block_align: block_align,
        bits_per_sample: 16,
        data: None,
    }
}

#[derive(Debug, Default)]
pub(crate) struct AudioCapture {
    /// Interleaved 16-bit samples of the first format the server used.
    pub samples: Vec<i16>,
    pub format_no: Option<usize>,
    pub waves: u64,
    pub first_wave_at: Option<Instant>,
    pub volume: Option<(u16, u16)>,
    pub closed: bool,
    pub format_changes: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct ProbeRdpsnd {
    formats: Vec<AudioFormat>,
    pub capture: Arc<Mutex<AudioCapture>>,
}

impl ProbeRdpsnd {
    /// Offers exactly one stereo PCM16 format. wFormatNo indexes the list the
    /// client sent, and ironrdp-rdpsnd builds that list from a HashSet (the
    /// order is not ours), so a single entry is the only unambiguous index —
    /// the same choice Taomni's own client makes.
    pub fn new(rate: u32) -> Self {
        Self {
            formats: vec![pcm(rate, 2)],
            capture: Arc::new(Mutex::new(AudioCapture::default())),
        }
    }

    pub fn format(&self, index: usize) -> Option<&AudioFormat> {
        self.formats.get(index)
    }
}

impl RdpsndClientHandler for ProbeRdpsnd {
    fn get_flags(&self) -> AudioFormatFlags {
        AudioFormatFlags::ALIVE | AudioFormatFlags::VOLUME
    }

    fn get_formats(&self) -> &[AudioFormat] {
        &self.formats
    }

    fn wave(&mut self, format_no: usize, _ts: u32, data: Cow<'_, [u8]>) {
        let mut capture = self.capture.lock().expect("audio capture");
        match capture.format_no {
            None => capture.format_no = Some(format_no),
            Some(current) if current != format_no => {
                capture.format_changes += 1;
                return;
            }
            Some(_) => {}
        }
        capture.waves += 1;
        capture.first_wave_at.get_or_insert_with(Instant::now);
        // Cap memory at ~60 s of 48 kHz stereo.
        if capture.samples.len() < 48_000 * 2 * 60 {
            capture.samples.extend(
                data.chunks_exact(2)
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]])),
            );
        }
    }

    fn set_volume(&mut self, volume: VolumePdu) {
        self.capture.lock().expect("audio capture").volume =
            Some((volume.volume_left, volume.volume_right));
    }

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {
        self.capture.lock().expect("audio capture").closed = true;
    }
}
