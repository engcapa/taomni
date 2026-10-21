use super::avc::compression_as_vt_session;
use super::avc::ensure_status;
use super::avc::pixel_buffer_as_image_buffer;
use super::avc::sample_to_avc;
use super::flow_control::ENCODE_FLUSH_DELAY;
use super::flow_control::ENCODE_TIMEOUT;
use super::flow_control::MAX_ENCODER_FRAMES_IN_FLIGHT;
use crate::servers::rdp::capture::Frame;
use core::ffi::c_void;
use objc2_core_foundation::CFBoolean;
use objc2_core_foundation::CFNumber;
use objc2_core_foundation::CFRetained;
use objc2_core_media::CMSampleBuffer;
use objc2_core_media::CMTime;
use objc2_core_media::kCMTimeInvalid;
use objc2_core_media::kCMVideoCodecType_H264;
use objc2_core_video::CVImageBuffer;
use objc2_core_video::CVPixelBuffer;
use objc2_core_video::CVPixelBufferCreateWithBytes;
use objc2_core_video::kCVPixelFormatType_32BGRA;
use objc2_core_video::kCVReturnSuccess;
use objc2_video_toolbox::VTCompressionSession;
use objc2_video_toolbox::VTSessionSetProperty;
use objc2_video_toolbox::kVTCompressionPropertyKey_AllowFrameReordering;
use objc2_video_toolbox::kVTCompressionPropertyKey_MaxFrameDelayCount;
use objc2_video_toolbox::kVTCompressionPropertyKey_RealTime;
use std::collections::VecDeque;
use std::ptr;
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::mpsc::UnboundedSender;

/// Per-client VideoToolbox H.264 encoder. It stays inside the display updater
/// (and its dedicated RDP runtime thread), rather than the capture callback or
/// shared EGFX lock, so the capture source never waits for codec work.
pub(crate) struct H264Encoder {
    pub(super) session: CFRetained<VTCompressionSession>,
    pub(super) callback_state: Arc<EncoderCallbackState>,
    pub(super) output: UnboundedReceiver<EncodedFrame>,
    pub(super) width: u16,
    pub(super) height: u16,
    pub(super) encoded_width: u16,
    pub(super) encoded_height: u16,
    pub(super) next_timestamp: i64,
    pub(super) next_frame_id: usize,
}

pub(super) struct EncoderCallbackState {
    pub(super) sender: UnboundedSender<EncodedFrame>,
    pub(super) pending: Mutex<VecDeque<(usize, PendingInput)>>,
    pub(super) in_flight: AtomicUsize,
}

pub(super) struct PendingInput {
    pub(super) _pixel_buffer: CFRetained<CVPixelBuffer>,
    pub(super) _padded_input: Option<Vec<u8>>,
    pub(super) frame: Frame,
    pub(super) submitted_at: Instant,
    pub(super) flushed: bool,
}

pub(crate) struct EncodedFrame {
    pub(crate) frame: Frame,
    pub(crate) result: anyhow::Result<Vec<u8>>,
}

// `RdpServerDisplayUpdates` requires a `Send` future even though Taomni runs
// this server on one dedicated current-thread runtime. VideoToolbox sessions
// are explicitly driven serially by that updater; we never share a session or
// use it concurrently. Moving the owning updater before its first poll is
// therefore safe, while declaring `Sync` would not be.
unsafe impl Send for H264Encoder {}

impl H264Encoder {
    pub(crate) fn new(width: u16, height: u16) -> anyhow::Result<Self> {
        let encoded_width = align_dimension(width)?;
        let encoded_height = align_dimension(height)?;
        let (output_tx, output) = tokio::sync::mpsc::unbounded_channel();
        let callback_state = Arc::new(EncoderCallbackState {
            sender: output_tx,
            pending: Mutex::new(VecDeque::new()),
            in_flight: AtomicUsize::new(0),
        });
        let mut raw = ptr::null_mut();
        let status = unsafe {
            VTCompressionSession::create(
                None,
                i32::from(encoded_width),
                i32::from(encoded_height),
                kCMVideoCodecType_H264,
                None,
                None,
                None,
                Some(on_h264_encoded),
                Arc::as_ptr(&callback_state).cast_mut().cast(),
                NonNull::from(&mut raw),
            )
        };
        ensure_status(status, "create VideoToolbox H.264 encoder")?;
        let raw = NonNull::new(raw)
            .ok_or_else(|| anyhow::anyhow!("VideoToolbox returned a null H.264 session"))?;
        let session = unsafe { CFRetained::from_raw(raw) };

        // Disable B-frame reordering and request real-time scheduling. Both
        // properties are essential for remote-control latency, and failure is
        // surfaced so the caller can safely use the regular bitmap channel.
        let vt_session = unsafe { compression_as_vt_session(&session) };
        ensure_status(
            unsafe {
                VTSessionSetProperty(
                    vt_session,
                    kVTCompressionPropertyKey_RealTime,
                    Some(CFBoolean::new(true).as_ref()),
                )
            },
            "enable VideoToolbox real-time encoding",
        )?;
        ensure_status(
            unsafe {
                VTSessionSetProperty(
                    vt_session,
                    kVTCompressionPropertyKey_AllowFrameReordering,
                    Some(CFBoolean::new(false).as_ref()),
                )
            },
            "disable VideoToolbox frame reordering",
        )?;
        let max_frame_delay = CFNumber::new_i32(1);
        let delay_status = unsafe {
            VTSessionSetProperty(
                vt_session,
                kVTCompressionPropertyKey_MaxFrameDelayCount,
                Some(max_frame_delay.as_ref()),
            )
        };
        if delay_status != 0 {
            tracing::debug!(
                status = delay_status,
                "VideoToolbox encoder does not support an explicit frame-delay window"
            );
        }
        ensure_status(
            unsafe { session.prepare_to_encode_frames() },
            "prepare VideoToolbox H.264 encoder",
        )?;

        Ok(Self {
            session,
            callback_state,
            output,
            width,
            height,
            encoded_width,
            encoded_height,
            next_timestamp: 0,
            next_frame_id: 0,
        })
    }

