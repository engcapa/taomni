use super::download::FileDownload;
use super::download::Progress;
use super::files::process_staging_root;
use super::host_content::HostContent;
use super::limits::CF_UNICODETEXT;
use super::limits::HTML_FORMAT_ID;
use super::limits::MAX_CLIPBOARD_TEXT_BYTES;
use super::requests::Fetch;
use super::requests::Incoming;
use super::requests::RequestGate;
use super::shared::Command;
use super::shared::Shared;
use crate::rdp::session::read_clipboard_file_range;
use crate::servers::rdp::clipboard_formats::MAX_HTML_BYTES;
use crate::servers::rdp::clipboard_formats::cf_html_encode;
use crate::servers::rdp::clipboard_formats::cf_html_fragment;
use crate::servers::rdp::clipboard_formats::dib_to_rgba;
use crate::servers::rdp::clipboard_formats::rgba_to_dib;
use crate::servers::rdp::clipboard_formats::rgba_to_dibv5;
use ironrdp::cliprdr::backend::ClipboardMessage;
use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::ClipboardFormat;
use ironrdp::cliprdr::pdu::ClipboardFormatId;
use ironrdp::cliprdr::pdu::ClipboardFormatName;
use ironrdp::cliprdr::pdu::ClipboardGeneralCapabilityFlags;
use ironrdp::cliprdr::pdu::FileContentsFlags;
use ironrdp::cliprdr::pdu::FileContentsRequest;
use ironrdp::cliprdr::pdu::FileContentsResponse;
use ironrdp::cliprdr::pdu::FileDescriptor;
use ironrdp::cliprdr::pdu::FormatDataRequest;
use ironrdp::cliprdr::pdu::FormatDataResponse;
use ironrdp::cliprdr::pdu::LockDataId;
use ironrdp::core::AsAny;
use ironrdp::core::IntoOwned as _;
use std::hash::Hasher;
use std::sync::Arc;
use std::sync::atomic::Ordering;

pub(super) struct ClipboardBackend {
    pub(super) shared: Arc<Shared>,
    pub(super) temp_dir: String,
    pub(super) incoming: Incoming,
    pub(super) requests: RequestGate,
    pub(super) download: Option<FileDownload>,
}

impl core::fmt::Debug for ClipboardBackend {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ClipboardBackend")
            .field("pending", &self.incoming.pending)
            .field("downloading", &self.download.is_some())
            .finish()
    }
}

// `CliprdrBackend: AsAny`; the downcast is unused, so a direct impl suffices.
impl AsAny for ClipboardBackend {
    fn as_any(&self) -> &dyn core::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
        self
    }
}

impl ClipboardBackend {
    pub(super) fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            temp_dir: process_staging_root().to_string_lossy().into_owned(),
            incoming: Incoming::default(),
            requests: RequestGate::default(),
            download: None,
        }
    }

    pub(super) fn queue(&mut self, fetch: Fetch, format: ClipboardFormatId) {
        self.incoming.queue.push_back((fetch, format));
    }

    /// Ask for the next queued format; publish what arrived once none is left.
    /// Waits while an earlier request is unanswered (see [`RequestGate`]).
    pub(super) fn request_next_format(&mut self) {
        if !self.requests.idle() {
            return;
        }
        match self.incoming.queue.pop_front() {
            Some((fetch, format)) => {
                self.incoming.pending = Some(fetch);
                self.requests.sent();
                self.shared
                    .send(ClipboardMessage::SendInitiatePaste(format));
            }
            None => {
                let content = std::mem::take(&mut self.incoming.content);
                if !content.is_empty() {
                    self.publish(content);
                }
            }
        }
    }

    /// Hand client content to the worker unless this computer already shows
    /// it — the echo of our own advertisement from a same-machine client.
    pub(super) fn publish(&self, content: HostContent) -> bool {
        if content.identity() == self.shared.snapshot().identity() {
            tracing::debug!("RDP clipboard: client content already on this computer");
            return false;
        }
        self.shared.command(Command::Write(content));
        true
    }

    pub(super) fn drive_download(&mut self, progress: Progress) {
        match progress {
            Progress::Request(request) => self
                .shared
                .send(ClipboardMessage::SendFileContentsRequest(request)),
            Progress::Done => {
                let Some(download) = self.download.take() else {
                    return;
                };
                let content = HostContent {
                    files: download.top_level.clone(),
                    ..HostContent::default()
                };
                // Unpublished staging is removed when `download` drops.
                if self.publish(content)
                    && let Ok(mut host) = self.shared.host.lock()
                {
                    host.published_staging = Some(download.staging);
                }
            }
        }
    }
}

