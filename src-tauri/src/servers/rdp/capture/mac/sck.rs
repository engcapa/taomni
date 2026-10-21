//! ScreenCaptureKit capture backend for macOS 12.3 and later.
//!
//! ScreenCaptureKit delivers the requested BGRA IOSurface on a serial GCD
//! queue. The delegate copies only the current surface into a one-slot mailbox;
//! it never waits for RDP encoding or network I/O. Keeping the native queue at
//! three frames and the Rust handoff at one prevents a slow client from making
//! the cursor and desktop progressively older.

#[derive(Debug)]
struct StreamOutputIvars {
    slot: Arc<FrameSlot>,
    malformed_samples: AtomicUsize,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "TaomniRdpScreenCaptureOutput"]
    #[ivars = StreamOutputIvars]
    #[derive(Debug)]
    struct StreamOutput;

    unsafe impl SCStreamOutput for StreamOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn stream_didOutputSampleBuffer_ofType(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            output_type: SCStreamOutputType,
        ) {
            if output_type != SCStreamOutputType::Screen {
                return;
            }
            match retain_bgra_frame(sample_buffer) {
                // `None` is an idle sample: the desktop did not change, so
                // there is nothing to publish and nothing worth logging.
                Ok(Some(frame)) => {
                    self.ivars().malformed_samples.store(0, Ordering::Relaxed);
                    self.ivars().slot.publish(frame);
                }
                Ok(None) => {
                    self.ivars().malformed_samples.store(0, Ordering::Relaxed);
                }
                // ScreenCaptureKit can emit transient malformed buffers while
                // a display is changing mode. Do not terminate a usable
                // session for one such sample; the timed consumer path will
                // surface a persistent outage with a clear error.
                Err(error) => {
                    let malformed = self
                        .ivars()
                        .malformed_samples
                        .fetch_add(1, Ordering::Relaxed)
                        + 1;
                    if malformed >= MALFORMED_SAMPLE_LIMIT {
                        self.ivars().slot.stop(format!(
                            "ScreenCaptureKit delivered {malformed} consecutive invalid samples: {error}"
                        ));
                    } else {
                        tracing::debug!(
                            "discarding ScreenCaptureKit sample ({malformed}/{MALFORMED_SAMPLE_LIMIT}): {error}"
                        );
                    }
                }
            }
        }
    }

    unsafe impl SCStreamDelegate for StreamOutput {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stream_did_stop_with_error(&self, _stream: &SCStream, _error: &NSError) {
            self.ivars()
                .slot
                .stop("macOS stopped the ScreenCaptureKit stream with an error");
        }
    }
);

unsafe impl NSObjectProtocol for StreamOutput {}

impl StreamOutput {
    fn new(slot: Arc<FrameSlot>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(StreamOutputIvars {
            slot,
            malformed_samples: AtomicUsize::new(0),
        });
        unsafe { msg_send![super(this), init] }
    }
}

use std::sync::atomic::{AtomicUsize, Ordering};

use std::sync::mpsc::{self, RecvTimeoutError};

use std::sync::{Arc, Condvar, Mutex};

use std::time::{Duration, Instant};

use block2::RcBlock;

use dispatch2::{DispatchQoS, DispatchQueue, DispatchQueueAttr, DispatchRetained};

use objc2::rc::Retained;

use objc2::runtime::{NSObjectProtocol, ProtocolObject};

use objc2::{AnyThread, DefinedClass, define_class, msg_send};

use objc2_core_foundation::{CFDictionary, CFNumber};

use objc2_core_graphics::{CGDisplayPixelsHigh, CGDisplayPixelsWide, CGMainDisplayID};

use objc2_core_media::CMSampleBuffer;

use objc2_core_video::{
    CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType,
    CVPixelBufferGetWidth, kCVPixelFormatType_32BGRA,
};

use objc2_foundation::{NSArray, NSError, NSObject};

use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCFrameStatus, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamFrameInfoStatus, SCStreamOutput, SCStreamOutputType,
};

use super::{Capturer, FRAME_TIMEOUT, Frame, INITIAL_FRAME_TIMEOUT, permission_granted};

use crate::servers::engine::LogEmitter;

mod limits;

mod mailbox;

mod lifetime;

mod configuration;

mod frames;

#[cfg(test)]
mod tests;

use limits::{
    CONTENT_TIMEOUT, FRAME_RATE, IDLE_POLL, MALFORMED_SAMPLE_LIMIT, NATIVE_QUEUE_DEPTH,
    STOP_TIMEOUT,
};

use mailbox::{FrameSlot, FrameSlotState};

pub(super) use lifetime::SckCapturer;

pub(crate) use configuration::{select_display, shareable_content, start_stream, stop_stream};

use configuration::{configure_stream, update_stream_configuration};

use frames::{frame_dimensions, retain_bgra_frame, sample_frame_status};
