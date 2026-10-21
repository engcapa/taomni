use super::model::DecodedCursor;
use crate::vnc::pixel::PixelConverter;
use std::io::Read;

pub(super) const MAX_CURSOR_DIMENSION: u16 = 512;

/// Decode the RichCursor pseudo-encoding (-239). Pixel bytes use the 32-bit
/// RGBA format negotiated for normal rectangles, followed by a one-bit alpha
/// mask whose rows are padded to whole bytes.
pub fn read_rich_cursor<R: Read>(
    reader: &mut R,
    hotspot_x: u16,
    hotspot_y: u16,
    width: u16,
    height: u16,
    conv: &PixelConverter,
) -> Result<DecodedCursor, String> {
    if width == 0 || height == 0 {
        return Ok(DecodedCursor {
            hotspot_x: 0,
            hotspot_y: 0,
            width: 0,
            height: 0,
            rgba: Vec::new(),
        });
    }
    if width > MAX_CURSOR_DIMENSION || height > MAX_CURSOR_DIMENSION {
        return Err(format!(
            "rich cursor dimensions {width}x{height} exceed {MAX_CURSOR_DIMENSION}x{MAX_CURSOR_DIMENSION}"
        ));
    }
    if hotspot_x >= width || hotspot_y >= height {
        return Err(format!(
            "rich cursor hotspot {hotspot_x},{hotspot_y} lies outside {width}x{height}"
        ));
    }

    let pixel_count = usize::from(width)
        .checked_mul(usize::from(height))
        .ok_or_else(|| "rich cursor pixel byte count overflow".to_string())?;
    let pixel_bytes = pixel_count
        .checked_mul(conv.bytes_per_pixel())
        .ok_or_else(|| "rich cursor pixel byte count overflow".to_string())?;
    let mask_stride = usize::from(width).div_ceil(8);
    let mask_bytes = mask_stride
        .checked_mul(usize::from(height))
        .ok_or_else(|| "rich cursor mask byte count overflow".to_string())?;

    let mut wire = vec![0u8; pixel_bytes];
    reader
        .read_exact(&mut wire)
        .map_err(|e| format!("rich cursor pixels: {e}"))?;
    let mut rgba = vec![0u8; pixel_count * 4];
    conv.convert_row(&wire, &mut rgba);
    let mut mask = vec![0u8; mask_bytes];
    reader
        .read_exact(&mut mask)
        .map_err(|e| format!("rich cursor mask: {e}"))?;

    for row in 0..usize::from(height) {
        for column in 0..usize::from(width) {
            let mask_byte = mask[row * mask_stride + column / 8];
            let visible = mask_byte & (0x80 >> (column % 8)) != 0;
            rgba[(row * usize::from(width) + column) * 4 + 3] = if visible { 255 } else { 0 };
        }
    }

    Ok(DecodedCursor {
        hotspot_x,
        hotspot_y,
        width,
        height,
        rgba,
    })
}

/// Decode the XCursor pseudo-encoding (-240). The payload contains foreground
/// and background RGB colours, followed by one-bit image and transparency
/// bitmaps whose rows are padded to whole bytes. A set image bit selects the
/// foreground colour; a set mask bit makes the pixel visible.
pub fn read_x_cursor<R: Read>(
    reader: &mut R,
    hotspot_x: u16,
    hotspot_y: u16,
    width: u16,
    height: u16,
) -> Result<DecodedCursor, String> {
    if width == 0 || height == 0 {
        return Ok(DecodedCursor {
            hotspot_x: 0,
            hotspot_y: 0,
            width: 0,
            height: 0,
            rgba: Vec::new(),
        });
    }
    if width > MAX_CURSOR_DIMENSION || height > MAX_CURSOR_DIMENSION {
        return Err(format!(
            "X cursor dimensions {width}x{height} exceed {MAX_CURSOR_DIMENSION}x{MAX_CURSOR_DIMENSION}"
        ));
    }
    if hotspot_x >= width || hotspot_y >= height {
        return Err(format!(
            "X cursor hotspot {hotspot_x},{hotspot_y} lies outside {width}x{height}"
        ));
    }

    let pixel_count = usize::from(width)
        .checked_mul(usize::from(height))
        .ok_or_else(|| "X cursor pixel count overflow".to_string())?;
    let rgba_bytes = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "X cursor RGBA byte count overflow".to_string())?;
    let bitmap_stride = usize::from(width).div_ceil(8);
    let bitmap_bytes = bitmap_stride
        .checked_mul(usize::from(height))
        .ok_or_else(|| "X cursor bitmap byte count overflow".to_string())?;

    let mut colours = [0u8; 6];
    reader
        .read_exact(&mut colours)
        .map_err(|e| format!("X cursor colours: {e}"))?;
    let mut bitmap = vec![0u8; bitmap_bytes];
    reader
        .read_exact(&mut bitmap)
        .map_err(|e| format!("X cursor bitmap: {e}"))?;
    let mut mask = vec![0u8; bitmap_bytes];
    reader
        .read_exact(&mut mask)
        .map_err(|e| format!("X cursor mask: {e}"))?;

    let mut rgba = vec![0u8; rgba_bytes];
    for row in 0..usize::from(height) {
        for column in 0..usize::from(width) {
            let bit = 0x80 >> (column % 8);
            let bitmap_offset = row * bitmap_stride + column / 8;
            let colour_offset = if bitmap[bitmap_offset] & bit != 0 {
                0
            } else {
                3
            };
            let rgba_offset = (row * usize::from(width) + column) * 4;
            rgba[rgba_offset..rgba_offset + 3]
                .copy_from_slice(&colours[colour_offset..colour_offset + 3]);
            rgba[rgba_offset + 3] = if mask[bitmap_offset] & bit != 0 {
                255
            } else {
                0
            };
        }
    }

    Ok(DecodedCursor {
        hotspot_x,
        hotspot_y,
        width,
        height,
        rgba,
    })
}