    pub(crate) fn matches(&self, frame: &Frame) -> bool {
        self.width == frame.width && self.height == frame.height
    }

    pub(crate) fn can_submit(&self) -> bool {
        self.callback_state.in_flight.load(Ordering::Relaxed) < MAX_ENCODER_FRAMES_IN_FLIGHT
    }

    pub(crate) fn oldest_deadline(&self) -> Option<Instant> {
        self.callback_state
            .pending
            .lock()
            .ok()?
            .front()
            .map(|(_, input)| input.submitted_at + ENCODE_TIMEOUT)
    }

    pub(crate) fn flush_deadline(&self) -> Option<Instant> {
        self.callback_state
            .pending
            .lock()
            .ok()?
            .iter()
            .find(|(_, input)| !input.flushed)
            .map(|(_, input)| input.submitted_at + ENCODE_FLUSH_DELAY)
    }

    pub(crate) fn flush_pending(&self) -> anyhow::Result<()> {
        {
            let mut pending = self
                .callback_state
                .pending
                .lock()
                .map_err(|_| anyhow::anyhow!("VideoToolbox pending-frame lock poisoned"))?;
            for (_, input) in pending.iter_mut() {
                input.flushed = true;
            }
        }
        ensure_status(
            unsafe { self.session.complete_frames(kCMTimeInvalid) },
            "flush idle VideoToolbox H.264 frames",
        )
    }

    pub(crate) async fn next_output(&mut self) -> Option<EncodedFrame> {
        let output = self.output.recv().await;
        if output.is_some() {
            self.callback_state
                .in_flight
                .fetch_sub(1, Ordering::Relaxed);
        }
        output
    }

    /// Queue one frame and return immediately. The callback owns the retained
    /// input until VideoToolbox has finished reading it, so ScreenCaptureKit's
    /// IOSurface and any temporary macroblock padding outlive asynchronous
    /// encoding without blocking the display updater.
    pub(crate) fn submit(&mut self, frame: &Frame) -> anyhow::Result<()> {
        if !self.matches(frame) {
            anyhow::bail!("H.264 encoder dimensions no longer match captured frame");
        }
        if !self.can_submit() {
            anyhow::bail!("VideoToolbox H.264 queue is full");
        }

        let prepared = self.prepare_input(frame)?;
        let image_buffer =
            unsafe { pixel_buffer_as_image_buffer(&prepared.pixel_buffer) } as *const CVImageBuffer;
        self.next_frame_id = self.next_frame_id.wrapping_add(1).max(1);
        let frame_id = self.next_frame_id;
        self.callback_state
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("VideoToolbox pending-frame lock poisoned"))?
            .push_back((
                frame_id,
                PendingInput {
                    frame: frame.clone(),
                    submitted_at: Instant::now(),
                    flushed: false,
                    _pixel_buffer: prepared.pixel_buffer,
                    _padded_input: prepared.padded_input,
                },
            ));
        self.callback_state
            .in_flight
            .fetch_add(1, Ordering::Relaxed);

