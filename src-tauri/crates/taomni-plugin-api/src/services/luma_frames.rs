//! Existing TQF1 layout, checked before allocating or handing bytes to a QR
//! decoder. Screen pixels never pass through JSON/base64.
use crate::{ErrorCode, RpcError};

pub const MAX_CAPTURE_BYTES: usize = 64 * 1024 * 1024;
const MAGIC: &[u8; 4] = b"TQF1";

#[derive(Debug, PartialEq, Eq)]
pub struct LumaFrameRef<'a> {
    pub width: u32,
    pub height: u32,
    pub luma: &'a [u8],
}

fn invalid() -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, "Invalid luma frame container")
}

fn pixels(width: u32, height: u32) -> Result<usize, RpcError> {
    if width == 0 || height == 0 {
        return Err(invalid());
    }
    (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(invalid)
}

pub fn encode_luma_frames(frames: &[LumaFrameRef<'_>]) -> Result<Vec<u8>, RpcError> {
    if frames.is_empty() || frames.len() > u32::MAX as usize {
        return Err(invalid());
    }
    let mut length = 8usize;
    for frame in frames {
        if pixels(frame.width, frame.height)? != frame.luma.len() {
            return Err(invalid());
        }
        length = length
            .checked_add(8)
            .and_then(|n| n.checked_add(frame.luma.len()))
            .filter(|n| *n <= MAX_CAPTURE_BYTES)
            .ok_or_else(invalid)?;
    }
    let mut output = Vec::with_capacity(length);
    output.extend_from_slice(MAGIC);
    output.extend_from_slice(&(frames.len() as u32).to_le_bytes());
    for frame in frames {
        output.extend_from_slice(&frame.width.to_le_bytes());
        output.extend_from_slice(&frame.height.to_le_bytes());
        output.extend_from_slice(frame.luma);
    }
    Ok(output)
}

pub fn validate_luma_frames(bytes: &[u8]) -> Result<(), RpcError> {
    visit_luma_frames(bytes, |_| Ok(()))
}

/// Borrow each validated frame in display order. A malformed later frame or
/// trailing data still fails the call after earlier frames have been visited.
pub fn visit_luma_frames(
    bytes: &[u8],
    mut visit: impl FnMut(LumaFrameRef<'_>) -> Result<(), RpcError>,
) -> Result<(), RpcError> {
    if bytes.len() < 8 || bytes.len() > MAX_CAPTURE_BYTES || &bytes[..4] != MAGIC {
        return Err(invalid());
    }
    let count = u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| invalid())?) as usize;
    // Each nonempty frame needs eight header bytes and at least one pixel.
    // Check before iterating an untrusted frame count, without allocating it.
    if count == 0 || count > (bytes.len() - 8) / 9 {
        return Err(invalid());
    }
    let mut offset = 8usize;
    for _ in 0..count {
        let header = bytes
            .get(offset..offset.checked_add(8).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        let width = u32::from_le_bytes(header[..4].try_into().map_err(|_| invalid())?);
        let height = u32::from_le_bytes(header[4..].try_into().map_err(|_| invalid())?);
        let start = offset + 8;
        offset = start
            .checked_add(pixels(width, height)?)
            .filter(|n| *n <= bytes.len())
            .ok_or_else(invalid)?;
        visit(LumaFrameRef {
            width,
            height,
            luma: &bytes[start..offset],
        })?;
    }
    if offset != bytes.len() {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_multidisplay_wire_layout_roundtrips_without_json() {
        let bytes = encode_luma_frames(&[
            LumaFrameRef {
                width: 2,
                height: 1,
                luma: &[0, 255],
            },
            LumaFrameRef {
                width: 1,
                height: 2,
                luma: &[64, 128],
            },
        ])
        .unwrap();
        assert_eq!(&bytes[..8], b"TQF1\x02\0\0\0");
        assert_eq!(bytes.len(), 28);
        validate_luma_frames(&bytes).unwrap();
        for end in 0..bytes.len() {
            assert!(validate_luma_frames(&bytes[..end]).is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(validate_luma_frames(&trailing).is_err());
        for index in [0, 4, 8, 12] {
            let mut invalid = bytes.clone();
            invalid[index..index + 4].fill(255);
            assert!(validate_luma_frames(&invalid).is_err());
        }
    }

    #[test]
    fn bad_geometry_and_empty_payloads_fail_before_output_allocation() {
        for (width, height, luma) in [
            (0, 1, &[][..]),
            (1, 0, &[][..]),
            (2, 2, &[1][..]),
            (u32::MAX, u32::MAX, &[][..]),
        ] {
            assert!(
                encode_luma_frames(&[LumaFrameRef {
                    width,
                    height,
                    luma
                }])
                .is_err()
            );
        }
        assert!(encode_luma_frames(&[]).is_err());
        assert!(validate_luma_frames(b"TQF1\0\0\0\0").is_err());
    }
}
