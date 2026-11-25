//! Probe-side MS-RDPEAI (AUDIO_INPUT) dynamic channel client.
//!
//! Written from the spec independently of the server implementation:
//! Version ↔ Version, Sound Formats ↔ Sound Formats (client subset),
//! Open → Format Change + Open Reply, then Incoming Data + Data packets.

use std::sync::{Arc, Mutex};

use ironrdp::core::{Encode, EncodeResult, WriteCursor, impl_as_any};
use ironrdp::dvc::{DvcClientProcessor, DvcEncode, DvcMessage, DvcProcessor};
use ironrdp::pdu::PduResult;

pub(crate) const CHANNEL_NAME: &str = "AUDIO_INPUT";

const MSG_VERSION: u8 = 0x01;
const MSG_FORMATS: u8 = 0x02;
const MSG_OPEN: u8 = 0x03;
const MSG_OPEN_REPLY: u8 = 0x04;
const MSG_DATA_INCOMING: u8 = 0x05;
const MSG_DATA: u8 = 0x06;
const MSG_FORMAT_CHANGE: u8 = 0x07;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PcmFormat {
    pub tag: u16,
    pub channels: u16,
    pub rate: u32,
    pub bits: u16,
}

#[derive(Debug, Default)]
pub(crate) struct AudioInputState {
    pub channel_id: Option<u32>,
    pub server_version: Option<u32>,
    pub server_formats: Vec<PcmFormat>,
    /// Formats we answered with, in the order the server indexes them.
    pub client_formats: Vec<PcmFormat>,
    pub frames_per_packet: u32,
    pub current: Option<PcmFormat>,
    pub open: bool,
    pub log: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct AudioInputClient {
    pub state: Arc<Mutex<AudioInputState>>,
}

/// Raw, already-serialized DVC payload.
pub(crate) struct RawDvc(pub Vec<u8>);

impl Encode for RawDvc {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        dst.write_slice(&self.0);
        Ok(())
    }
    fn name(&self) -> &'static str {
        "AUDIO_INPUT payload"
    }
    fn size(&self) -> usize {
        self.0.len()
    }
}

impl DvcEncode for RawDvc {}

fn message(bytes: Vec<u8>) -> DvcMessage {
    Box::new(RawDvc(bytes))
}

fn version_pdu(version: u32) -> Vec<u8> {
    let mut out = vec![MSG_VERSION];
    out.extend_from_slice(&version.to_le_bytes());
    out
}

fn format_change_pdu(index: u32) -> Vec<u8> {
    let mut out = vec![MSG_FORMAT_CHANGE];
    out.extend_from_slice(&index.to_le_bytes());
    out
}

