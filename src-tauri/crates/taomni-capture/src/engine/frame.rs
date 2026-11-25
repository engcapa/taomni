//! BGRA frame ownership and lazy native pixel readback.

#[cfg(target_os = "macos")]
use objc2_core_foundation::CFRetained;
#[cfg(target_os = "macos")]
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVReturnSuccess,
};
use std::time::Instant;
#[cfg(target_os = "macos")]
use std::{
    fmt, slice,
    sync::{Arc, OnceLock},
};

/// One captured frame or sub-region: BGRA8888, `stride` bytes per row,
/// `height` rows. `x`/`y` are the top-left origin of this region within the
/// desktop (0,0 for a full-screen frame), so the display layer can place a
/// cropped damage rectangle at the right offset in the client's framebuffer.
#[derive(Clone, Debug)]
pub struct Frame {
    /// Reference-counted pixels make retaining the most recent complete frame
    /// cheap. A newly authenticated client can replay that frame immediately
    /// instead of waiting several seconds for a new native capture stream.
    pub data: bytes::Bytes,
    /// ScreenCaptureKit's retained IOSurface. The regular bitmap path copies it
    /// lazily, while VideoToolbox consumes it directly without a BGRA roundtrip.
    #[cfg(target_os = "macos")]
    native: Option<NativeBgraFrame>,
    /// Monotonic timestamp taken after the backend has produced the pixels.
    /// It lets the display handoff report frame age without relying on wall
    /// clock time or carrying user-visible data into telemetry.
    pub captured_at: Instant,
    /// Assigned by the capture loop immediately before publication.
    pub sequence: u64,
    /// Region origin within the desktop, in pixels.
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    /// Bytes per row (`>= width * 4`).
    pub stride: usize,
}

impl Frame {
    pub fn bgra(data: Vec<u8>, x: u16, y: u16, width: u16, height: u16, stride: usize) -> Self {
        Self {
            data: data.into(),
            #[cfg(target_os = "macos")]
            native: None,
            captured_at: Instant::now(),
            sequence: 0,
            x,
            y,
            width,
            height,
            stride,
        }
    }

    #[cfg(target_os = "macos")]
    pub fn native_bgra(
        pixel_buffer: CFRetained<CVPixelBuffer>,
        width: u16,
        height: u16,
        stride: usize,
    ) -> Self {
        Self {
            data: bytes::Bytes::new(),
            native: Some(NativeBgraFrame::new(pixel_buffer, stride, height)),
            captured_at: Instant::now(),
            sequence: 0,
            x: 0,
            y: 0,
            width,
            height,
            stride,
        }
    }

    /// Logical BGRA payload size without forcing a native IOSurface readback.
    pub fn byte_len(&self) -> usize {
        #[cfg(target_os = "macos")]
        if let Some(native) = &self.native {
            return native.byte_len();
        }
        self.data.len()
    }

    /// Return owned BGRA pixels for the compatibility bitmap path. Native
    /// frames are copied at most once across all clones of the retained frame.
    pub fn bgra_bytes(&self) -> anyhow::Result<bytes::Bytes> {
        #[cfg(target_os = "macos")]
        if let Some(native) = &self.native {
            return native.bgra_bytes();
        }
        Ok(self.data.clone())
    }

    #[cfg(target_os = "macos")]
    pub fn native_pixel_buffer(&self) -> Option<CFRetained<CVPixelBuffer>> {
        self.native.as_ref().map(NativeBgraFrame::pixel_buffer)
    }

    #[cfg(target_os = "macos")]
    pub fn copy_bgra_rows_to(&self, output: &mut [u8], output_stride: usize) -> anyhow::Result<()> {
        let row_bytes = usize::from(self.width)
            .checked_mul(4)
            .ok_or_else(|| anyhow::anyhow!("BGRA row size overflow"))?;
        if self.stride < row_bytes || output_stride < row_bytes {
            anyhow::bail!("BGRA row stride is smaller than the visible row");
        }
        let output_len = output_stride
            .checked_mul(usize::from(self.height))
            .ok_or_else(|| anyhow::anyhow!("BGRA output size overflow"))?;
        if output.len() < output_len {
            anyhow::bail!(
                "BGRA output has {} bytes; expected at least {output_len}",
                output.len()
            );
        }
        if let Some(native) = &self.native {
            return native.copy_rows_to(output, output_stride, self.stride, row_bytes, self.height);
        }
        let source_len = self
            .stride
            .checked_mul(usize::from(self.height))
            .ok_or_else(|| anyhow::anyhow!("BGRA source size overflow"))?;
        if self.data.len() < source_len {
            anyhow::bail!(
                "BGRA source has {} bytes; expected at least {source_len}",
                self.data.len()
            );
        }
        copy_rows(
            &self.data,
            self.stride,
            output,
            output_stride,
            row_bytes,
            self.height,
        );
        Ok(())
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct NativeBgraFrame {
    inner: Arc<NativeBgraFrameInner>,
}

#[cfg(target_os = "macos")]
struct NativeBgraFrameInner {
    pixel_buffer: CFRetained<CVPixelBuffer>,
    byte_len: usize,
    copied: OnceLock<Result<bytes::Bytes, String>>,
}

// CVPixelBuffer/IOSurface objects are retainable, lockable CoreVideo buffers
// intended for cross-queue media pipelines. Access to mutable base-address
// state is serialized by CoreVideo's lock API, and the lazy copy is OnceLock.
#[cfg(target_os = "macos")]
unsafe impl Send for NativeBgraFrameInner {}
#[cfg(target_os = "macos")]
unsafe impl Sync for NativeBgraFrameInner {}

#[cfg(target_os = "macos")]
impl NativeBgraFrame {
    fn new(pixel_buffer: CFRetained<CVPixelBuffer>, stride: usize, height: u16) -> Self {
        Self {
            inner: Arc::new(NativeBgraFrameInner {
                pixel_buffer,
                byte_len: stride.saturating_mul(usize::from(height)),
                copied: OnceLock::new(),
            }),
        }
    }

    fn byte_len(&self) -> usize {
        self.inner.byte_len
    }

    fn pixel_buffer(&self) -> CFRetained<CVPixelBuffer> {
        self.inner.pixel_buffer.clone()
    }

    fn bgra_bytes(&self) -> anyhow::Result<bytes::Bytes> {
        self.inner
            .copied
            .get_or_init(|| copy_pixel_buffer(&self.inner.pixel_buffer, self.inner.byte_len))
            .as_ref()
            .cloned()
            .map_err(|error| anyhow::anyhow!(error.clone()))
    }

    fn copy_rows_to(
        &self,
        output: &mut [u8],
        output_stride: usize,
        source_stride: usize,
        row_bytes: usize,
        height: u16,
    ) -> anyhow::Result<()> {
        with_pixel_buffer_bytes(&self.inner.pixel_buffer, self.inner.byte_len, |source| {
            copy_rows(
                source,
                source_stride,
                output,
                output_stride,
                row_bytes,
                height,
            );
            Ok(())
        })
        .map_err(anyhow::Error::msg)
    }
}

#[cfg(target_os = "macos")]
impl fmt::Debug for NativeBgraFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeBgraFrame")
            .field("byte_len", &self.inner.byte_len)
            .field("copied", &self.inner.copied.get().is_some())
            .finish_non_exhaustive()
    }
}

