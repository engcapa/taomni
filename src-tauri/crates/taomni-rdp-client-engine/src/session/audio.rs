use super::*;

impl RdpsndWsBackend {
    pub(super) fn new(out_tx: SessionOutputSender) -> Self {
        Self {
            out_tx,
            formats: vec![IronAudioFormat {
                format: IronWaveFormat::PCM,
                n_channels: AUDIO_CHANNELS,
                n_samples_per_sec: AUDIO_SAMPLE_RATE,
                n_avg_bytes_per_sec: AUDIO_SAMPLE_RATE
                    * u32::from(AUDIO_CHANNELS)
                    * u32::from(AUDIO_BITS_PER_SAMPLE / 8),
                n_block_align: AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8),
                bits_per_sample: AUDIO_BITS_PER_SAMPLE,
                data: None,
            }],
        }
    }
}

impl std::fmt::Debug for RdpsndWsBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RdpsndWsBackend")
            .field("formats", &self.formats)
            .finish_non_exhaustive()
    }
}

impl RdpsndClientHandler for RdpsndWsBackend {
    fn get_formats(&self) -> &[IronAudioFormat] {
        &self.formats
    }

    fn wave(&mut self, format_no: usize, ts: u32, data: Cow<'_, [u8]>) {
        let payload = audio_payload_with_header(format_no, ts, data.as_ref());
        let _ = self.out_tx.send(SessionOutput::Channel {
            tag: channel::AUDIO,
            payload,
        });
    }

    fn set_volume(&mut self, _volume: VolumePdu) {}

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {
        send_status(&self.out_tx, "audio-closed", "RDP audio channel closed.");
    }
}

pub(super) fn audio_payload_with_header(format_no: usize, timestamp: u32, pcm: &[u8]) -> Vec<u8> {
    let format_no = u16::try_from(format_no).unwrap_or(u16::MAX);
    let mut payload = Vec::with_capacity(16 + pcm.len());
    payload.extend_from_slice(&AUDIO_SAMPLE_RATE.to_be_bytes());
    payload.extend_from_slice(&AUDIO_CHANNELS.to_be_bytes());
    payload.extend_from_slice(&AUDIO_BITS_PER_SAMPLE.to_be_bytes());
    payload.extend_from_slice(&timestamp.to_be_bytes());
    payload.extend_from_slice(&format_no.to_be_bytes());
    payload.extend_from_slice(&0u16.to_be_bytes());
    payload.extend_from_slice(pcm);
    payload
}