impl Drop for ClipboardBackend {
    fn drop(&mut self) {
        self.shared.ready.store(false, Ordering::Release);
        self.shared.files_negotiated.store(false, Ordering::Release);
        if let Ok(mut host) = self.shared.host.lock() {
            host.announced = Arc::default();
            host.locks.clear();
        }
        // An unfinished download takes its staging directory with it.
        self.download = None;
        self.shared.log.line("clipboard channel stopped");
    }
}

impl CliprdrBackend for ClipboardBackend {
    fn temporary_directory(&self) -> &str {
        &self.temp_dir
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        let mut flags = ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES;
        if self.shared.policy.files_enabled() {
            flags |= ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
                | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
                | ClipboardGeneralCapabilityFlags::CAN_LOCK_CLIPDATA;
        }
        flags
    }

    fn on_ready(&mut self) {
        self.shared.ready.store(true, Ordering::Release);
        self.shared.log.line("clipboard channel ready");
        self.shared.command(Command::Advertise);
    }

    fn on_request_format_list(&mut self) {
        if self.shared.ready.load(Ordering::Acquire) {
            self.shared.command(Command::Advertise);
        }
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        self.shared.files_negotiated.store(
            capabilities.contains(ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED),
            Ordering::Release,
        );
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        // A new client clipboard supersedes anything still being fetched.
        self.incoming = Incoming::default();
        self.requests.supersede();
        self.download = None;
        let level = self.shared.policy.client_to_server;
        if !level.allows_text() {
            return;
        }
        let named = |name: &ClipboardFormatName| {
            available_formats
                .iter()
                .find(|format| {
                    format
                        .name()
                        .is_some_and(|value| value.value().eq_ignore_ascii_case(name.value()))
                })
                .map(ClipboardFormat::id)
        };
        let offered =
            |id: ClipboardFormatId| available_formats.iter().any(|format| format.id() == id);
        if let Some(format) = named(&ClipboardFormatName::FILE_LIST)
            && level.allows_files()
            && self.shared.files_negotiated.load(Ordering::Acquire)
        {
            self.queue(Fetch::FileList, format);
            self.request_next_format();
            return;
        }
        if offered(CF_UNICODETEXT) {
            self.queue(Fetch::Text, CF_UNICODETEXT);
        }
        if level.allows_rich() {
            if let Some(format) = named(&ClipboardFormatName::HTML) {
                self.queue(Fetch::Html, format);
            }
            if offered(ClipboardFormatId::CF_DIBV5) {
                self.queue(Fetch::Image, ClipboardFormatId::CF_DIBV5);
            } else if offered(ClipboardFormatId::CF_DIB) {
                self.queue(Fetch::Image, ClipboardFormatId::CF_DIB);
            }
        }
        self.request_next_format();
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let snapshot = self.shared.snapshot();
        let level = self.shared.policy.server_to_client;
        let format = request.format;
        let data = if format == CF_UNICODETEXT && level.allows_text() {
            snapshot
                .text
                .as_deref()
                .map(FormatDataResponse::new_unicode_string)
        } else if format == HTML_FORMAT_ID && level.allows_rich() {
            snapshot
                .html
                .as_deref()
                .map(|html| FormatDataResponse::new_data(cf_html_encode(html)))
        } else if format == ClipboardFormatId::CF_DIBV5 && level.allows_rich() {
            snapshot
                .image
                .as_deref()
                .map(|image| FormatDataResponse::new_data(rgba_to_dibv5(image)))
        } else if format == ClipboardFormatId::CF_DIB && level.allows_rich() {
            snapshot
                .image
                .as_deref()
                .map(|image| FormatDataResponse::new_data(rgba_to_dib(image)))
        } else {
            None
        };
        let response = data.unwrap_or_else(FormatDataResponse::new_error);
        self.shared
            .send(ClipboardMessage::SendFormatData(response.into_owned()));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if !self.requests.answered() {
            // Answer to a request of a superseded copy.
            self.request_next_format();
            return;
        }
        let Some(fetch) = self.incoming.pending.take() else {
            return;
        };
        let data = response.data();
        if response.is_error() {
            tracing::debug!(?fetch, "RDP clipboard: client could not provide a format");
        } else {
            match fetch {
                Fetch::Text if data.len() <= MAX_CLIPBOARD_TEXT_BYTES => {
                    match response.to_unicode_string() {
                        Ok(text) if !text.is_empty() => self.incoming.content.text = Some(text),
                        Ok(_) => {}
                        Err(error) => self.shared.log.line(format!(
                            "clipboard: bad unicode text from the client: {error}"
                        )),
                    }
                }
                Fetch::Html if data.len() <= MAX_HTML_BYTES => {
                    self.incoming.content.html = cf_html_fragment(data)
                        .filter(|html| !html.is_empty())
                        .map(Arc::new);
                }
                Fetch::Text | Fetch::Html => self.shared.log.line(format!(
                    "clipboard: rejected client {} larger than the limit",
                    if fetch == Fetch::Text { "text" } else { "HTML" }
                )),
                Fetch::Image => match dib_to_rgba(data) {
                    Ok(image) => self.incoming.content.image = Some(Arc::new(image)),
                    Err(error) => self
                        .shared
                        .log
                        .line(format!("clipboard: client image rejected: {error}")),
                },
                Fetch::FileList => self
                    .shared
                    .log
                    .line("clipboard: the client's file list could not be decoded"),
            }
        }
        self.request_next_format();
    }

