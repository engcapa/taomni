use crate::rdp::session::ClipboardAction;
use crate::rdp::session::ClipboardBridge;
use crate::rdp::session::events::send_status;
use crate::rdp::session::events::send_text;
use ironrdp::cliprdr::pdu::ClipboardFormatId;
use serde_json::json;

impl ClipboardBridge {
    pub(in crate::rdp::session) fn queue_remote_request(&self, format: ClipboardFormatId) {
        if let Ok(mut state) = self.state.lock() {
            state.pending_remote_format = Some(format);
            state
                .actions
                .push_back(ClipboardAction::RequestRemoteData(format));
        }
    }

    pub(in crate::rdp::session) fn take_pending_remote_format(&self) -> Option<ClipboardFormatId> {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.pending_remote_format.take())
    }

    pub(in crate::rdp::session) fn send_clipboard_text(&self, text: String) {
        send_text(
            &self.out_tx,
            json!({
                "type": "clipboard",
                "text": text,
            })
            .to_string(),
        );
    }

    pub(in crate::rdp::session) fn send_clipboard_status(&self, stage: &str, detail: &str) {
        send_status(&self.out_tx, stage, detail);
    }
}
