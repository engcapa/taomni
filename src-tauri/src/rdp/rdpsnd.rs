//! RDPSND (Audio Output Virtual Channel) — MS-RDPEA.
//!
//! Audio frames travel from server to client. We negotiate exactly one
//! format on the way in (PCM 44.1 kHz / 16-bit / stereo, the lowest
//! common denominator for Windows hosts) and re-emit each Wave PDU as
//! an `AUDIO`-tagged WS frame for the React canvas's AudioWorklet to
//! play back.
//!
//! Implemented + unit-tested:
//!
//! - `WAVEFORMATEX` encode/decode (the format header used in
//!   `Server Audio Formats and Version PDU`).
//! - Format-list filter that selects PCM 44.1k stereo when offered.
//! - Wave PDU framing (`SNDC_WAVE`) and `Wave Confirm` PDU encoding.

// ── PDU types (sndProlog.msgType) ────────────────────────────────────────

pub const SNDC_FORMATS: u8 = 0x07;
pub const SNDC_TRAINING: u8 = 0x06;
pub const SNDC_WAVE: u8 = 0x02;
pub const SNDC_CLOSE: u8 = 0x01;
pub const SNDC_WAVECONFIRM: u8 = 0x05;
pub const SNDC_QUALITYMODE: u8 = 0x0C;

pub const WAVE_FORMAT_PCM: u16 = 0x0001;

// ── WAVEFORMATEX ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaveFormat {
    pub format_tag: u16,
    pub channels: u16,
    pub samples_per_sec: u32,
    pub avg_bytes_per_sec: u32,
    pub block_align: u16,
    pub bits_per_sample: u16,
    pub extra_data: Vec<u8>,
}

impl WaveFormat {
    pub const HEADER_SIZE: usize = 18;

    pub fn pcm(samples_per_sec: u32, channels: u16, bits_per_sample: u16) -> Self {
        let block_align = channels * (bits_per_sample / 8);
        let avg_bytes_per_sec = samples_per_sec * block_align as u32;
        Self {
            format_tag: WAVE_FORMAT_PCM,
            channels,
            samples_per_sec,
            avg_bytes_per_sec,
            block_align,
            bits_per_sample,
            extra_data: Vec::new(),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(Self::HEADER_SIZE + self.extra_data.len());
        out.extend_from_slice(&self.format_tag.to_le_bytes());
        out.extend_from_slice(&self.channels.to_le_bytes());
        out.extend_from_slice(&self.samples_per_sec.to_le_bytes());
        out.extend_from_slice(&self.avg_bytes_per_sec.to_le_bytes());
        out.extend_from_slice(&self.block_align.to_le_bytes());
        out.extend_from_slice(&self.bits_per_sample.to_le_bytes());
        let extra_len = self.extra_data.len() as u16;
        out.extend_from_slice(&extra_len.to_le_bytes());
        out.extend_from_slice(&self.extra_data);
        out
    }

    pub fn parse(buf: &[u8]) -> Result<(Self, usize), String> {
        if buf.len() < Self::HEADER_SIZE {
            return Err(format!(
                "WAVEFORMATEX: {} bytes < {}",
                buf.len(),
                Self::HEADER_SIZE
            ));
        }
        let format_tag = u16::from_le_bytes([buf[0], buf[1]]);
        let channels = u16::from_le_bytes([buf[2], buf[3]]);
        let samples_per_sec = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
        let avg_bytes_per_sec = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        let block_align = u16::from_le_bytes([buf[12], buf[13]]);
        let bits_per_sample = u16::from_le_bytes([buf[14], buf[15]]);
        let extra_len = u16::from_le_bytes([buf[16], buf[17]]) as usize;
        let total = Self::HEADER_SIZE + extra_len;
        if buf.len() < total {
            return Err(format!(
                "WAVEFORMATEX: declared extra {} bytes but buffer has {} after header",
                extra_len,
                buf.len() - Self::HEADER_SIZE,
            ));
        }
        let extra_data = buf[Self::HEADER_SIZE..total].to_vec();
        Ok((
            Self {
                format_tag,
                channels,
                samples_per_sec,
                avg_bytes_per_sec,
                block_align,
                bits_per_sample,
                extra_data,
            },
            total,
        ))
    }
}

/// Walk a server-side format list and pick the first PCM 44.1 kHz / 16-bit
/// stereo entry, returning its index (server-assigned `wFormatNo`) and the
/// parsed format. `None` means we'll have to fall back to silence.
pub fn pick_pcm_format(formats: &[WaveFormat]) -> Option<(u16, WaveFormat)> {
    formats.iter().enumerate().find_map(|(i, f)| {
        if f.format_tag == WAVE_FORMAT_PCM
            && f.channels == 2
            && f.samples_per_sec == 44_100
            && f.bits_per_sample == 16
        {
            Some((i as u16, f.clone()))
        } else {
            None
        }
    })
}

// ── PDU framing ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SndProlog {
    pub msg_type: u8,
    pub body_size: u16,
}

impl SndProlog {
    pub const SIZE: usize = 4;

