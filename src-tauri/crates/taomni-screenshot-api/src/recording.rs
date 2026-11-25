use std::io;

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;

// An MP4 at the highest supported bitrate can approach 450 MB in five minutes.
pub const MAX_CLIP_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordStart {
    pub source: Endpoint,
    pub format: String,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
}

/// A frame header precedes a full RGBA image of the confirmed dimensions.
/// An end header supplies the last frame's end timestamp and has no payload.
pub struct FrameHeader {
    pub at_ms: u64,
    pub end: bool,
}

impl FrameHeader {
    pub const LENGTH: usize = 9;

    pub fn bytes(&self) -> [u8; Self::LENGTH] {
        let mut bytes = [0; Self::LENGTH];
        bytes[0] = u8::from(self.end);
        bytes[1..].copy_from_slice(&self.at_ms.to_be_bytes());
        bytes
    }

    pub fn parse(bytes: [u8; Self::LENGTH]) -> io::Result<Self> {
        let [kind, timestamp @ ..] = bytes;
        if kind > 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Unknown recording frame kind",
            ));
        }
        Ok(Self {
            at_ms: u64::from_be_bytes(timestamp),
            end: kind == 1,
        })
    }
}
