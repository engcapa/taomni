//! Probe-side CLIPRDR backend.
//!
//! Callbacks record what the server did and queue the replies a scenario must
//! send (the backend cannot write to the transport itself). Format encoders
//! here are written from MS-RDPECLIP / the CF_HTML spec independently of the
//! server's converters, so a symmetric conversion bug cannot verify itself.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardFormatName,
    ClipboardGeneralCapabilityFlags, FileContentsFlags, FileContentsRequest, FileContentsResponse,
    FileDescriptor, FormatDataRequest, FormatDataResponse, LockDataId, OwnedFormatDataResponse,
    PackedFileList,
};
use ironrdp::core::AsAny;

pub(crate) const HTML_FORMAT_NAME: &str = "HTML Format";
pub(crate) const FILE_LIST_FORMAT_NAME: &str = "FileGroupDescriptorW";
/// Registered-format ids are chosen by the sender; the receiver maps by name.
pub(crate) const HTML_FORMAT_ID: u32 = 0xC0F0;
pub(crate) const FILE_LIST_FORMAT_ID: u32 = 0xC0F1;

/// One local file offered by `clipboard-send --files`.
#[derive(Clone, Debug)]
pub(crate) struct LocalFile {
    /// Name as advertised (relative, `\`-separated per FILEDESCRIPTORW).
    pub name: String,
    pub path: Option<PathBuf>,
    pub is_dir: bool,
    pub size: u64,
}

/// Content the probe advertises as "the client clipboard".
#[derive(Clone, Debug, Default)]
pub(crate) struct LocalContent {
    pub text: Option<String>,
    pub html: Option<String>,
    pub dib: Option<Vec<u8>>,
    pub files: Vec<LocalFile>,
}

impl LocalContent {
    pub fn formats(&self) -> Vec<ClipboardFormat> {
        let mut formats = Vec::new();
        if self.text.is_some() || self.html.is_some() {
            formats.push(ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT));
        }
        if self.html.is_some() {
            formats.push(
                ClipboardFormat::new(ClipboardFormatId::new(HTML_FORMAT_ID))
                    .with_name(ClipboardFormatName::new(HTML_FORMAT_NAME)),
            );
        }
        if self.dib.is_some() {
            formats.push(ClipboardFormat::new(ClipboardFormatId::CF_DIB));
        }
        if !self.files.is_empty() {
            formats.push(
                ClipboardFormat::new(ClipboardFormatId::new(FILE_LIST_FORMAT_ID))
                    .with_name(ClipboardFormatName::new(FILE_LIST_FORMAT_NAME)),
            );
        }
        formats
    }

    fn file_list(&self) -> PackedFileList {
        PackedFileList {
            files: self
                .files
                .iter()
                .map(|file| {
                    let attributes = if file.is_dir {
                        ClipboardFileAttributes::DIRECTORY
                    } else {
                        ClipboardFileAttributes::ARCHIVE
                    };
                    let mut descriptor =
                        FileDescriptor::new(file.name.clone()).with_attributes(attributes);
                    if !file.is_dir {
                        descriptor = descriptor.with_file_size(file.size);
                    }
                    descriptor
                })
                .collect(),
        }
    }
}

/// Replies queued by callbacks for the scenario loop to transmit.
#[derive(Debug)]
pub(crate) enum ClipAction {
    Advertise(Vec<ClipboardFormat>),
    SubmitFormatData(OwnedFormatDataResponse),
    SubmitFileContents(FileContentsResponse<'static>),
}

#[derive(Debug, Default)]
pub(crate) struct ClipState {
    pub ready: bool,
    pub negotiated: Option<u32>,
    pub local: LocalContent,
    pub actions: VecDeque<ClipAction>,
    /// Every remote format list (server "copy" announcements), in order.
    pub remote_copies: Vec<Vec<ClipboardFormat>>,
    /// Data responses for our paste requests (format id requested, bytes).
    pub pending_paste: Option<u32>,
    pub responses: Vec<(u32, Result<Vec<u8>, String>)>,
    /// Server-initiated requests against our clipboard.
    pub requested_formats: Vec<u32>,
    pub file_requests: u64,
    pub file_bytes_served: u64,
    pub file_responses: VecDeque<FileContentsResponse<'static>>,
    pub format_list_acks: Vec<bool>,
    pub locks: Vec<u32>,
    pub log: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ProbeClipboard {
    pub state: Arc<Mutex<ClipState>>,
    temp: String,
}

impl ProbeClipboard {
    pub fn new(local: LocalContent) -> Self {
        let state = ClipState {
            local,
            ..ClipState::default()
        };
        Self {
            state: Arc::new(Mutex::new(state)),
            temp: std::env::temp_dir().to_string_lossy().into_owned(),
        }
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut ClipState) -> R) -> R {
        let mut guard = self.state.lock().expect("clipboard state");
        f(&mut guard)
    }

