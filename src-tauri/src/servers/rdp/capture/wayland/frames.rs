use super::mailbox::RawFrame;
use crate::servers::rdp::capture::Frame;
use anyhow::Context as _;
use anyhow::bail;

pub(super) fn map_absolute_coordinate(value: f64, surface_extent: u16, logical_extent: u32) -> f64 {
    if surface_extent <= 1 || logical_extent == 0 {
        return 0.0;
    }
    let max = f64::from(surface_extent - 1);
    value.clamp(0.0, max) * f64::from(logical_extent) / f64::from(surface_extent)
}

pub(super) fn raw_to_frame(raw: RawFrame) -> anyhow::Result<Frame> {
    let width = u16::try_from(raw.width).context("Wayland stream width exceeds RDP limits")?;
    let height = u16::try_from(raw.height).context("Wayland stream height exceeds RDP limits")?;
    let stride = usize::from(width)
        .checked_mul(4)
        .context("Wayland frame stride overflow")?;
    let expected = stride
        .checked_mul(usize::from(height))
        .context("Wayland frame size overflow")?;
    if width == 0 || height == 0 || raw.bgra.len() != expected {
        bail!(
            "invalid Wayland frame geometry {}x{} for {} bytes",
            width,
            height,
            raw.bgra.len()
        );
    }
    let mut frame = Frame::bgra(raw.bgra, 0, 0, width, height, stride);
    frame.captured_at = raw.captured_at;
    Ok(frame)
}
