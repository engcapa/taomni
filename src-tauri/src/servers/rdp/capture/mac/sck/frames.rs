use crate::servers::rdp::capture::mac::Frame;
use objc2_core_foundation::CFDictionary;
use objc2_core_foundation::CFNumber;
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::CVPixelBufferGetBytesPerRow;
use objc2_core_video::CVPixelBufferGetHeight;
use objc2_core_video::CVPixelBufferGetPixelFormatType;
use objc2_core_video::CVPixelBufferGetWidth;
use objc2_core_video::kCVPixelFormatType_32BGRA;
use objc2_screen_capture_kit::SCFrameStatus;
use objc2_screen_capture_kit::SCStreamFrameInfoStatus;

/// Retain one ScreenCaptureKit IOSurface without reading its BGRA bytes.
///
/// Returns `Ok(None)` for an incomplete or idle sample, including idle samples
/// that still retain the previous image buffer. The attachment status, rather
/// than image-buffer presence, determines whether new pixels are available.
pub(super) fn retain_bgra_frame(sample_buffer: &CMSampleBuffer) -> anyhow::Result<Option<Frame>> {
    if sample_frame_status(sample_buffer).is_some_and(|status| status != SCFrameStatus::Complete) {
        return Ok(None);
    }
    let image_buffer = unsafe { sample_buffer.image_buffer() };
    let Some(pixel_buffer) = image_buffer else {
        return Ok(None);
    };
    if CVPixelBufferGetPixelFormatType(&pixel_buffer) != kCVPixelFormatType_32BGRA {
        anyhow::bail!("ScreenCaptureKit sample was not delivered as BGRA");
    }
    let width = u16::try_from(CVPixelBufferGetWidth(&pixel_buffer))
        .map_err(|_| anyhow::anyhow!("captured display width exceeds RDP limits"))?;
    let height = u16::try_from(CVPixelBufferGetHeight(&pixel_buffer))
        .map_err(|_| anyhow::anyhow!("captured display height exceeds RDP limits"))?;
    let stride = CVPixelBufferGetBytesPerRow(&pixel_buffer);
    let row_bytes = usize::from(width)
        .checked_mul(4)
        .ok_or_else(|| anyhow::anyhow!("ScreenCaptureKit row width overflow"))?;
    if width == 0 || height == 0 || stride < row_bytes {
        anyhow::bail!("ScreenCaptureKit returned an invalid BGRA surface");
    }
    stride
        .checked_mul(usize::from(height))
        .ok_or_else(|| anyhow::anyhow!("ScreenCaptureKit surface size overflow"))?;

    Ok(Some(Frame::native_bgra(
        pixel_buffer,
        width,
        height,
        stride,
    )))
}

pub(super) fn sample_frame_status(sample_buffer: &CMSampleBuffer) -> Option<SCFrameStatus> {
    // CoreMedia owns these dictionaries and ScreenCaptureKit defines the
    // status value as an NSNumber (toll-free bridged to CFNumber).
    let attachments = unsafe { sample_buffer.sample_attachments_array(false) }?;
    if attachments.count() == 0 {
        return None;
    }
    let dictionary = unsafe {
        attachments
            .value_at_index(0)
            .cast::<CFDictionary>()
            .as_ref()
    }?;
    let key = std::ptr::from_ref(unsafe { SCStreamFrameInfoStatus });
    let number = unsafe { dictionary.value(key.cast()).cast::<CFNumber>().as_ref() }?;
    number.as_isize().map(SCFrameStatus)
}

pub(super) fn frame_dimensions(frame: &Frame) -> anyhow::Result<(u16, u16)> {
    if frame.width == 0 || frame.height == 0 || frame.stride < usize::from(frame.width) * 4 {
        anyhow::bail!("ScreenCaptureKit returned an invalid BGRA frame");
    }
    let expected = frame
        .stride
        .checked_mul(usize::from(frame.height))
        .ok_or_else(|| anyhow::anyhow!("ScreenCaptureKit frame size overflow"))?;
    if frame.byte_len() != expected {
        anyhow::bail!(
            "ScreenCaptureKit frame has {} bytes; expected {expected}",
            frame.byte_len()
        );
    }
    Ok((frame.width, frame.height))
}
