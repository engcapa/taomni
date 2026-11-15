//! Pure clipboard codecs shared by RDP client and server CLIPRDR bridges.
//!
//! - Per-direction policy levels (DEC-10): `off < text < rich < all`, modelled
//!   on Windows' "restrict clipboard transfer" policy tiers.
//! - CF_HTML ("HTML Format"): the Windows header with byte offsets around a
//!   UTF-8 document, converted to and from the HTML fragment the host
//!   clipboard (arboard) exchanges.
//! - Device-independent bitmaps: CF_DIB / CF_DIBV5 to and from RGBA8.
//!
//! Everything here is deterministic and allocation-bounded so it can be unit
//! tested without a host clipboard or an RDP peer.

/// Maximum HTML payload accepted in either direction.
pub const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;
/// Largest image (in pixels) accepted in either direction: 8192 x 8192.
pub const MAX_IMAGE_PIXELS: u64 = 8192 * 8192;

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
const BI_ALPHABITFIELDS: u32 = 6;
const BITMAPINFOHEADER_SIZE: u32 = 40;
const BITMAPV5HEADER_SIZE: u32 = 124;
/// `'sRGB'`: the colour space of every bitmap we produce.
const LCS_SRGB: u32 = 0x7352_4742;
const LCS_GM_IMAGES: u32 = 4;

const START_FRAGMENT: &str = "<!--StartFragment-->";
const END_FRAGMENT: &str = "<!--EndFragment-->";

/// How much of the clipboard may cross one direction of the bridge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ClipboardLevel {
    Off,
    /// Unicode text only.
    Text,
    /// Text, HTML and images.
    Rich,
    /// Rich formats plus files.
    All,
}

impl ClipboardLevel {
    /// Parse a persisted setting. `None` for unknown values so the caller can
    /// log and fall back instead of silently widening the policy.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "off" => Some(Self::Off),
            "text" => Some(Self::Text),
            "rich" => Some(Self::Rich),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Text => "text",
            Self::Rich => "rich",
            Self::All => "all",
        }
    }

    pub fn allows_text(self) -> bool {
        self >= Self::Text
    }

    pub fn allows_rich(self) -> bool {
        self >= Self::Rich
    }

    pub fn allows_files(self) -> bool {
        self >= Self::All
    }
}

/// Tightly packed, top-down RGBA8 pixels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl RgbaImage {
    pub fn new(width: u32, height: u32, pixels: Vec<u8>) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("image has an empty dimension".to_string());
        }
        let count = u64::from(width) * u64::from(height);
        if count > MAX_IMAGE_PIXELS {
            return Err(format!(
                "image {width}x{height} exceeds the {MAX_IMAGE_PIXELS}-pixel limit"
            ));
        }
        if pixels.len() as u64 != count * 4 {
            return Err(format!(
                "image {width}x{height} has {} bytes of RGBA data",
                pixels.len()
            ));
        }
        Ok(Self {
            width,
            height,
            pixels,
        })
    }
}

// ------------------------------------------------------------------ CF_HTML

fn cf_html_header(
    start_html: usize,
    end_html: usize,
    start_frag: usize,
    end_frag: usize,
) -> String {
    format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\n\
         StartFragment:{start_frag:010}\r\nEndFragment:{end_frag:010}\r\n"
    )
}

fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .to_ascii_lowercase()
        .find(&needle.to_ascii_lowercase())
}

fn rfind_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .to_ascii_lowercase()
        .rfind(&needle.to_ascii_lowercase())
}

/// Byte offsets just after `<body ...>` and at `</body`, when both exist.
fn body_bounds(html: &str) -> Option<(usize, usize)> {
    let open = find_ascii_ci(html, "<body")?;
    let open_end = open + html[open..].find('>')? + 1;
    let close = rfind_ascii_ci(html, "</body")?;
    (open_end <= close).then_some((open_end, close))
}

/// Wrap an HTML fragment or document in the Windows "HTML Format" envelope.
/// Existing fragment markers are respected; otherwise the `<body>` content
/// (or the whole input) becomes the fragment.
pub fn cf_html_encode(html: &str) -> Vec<u8> {
    let document = if html.contains(START_FRAGMENT) && html.contains(END_FRAGMENT) {
        html.to_string()
    } else if let Some((open_end, close)) = body_bounds(html) {
        format!(
            "{}{START_FRAGMENT}{}{END_FRAGMENT}{}",
            &html[..open_end],
            &html[open_end..close],
            &html[close..]
        )
    } else {
        format!("<html><body>{START_FRAGMENT}{html}{END_FRAGMENT}</body></html>")
    };
    // The header has a fixed width (10-digit offsets), so its length does not
    // depend on the values written into it.
    let start_html = cf_html_header(0, 0, 0, 0).len();
    let frag_marker = document.find(START_FRAGMENT).unwrap_or(0);
    let start_frag = start_html + frag_marker + START_FRAGMENT.len();
    let end_frag = start_html
        + document[frag_marker..]
            .find(END_FRAGMENT)
            .map(|offset| frag_marker + offset)
            .unwrap_or(document.len());
    let end_html = start_html + document.len();
    let mut out = cf_html_header(start_html, end_html, start_frag, end_frag).into_bytes();
    out.extend_from_slice(document.as_bytes());
    out.push(0);
    out
}

