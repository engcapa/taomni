// Pixel decoders write straight into a caller-owned, tightly packed RGBA
// scratch block of `w*h*4` bytes (stride `w*4`). The RFB connection then blits
// that block into the authoritative framebuffer once per server rectangle, so
// no per-tile allocation or per-tile relay message is produced.

#[derive(Debug)]
pub struct DecodedCursor {
    pub hotspot_x: u16,
    pub hotspot_y: u16,
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
}

/// Cursor position delivered by the RFB PointerPos pseudo-encoding (-232).
/// The encoding uses the rectangle header only; its width and height must be
/// zero and no payload follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedPointerPosition {
    pub x: u16,
    pub y: u16,
}

pub const ENCODING_DESKTOP_SIZE: i32 = -223;
pub const ENCODING_POINTER_POS: i32 = -232;
pub const ENCODING_RICH_CURSOR: i32 = -239;
pub const ENCODING_X_CURSOR: i32 = -240;