#[cfg(target_os = "macos")]
fn copy_pixel_buffer(
    pixel_buffer: &CVPixelBuffer,
    byte_len: usize,
) -> Result<bytes::Bytes, String> {
    with_pixel_buffer_bytes(pixel_buffer, byte_len, |data| {
        Ok(bytes::Bytes::copy_from_slice(data))
    })
}

#[cfg(target_os = "macos")]
fn with_pixel_buffer_bytes<T>(
    pixel_buffer: &CVPixelBuffer,
    byte_len: usize,
    operation: impl FnOnce(&[u8]) -> Result<T, String>,
) -> Result<T, String> {
    let lock_result =
        unsafe { CVPixelBufferLockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly) };
    if lock_result != kCVReturnSuccess {
        return Err(format!(
            "could not lock ScreenCaptureKit pixel buffer ({lock_result})"
        ));
    }

    let result = (|| {
        let base = CVPixelBufferGetBaseAddress(pixel_buffer);
        if base.is_null() {
            return Err("ScreenCaptureKit returned a null BGRA surface address".to_string());
        }
        let data = unsafe { slice::from_raw_parts(base.cast::<u8>(), byte_len) };
        operation(data)
    })();

    let unlock_result =
        unsafe { CVPixelBufferUnlockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly) };
    if unlock_result != kCVReturnSuccess {
        return Err(format!(
            "could not unlock ScreenCaptureKit pixel buffer ({unlock_result})"
        ));
    }
    result
}

#[cfg(target_os = "macos")]
fn copy_rows(
    source: &[u8],
    source_stride: usize,
    output: &mut [u8],
    output_stride: usize,
    row_bytes: usize,
    height: u16,
) {
    for row in 0..usize::from(height) {
        let source_start = row * source_stride;
        let output_start = row * output_stride;
        output[output_start..output_start + row_bytes]
            .copy_from_slice(&source[source_start..source_start + row_bytes]);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use core::ffi::c_void;
    use std::ptr::{self, NonNull};

    use objc2_core_foundation::CFRetained;
    use objc2_core_video::{
        CVPixelBuffer, CVPixelBufferCreateWithBytes, kCVPixelFormatType_32BGRA, kCVReturnSuccess,
    };

    use super::Frame;

    fn native_frame(data: &mut [u8], width: u16, height: u16) -> Frame {
        let stride = usize::from(width) * 4;
        let mut raw = ptr::null_mut();
        let status = unsafe {
            CVPixelBufferCreateWithBytes(
                None,
                usize::from(width),
                usize::from(height),
                kCVPixelFormatType_32BGRA,
                NonNull::new(data.as_mut_ptr().cast::<c_void>()).unwrap(),
                stride,
                None,
                ptr::null_mut(),
                None,
                NonNull::from(&mut raw),
            )
        };
        assert_eq!(status, kCVReturnSuccess);
        let pixel_buffer: CFRetained<CVPixelBuffer> =
            unsafe { CFRetained::from_raw(NonNull::new(raw).unwrap()) };
        Frame::native_bgra(pixel_buffer, width, height, stride)
    }

    #[test]
    fn native_padding_copy_does_not_materialize_an_intermediate_frame() {
        let mut source = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let frame = native_frame(&mut source, 2, 1);
        let mut padded = vec![0; 16];

        frame.copy_bgra_rows_to(&mut padded, 16).unwrap();

        assert_eq!(&padded[..8], source.as_slice());
        assert_eq!(&padded[8..], &[0; 8]);
        assert!(
            frame.native.as_ref().unwrap().inner.copied.get().is_none(),
            "VideoToolbox padding must not allocate a second full BGRA frame"
        );
    }

    #[test]
    fn bitmap_readback_is_cached_across_native_frame_clones() {
        let mut source = vec![9, 8, 7, 6];
        let frame = native_frame(&mut source, 1, 1);
        let clone = frame.clone();

        let first = frame.bgra_bytes().unwrap();
        let second = clone.bgra_bytes().unwrap();

        assert_eq!(first.as_ref(), source.as_slice());
        assert_eq!(first.as_ptr(), second.as_ptr());
    }
}