    fn on_remote_file_list(&mut self, files: &[FileDescriptor], clip_data_id: Option<u32>) {
        // ironrdp-cliprdr decodes file-list answers itself; this is still
        // the response to our request.
        if !self.requests.answered() {
            self.request_next_format();
            return;
        }
        if self.incoming.pending == Some(Fetch::FileList) {
            self.incoming.pending = None;
        }
        match FileDownload::start(files, clip_data_id, self.shared.policy.file_max_bytes) {
            Ok(mut download) => {
                self.shared.log.line(format!(
                    "clipboard: receiving {} file item(s) from the client",
                    files.len()
                ));
                let progress = download.next_request();
                self.download = Some(download);
                self.drive_download(progress);
            }
            Err(error) => self
                .shared
                .log
                .line(format!("clipboard: client files rejected: {error}")),
        }
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let stream_id = request.stream_id;
        let response = match self.shared.announced_file(request.index, request.data_id) {
            Some(file) if request.flags.contains(FileContentsFlags::SIZE) => {
                FileContentsResponse::new_size_response(stream_id, file.size)
            }
            Some(file)
                if request.flags.contains(FileContentsFlags::RANGE)
                    && !file.is_directory
                    && request.position <= file.size =>
            {
                let size = u64::from(request.requested_size).min(file.size - request.position);
                read_clipboard_file_range(&file.path, request.position, size as u32)
                    .map(|data| FileContentsResponse::new_data_response(stream_id, data))
                    .unwrap_or_else(|_| FileContentsResponse::new_error(stream_id))
            }
            _ => FileContentsResponse::new_error(stream_id),
        };
        self.shared
            .send(ClipboardMessage::SendFileContentsResponse(response));
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        let Some(download) = self.download.as_mut() else {
            return;
        };
        match download.accept(&response) {
            Ok(progress) => self.drive_download(progress),
            Err(error) => {
                self.shared.log.line(format!(
                    "clipboard: file transfer from the client failed: {error}"
                ));
                self.download = None;
            }
        }
    }

    fn on_lock(&mut self, data_id: LockDataId) {
        if let Ok(mut host) = self.shared.host.lock() {
            // Locks are released by Unlock PDUs; the cap only bounds a
            // misbehaving client that never sends them.
            if host.locks.len() >= 64 {
                host.locks.clear();
            }
            let frozen = Arc::clone(&host.announced);
            host.locks.insert(data_id.0, frozen);
        }
    }

    fn on_unlock(&mut self, data_id: LockDataId) {
        if let Ok(mut host) = self.shared.host.lock() {
            host.locks.remove(&data_id.0);
        }
    }
}
