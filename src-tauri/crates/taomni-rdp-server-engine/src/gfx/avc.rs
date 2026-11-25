use core::ffi::c_void;
use objc2_core_foundation::CFRetained;
use objc2_core_media::CMBlockBuffer;
use objc2_core_media::CMSampleBuffer;
use objc2_core_media::CMVideoFormatDescriptionGetH264ParameterSetAtIndex;
use objc2_core_video::CVImageBuffer;
use objc2_core_video::CVPixelBuffer;
use objc2_video_toolbox::VTCompressionSession;
use objc2_video_toolbox::VTSession;
use std::ptr;
use std::ptr::NonNull;

pub(super) fn ensure_status(status: i32, operation: &str) -> anyhow::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        anyhow::bail!("{operation} failed (status {status})")
    }
}

/// VideoToolbox's APIs model all session variants as `VTSession` (CFType),
/// while the compression API returns its concrete opaque subtype. The cast is
/// the documented C ABI relationship and does not change ownership.
pub(super) unsafe fn compression_as_vt_session(
    session: &CFRetained<VTCompressionSession>,
) -> &VTSession {
    unsafe { &*(session.as_ref() as *const VTCompressionSession).cast::<VTSession>() }
}

/// CVPixelBuffer is a CVImageBuffer subtype in the CoreVideo C ABI.
pub(super) unsafe fn pixel_buffer_as_image_buffer(
    pixel_buffer: &CFRetained<CVPixelBuffer>,
) -> &CVImageBuffer {
    unsafe { &*(pixel_buffer.as_ref() as *const CVPixelBuffer).cast::<CVImageBuffer>() }
}

/// Convert one VideoToolbox sample into the AVC byte-stream form required by
/// `RFX_AVC420_BITMAP_STREAM`. CoreMedia stores encoded samples as AVCC, but
/// the NAL length prefix is allowed to vary with the encoder configuration;
/// MS-RDPEGFX requires every NAL in the wire payload to use a four-byte
/// big-endian length prefix. SPS/PPS live in the format description, so they
/// are prepended to every frame to make a newly-created surface independently
/// decodable.
pub(super) unsafe fn sample_to_avc(sample: &CMSampleBuffer) -> anyhow::Result<Vec<u8>> {
    let block: CFRetained<CMBlockBuffer> = unsafe { sample.data_buffer() }
        .ok_or_else(|| anyhow::anyhow!("VideoToolbox returned H.264 without a data buffer"))?;
    let data_length = unsafe { block.data_length() };
    let mut h264 = vec![0; data_length];
    if data_length > 0 {
        let destination = NonNull::new(h264.as_mut_ptr().cast::<c_void>())
            .ok_or_else(|| anyhow::anyhow!("cannot copy an empty H.264 data buffer"))?;
        ensure_status(
            unsafe { block.copy_data_bytes(0, data_length, destination) },
            "copy VideoToolbox H.264 data",
        )?;
    }

    // VideoToolbox emits AVCC slices but stores SPS/PPS in the sample's format
    // description. Prefix the parameter sets on every frame: the cost is tiny,
    // while it makes each freshly-created RDP EGFX surface independently
    // decodable and avoids a stale decoder after a client reconnect.
    let description = unsafe { sample.format_description() }
        .ok_or_else(|| anyhow::anyhow!("VideoToolbox H.264 sample has no format description"))?;
    let mut count = 0;
    let mut nal_header_length = 0;
    ensure_status(
        unsafe {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                &description,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut count,
                &mut nal_header_length,
            )
        },
        "read VideoToolbox H.264 parameter-set count",
    )?;
    let nal_header_length = usize::try_from(nal_header_length)
        .ok()
        .filter(|length| (1..=4).contains(length))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "VideoToolbox returned invalid H.264 NAL header length {nal_header_length}"
            )
        })?;

    let mut output = Vec::with_capacity(h264.len().saturating_add(128));
    for index in 0..count {
        let mut pointer = ptr::null();
        let mut length = 0;
        ensure_status(
            unsafe {
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    &description,
                    index,
                    &mut pointer,
                    &mut length,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            "read VideoToolbox H.264 parameter set",
        )?;
        let length = u32::try_from(length)
            .map_err(|_| anyhow::anyhow!("VideoToolbox H.264 parameter set is too large"))?;
        if pointer.is_null() || length == 0 {
            anyhow::bail!("VideoToolbox returned an empty H.264 parameter set");
        }
        let parameter_set = unsafe { std::slice::from_raw_parts(pointer, length as usize) };
        append_avc_nal(&mut output, parameter_set)?;
    }
    avcc_to_four_byte(&h264, nal_header_length, &mut output)?;
    Ok(output)
}

pub(super) fn append_avc_nal(output: &mut Vec<u8>, nal: &[u8]) -> anyhow::Result<()> {
    let length = u32::try_from(nal.len())
        .map_err(|_| anyhow::anyhow!("H.264 NAL unit is too large for AVC wire format"))?;
    if length == 0 {
        anyhow::bail!("AVC stream contains an empty NAL unit");
    }
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(nal);
    Ok(())
}

pub(super) fn avcc_to_four_byte(
    avcc: &[u8],
    nal_header_length: usize,
    output: &mut Vec<u8>,
) -> anyhow::Result<()> {
    if !(1..=4).contains(&nal_header_length) {
        anyhow::bail!("invalid AVCC NAL header length {nal_header_length}");
    }

    let mut offset = 0usize;
    let mut nal_count = 0usize;
    while offset < avcc.len() {
        let header_end = offset
            .checked_add(nal_header_length)
            .filter(|end| *end <= avcc.len())
            .ok_or_else(|| anyhow::anyhow!("truncated AVCC NAL length at byte {offset}"))?;
        let nal_length = avcc[offset..header_end]
            .iter()
            .fold(0usize, |value, byte| (value << 8) | usize::from(*byte));
        if nal_length == 0 {
            anyhow::bail!("AVCC sample contains an empty NAL unit at byte {offset}");
        }
        let nal_end = header_end
            .checked_add(nal_length)
            .filter(|end| *end <= avcc.len())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "AVCC NAL at byte {offset} declares {nal_length} bytes beyond the sample"
                )
            })?;
        append_avc_nal(output, &avcc[header_end..nal_end])?;
        offset = nal_end;
        nal_count += 1;
    }

    if nal_count == 0 {
        anyhow::bail!("VideoToolbox returned an empty H.264 sample");
    }
    Ok(())
}
