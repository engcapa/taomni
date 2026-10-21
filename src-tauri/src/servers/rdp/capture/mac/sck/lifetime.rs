use super::StreamOutput;
use super::configuration::configure_stream;
use super::configuration::select_display;
use super::configuration::shareable_content;
use super::configuration::start_stream;
use super::configuration::stop_stream;
use super::configuration::update_stream_configuration;
use super::frames::frame_dimensions;
use super::limits::IDLE_POLL;
use super::limits::NATIVE_QUEUE_DEPTH;
use super::mailbox::FrameSlot;
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::capture::mac::Capturer;
use crate::servers::rdp::capture::mac::FRAME_TIMEOUT;
use crate::servers::rdp::capture::mac::Frame;
use crate::servers::rdp::capture::mac::INITIAL_FRAME_TIMEOUT;
use crate::servers::rdp::capture::mac::permission_granted;
use dispatch2::DispatchQoS;
use dispatch2::DispatchQueue;
use dispatch2::DispatchQueueAttr;
use dispatch2::DispatchRetained;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_core_graphics::CGDisplayPixelsHigh;
use objc2_core_graphics::CGDisplayPixelsWide;
use objc2_foundation::NSArray;
use objc2_screen_capture_kit::SCContentFilter;
use objc2_screen_capture_kit::SCStream;
use objc2_screen_capture_kit::SCStreamConfiguration;
use objc2_screen_capture_kit::SCStreamDelegate;
use objc2_screen_capture_kit::SCStreamOutput;
use objc2_screen_capture_kit::SCStreamOutputType;
use std::sync::Arc;
use std::time::Instant;

/// Persistent ScreenCaptureKit stream. All Objective-C objects stay on the
/// capture thread that creates this type; it is never sent through Tokio.
#[derive(Debug)]
pub(in crate::servers::rdp::capture::mac) struct SckCapturer {
    pub(super) stream: Retained<SCStream>,
    pub(super) _output: Retained<StreamOutput>,
    pub(super) _queue: DispatchRetained<DispatchQueue>,
    pub(super) slot: Arc<FrameSlot>,
    pub(super) pending: Option<Frame>,
    pub(super) width: u16,
    pub(super) height: u16,
}

impl SckCapturer {
    pub(in crate::servers::rdp::capture::mac) fn new(
        log: &LogEmitter,
        display_id: Option<&str>,
    ) -> anyhow::Result<Self> {
        if !permission_granted() {
            anyhow::bail!(
                "Screen Recording permission is not granted. Open RDP Server settings, grant permission, then restart Taomni if macOS requests it."
            );
        }

        let content = shareable_content()?;
        let (display, id) = select_display(&content, display_id)?;
        let width = u16::try_from(CGDisplayPixelsWide(id))
            .map_err(|_| anyhow::anyhow!("captured display width exceeds RDP limits"))?;
        let height = u16::try_from(CGDisplayPixelsHigh(id))
            .map_err(|_| anyhow::anyhow!("captured display height exceeds RDP limits"))?;
        if width == 0 || height == 0 {
            anyhow::bail!("selected display {id} has an invalid pixel size {width}x{height}");
        }

        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::new(),
            )
        };
        let configuration = unsafe { SCStreamConfiguration::new() };
        configure_stream(&configuration, width, height);

        let slot = Arc::new(FrameSlot::new());
        let output = StreamOutput::new(slot.clone());
        let delegate: &ProtocolObject<dyn SCStreamDelegate> = ProtocolObject::from_ref(&*output);
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &configuration,
                Some(delegate),
            )
        };
        // This queue is on the remote input-to-screen path. Its native wait
        // happens before Frame::captured_at, so Rust mailbox age cannot reveal
        // callbacks postponed by the default QoS. Keep it serial and shallow,
        // but schedule the current desktop with interactive work.
        let attributes = DispatchQueueAttr::with_qos_class(None, DispatchQoS::UserInteractive, 0);
        let queue = DispatchQueue::new("taomni.rdp.screencapture", Some(&attributes));
        let stream_output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*output);
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                stream_output,
                SCStreamOutputType::Screen,
                Some(&queue),
            )
        }
        .map_err(|_| anyhow::anyhow!("could not attach ScreenCaptureKit display output"))?;
        start_stream(&stream)?;

        let first = slot.take(INITIAL_FRAME_TIMEOUT)?;
        let (frame_width, frame_height) = frame_dimensions(&first)?;
        log.line(format!(
            "macOS capture stream ready: ScreenCaptureKit display {id} ({frame_width}x{frame_height}, BGRA, queue depth {NATIVE_QUEUE_DEPTH})"
        ));

        Ok(Self {
            stream,
            _output: output,
            _queue: queue,
            slot,
            pending: Some(first),
            width: frame_width,
            height: frame_height,
        })
    }
}

impl Capturer for SckCapturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn supports_output_resize(&self) -> bool {
        true
    }

    fn resize_output(&mut self, width: u16, height: u16) -> anyhow::Result<Frame> {
        if width == 0 || height == 0 {
            anyhow::bail!("cannot resize ScreenCaptureKit to a zero dimension");
        }
        let configuration = unsafe { SCStreamConfiguration::new() };
        configure_stream(&configuration, width, height);
        update_stream_configuration(&self.stream, &configuration)?;

        // Samples queued before the completion callback still use the old
        // dimensions. Drop them and wait for the first surface produced by the
        // completed configuration before acknowledging the RDP handshake.
        self.pending = None;
        self.slot.discard_pending();
        let deadline = Instant::now() + INITIAL_FRAME_TIMEOUT;
        loop {
            let now = Instant::now();
            if now >= deadline {
                anyhow::bail!(
                    "ScreenCaptureKit produced no {width}x{height} frame after reconfiguration"
                );
            }
            let frame = self.slot.take(deadline.saturating_duration_since(now))?;
            if frame.width == width && frame.height == height {
                return self.accept(frame);
            }
        }
    }

    /// ScreenCaptureKit enforces [`FRAME_RATE`] through
    /// `setMinimumFrameInterval`, so the display loop must not pace again.
    fn is_self_paced(&self) -> bool {
        true
    }

    /// ScreenCaptureKit emits an idle sample with no image buffer while the
    /// desktop is unchanged. Every frame that reaches this trait is therefore
    /// already a change notification; re-hashing the entire BGRA surface would
    /// add tens of milliseconds on a Retina display without filtering anything.
    fn needs_frame_deduplication(&self) -> bool {
        false
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        let frame = match self.pending.take() {
            Some(frame) => frame,
            None => self.slot.take(FRAME_TIMEOUT)?,
        };
        self.accept(frame)
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        let frame = match self.pending.take() {
            Some(frame) => frame,
            None => match self.slot.take_or_idle(IDLE_POLL)? {
                Some(frame) => frame,
                // Static desktop. The stream is healthy and will deliver again
                // as soon as something on screen changes.
                None => return Ok(None),
            },
        };
        self.accept(frame).map(Some)
    }
}

impl SckCapturer {
    /// Validate a delivered frame and adopt its dimensions, which change when
    /// the captured display switches mode.
    pub(super) fn accept(&mut self, frame: Frame) -> anyhow::Result<Frame> {
        let (width, height) = frame_dimensions(&frame)?;
        self.width = width;
        self.height = height;
        Ok(frame)
    }
}

impl Drop for SckCapturer {
    fn drop(&mut self) {
        self.slot.stop("RDP client disconnected");
        stop_stream(&self.stream);
    }
}
