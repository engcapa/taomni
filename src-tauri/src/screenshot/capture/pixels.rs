use crate::servers::rdp::capture::Frame;
use anyhow::Context;
use image::RgbaImage;

/// Clamp a region to the image and crop it.
pub fn crop(image: &RgbaImage, x: u32, y: u32, width: u32, height: u32) -> RgbaImage {
    let (rx, ry, rw, rh) = clamp_region(image.width(), image.height(), (x, y, width, height));
    image::imageops::crop_imm(image, rx, ry, rw, rh).to_image()
}

/// Clamp `(x, y, w, h)` into a `full_w` x `full_h` image (at least 1x1).
pub fn clamp_region(
    full_w: u32,
    full_h: u32,
    region: (u32, u32, u32, u32),
) -> (u32, u32, u32, u32) {
    let (x, y, w, h) = region;
    let x = x.min(full_w.saturating_sub(1));
    let y = y.min(full_h.saturating_sub(1));
    let w = w.min(full_w - x).max(1);
    let h = h.min(full_h - y).max(1);
    (x, y, w, h)
}

/// Map a region given in display physical pixels into a frame whose size
/// differs from the display (e.g. ScreenCaptureKit streams in points).
pub fn map_region(
    region: (u32, u32, u32, u32),
    display: (u32, u32),
    frame: (u32, u32),
) -> (u32, u32, u32, u32) {
    if display == frame || display.0 == 0 || display.1 == 0 {
        return clamp_region(frame.0, frame.1, region);
    }
    let sx = frame.0 as f64 / display.0 as f64;
    let sy = frame.1 as f64 / display.1 as f64;
    let (x, y, w, h) = region;
    clamp_region(
        frame.0,
        frame.1,
        (
            (x as f64 * sx).round() as u32,
            (y as f64 * sy).round() as u32,
            (w as f64 * sx).round() as u32,
            (h as f64 * sy).round() as u32,
        ),
    )
}

/// Convert a BGRA capture frame (any stride) to RGBA.
pub(crate) fn frame_to_rgba(frame: &Frame) -> anyhow::Result<RgbaImage> {
    frame_region_to_rgba(
        frame,
        (0, 0, u32::from(frame.width), u32::from(frame.height)),
    )
}

pub(super) fn frame_region_to_rgba(
    frame: &Frame,
    region: (u32, u32, u32, u32),
) -> anyhow::Result<RgbaImage> {
    let width = u32::from(frame.width);
    let height = u32::from(frame.height);
    if width == 0 || height == 0 {
        anyhow::bail!("capturer returned an empty frame");
    }
    let bytes = frame.bgra_bytes().context("read frame pixels")?;
    if frame.stride < width as usize * 4 {
        anyhow::bail!("frame stride is smaller than the visible row");
    }
    let (x, y, width, height) = clamp_region(width, height, region);
    let row_bytes = width as usize * 4;
    let mut rgba = vec![0u8; row_bytes * height as usize];
    for (row, out) in rgba.chunks_exact_mut(row_bytes).enumerate() {
        let start = (row + y as usize) * frame.stride + x as usize * 4;
        let src = bytes
            .get(start..start + row_bytes)
            .context("frame row out of bounds")?;
        out.copy_from_slice(src);
        for px in out.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
    }
    RgbaImage::from_raw(width, height, rgba).context("build rgba image")
}
