use super::protocol::file_list_clipboard_format_id;
use crate::rdp::session::ClipboardAction;
use crate::rdp::session::TaomniCliprdrBackend;
use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::ClipboardFormat;
use ironrdp::cliprdr::pdu::ClipboardFormatId;
use ironrdp::cliprdr::pdu::ClipboardGeneralCapabilityFlags;
use ironrdp::cliprdr::pdu::FileContentsRequest;
use ironrdp::cliprdr::pdu::FileContentsResponse;
use ironrdp::cliprdr::pdu::FormatDataRequest;
use ironrdp::cliprdr::pdu::FormatDataResponse;
use ironrdp::cliprdr::pdu::LockDataId;
use ironrdp::core::AsAny;
use ironrdp::core::IntoOwned;
use std::fmt;

impl std::fmt::Debug for TaomniCliprdrBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaomniCliprdrBackend")
            .finish_non_exhaustive()
    }
}

impl AsAny for TaomniCliprdrBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl CliprdrBackend for TaomniCliprdrBackend {
    fn temporary_directory(&self) -> &str {
        &self.temporary_directory
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
            | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
    }

    fn on_ready(&mut self) {
        if let Ok(mut state) = self.bridge.state.lock() {
            state.ready = true;
        }
        self.bridge
            .send_clipboard_status("clipboard-ready", "RDP clipboard channel is ready.");
    }

    fn on_request_format_list(&mut self) {
        self.bridge.queue_action(ClipboardAction::AdvertiseFormats(
            self.bridge.local_formats(),
        ));
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        if let Ok(mut state) = self.bridge.state.lock() {
            state.negotiated_capabilities = capabilities;
        }
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        if let Some(format) = available_formats
            .iter()
            .map(ClipboardFormat::id)
            .find(|id| *id == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.bridge.queue_remote_request(format);
            return;
        }

        if let Some(format) = available_formats
            .iter()
            .find(|format| {
                format
                    .name()
                    .is_some_and(|name| name.value().eq_ignore_ascii_case("FileGroupDescriptorW"))
            })
            .map(ClipboardFormat::id)
        {
            self.bridge.queue_remote_request(format);
            return;
        }

        self.bridge.send_clipboard_status(
            "clipboard-unsupported-format",
            "Remote clipboard changed, but no Unicode text or file-list format was advertised.",
        );
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let response = if request.format == ClipboardFormatId::CF_UNICODETEXT {
            self.bridge
                .local_text()
                .map(|text| FormatDataResponse::new_unicode_string(&text).into_owned())
                .unwrap_or_else(|| FormatDataResponse::new_error().into_owned())
        } else if request.format == file_list_clipboard_format_id() {
            self.bridge.local_file_list_response()
        } else {
            FormatDataResponse::new_error().into_owned()
        };
        self.bridge
            .queue_action(ClipboardAction::SubmitFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            self.bridge.send_clipboard_status(
                "clipboard-read-failed",
                "Remote clipboard data request failed.",
            );
            return;
        }
        match self.bridge.take_pending_remote_format() {
            Some(format) if format == ClipboardFormatId::CF_UNICODETEXT => {
                match response.to_unicode_string() {
                    Ok(text) => self.bridge.send_clipboard_text(text),
                    Err(e) => self.bridge.send_clipboard_status(
                        "clipboard-decode-failed",
                        &format!("Remote clipboard text could not be decoded: {}", e),
                    ),
                }
            }
            Some(_) => match response.to_file_list() {
                Ok(list) => self.bridge.start_remote_file_receive(list),
                Err(e) => self.bridge.send_clipboard_status(
                    "clipboard-decode-failed",
                    &format!("Remote clipboard file list could not be decoded: {}", e),
                ),
            },
            None => self.bridge.send_clipboard_status(
                "clipboard-decode-failed",
                "Remote clipboard response arrived without a tracked requested format.",
            ),
        }
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let response = self.bridge.local_file_contents_response(&request);
        self.bridge
            .queue_action(ClipboardAction::SubmitFileContents(response));
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        self.bridge.handle_remote_file_contents_response(response);
    }

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}
