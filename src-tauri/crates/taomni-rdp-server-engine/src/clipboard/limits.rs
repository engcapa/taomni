use ironrdp::cliprdr::pdu::ClipboardFormatId;
use std::time::Duration;

pub(super) const CF_UNICODETEXT: ClipboardFormatId = ClipboardFormatId::CF_UNICODETEXT;
/// Private id under which this server lists "HTML Format"; peers map it by name.
pub(super) const HTML_FORMAT_ID: ClipboardFormatId = ClipboardFormatId(0xC0E0);
pub(super) const MAX_CLIPBOARD_TEXT_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_FILE_ITEMS: usize = 1024;
pub(super) const FILE_CHUNK_BYTES: u32 = 1024 * 1024;
/// Host change checks when a cheap change token exists.
pub(super) const TOKEN_POLL: Duration = Duration::from_millis(250);
/// Full content comparison when no change token exists (Wayland without X11).
pub(super) const CONTENT_POLL: Duration = Duration::from_secs(1);
/// FILETIME of the Unix epoch, in 100 ns intervals since 1601-01-01.
pub(super) const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;