    pub fn encode(&self) -> [u8; Self::SIZE] {
        [
            self.msg_type,
            0,
            self.body_size as u8,
            (self.body_size >> 8) as u8,
        ]
    }

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err("SNDPROLOG truncated".into());
        }
        Ok(Self {
            msg_type: buf[0],
            body_size: u16::from_le_bytes([buf[2], buf[3]]),
        })
    }
}

/// Build a Wave Confirm PDU body. Time-stamp echoes the server's `wTimeStamp`
/// from the inbound Wave PDU; `wave_block_no` echoes the outbound counter.
pub fn build_wave_confirm(timestamp: u16, wave_block_no: u8) -> Vec<u8> {
    let body = vec![timestamp as u8, (timestamp >> 8) as u8, wave_block_no, 0];
    let mut out = SndProlog {
        msg_type: SNDC_WAVECONFIRM,
        body_size: body.len() as u16,
    }
    .encode()
    .to_vec();
    out.extend_from_slice(&body);
    out
}

/// Inbound Wave PDU body (after the 4-byte SNDPROLOG): a `wTimeStamp` u16,
/// a `wFormatNo` u16, a `cBlockNo` u8, three reserved bytes, then PCM data.
#[derive(Debug, Clone)]
pub struct WaveBody<'a> {
    pub timestamp: u16,
    pub format_no: u16,
    pub block_no: u8,
    pub pcm: &'a [u8],
}

pub fn parse_wave_body(buf: &[u8]) -> Result<WaveBody<'_>, String> {
    if buf.len() < 8 {
        return Err(format!("Wave body: {} bytes < 8 header", buf.len()));
    }
    Ok(WaveBody {
        timestamp: u16::from_le_bytes([buf[0], buf[1]]),
        format_no: u16::from_le_bytes([buf[2], buf[3]]),
        block_no: buf[4],
        pcm: &buf[8..],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_helper_computes_block_align() {
        let f = WaveFormat::pcm(44_100, 2, 16);
        assert_eq!(f.block_align, 4);
        assert_eq!(f.avg_bytes_per_sec, 44_100 * 4);
    }

    #[test]
    fn waveformatex_round_trip_no_extra() {
        let f = WaveFormat::pcm(48_000, 2, 16);
        let buf = f.encode();
        let (parsed, consumed) = WaveFormat::parse(&buf).unwrap();
        assert_eq!(parsed, f);
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn waveformatex_round_trip_with_extra_data() {
        let mut f = WaveFormat::pcm(22_050, 1, 8);
        f.extra_data = vec![0xAA, 0xBB, 0xCC];
        let buf = f.encode();
        let (parsed, consumed) = WaveFormat::parse(&buf).unwrap();
        assert_eq!(parsed, f);
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn waveformatex_rejects_truncated() {
        assert!(WaveFormat::parse(&[0; 10]).is_err());
    }

    #[test]
    fn waveformatex_rejects_extra_overflow() {
        let mut buf = WaveFormat::pcm(44_100, 2, 16).encode();
        // Force claimed extra=1024 with only 0 trailing bytes.
        buf[16] = 0x00;
        buf[17] = 0x04;
        assert!(WaveFormat::parse(&buf).is_err());
    }

    #[test]
    fn pick_pcm_finds_correct_index() {
        let formats = vec![
            WaveFormat::pcm(8_000, 1, 8),
            WaveFormat::pcm(48_000, 2, 16),
            WaveFormat::pcm(44_100, 2, 16),
        ];
        let (idx, f) = pick_pcm_format(&formats).unwrap();
        assert_eq!(idx, 2);
        assert_eq!(f.samples_per_sec, 44_100);
    }

    #[test]
    fn pick_pcm_returns_none_when_unsupported() {
        let formats = vec![WaveFormat::pcm(48_000, 2, 16)];
        assert!(pick_pcm_format(&formats).is_none());
    }

    #[test]
    fn prolog_round_trip() {
        let p = SndProlog {
            msg_type: SNDC_WAVE,
            body_size: 1024,
        };
        let buf = p.encode();
        let parsed = SndProlog::parse(&buf).unwrap();
        assert_eq!(parsed, p);
    }

    #[test]
    fn wave_confirm_layout() {
        let buf = build_wave_confirm(0x1234, 7);
        assert_eq!(buf[0], SNDC_WAVECONFIRM);
        // body size = 4
        assert_eq!(u16::from_le_bytes([buf[2], buf[3]]), 4);
        assert_eq!(u16::from_le_bytes([buf[4], buf[5]]), 0x1234);
        assert_eq!(buf[6], 7);
        assert_eq!(buf[7], 0);
    }

    #[test]
    fn wave_body_parses_pcm_payload() {
        let mut buf = vec![
            0x34, 0x12, // timestamp
            0x02, 0x00, // format_no
            0x05, // block_no
            0, 0, 0, // reserved (3 bytes — verified by the +8 offset)
        ];
        buf.extend_from_slice(&[0x10, 0x20, 0x30, 0x40]);
        let parsed = parse_wave_body(&buf).unwrap();
        assert_eq!(parsed.timestamp, 0x1234);
        assert_eq!(parsed.format_no, 2);
        assert_eq!(parsed.block_no, 5);
        assert_eq!(parsed.pcm, &[0x10, 0x20, 0x30, 0x40]);
    }
}
