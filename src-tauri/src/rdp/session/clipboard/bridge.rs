use super::protocol::file_list_clipboard_format;
use super::staging::cleanup_stale_clipboard_staging;
use super::staging::clipboard_process_staging_root;
use crate::rdp::session::ClipboardAction;
use crate::rdp::session::ClipboardBridge;
use crate::rdp::session::ClipboardBridgeState;
use crate::rdp::session::SessionOutputSender;
use crate::rdp::session::TaomniCliprdrBackend;
use ironrdp::cliprdr::pdu::ClipboardFormat;
use ironrdp::cliprdr::pdu::ClipboardFormatId;
use ironrdp::cliprdr::pdu::ClipboardGeneralCapabilityFlags;
use ironrdp::core::IntoOwned;
use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;

impl ClipboardBridge {
    pub(in crate::rdp::session) fn new(out_tx: SessionOutputSender) -> Self {
        cleanup_stale_clipboard_staging();
        Self {
            state: Arc::new(Mutex::new(ClipboardBridgeState {
                local_text: None,
                local_files: Vec::new(),
                pending_remote_format: None,
                remote_file_transfer: None,
                completed_remote_staging: Vec::new(),
                actions: VecDeque::new(),
                ready: false,
                negotiated_capabilities: ClipboardGeneralCapabilityFlags::empty(),
            })),
            out_tx,
        }
    }

    pub(in crate::rdp::session) fn backend(&self) -> TaomniCliprdrBackend {
        let temporary_directory = clipboard_process_staging_root()
            .to_string_lossy()
            .into_owned();
        TaomniCliprdrBackend {
            bridge: self.clone(),
            temporary_directory,
        }
    }

    pub(in crate::rdp::session) fn local_formats(&self) -> Vec<ClipboardFormat> {
        match self.state.lock() {
            Ok(state)
                if state
                    .local_text
                    .as_ref()
                    .is_some_and(|text| !text.is_empty()) =>
            {
                vec![ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]
            }
            Ok(state) if !state.local_files.is_empty() => vec![file_list_clipboard_format()],
            _ => Vec::new(),
        }
    }

    pub(in crate::rdp::session) fn drain_actions(&self) -> Vec<ClipboardAction> {
        match self.state.lock() {
            Ok(mut state) => state.actions.drain(..).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub(in crate::rdp::session) fn queue_action(&self, action: ClipboardAction) {
        if let Ok(mut state) = self.state.lock() {
            state.actions.push_back(action);
        }
    }

    pub(in crate::rdp::session) fn local_text(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.local_text.clone())
    }
}

impl std::fmt::Debug for ClipboardBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClipboardBridge").finish_non_exhaustive()
    }
}
