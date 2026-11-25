use super::model::ProbeSession;
use super::model::SvcMessagesOf;
use crate::ProbeError;
use ironrdp::core::WriteBuf;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::input::MouseButton;
use ironrdp::input::MousePosition;
use ironrdp::input::Operation;
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::rdp::headers::ShareDataPdu;
use ironrdp::pdu::rdp::refresh_rectangle::RefreshRectanglePdu;
use ironrdp_tokio::FramedWrite;
use tokio::io::AsyncWriteExt;

impl ProbeSession {
    /// Ask the server to repaint the whole desktop (RefreshRectangle PDU).
    pub async fn request_refresh(&mut self) -> Result<(), ProbeError> {
        let (width, height) = (self.image.width(), self.image.height());
        if width == 0 || height == 0 {
            return Ok(());
        }
        let pdu = ShareDataPdu::RefreshRectangle(RefreshRectanglePdu {
            areas_to_refresh: vec![InclusiveRectangle {
                left: 0,
                top: 0,
                right: width - 1,
                bottom: height - 1,
            }],
        });
        let mut output = WriteBuf::new();
        self.active_stage
            .encode_static(&mut output, pdu)
            .map_err(|e| ProbeError::connection(format!("refresh encode: {e}")))?;
        self.write_raw(output.filled()).await
    }

    pub async fn write_raw(&mut self, bytes: &[u8]) -> Result<(), ProbeError> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.framed
            .write_all(bytes)
            .await
            .map_err(|e| ProbeError::connection(format!("RDP write: {e}")))
    }

    pub async fn send_operations(&mut self, ops: Vec<Operation>) -> Result<(), ProbeError> {
        let events = self.input.apply(ops);
        if events.is_empty() {
            return Ok(());
        }
        let outputs = self
            .active_stage
            .process_fastpath_input(&mut self.image, &events)
            .map_err(|e| ProbeError::connection(format!("input encode: {e}")))?;
        let _ = self.handle_outputs(outputs).await?;
        Ok(())
    }

    pub async fn click(&mut self, x: u16, y: u16) -> Result<(), ProbeError> {
        self.send_operations(vec![
            Operation::MouseMove(MousePosition { x, y }),
            Operation::MouseButtonPressed(MouseButton::Left),
        ])
        .await?;
        self.send_operations(vec![Operation::MouseButtonReleased(MouseButton::Left)])
            .await
    }

    pub async fn type_char(&mut self, ch: char) -> Result<(), ProbeError> {
        self.send_operations(vec![
            Operation::UnicodeKeyPressed(ch),
            Operation::UnicodeKeyReleased(ch),
        ])
        .await
    }

    /// Flush messages a static-channel backend queued (clipboard, audio input).
    pub async fn send_svc_messages<C>(
        &mut self,
        messages: ironrdp::svc::SvcProcessorMessages<C>,
    ) -> Result<(), ProbeError>
    where
        C: ironrdp::svc::SvcProcessor + 'static,
    {
        let frame = self
            .active_stage
            .process_svc_processor_messages(messages)
            .map_err(|e| ProbeError::connection(format!("SVC encode: {e}")))?;
        self.write_raw(&frame).await
    }

    /// Encode pending DVC messages of a dynamic channel client.
    pub async fn send_dvc_messages(
        &mut self,
        channel_id: u32,
        messages: Vec<ironrdp::dvc::DvcMessage>,
    ) -> Result<(), ProbeError> {
        if messages.is_empty() {
            return Ok(());
        }
        let svc_messages = ironrdp::dvc::encode_dvc_messages(
            channel_id,
            messages,
            ironrdp::svc::ChannelFlags::empty(),
        )
        .map_err(|e| ProbeError::connection(format!("DVC encode: {e}")))?;
        let drdynvc = SvcMessagesOf::<DrdynvcClient>::new(svc_messages);
        self.send_svc_messages(drdynvc).await
    }
}
