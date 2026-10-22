use super::frames::map_absolute_coordinate;
use super::frames::raw_to_frame;
use super::limits::FRAME_WAIT;
use super::limits::INITIAL_FRAME_TIMEOUT;
use super::limits::INPUT_POLL_WAIT;
use super::mailbox::FrameMailbox;
use super::pipewire::spawn_pipewire_capture;
use super::portal::PortalContext;
use super::startup::MonitorTarget;
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::capture::Capturer;
use crate::servers::rdp::capture::Frame;
use crate::servers::rdp::capture::PortalInput;
use anyhow::bail;
use pipewire::channel;
use std::sync::Arc;

pub(crate) struct WaylandCapturer {
    pub(super) portal: PortalContext,
    pub(super) mailbox: Arc<FrameMailbox>,
    pub(super) stop: channel::Sender<()>,
    pub(super) width: u16,
    pub(super) height: u16,
    pub(super) retained: Option<Frame>,
}

impl WaylandCapturer {
    pub(super) fn new(
        log: &LogEmitter,
        request_input: bool,
        target: Option<MonitorTarget>,
    ) -> anyhow::Result<Self> {
        let (portal, pipewire_fd) = PortalContext::new(request_input, target).map_err(|error| {
            anyhow::anyhow!(
                "Wayland RemoteDesktop portal authorization failed: {error}. \
                 Approve the monitor and requested input devices in the compositor dialog."
            )
        })?;
        let mailbox = Arc::new(FrameMailbox::default());
        let stop = spawn_pipewire_capture(
            pipewire_fd,
            portal.stream_node,
            mailbox.clone(),
            log.clone(),
        )?;
        let initial = mailbox
            .take_timeout(INITIAL_FRAME_TIMEOUT)?
            .ok_or_else(|| anyhow::anyhow!("PipeWire produced no frame within 10 seconds"))?;
        let frame = raw_to_frame(initial)?;
        let width = frame.width;
        let height = frame.height;
        log.line(format!(
            "Wayland capture ready: {}x{} (RemoteDesktop portal, PipeWire, input={})",
            width,
            height,
            if portal.input_enabled {
                "granted"
            } else {
                "disabled"
            }
        ));
        let mut portal = portal;
        if portal.logical_size.is_none() {
            portal.logical_size = Some((u32::from(width), u32::from(height)));
        }
        Ok(Self {
            portal,
            mailbox,
            stop,
            width,
            height,
            retained: Some(frame),
        })
    }
}

impl Drop for WaylandCapturer {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

impl Capturer for WaylandCapturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        if let Some(frame) = self.retained.take() {
            return Ok(frame);
        }
        loop {
            if let Some(raw) = self.mailbox.take_timeout(FRAME_WAIT)? {
                let frame = raw_to_frame(raw)?;
                self.width = frame.width;
                self.height = frame.height;
                return Ok(frame);
            }
            if self.mailbox.is_closed() {
                bail!("Wayland PipeWire capture stream closed");
            }
        }
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        if let Some(frame) = self.retained.take() {
            return Ok(Some(frame));
        }
        let wait = if self.portal.input_enabled {
            INPUT_POLL_WAIT
        } else {
            FRAME_WAIT
        };
        let Some(raw) = self.mailbox.take_timeout(wait)? else {
            if self.mailbox.is_closed() {
                bail!("Wayland PipeWire capture stream closed");
            }
            return Ok(None);
        };
        let frame = raw_to_frame(raw)?;
        self.width = frame.width;
        self.height = frame.height;
        Ok(Some(frame))
    }

    fn is_self_paced(&self) -> bool {
        true
    }

    fn needs_frame_deduplication(&self) -> bool {
        false
    }

    fn supports_portal_input(&self) -> bool {
        self.portal.input_enabled
    }

    fn inject_portal_input(&mut self, input: PortalInput) -> anyhow::Result<()> {
        let input = match input {
            PortalInput::MotionAbsolute { x, y } => {
                let (logical_width, logical_height) = self
                    .portal
                    .logical_size
                    .unwrap_or((u32::from(self.width), u32::from(self.height)));
                PortalInput::MotionAbsolute {
                    x: map_absolute_coordinate(x, self.width, logical_width),
                    y: map_absolute_coordinate(y, self.height, logical_height),
                }
            }
            other => other,
        };
        self.portal.inject(input)
    }
}
