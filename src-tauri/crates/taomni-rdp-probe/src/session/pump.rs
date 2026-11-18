use super::model::ProbeSession;
use super::model::PumpEvent;
use crate::ProbeError;
use ironrdp::connector::Sequence;
use ironrdp::connector::connection_activation::ConnectionActivationState;
use ironrdp::core::WriteBuf;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::pdu::Action;
use ironrdp::session::ActiveStageOutput;
use ironrdp::session::image::DecodedImage;
use ironrdp_tokio::FramedWrite;
use std::time::Duration;
use std::time::Instant;
use tokio::io::AsyncWriteExt;

impl ProbeSession {
    /// Process at most one server PDU (waiting up to `wait`). Returns the
    /// events it produced; an empty vector means the wait elapsed.
    pub async fn pump(&mut self, wait: Duration) -> Result<Vec<PumpEvent>, ProbeError> {
        let read = match tokio::time::timeout(wait, self.framed.read_pdu()).await {
            Err(_) => return Ok(Vec::new()),
            Ok(read) => read,
        };
        let (action, payload) =
            read.map_err(|e| ProbeError::connection(format!("RDP read: {e}")))?;
        self.pdus_in += 1;
        self.bytes_in += payload.len() as u64;
        if let Some(sequence) = self.reactivation.as_mut() {
            if !matches!(action, Action::X224) {
                return Ok(Vec::new());
            }
            let mut output = WriteBuf::new();
            sequence
                .step(&payload, &mut output)
                .map_err(|e| ProbeError::connection(format!("reactivation: {e}")))?;
            loop {
                if !output.filled().is_empty() {
                    self.framed
                        .write_all(output.filled())
                        .await
                        .map_err(|e| ProbeError::connection(format!("reactivation write: {e}")))?;
                }
                if let ConnectionActivationState::Finalized {
                    desktop_size,
                    enable_server_pointer,
                    ..
                } = sequence.connection_activation_state()
                {
                    self.active_stage
                        .set_enable_server_pointer(enable_server_pointer);
                    self.image = DecodedImage::new(
                        PixelFormat::RgbA32,
                        desktop_size.width,
                        desktop_size.height,
                    );
                    self.reactivation = None;
                    self.rfx.reactivate();
                    self.request_refresh().await?;
                    return Ok(vec![PumpEvent::Reactivated {
                        width: desktop_size.width,
                        height: desktop_size.height,
                    }]);
                }
                if sequence.next_pdu_hint().is_some() {
                    return Ok(Vec::new());
                }
                output.clear();
                sequence
                    .step_no_input(&mut output)
                    .map_err(|e| ProbeError::connection(format!("reactivation step: {e}")))?;
            }
        }
        if matches!(action, Action::FastPath) {
            self.rfx.inspect_fast_path(&payload);
        }
        let outputs = self
            .active_stage
            .process(&mut self.image, action, &payload)
            .map_err(|e| ProbeError::connection(format!("active stage: {e}")))?;
        self.handle_outputs(outputs).await
    }

    pub(super) async fn handle_outputs(
        &mut self,
        outputs: Vec<ActiveStageOutput>,
    ) -> Result<Vec<PumpEvent>, ProbeError> {
        let mut events = Vec::new();
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    if !frame.is_empty() {
                        self.framed
                            .write_all(&frame)
                            .await
                            .map_err(|e| ProbeError::connection(format!("RDP write: {e}")))?;
                    }
                }
                ActiveStageOutput::GraphicsUpdate(rect) => {
                    self.graphics_updates += 1;
                    // ironrdp reports a pixel-less surface update as the
                    // all-zero rectangle.
                    let zero =
                        rect.left == 0 && rect.top == 0 && rect.right == 0 && rect.bottom == 0;
                    if zero || rect.right < rect.left || rect.bottom < rect.top {
                        self.empty_updates += 1;
                    }
                    if self.first_graphics_ms.is_none() {
                        self.first_graphics_ms =
                            Some(self.connected_at.elapsed().as_millis() as u64 + self.connect_ms);
                    }
                    events.push(PumpEvent::Graphics(rect));
                }
                ActiveStageOutput::PointerBitmap(_) => {
                    self.pointer_updates += 1;
                    events.push(PumpEvent::PointerBitmap);
                }
                ActiveStageOutput::PointerPosition { .. } => {
                    self.pointer_updates += 1;
                    events.push(PumpEvent::PointerPosition);
                }
                ActiveStageOutput::PointerDefault | ActiveStageOutput::PointerHidden => {
                    self.pointer_updates += 1;
                }
                ActiveStageOutput::AutoDetect(request) => {
                    events.push(PumpEvent::AutoDetect(request));
                }
                ActiveStageOutput::Terminate(reason) => {
                    self.terminated = Some(reason.description().to_string());
                }
                ActiveStageOutput::DeactivateAll => {
                    self.reactivation = Some(self.activation_factory.create());
                }
                ActiveStageOutput::MultitransportRequest(_) => {}
            }
        }
        Ok(events)
    }

    /// Pump until `deadline`, returning every event. Stops early on terminate.
    pub async fn pump_until(&mut self, deadline: Instant) -> Result<Vec<PumpEvent>, ProbeError> {
        let mut all = Vec::new();
        while Instant::now() < deadline && self.terminated.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            all.extend(self.pump(left.min(Duration::from_millis(200))).await?);
        }
        Ok(all)
    }

    /// Wait until the first graphics update arrives (or fail).
    pub async fn wait_first_frame(&mut self, limit: Duration) -> Result<(), ProbeError> {
        let deadline = Instant::now() + limit;
        while self.first_graphics_ms.is_none() {
            if Instant::now() >= deadline {
                return Err(ProbeError::unmet(format!(
                    "no graphics update within {} ms after activation",
                    limit.as_millis()
                )));
            }
            if let Some(reason) = &self.terminated {
                return Err(ProbeError::connection(format!(
                    "server terminated the session: {reason}"
                )));
            }
            let _ = self.pump(Duration::from_millis(200)).await?;
        }
        Ok(())
    }
}