/// Extract the fragment (or failing that, the document) from CF_HTML bytes.
pub fn cf_html_fragment(data: &[u8]) -> Option<String> {
    let end = data
        .iter()
        .rposition(|byte| *byte != 0)
        .map_or(0, |i| i + 1);
    let data = &data[..end];
    let mut fields = std::collections::HashMap::new();
    for line in data[..data.len().min(1024)].split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.first() == Some(&b'<') {
            break;
        }
        let Ok(line) = std::str::from_utf8(line) else {
            break;
        };
        if let Some((key, value)) = line.split_once(':') {
            fields.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let offset = |key: &str| {
        fields
            .get(key)
            .and_then(|value| value.parse::<i64>().ok())
            .and_then(|value| usize::try_from(value).ok())
    };
    let slice = |start: Option<usize>, end: Option<usize>| match (start, end) {
        (Some(start), Some(end)) if start <= end && end <= data.len() => {
            Some(String::from_utf8_lossy(&data[start..end]).into_owned())
        }
        _ => None,
    };
    slice(offset("startfragment"), offset("endfragment"))
        .or_else(|| slice(offset("starthtml"), offset("endhtml")))
}

// -------------------------------------------------------------------- DIBs

fn read_u16(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..at + 2)
        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 4)
        .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// Scale the bits selected by `mask` to 0..=255.
fn channel(value: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let bits = (mask >> shift).count_ones();
    let raw = u64::from((value & mask) >> shift);
    if bits >= 8 {
        (raw >> (bits - 8)) as u8
    } else {
        let max = (1u64 << bits) - 1;
        ((raw * 255 + max / 2) / max) as u8
    }
}

/// Decode a packed DIB (CF_DIB or CF_DIBV5 payload) into RGBA8.
///
/// Supports 24- and 32-bit BI_RGB and BI_BITFIELDS / BI_ALPHABITFIELDS,
/// bottom-up and top-down rows. 32-bit BI_RGB is treated as opaque: its
/// fourth byte is reserved, and only an explicit alpha mask carries alpha.
pub fn dib_to_rgba(data: &[u8]) -> Result<RgbaImage, String> {
    let header_size = read_u32(data, 0).ok_or("DIB is shorter than its header size")?;
    if header_size < BITMAPINFOHEADER_SIZE || data.len() < header_size as usize {
        return Err(format!("unsupported DIB header size {header_size}"));
    }
    let width = read_u32(data, 4).ok_or("DIB width missing")? as i32;
    let height = read_u32(data, 8).ok_or("DIB height missing")? as i32;
    let bpp = read_u16(data, 14).ok_or("DIB bit count missing")?;
    let compression = read_u32(data, 16).ok_or("DIB compression missing")?;
    let colors_used = read_u32(data, 32).ok_or("DIB colour count missing")?;
    if width <= 0 || height == 0 || height == i32::MIN {
        return Err(format!("invalid DIB dimensions {width}x{height}"));
    }
    if bpp != 24 && bpp != 32 {
        return Err(format!("unsupported DIB depth {bpp} bpp"));
    }
    let (w, h) = (width as u32, height.unsigned_abs());
    if u64::from(w) * u64::from(h) > MAX_IMAGE_PIXELS {
        return Err(format!(
            "DIB {w}x{h} exceeds the {MAX_IMAGE_PIXELS}-pixel limit"
        ));
    }

    let header_end = header_size as usize;
    let (masks, mut offset) = match compression {
        BI_RGB if bpp == 32 => ([0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0], header_end),
        BI_RGB => ([0; 4], header_end),
        BI_BITFIELDS | BI_ALPHABITFIELDS if bpp == 32 => {
            if header_size >= 52 {
                let alpha = if header_size >= 56 {
                    read_u32(data, 52).unwrap_or(0)
                } else {
                    0
                };
                (
                    [
                        read_u32(data, 40).unwrap_or(0),
                        read_u32(data, 44).unwrap_or(0),
                        read_u32(data, 48).unwrap_or(0),
                        alpha,
                    ],
                    header_end,
                )
            } else {
                // BITMAPINFOHEADER: the masks follow the header.
                let count = if compression == BI_ALPHABITFIELDS {
                    4
                } else {
                    3
                };
                let mut masks = [0u32; 4];
                for (index, mask) in masks.iter_mut().enumerate().take(count) {
                    *mask = read_u32(data, header_end + index * 4)
                        .ok_or("DIB colour masks are truncated")?;
                }
                (masks, header_end + count * 4)
            }
        }
        other => return Err(format!("unsupported DIB compression {other} at {bpp} bpp")),
    };
    // A colour table is legal (if useless) for true-colour bitmaps; skip it.
    offset = offset
        .checked_add(colors_used as usize * 4)
        .ok_or("DIB colour table overflows")?;

    let stride = ((u64::from(w) * u64::from(bpp) + 31) / 32 * 4) as usize;
    let needed = stride
        .checked_mul(h as usize)
        .and_then(|bytes| bytes.checked_add(offset))
        .ok_or("DIB size overflows")?;
    if data.len() < needed {
        return Err(format!(
            "DIB pixel data is truncated ({} of {needed} bytes)",
            data.len()
        ));
    }
    let top_down = height < 0;
    let mut pixels = Vec::with_capacity(w as usize * h as usize * 4);
    for row in 0..h as usize {
        let source_row = if top_down { row } else { h as usize - 1 - row };
        let start = offset + source_row * stride;
        let line = &data[start..start + stride];
        for x in 0..w as usize {
            if bpp == 32 {
                let px = &line[x * 4..x * 4 + 4];
                let value = u32::from_le_bytes([px[0], px[1], px[2], px[3]]);
                let alpha = if masks[3] == 0 {
                    255
                } else {
                    channel(value, masks[3])
                };
                pixels.extend_from_slice(&[
                    channel(value, masks[0]),
                    channel(value, masks[1]),
                    channel(value, masks[2]),
                    alpha,
                ]);
            } else {
                let px = &line[x * 3..x * 3 + 3];
                pixels.extend_from_slice(&[px[2], px[1], px[0], 255]);
            }
        }
    }
    RgbaImage::new(w, h, pixels)
}