    fn record(&self, entry: impl Into<String>) {
        self.with(|s| {
            if s.log.len() < 200 {
                s.log.push(entry.into());
            }
        });
    }
}

impl AsAny for ProbeClipboard {
    fn as_any(&self) -> &dyn core::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
        self
    }
}

impl CliprdrBackend for ProbeClipboard {
    fn temporary_directory(&self) -> &str {
        &self.temp
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
            | ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
            | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
            | ClipboardGeneralCapabilityFlags::CAN_LOCK_CLIPDATA
            | ClipboardGeneralCapabilityFlags::HUGE_FILE_SUPPORT_ENABLED
    }

    fn on_ready(&mut self) {
        self.record("ready");
        self.with(|s| s.ready = true);
    }

    fn on_request_format_list(&mut self) {
        self.record("request-format-list");
        self.with(|s| {
            let formats = s.local.formats();
            s.actions.push_back(ClipAction::Advertise(formats));
        });
    }

    fn on_format_list_response(&mut self, ok: bool) {
        self.with(|s| s.format_list_acks.push(ok));
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        self.with(|s| s.negotiated = Some(capabilities.bits()));
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let names: Vec<String> = available_formats
            .iter()
            .map(|f| match f.name() {
                Some(name) => format!("{}:{}", f.id().value(), name.value()),
                None => f.id().value().to_string(),
            })
            .collect();
        self.record(format!("remote-copy [{}]", names.join(", ")));
        self.with(|s| s.remote_copies.push(available_formats.to_vec()));
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let id = request.format.value();
        self.record(format!("format-data-request {id}"));
        self.with(|s| {
            s.requested_formats.push(id);
            let response = local_format_data(&s.local, id);
            s.actions.push_back(ClipAction::SubmitFormatData(response));
        });
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        self.with(|s| {
            let id = s.pending_paste.take().unwrap_or(0);
            let entry = if response.is_error() {
                Err("server answered CB_RESPONSE_FAIL".to_string())
            } else {
                Ok(response.data().to_vec())
            };
            s.responses.push((id, entry));
        });
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        self.with(|s| {
            s.file_requests += 1;
            let response = serve_file_contents(&s.local, &request);
            if !response.is_error() && request.flags.contains(FileContentsFlags::RANGE) {
                s.file_bytes_served += response.data().len() as u64;
            }
            s.actions
                .push_back(ClipAction::SubmitFileContents(response));
        });
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        use ironrdp::core::IntoOwned as _;
        self.with(|s| s.file_responses.push_back(response.into_owned()));
    }

    fn on_lock(&mut self, data_id: LockDataId) {
        self.with(|s| s.locks.push(data_id.0));
    }

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

fn local_format_data(local: &LocalContent, id: u32) -> OwnedFormatDataResponse {
    match id {
        13 => {
            let text = local
                .text
                .clone()
                .or_else(|| local.html.as_ref().map(|h| strip_tags(h)))
                .unwrap_or_default();
            FormatDataResponse::new_unicode_string(&text)
        }
        HTML_FORMAT_ID => match &local.html {
            Some(html) => FormatDataResponse::new_data(cf_html_encode(html)),
            None => FormatDataResponse::new_error(),
        },
        8 => match &local.dib {
            Some(dib) => FormatDataResponse::new_data(dib.clone()),
            None => FormatDataResponse::new_error(),
        },
        FILE_LIST_FORMAT_ID => match FormatDataResponse::new_file_list(&local.file_list()) {
            Ok(response) => response,
            Err(_) => FormatDataResponse::new_error(),
        },
        _ => FormatDataResponse::new_error(),
    }
}

fn serve_file_contents(
    local: &LocalContent,
    request: &FileContentsRequest,
) -> FileContentsResponse<'static> {
    let Some(file) = usize::try_from(request.index)
        .ok()
        .and_then(|index| local.files.get(index))
    else {
        return FileContentsResponse::new_error(request.stream_id);
    };
    if request.flags.contains(FileContentsFlags::SIZE) {
        return FileContentsResponse::new_size_response(request.stream_id, file.size);
    }
    let Some(path) = &file.path else {
        return FileContentsResponse::new_error(request.stream_id);
    };
    match read_range(path, request.position, request.requested_size) {
        Ok(bytes) => FileContentsResponse::new_data_response(request.stream_id, bytes),
        Err(_) => FileContentsResponse::new_error(request.stream_id),
    }
}