fn encode_format(out: &mut Vec<u8>, f: &PcmFormat) {
    let block = f.channels * (f.bits / 8);
    out.extend_from_slice(&f.tag.to_le_bytes());
    out.extend_from_slice(&f.channels.to_le_bytes());
    out.extend_from_slice(&f.rate.to_le_bytes());
    out.extend_from_slice(&(f.rate * u32::from(block)).to_le_bytes());
    out.extend_from_slice(&block.to_le_bytes());
    out.extend_from_slice(&f.bits.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
}

fn formats_pdu(formats: &[PcmFormat]) -> Vec<u8> {
    let mut body = Vec::new();
    for f in formats {
        encode_format(&mut body, f);
    }
    let mut out = vec![MSG_FORMATS];
    out.extend_from_slice(&(formats.len() as u32).to_le_bytes());
    // cbSizeFormatsPacket: size of the whole PDU including the header.
    out.extend_from_slice(&((9 + body.len()) as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

/// Parse one AUDIO_FORMAT; returns the format and the bytes consumed.
fn parse_format(src: &[u8]) -> Option<(PcmFormat, usize)> {
    if src.len() < 18 {
        return None;
    }
    let u16_at = |o: usize| u16::from_le_bytes([src[o], src[o + 1]]);
    let u32_at = |o: usize| u32::from_le_bytes([src[o], src[o + 1], src[o + 2], src[o + 3]]);
    let format = PcmFormat {
        tag: u16_at(0),
        channels: u16_at(2),
        rate: u32_at(4),
        bits: u16_at(14),
    };
    let extra = usize::from(u16_at(16));
    Some((format, 18 + extra))
}

pub(crate) fn data_pdus(pcm: &[u8]) -> Vec<DvcMessage> {
    let mut data = Vec::with_capacity(1 + pcm.len());
    data.push(MSG_DATA);
    data.extend_from_slice(pcm);
    vec![message(vec![MSG_DATA_INCOMING]), message(data)]
}

impl AudioInputClient {
    fn with<R>(&self, f: impl FnOnce(&mut AudioInputState) -> R) -> R {
        f(&mut self.state.lock().expect("audio input state"))
    }
}

impl_as_any!(AudioInputClient);

impl DvcProcessor for AudioInputClient {
    fn channel_name(&self) -> &str {
        CHANNEL_NAME
    }

    fn start(&mut self, channel_id: u32) -> PduResult<Vec<DvcMessage>> {
        self.with(|s| {
            s.channel_id = Some(channel_id);
            s.log.push(format!("channel opened id={channel_id}"));
        });
        Ok(Vec::new())
    }

    fn process(&mut self, _channel_id: u32, payload: &[u8]) -> PduResult<Vec<DvcMessage>> {
        let Some((&id, body)) = payload.split_first() else {
            return Ok(Vec::new());
        };
        let reply = self.with(|s| match id {
            MSG_VERSION if body.len() >= 4 => {
                let version = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
                s.server_version = Some(version);
                s.log.push(format!("server version {version}"));
                vec![message(version_pdu(version.min(2)))]
            }
            MSG_FORMATS if body.len() >= 8 => {
                let count = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
                let mut offset = 8;
                s.server_formats.clear();
                for _ in 0..count {
                    let Some((format, used)) = parse_format(&body[offset.min(body.len())..]) else {
                        break;
                    };
                    s.server_formats.push(format);
                    offset += used;
                }
                s.client_formats = s
                    .server_formats
                    .iter()
                    .copied()
                    .filter(|f| f.tag == 1 && f.bits == 16 && (1..=2).contains(&f.channels))
                    .collect();
                s.log.push(format!(
                    "server offered {} formats, client accepts {}",
                    s.server_formats.len(),
                    s.client_formats.len()
                ));
                vec![message(formats_pdu(&s.client_formats))]
            }
            MSG_OPEN if body.len() >= 8 => {
                s.frames_per_packet = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
                let initial = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                s.current = s.client_formats.get(initial as usize).copied();
                s.open = s.current.is_some();
                s.log.push(format!(
                    "open frames_per_packet={} initial_format={initial} ok={}",
                    s.frames_per_packet, s.open
                ));
                let result: u32 = if s.open { 0 } else { 0x8000_4005 };
                let mut open_reply = vec![MSG_OPEN_REPLY];
                open_reply.extend_from_slice(&result.to_le_bytes());
                vec![message(format_change_pdu(initial)), message(open_reply)]
            }
            MSG_FORMAT_CHANGE if body.len() >= 4 => {
                let index = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
                s.current = s.client_formats.get(index as usize).copied();
                s.log.push(format!("server format change {index}"));
                vec![message(format_change_pdu(index))]
            }
            other => {
                s.log.push(format!("ignored message 0x{other:02x}"));
                Vec::new()
            }
        });
        Ok(reply)
    }

    fn close(&mut self, _channel_id: u32) {
        self.with(|s| {
            s.open = false;
            s.log.push("channel closed".to_string());
        });
    }
}

impl DvcClientProcessor for AudioInputClient {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_pdu_declares_whole_packet_size() {
        let pdu = formats_pdu(&[PcmFormat {
            tag: 1,
            channels: 2,
            rate: 44_100,
            bits: 16,
        }]);
        assert_eq!(pdu[0], MSG_FORMATS);
        let size = u32::from_le_bytes([pdu[5], pdu[6], pdu[7], pdu[8]]) as usize;
        assert_eq!(size, pdu.len());
        let (format, used) = parse_format(&pdu[9..]).unwrap();
        assert_eq!(used, 18);
        assert_eq!(format.rate, 44_100);
    }
}
