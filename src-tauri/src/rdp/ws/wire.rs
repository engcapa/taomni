use super::model::RdpControl;
use crate::rdp::frame::TileHeader;
use crate::rdp::input::KeyEvent;
use crate::rdp::input::PointerEvent;
use crate::rdp::input::PointerWheelEvent;
use tungstenite::http::header;

/// Wire-protocol channel tags for the binary WS frames.
pub mod channel {
    pub const FRAME: u8 = 0; // bitmap tile (display)
    pub const AUDIO: u8 = 1; // PCM audio
    pub const CURSOR: u8 = 2; // cursor shape change
    pub const CLIPBOARD_OFFER: u8 = 3; // text/file offer metadata
    pub const CLIPBOARD_DATA: u8 = 4; // requested clipboard contents
    pub const STATUS: u8 = 5; // text status / error JSON

    pub const FRAME_END: u8 = 6; // sentinel: server flushed a batch

    /// Inbound (browser → relay) tags.
    pub const IN_PING: u8 = 0;
    pub const IN_ACK: u8 = 1;
    pub const IN_KEY: u8 = 2;
    pub const IN_POINTER: u8 = 3;
    pub const IN_RESIZE: u8 = 4;
    pub const IN_WHEEL: u8 = 5;
    pub const IN_REFRESH: u8 = 6; // request a full-desktop redraw
}

/// Payload kinds carried by [`channel::CURSOR`]. Bitmap payloads continue with
/// hotspot x/y, width/height (all big-endian u16), then PNG bytes.
pub mod cursor {
    pub const DEFAULT: u8 = 0;
    pub const HIDDEN: u8 = 1;
    pub const BITMAP: u8 = 2;
    pub const BITMAP_HEADER_LEN: usize = 9;
    pub const MAX_DIMENSION: u16 = 512;
}

/// Decode a binary control frame from the canvas. Layout:
///
/// ```text
/// tag=IN_KEY:    [tag, down, scan_lo, scan_hi]
/// tag=IN_POINTER:[tag, buttons, x_hi, x_lo, y_hi, y_lo]
/// tag=IN_RESIZE: [tag, w_hi, w_lo, h_hi, h_lo]
/// tag=IN_WHEEL:  [tag, orientation, x_hi, x_lo, y_hi, y_lo, units_hi, units_lo]
/// tag=IN_PING:   [tag]
/// tag=IN_ACK:    [tag]
/// tag=IN_REFRESH:[tag]
/// ```
pub fn parse_binary_control(bytes: &[u8]) -> Option<RdpControl> {
    if bytes.is_empty() {
        return None;
    }
    match bytes[0] {
        channel::IN_PING | channel::IN_ACK => Some(RdpControl::Ack),
        channel::IN_REFRESH => Some(RdpControl::Refresh),
        channel::IN_KEY if bytes.len() >= 4 => {
            let down = bytes[1] != 0;
            let scancode = u16::from_be_bytes([bytes[2], bytes[3]]);
            Some(RdpControl::Key(KeyEvent { down, scancode }))
        }
        channel::IN_POINTER if bytes.len() >= 6 => {
            let buttons = bytes[1];
            let x = u16::from_be_bytes([bytes[2], bytes[3]]);
            let y = u16::from_be_bytes([bytes[4], bytes[5]]);
            Some(RdpControl::Pointer(PointerEvent { x, y, buttons }))
        }
        channel::IN_RESIZE if bytes.len() >= 5 => {
            let w = u16::from_be_bytes([bytes[1], bytes[2]]);
            let h = u16::from_be_bytes([bytes[3], bytes[4]]);
            Some(RdpControl::Resize {
                width: w,
                height: h,
            })
        }
        channel::IN_WHEEL if bytes.len() >= 8 => {
            let is_vertical = bytes[1] == 0;
            let x = u16::from_be_bytes([bytes[2], bytes[3]]);
            let y = u16::from_be_bytes([bytes[4], bytes[5]]);
            let rotation_units = i16::from_be_bytes([bytes[6], bytes[7]]);
            (rotation_units != 0).then_some(RdpControl::Wheel(PointerWheelEvent {
                x,
                y,
                is_vertical,
                rotation_units,
            }))
        }
        _ => None,
    }
}

/// Helper for callers that want to embed a tile header in an outgoing
/// FRAME-channel message. Header layout (big-endian): x, y, w, h.
pub fn frame_payload_with_header(header: TileHeader, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + rgba.len());
    out.extend_from_slice(&header.x.to_be_bytes());
    out.extend_from_slice(&header.y.to_be_bytes());
    out.extend_from_slice(&header.w.to_be_bytes());
    out.extend_from_slice(&header.h.to_be_bytes());
    out.extend_from_slice(rgba);
    out
}