fn read_range(path: &std::path::Path, position: u64, len: u32) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(position))?;
    let mut buf = Vec::with_capacity(len as usize);
    file.take(u64::from(len)).read_to_end(&mut buf)?;
    Ok(buf)
}

fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// Build a CF_HTML payload (Version 0.9) whose offsets are UTF-8 byte offsets.
pub(crate) fn cf_html_encode(fragment: &str) -> Vec<u8> {
    const PREFIX: &str = "<html><body>\r\n<!--StartFragment-->";
    const SUFFIX: &str = "<!--EndFragment-->\r\n</body></html>";
    let header_len = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n".len();
    let start_html = header_len;
    let start_fragment = start_html + PREFIX.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + SUFFIX.len();
    let mut out = format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n{PREFIX}{fragment}{SUFFIX}"
    )
    .into_bytes();
    out.push(0);
    out
}

/// Extract the fragment of a CF_HTML payload using its declared offsets.
pub(crate) fn cf_html_fragment(data: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(data);
    let field = |name: &str| -> Option<usize> {
        let start = text.find(name)? + name.len();
        let digits: String = text[start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        digits.parse().ok()
    };
    let start = field("StartFragment:")?;
    let end = field("EndFragment:")?;
    let bytes = data.get(start..end)?;
    Some(String::from_utf8_lossy(bytes).into_owned())
}

/// Encode RGBA pixels as a 32-bpp bottom-up `BITMAPINFOHEADER` DIB (CF_DIB).
pub(crate) fn rgba_to_dib(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let row = (width as usize) * 4;
    let mut out = Vec::with_capacity(40 + rgba.len());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(height as i32).to_le_bytes()); // positive = bottom-up
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&((row * height as usize) as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for y in (0..height as usize).rev() {
        for px in rgba[y * row..(y + 1) * row].chunks_exact(4) {
            out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }
    out
}

/// Decode a CF_DIB / CF_DIBV5 payload (24/32 bpp, BI_RGB or BI_BITFIELDS with
/// the standard masks) into `(width, height, rgba)`.
pub(crate) fn dib_to_rgba(dib: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let u32_at = |o: usize| -> Result<u32, String> {
        dib.get(o..o + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .ok_or_else(|| "DIB truncated".to_string())
    };
    let header_size = u32_at(0)? as usize;
    let width = u32_at(4)? as i32;
    let height = u32_at(8)? as i32;
    let bpp = dib
        .get(14..16)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .ok_or("DIB truncated")?;
    let compression = u32_at(16)?;
    if width <= 0 || height == 0 {
        return Err(format!("unsupported DIB size {width}x{height}"));
    }
    if bpp != 32 && bpp != 24 {
        return Err(format!("unsupported DIB depth {bpp}"));
    }
    // BI_BITFIELDS with a plain BITMAPINFOHEADER stores three masks after it.
    let masks = if compression == 3 && header_size == 40 {
        12
    } else {
        0
    };
    let pixels = header_size + masks;
    let (w, h) = (width as usize, height.unsigned_abs() as usize);
    let stride = (w * usize::from(bpp) / 8).div_ceil(4) * 4;
    if dib.len() < pixels + stride * h {
        return Err("DIB pixel data truncated".to_string());
    }
    let mut rgba = vec![0u8; w * h * 4];
    for row in 0..h {
        let src_row = if height > 0 { h - 1 - row } else { row };
        let src = &dib[pixels + src_row * stride..];
        for col in 0..w {
            let (b, g, r, a) = if bpp == 32 {
                let p = &src[col * 4..col * 4 + 4];
                (p[0], p[1], p[2], p[3])
            } else {
                let p = &src[col * 3..col * 3 + 3];
                (p[0], p[1], p[2], 255)
            };
            let dst = &mut rgba[(row * w + col) * 4..(row * w + col) * 4 + 4];
            dst.copy_from_slice(&[r, g, b, a]);
        }
    }
    Ok((w as u32, h as u32, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cf_html_round_trip_uses_byte_offsets() {
        let fragment = "<b>粗体 bold</b>";
        let encoded = cf_html_encode(fragment);
        assert_eq!(cf_html_fragment(&encoded).as_deref(), Some(fragment));
    }

    #[test]
    fn dib_round_trip_keeps_orientation() {
        // 2x2: red, green / blue, white (top row first).
        let rgba = [
            255, 0, 0, 255, 0, 255, 0, 255, //
            0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let dib = rgba_to_dib(2, 2, &rgba);
        let (w, h, decoded) = dib_to_rgba(&dib).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(decoded, rgba);
    }
}
