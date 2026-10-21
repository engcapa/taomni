use super::limits::HTML_FORMAT_ID;
use super::limits::MAX_CLIPBOARD_TEXT_BYTES;
use crate::servers::rdp::clipboard_formats::ClipboardLevel;
use ironrdp::cliprdr::pdu::ClipboardFormat;
use ironrdp::cliprdr::pdu::ClipboardFormatName;

pub(super) fn unicode_payload_within_limit(text: &str) -> bool {
    text.encode_utf16()
        .count()
        .checked_mul(2)
        .and_then(|bytes| bytes.checked_add(2))
        .is_some_and(|bytes| bytes <= MAX_CLIPBOARD_TEXT_BYTES)
}

pub(super) fn html_format() -> ClipboardFormat {
    ClipboardFormat::new(HTML_FORMAT_ID).with_name(ClipboardFormatName::HTML)
}

/// Per-direction clipboard policy of one server run (DEC-10).
#[derive(Clone, Copy, Debug)]
pub(crate) struct ClipboardPolicy {
    pub server_to_client: ClipboardLevel,
    pub client_to_server: ClipboardLevel,
    pub file_max_bytes: u64,
}

impl ClipboardPolicy {
    pub(crate) const DEFAULT_FILE_MAX_MB: u64 = 2048;

    /// Build from persisted settings. A missing value keeps Windows' default of
    /// allowing everything; an unrecognised one falls back to text only and is
    /// reported in the returned warnings.
    pub(crate) fn from_settings(
        server_to_client: &str,
        client_to_server: &str,
        file_max_mb: u64,
    ) -> (Self, Vec<String>) {
        let mut warnings = Vec::new();
        let mut level = |key: &str, value: &str| {
            if value.trim().is_empty() {
                return ClipboardLevel::All;
            }
            ClipboardLevel::parse(value).unwrap_or_else(|| {
                warnings.push(format!(
                    "clipboard: unknown {key} level '{value}'; using text only"
                ));
                ClipboardLevel::Text
            })
        };
        let policy = Self {
            server_to_client: level("clipboardServerToClient", server_to_client),
            client_to_server: level("clipboardClientToServer", client_to_server),
            file_max_bytes: file_max_mb.clamp(1, 1024 * 1024) * 1024 * 1024,
        };
        (policy, warnings)
    }

    /// Whether the CLIPRDR channel should be offered at all.
    pub(crate) fn enabled(&self) -> bool {
        self.server_to_client != ClipboardLevel::Off || self.client_to_server != ClipboardLevel::Off
    }

    pub(super) fn files_enabled(&self) -> bool {
        self.server_to_client.allows_files() || self.client_to_server.allows_files()
    }

    pub(crate) fn summary(&self) -> String {
        format!(
            "RDP clipboard: this computer -> client {}, client -> this computer {}, file limit {} MiB",
            self.server_to_client.label(),
            self.client_to_server.label(),
            self.file_max_bytes / (1024 * 1024)
        )
    }
}