/// Bottom-up BGRA rows, the pixel layout both DIB encoders emit.
fn bottom_up_bgra(image: &RgbaImage) -> Vec<u8> {
    let row_bytes = image.width as usize * 4;
    let mut out = Vec::with_capacity(image.pixels.len());
    for row in image.pixels.chunks_exact(row_bytes).rev() {
        for px in row.chunks_exact(4) {
            out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }
    out
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// CF_DIB: BITMAPINFOHEADER, 32-bit BI_RGB, bottom-up. Alpha rides in the
/// reserved byte, which readers that understand it may use.
pub fn rgba_to_dib(image: &RgbaImage) -> Vec<u8> {
    let pixels = bottom_up_bgra(image);
    let mut out = Vec::with_capacity(BITMAPINFOHEADER_SIZE as usize + pixels.len());
    put_u32(&mut out, BITMAPINFOHEADER_SIZE);
    put_u32(&mut out, image.width);
    put_u32(&mut out, image.height);
    put_u16(&mut out, 1);
    put_u16(&mut out, 32);
    put_u32(&mut out, BI_RGB);
    put_u32(&mut out, pixels.len() as u32);
    put_u32(&mut out, 0);
    put_u32(&mut out, 0);
    put_u32(&mut out, 0);
    put_u32(&mut out, 0);
    out.extend_from_slice(&pixels);
    out
}

/// CF_DIBV5: BITMAPV5HEADER with explicit RGBA masks and sRGB, bottom-up.
pub fn rgba_to_dibv5(image: &RgbaImage) -> Vec<u8> {
    let pixels = bottom_up_bgra(image);
    let mut out = Vec::with_capacity(BITMAPV5HEADER_SIZE as usize + pixels.len());
    put_u32(&mut out, BITMAPV5HEADER_SIZE);
    put_u32(&mut out, image.width);
    put_u32(&mut out, image.height);
    put_u16(&mut out, 1);
    put_u16(&mut out, 32);
    put_u32(&mut out, BI_BITFIELDS);
    put_u32(&mut out, pixels.len() as u32);
    put_u32(&mut out, 0); // x pixels per metre
    put_u32(&mut out, 0); // y pixels per metre
    put_u32(&mut out, 0); // colours used
    put_u32(&mut out, 0); // important colours
    put_u32(&mut out, 0x00FF_0000);
    put_u32(&mut out, 0x0000_FF00);
    put_u32(&mut out, 0x0000_00FF);
    put_u32(&mut out, 0xFF00_0000);
    put_u32(&mut out, LCS_SRGB);
    out.extend_from_slice(&[0; 36]); // endpoints, unused for sRGB
    put_u32(&mut out, 0); // gamma red
    put_u32(&mut out, 0); // gamma green
    put_u32(&mut out, 0); // gamma blue
    put_u32(&mut out, LCS_GM_IMAGES);
    put_u32(&mut out, 0); // profile data
    put_u32(&mut out, 0); // profile size
    put_u32(&mut out, 0); // reserved
    debug_assert_eq!(out.len(), BITMAPV5HEADER_SIZE as usize);
    out.extend_from_slice(&pixels);
    out
}

#[cfg(test)]
#[path = "clipboard_formats_tests.rs"]
mod tests;