        self.next_timestamp = self.next_timestamp.saturating_add(1);
        let timestamp = unsafe { CMTime::new(self.next_timestamp, 30) };
        let duration = unsafe { kCMTimeInvalid };
        let status = unsafe {
            self.session.encode_frame(
                &*image_buffer,
                timestamp,
                duration,
                None,
                ptr::without_provenance_mut(frame_id),
                ptr::null_mut(),
            )
        };
        if status != 0 {
            if self.callback_state.take_pending(frame_id).is_some() {
                self.callback_state
                    .in_flight
                    .fetch_sub(1, Ordering::Relaxed);
            }
            ensure_status(status, "submit VideoToolbox H.264 frame")?;
        }
        Ok(())
    }

    pub(super) fn prepare_input(&self, frame: &Frame) -> anyhow::Result<PreparedInput> {
        let aligned = (self.encoded_width, self.encoded_height) == (frame.width, frame.height);
        if aligned && let Some(pixel_buffer) = frame.native_pixel_buffer() {
            return Ok(PreparedInput {
                pixel_buffer,
                padded_input: None,
            });
        }

        let row_bytes = usize::from(frame.width)
            .checked_mul(4)
            .ok_or_else(|| anyhow::anyhow!("H.264 source row size overflow"))?;
        if frame.stride < row_bytes {
            anyhow::bail!("H.264 source stride is smaller than its visible row");
        }
        let source_length = frame
            .stride
            .checked_mul(usize::from(frame.height))
            .ok_or_else(|| anyhow::anyhow!("H.264 source frame size overflow"))?;
        if frame.byte_len() < source_length {
            anyhow::bail!(
                "H.264 source has {} bytes; expected at least {source_length}",
                frame.byte_len()
            );
        }

        let (base_address, input_stride, padded_input) = if aligned {
            let source = frame.bgra_bytes()?;
            let address = NonNull::new(source.as_ptr().cast_mut().cast::<c_void>())
                .ok_or_else(|| anyhow::anyhow!("cannot encode an empty captured frame"))?;
            (address, frame.stride, None)
        } else {
            let padded_stride = usize::from(self.encoded_width)
                .checked_mul(4)
                .ok_or_else(|| anyhow::anyhow!("aligned H.264 row size overflow"))?;
            let padded_length = padded_stride
                .checked_mul(usize::from(self.encoded_height))
                .ok_or_else(|| anyhow::anyhow!("aligned H.264 frame size overflow"))?;
            let mut padded = vec![0; padded_length];
            frame.copy_bgra_rows_to(&mut padded, padded_stride)?;
            let address = NonNull::new(padded.as_mut_ptr().cast::<c_void>())
                .ok_or_else(|| anyhow::anyhow!("cannot encode an empty padded frame"))?;
            (address, padded_stride, Some(padded))
        };

        let mut raw_pixel_buffer = ptr::null_mut();
        let status = unsafe {
            CVPixelBufferCreateWithBytes(
                None,
                usize::from(self.encoded_width),
                usize::from(self.encoded_height),
                kCVPixelFormatType_32BGRA,
                base_address,
                input_stride,
                None,
                ptr::null_mut(),
                None,
                NonNull::from(&mut raw_pixel_buffer),
            )
        };
        if status != kCVReturnSuccess {
            anyhow::bail!("VideoToolbox input pixel buffer creation failed (status {status})");
        }
        let raw_pixel_buffer = NonNull::new(raw_pixel_buffer)
            .ok_or_else(|| anyhow::anyhow!("CoreVideo returned a null pixel buffer"))?;
        let pixel_buffer = unsafe { CFRetained::from_raw(raw_pixel_buffer) };
        Ok(PreparedInput {
            pixel_buffer,
            padded_input,
        })
    }
}

pub(super) struct PreparedInput {
    pub(super) pixel_buffer: CFRetained<CVPixelBuffer>,
    pub(super) padded_input: Option<Vec<u8>>,
}

impl EncoderCallbackState {
    pub(super) fn take_pending(&self, frame_id: usize) -> Option<PendingInput> {
        let mut pending = self.pending.lock().ok()?;
        let index = pending.iter().position(|(id, _)| *id == frame_id)?;
        pending.remove(index).map(|(_, input)| input)
    }
}

pub(super) fn align_dimension(value: u16) -> anyhow::Result<u16> {
    if value == 0 {
        anyhow::bail!("cannot create an H.264 encoder with a zero dimension");
    }
    value
        .checked_add(15)
        .map(|padded| padded & !15)
        .ok_or_else(|| anyhow::anyhow!("H.264 dimension {value} cannot be aligned to 16 pixels"))
}

pub(super) unsafe extern "C-unwind" fn on_h264_encoded(
    output_callback_ref_con: *mut c_void,
    source_frame_ref_con: *mut c_void,
    status: i32,
    _info_flags: objc2_video_toolbox::VTEncodeInfoFlags,
    sample: *mut CMSampleBuffer,
) {
    if output_callback_ref_con.is_null() || source_frame_ref_con.is_null() {
        return;
    }
    let state = unsafe { &*output_callback_ref_con.cast::<EncoderCallbackState>() };
    let frame_id = source_frame_ref_con.addr();
    let Some(pending) = state.take_pending(frame_id) else {
        tracing::warn!(frame_id, "VideoToolbox returned an unknown H.264 frame");
        return;
    };
    let result = if status != 0 {
        Err(anyhow::anyhow!(
            "VideoToolbox H.264 frame encoding failed (status {status})"
        ))
    } else if sample.is_null() {
        Err(anyhow::anyhow!("VideoToolbox dropped an H.264 frame"))
    } else {
        unsafe { sample_to_avc(&*sample) }
    };
    if state
        .sender
        .send(EncodedFrame {
            frame: pending.frame,
            result,
        })
        .is_err()
    {
        state.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Drop for H264Encoder {
    fn drop(&mut self) {
        unsafe { self.session.invalidate() };
        if let Ok(mut pending) = self.callback_state.pending.lock() {
            pending.clear();
        }
        self.callback_state.in_flight.store(0, Ordering::Relaxed);
    }
}
