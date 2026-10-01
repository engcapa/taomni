//! CLIPRDR clipboard bridge for the RDP server.
//!
//! Bridges the host OS clipboard (`arboard`) and the RDP client's clipboard in
//! both directions under a per-direction policy (DEC-10, [`ClipboardLevel`]):
//! `text` carries `CF_UNICODETEXT`, `rich` adds CF_HTML and CF_DIB/CF_DIBV5
//! images, `all` adds files (`FileGroupDescriptorW` + `FileContents`).
//!
//! Ownership:
//! - One host worker thread per running server owns the `arboard::Clipboard`
//!   (on X11 the data we publish only lives as long as that instance), detects
//!   host changes and performs every host write.
//! - The per-connection [`ClipboardBackend`] runs on the server reactor thread;
//!   it never touches arboard and never waits for the worker.
//!
//! host → client: the worker notices a change (Windows clipboard sequence
//! number, macOS pasteboard change count, XFixes selection events on X11,
//! content polling otherwise), snapshots the allowed formats and advertises
//! them. Format data and file ranges are then served from that snapshot.
//!
//! client → host: a remote format list is fetched eagerly, one format at a
//! time, because arboard has no cross-platform delayed rendering; files are
//! downloaded into a private staging directory before the worker publishes
//! them (DEC-11).
//!
//! Echo suppression (DEC-15): clipboard states are compared by identity (text,
//! image pixels, file names and sizes), so a client on the same machine, which
//! shares this OS clipboard, cannot drive an endless announce/fetch loop.

use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ironrdp::cliprdr::backend::{ClipboardMessage, CliprdrBackend, CliprdrBackendFactory};
use ironrdp::cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardFormatName,
    ClipboardGeneralCapabilityFlags, FileContentsFlags, FileContentsRequest, FileContentsResponse,
    FileDescriptor, FormatDataRequest, FormatDataResponse, LockDataId,
};
use ironrdp::core::{AsAny, IntoOwned as _};
use ironrdp::server::tokio::sync::mpsc::UnboundedSender;
use ironrdp::server::{CliprdrServerFactory, ServerEvent, ServerEventSender};

use super::clipboard_formats::{
    ClipboardLevel, MAX_HTML_BYTES, RgbaImage, cf_html_encode, cf_html_fragment, dib_to_rgba,
    rgba_to_dib, rgba_to_dibv5,
};
use crate::rdp::session::{
    clipboard_relative_name, ensure_private_directory, process_is_alive, read_clipboard_file_range,
    remote_clipboard_safe_path, remote_top_level_name, write_remote_file_chunk,
};
use crate::servers::engine::LogEmitter;

const CF_UNICODETEXT: ClipboardFormatId = ClipboardFormatId::CF_UNICODETEXT;
/// Private id under which this server lists "HTML Format"; peers map it by name.
const HTML_FORMAT_ID: ClipboardFormatId = ClipboardFormatId(0xC0E0);
const MAX_CLIPBOARD_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILE_ITEMS: usize = 1024;
const FILE_CHUNK_BYTES: u32 = 1024 * 1024;
/// Host change checks when a cheap change token exists.
const TOKEN_POLL: Duration = Duration::from_millis(250);
/// Full content comparison when no change token exists (Wayland without X11).
const CONTENT_POLL: Duration = Duration::from_secs(1);
/// FILETIME of the Unix epoch, in 100 ns intervals since 1601-01-01.
const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;

fn unicode_payload_within_limit(text: &str) -> bool {
    text.encode_utf16()
        .count()
        .checked_mul(2)
        .and_then(|bytes| bytes.checked_add(2))
        .is_some_and(|bytes| bytes <= MAX_CLIPBOARD_TEXT_BYTES)
}

fn html_format() -> ClipboardFormat {
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

    fn files_enabled(&self) -> bool {
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

/// One clipboard state in transferable form.
#[derive(Clone, Default)]
struct HostContent {
    text: Option<String>,
    html: Option<Arc<String>>,
    image: Option<Arc<RgbaImage>>,
    files: Vec<PathBuf>,
}

impl HostContent {
    fn is_empty(&self) -> bool {
        self.text.is_none() && self.html.is_none() && self.image.is_none() && self.files.is_empty()
    }

    /// What a user would call "the same clipboard": file names and sizes, image
    /// RGB pixels, or text with normalised line endings. Paths and alpha are
    /// deliberately excluded — a same-machine client stages files elsewhere and
    /// CF_DIB drops alpha — so its echo compares equal (DEC-15).
    fn identity(&self) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        if !self.files.is_empty() {
            1u8.hash(&mut hasher);
            let mut entries: Vec<(String, Option<u64>)> = self
                .files
                .iter()
                .map(|path| {
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let size = std::fs::metadata(path)
                        .ok()
                        .filter(|meta| meta.is_file())
                        .map(|meta| meta.len());
                    (name, size)
                })
                .collect();
            entries.sort();
            entries.hash(&mut hasher);
        } else if let Some(image) = &self.image {
            2u8.hash(&mut hasher);
            (image.width, image.height).hash(&mut hasher);
            let mut rgb = Vec::with_capacity(image.width as usize * 3);
            for row in image.pixels.chunks_exact(image.width as usize * 4) {
                rgb.clear();
                row.chunks_exact(4)
                    .for_each(|px| rgb.extend_from_slice(&px[..3]));
                hasher.write(&rgb);
            }
        } else if let Some(text) = &self.text {
            3u8.hash(&mut hasher);
            text.replace("\r\n", "\n").hash(&mut hasher);
        } else if let Some(html) = &self.html {
            4u8.hash(&mut hasher);
            html.hash(&mut hasher);
        }
        hasher.finish()
    }

    /// Format summary for the server log; never includes clipboard content.
    fn describe(&self) -> String {
        if !self.files.is_empty() {
            return format!("{} file item(s)", self.files.len());
        }
        let mut parts = Vec::new();
        if let Some(text) = &self.text {
            parts.push(format!("text ({} chars)", text.chars().count()));
        }
        if self.html.is_some() {
            parts.push("html".to_string());
        }
        if let Some(image) = &self.image {
            parts.push(format!("image {}x{}", image.width, image.height));
        }
        if parts.is_empty() {
            "empty clipboard".to_string()
        } else {
            parts.join(", ")
        }
    }
}

/// Another process holds the OS clipboard; retry on the next tick.
struct HostBusy;

/// `text/uri-list` lines end in CRLF (RFC 2483; GTK file managers write it
/// that way) but arboard splits the list on LF only, which leaves a `\r` on
/// every Linux path.
fn without_uri_list_cr(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|value| value.strip_suffix('\r')) {
        Some(trimmed) => PathBuf::from(trimmed),
        None => path,
    }
}

/// `Ok(None)` when a format is simply absent.
fn available<T>(result: Result<T, arboard::Error>) -> Result<Option<T>, HostBusy> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(arboard::Error::ClipboardOccupied) => Err(HostBusy),
        Err(_) => Ok(None),
    }
}

/// Read the formats `level` allows. Files win over everything else, like a
/// shell copy; otherwise text, HTML and an image may coexist.
fn read_host(
    clipboard: &mut arboard::Clipboard,
    level: ClipboardLevel,
) -> Result<HostContent, HostBusy> {
    let mut content = HostContent::default();
    if !level.allows_text() {
        return Ok(content);
    }
    if level.allows_files()
        && let Some(files) = available(clipboard.get().file_list())?
        && !files.is_empty()
    {
        content.files = files.into_iter().map(without_uri_list_cr).collect();
        return Ok(content);
    }
    content.text = available(clipboard.get_text())?
        .filter(|text| !text.is_empty() && unicode_payload_within_limit(text));
    if level.allows_rich() {
        content.html = available(clipboard.get().html())?
            .filter(|html| !html.is_empty() && html.len() <= MAX_HTML_BYTES)
            .map(Arc::new);
        content.image = available(clipboard.get_image())?
            .and_then(|image| {
                let width = u32::try_from(image.width).ok()?;
                let height = u32::try_from(image.height).ok()?;
                RgbaImage::new(width, height, image.bytes.into_owned()).ok()
            })
            .map(Arc::new);
    }
    Ok(content)
}

/// Publish client content on the host. arboard sets one representation per
/// write (HTML carries its plain-text alternative), so pick the richest one
/// the content stands for: files, a picture without text, HTML, then text.
fn write_host(
    clipboard: &mut arboard::Clipboard,
    content: &HostContent,
) -> Result<(), arboard::Error> {
    if !content.files.is_empty() {
        return clipboard.set().file_list(&content.files);
    }
    let text = content.text.as_deref().filter(|text| !text.is_empty());
    if let Some(image) = content.image.as_ref().filter(|_| text.is_none()) {
        return clipboard.set_image(arboard::ImageData {
            width: image.width as usize,
            height: image.height as usize,
            bytes: std::borrow::Cow::Borrowed(&image.pixels),
        });
    }
    match (&content.html, text) {
        (Some(html), alt) => clipboard.set_html(html.as_str(), alt),
        (None, Some(text)) => clipboard.set_text(text),
        (None, None) => Ok(()),
    }
}

/// Cheap signal that the host clipboard may have changed. `None` means the
/// session has no such signal and the content itself must be compared.
struct ChangeToken {
    #[cfg(target_os = "linux")]
    selection: Option<x11_selection::SelectionWatch>,
}

impl ChangeToken {
    fn new() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            selection: x11_selection::SelectionWatch::new(),
        }
    }

    #[cfg(target_os = "windows")]
    fn current(&mut self) -> Option<u64> {
        // SAFETY: a plain read of the session clipboard's change counter.
        Some(u64::from(unsafe {
            windows::Win32::System::DataExchange::GetClipboardSequenceNumber()
        }))
    }

    #[cfg(target_os = "macos")]
    fn current(&mut self) -> Option<u64> {
        Some(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as u64)
    }

    #[cfg(target_os = "linux")]
    fn current(&mut self) -> Option<u64> {
        self.selection
            .as_mut()
            .map(x11_selection::SelectionWatch::events)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    fn current(&mut self) -> Option<u64> {
        None
    }
}

#[cfg(target_os = "linux")]
mod x11_selection {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::Event;
    use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEventMask};
    use x11rb::protocol::xproto::ConnectionExt as _;
    use x11rb::rust_connection::RustConnection;

    /// Counts XFixes owner events for CLIPBOARD. Every copy re-asserts
    /// selection ownership, so the count changes without reading any data.
    pub(super) struct SelectionWatch {
        conn: RustConnection,
        events: u64,
    }

    impl SelectionWatch {
        pub(super) fn new() -> Option<Self> {
            std::env::var_os("DISPLAY")?;
            let (conn, screen) = x11rb::connect(None).ok()?;
            conn.xfixes_query_version(5, 0).ok()?.reply().ok()?;
            let root = conn.setup().roots.get(screen)?.root;
            let clipboard = conn
                .intern_atom(false, b"CLIPBOARD")
                .ok()?
                .reply()
                .ok()?
                .atom;
            conn.xfixes_select_selection_input(
                root,
                clipboard,
                SelectionEventMask::SET_SELECTION_OWNER
                    | SelectionEventMask::SELECTION_WINDOW_DESTROY
                    | SelectionEventMask::SELECTION_CLIENT_CLOSE,
            )
            .ok()?;
            conn.flush().ok()?;
            Some(Self { conn, events: 0 })
        }

        pub(super) fn events(&mut self) -> u64 {
            while let Ok(Some(event)) = self.conn.poll_for_event() {
                if matches!(event, Event::XfixesSelectionNotify(_)) {
                    self.events += 1;
                }
            }
            self.events
        }
    }
}

/// A host file or directory offered to the client, in announcement order
/// (`FileContentsRequest::index` is a position in this list).
#[derive(Clone, Debug)]
struct AnnouncedFile {
    path: PathBuf,
    size: u64,
    is_directory: bool,
}

fn filetime(meta: &std::fs::Metadata) -> Option<u64> {
    let since_epoch = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    u64::try_from(since_epoch.as_nanos() / 100)
        .ok()
        .map(|ticks| ticks + FILETIME_UNIX_EPOCH)
}

/// Expand the host file list (directories recursively, in name order) into
/// CLIPRDR descriptors. Any entry the wire cannot carry rejects the whole
/// list, because ironrdp would drop it and shift every later index.
fn collect_announced_files(
    roots: &[PathBuf],
    max_bytes: u64,
) -> Result<(Vec<FileDescriptor>, Vec<AnnouncedFile>), String> {
    let mut descriptors = Vec::new();
    let mut files = Vec::new();
    let mut total = 0u64;
    for root in roots {
        let path = root
            .canonicalize()
            .map_err(|e| format!("canonicalize '{}': {e}", root.display()))?;
        let base = path.parent().unwrap_or_else(|| Path::new("")).to_path_buf();
        collect_announced(
            &base,
            &path,
            max_bytes,
            &mut total,
            &mut descriptors,
            &mut files,
        )?;
    }
    Ok((descriptors, files))
}

fn collect_announced(
    base: &Path,
    path: &Path,
    max_bytes: u64,
    total: &mut u64,
    descriptors: &mut Vec<FileDescriptor>,
    files: &mut Vec<AnnouncedFile>,
) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("metadata '{}': {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!(
            "'{}' is a symbolic link; links are not transferred",
            path.display()
        ));
    }
    let is_directory = meta.is_dir();
    let size = if is_directory { 0 } else { meta.len() };
    *total = total.saturating_add(size);
    if *total > max_bytes {
        return Err(format!(
            "files exceed the {} MiB clipboard limit",
            max_bytes / (1024 * 1024)
        ));
    }
    if files.len() >= MAX_FILE_ITEMS {
        return Err(format!("more than {MAX_FILE_ITEMS} file items"));
    }
    // Also enforces the 259 UTF-16 unit limit of the descriptor name field.
    let wire_name = clipboard_relative_name(base, path)?;
    let (relative_path, name) = match wire_name.rsplit_once('\\') {
        Some((directory, name)) => (Some(directory.to_string()), name.to_string()),
        None => (None, wire_name.clone()),
    };
    let mut descriptor = FileDescriptor::new(name).with_attributes(if is_directory {
        ClipboardFileAttributes::DIRECTORY
    } else {
        ClipboardFileAttributes::NORMAL
    });
    if let Some(relative_path) = relative_path {
        descriptor = descriptor.with_relative_path(relative_path);
    }
    if !is_directory {
        descriptor = descriptor.with_file_size(size);
    }
    if let Some(time) = filetime(&meta) {
        descriptor = descriptor.with_last_write_time(time);
    }
    descriptors.push(descriptor);
    files.push(AnnouncedFile {
        path: path.to_path_buf(),
        size,
        is_directory,
    });
    if is_directory {
        let mut entries = std::fs::read_dir(path)
            .and_then(|entries| entries.collect::<Result<Vec<_>, _>>())
            .map_err(|e| format!("read directory '{}': {e}", path.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            collect_announced(base, &entry.path(), max_bytes, total, descriptors, files)?;
        }
    }
    Ok(())
}

fn staging_base() -> PathBuf {
    #[cfg(unix)]
    let name = format!("taomni-rdp-server-clipboard-{}", unsafe { libc::geteuid() });
    #[cfg(not(unix))]
    let name = "taomni-rdp-server-clipboard".to_string();
    std::env::temp_dir().join(name)
}

fn process_staging_root() -> PathBuf {
    staging_base().join(format!("process-{}", std::process::id()))
}

/// Remove staging left behind by server processes that no longer run.
fn cleanup_stale_staging() {
    let Ok(entries) = std::fs::read_dir(staging_base()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let dead = name
            .strip_prefix("process-")
            .and_then(|pid| pid.parse::<u32>().ok())
            .is_some_and(|pid| pid != std::process::id() && !process_is_alive(pid));
        if dead {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// A private download directory, removed when dropped.
#[derive(Debug)]
struct StagingDir(PathBuf);

impl Drop for StagingDir {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(path = %self.0.display(), %error, "failed to clean RDP server clipboard staging");
        }
    }
}

enum Command {
    /// A client channel became ready: advertise what the host holds now.
    Advertise,
    /// Publish content received from the client.
    Write(HostContent),
}

/// Host-side state shared by the worker and the per-connection backend.
#[derive(Default)]
struct HostState {
    snapshot: HostContent,
    announced: Arc<Vec<AnnouncedFile>>,
    /// Announced lists frozen by client Lock PDUs (clipDataId → files).
    locks: HashMap<u32, Arc<Vec<AnnouncedFile>>>,
    /// Files most recently received from the client stay staged while the
    /// host clipboard references them, until the next transfer replaces them.
    published_staging: Option<StagingDir>,
}

struct Shared {
    log: LogEmitter,
    policy: ClipboardPolicy,
    sender: Mutex<Option<UnboundedSender<ServerEvent>>>,
    /// A client CLIPRDR channel is up.
    ready: AtomicBool,
    /// The client negotiated CB_STREAM_FILECLIP_ENABLED.
    files_negotiated: AtomicBool,
    host: Mutex<HostState>,
    worker: Mutex<Option<Sender<Command>>>,
    advertisements: AtomicU64,
}

impl Shared {
    fn send(&self, message: ClipboardMessage) {
        if let Ok(sender) = self.sender.lock()
            && let Some(sender) = sender.as_ref()
        {
            let _ = sender.send(ServerEvent::Clipboard(message));
        }
    }

    fn command(&self, command: Command) {
        if let Ok(worker) = self.worker.lock()
            && let Some(worker) = worker.as_ref()
        {
            let _ = worker.send(command);
        }
    }

    fn snapshot(&self) -> HostContent {
        self.host
            .lock()
            .map(|host| host.snapshot.clone())
            .unwrap_or_default()
    }

    fn set_snapshot(&self, content: HostContent) {
        if let Ok(mut host) = self.host.lock() {
            host.snapshot = content;
        }
    }

    /// Offer `content` to the client within the host → client policy.
    fn advertise(&self, content: &HostContent) {
        if !self.ready.load(Ordering::Acquire) {
            return;
        }
        let level = self.policy.server_to_client;
        let count = self.advertisements.fetch_add(1, Ordering::Relaxed) + 1;
        if !content.files.is_empty() {
            if !level.allows_files() || !self.files_negotiated.load(Ordering::Acquire) {
                self.log.line(format!(
                    "clipboard: this computer holds {}, but file transfer is {}",
                    content.describe(),
                    if level.allows_files() {
                        "not supported by the client"
                    } else {
                        "disabled"
                    }
                ));
                return;
            }
            match collect_announced_files(&content.files, self.policy.file_max_bytes) {
                Ok((descriptors, files)) => {
                    if let Ok(mut host) = self.host.lock() {
                        host.announced = Arc::new(files);
                    }
                    self.log.line(format!(
                        "clipboard: this computer -> client: {} (#{count})",
                        content.describe()
                    ));
                    self.send(ClipboardMessage::SendInitiateFileCopy(descriptors));
                }
                Err(error) => self
                    .log
                    .line(format!("clipboard: files not offered: {error}")),
            }
            return;
        }
        let mut formats = Vec::new();
        if content.text.is_some() {
            formats.push(ClipboardFormat::new(CF_UNICODETEXT));
        }
        if level.allows_rich() {
            if content.html.is_some() {
                formats.push(html_format());
            }
            if content.image.is_some() {
                formats.push(ClipboardFormat::new(ClipboardFormatId::CF_DIBV5));
                formats.push(ClipboardFormat::new(ClipboardFormatId::CF_DIB));
            }
        }
        self.log.line(format!(
            "clipboard: this computer -> client: {} (#{count})",
            content.describe()
        ));
        self.send(ClipboardMessage::SendInitiateCopy(formats));
    }

    /// The announced file at `index`, from the list a client lock froze when
    /// the request names one.
    fn announced_file(&self, index: i32, data_id: Option<u32>) -> Option<AnnouncedFile> {
        let host = self.host.lock().ok()?;
        let list = data_id
            .and_then(|id| host.locks.get(&id))
            .unwrap_or(&host.announced);
        usize::try_from(index)
            .ok()
            .and_then(|index| list.get(index).cloned())
    }
}

/// The host worker: owns arboard, watches for changes, performs writes.
fn run_worker(shared: Arc<Shared>, commands: Receiver<Command>) {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(error) => {
            shared.log.line(format!(
                "clipboard: this computer's clipboard is unavailable: {error}"
            ));
            return;
        }
    };
    let level = shared.policy.server_to_client;
    let mut token = ChangeToken::new();
    let mut last_token = token.current();
    let poll = if last_token.is_some() {
        TOKEN_POLL
    } else {
        CONTENT_POLL
    };
    // Identity of the host state the client last learned about, or that we
    // wrote for it. Seeing it again is not a change worth announcing.
    let mut known: Option<u64> = None;
    loop {
        match commands.recv_timeout(poll) {
            Ok(Command::Advertise) => {
                last_token = token.current();
                if let Ok(content) = read_host(&mut clipboard, level) {
                    known = Some(content.identity());
                    if !content.is_empty() {
                        shared.advertise(&content);
                    }
                    shared.set_snapshot(content);
                }
                continue;
            }
            Ok(Command::Write(content)) => {
                if let Err(error) = write_host(&mut clipboard, &content) {
                    shared.log.line(format!(
                        "clipboard: could not update this computer's clipboard: {error}"
                    ));
                    continue;
                }
                shared.log.line(format!(
                    "clipboard: client -> this computer: {}",
                    content.describe()
                ));
                // The write is the new baseline and must not bounce back.
                last_token = token.current();
                known = Some(content.identity());
                let current = read_host(&mut clipboard, level).unwrap_or(content);
                shared.set_snapshot(current);
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if !shared.ready.load(Ordering::Acquire) || !level.allows_text() {
            continue;
        }
        let now = token.current();
        if now.is_some() && now == last_token {
            continue;
        }
        // Busy: keep the old token so the next tick reads again.
        let Ok(content) = read_host(&mut clipboard, level) else {
            continue;
        };
        last_token = now;
        let identity = content.identity();
        if known == Some(identity) {
            shared.set_snapshot(content);
            continue;
        }
        known = Some(identity);
        shared.set_snapshot(content.clone());
        shared.advertise(&content);
    }
}

/// Factory: the server builds one backend per connection; the factory owns
/// the host worker for the lifetime of the server.
pub(crate) struct ClipboardFactory {
    shared: Arc<Shared>,
}

impl ClipboardFactory {
    pub(crate) fn new(log: LogEmitter, policy: ClipboardPolicy) -> Self {
        cleanup_stale_staging();
        let shared = Arc::new(Shared {
            log,
            policy,
            sender: Mutex::new(None),
            ready: AtomicBool::new(false),
            files_negotiated: AtomicBool::new(false),
            host: Mutex::new(HostState::default()),
            worker: Mutex::new(None),
            advertisements: AtomicU64::new(0),
        });
        if policy.enabled() {
            let (tx, rx) = std::sync::mpsc::channel();
            let worker_shared = Arc::clone(&shared);
            match std::thread::Builder::new()
                .name("rdp-clipboard-host".to_string())
                .spawn(move || run_worker(worker_shared, rx))
            {
                Ok(_) => {
                    if let Ok(mut worker) = shared.worker.lock() {
                        *worker = Some(tx);
                    }
                }
                Err(error) => shared
                    .log
                    .line(format!("clipboard: host worker could not start: {error}")),
            }
        }
        Self { shared }
    }
}

impl Drop for ClipboardFactory {
    fn drop(&mut self) {
        // Closing the command channel ends the worker thread.
        if let Ok(mut worker) = self.shared.worker.lock() {
            worker.take();
        }
        if let Ok(mut host) = self.shared.host.lock() {
            host.published_staging = None;
        }
    }
}

impl ServerEventSender for ClipboardFactory {
    fn set_sender(&mut self, sender: UnboundedSender<ServerEvent>) {
        if let Ok(mut slot) = self.shared.sender.lock() {
            *slot = Some(sender);
        }
    }
}

impl CliprdrBackendFactory for ClipboardFactory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(ClipboardBackend::new(Arc::clone(&self.shared)))
    }
}

impl CliprdrServerFactory for ClipboardFactory {}

/// A format pulled from the client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fetch {
    Text,
    Html,
    Image,
    FileList,
}

/// Formats of one remote copy still to be pulled, and what arrived so far.
#[derive(Default)]
struct Incoming {
    queue: VecDeque<(Fetch, ClipboardFormatId)>,
    pending: Option<Fetch>,
    content: HostContent,
}

/// Format data responses carry no format id; they answer requests in order.
/// A new client format list supersedes the fetch in progress, yet answers to
/// requests already sent still arrive. They must not be taken for the new
/// copy: a client announcing twice in a row (its clipboard at Monitor Ready,
/// then a copy) would otherwise get its text stored as HTML or its file
/// list dropped. One request is outstanding at a time, so the file-list
/// correlation inside ironrdp-cliprdr stays aligned as well.
#[derive(Debug, Default)]
struct RequestGate {
    in_flight: usize,
    stale: usize,
}

impl RequestGate {
    fn sent(&mut self) {
        self.in_flight += 1;
    }

    /// The client clipboard changed: everything still unanswered is stale.
    fn supersede(&mut self) {
        self.stale = self.in_flight;
    }

    /// A response arrived; `false` when it answers a superseded request.
    fn answered(&mut self) -> bool {
        self.in_flight = self.in_flight.saturating_sub(1);
        if self.stale > 0 {
            self.stale -= 1;
            return false;
        }
        true
    }

    fn idle(&self) -> bool {
        self.in_flight == 0
    }
}

#[derive(Debug)]
struct DownloadEntry {
    path: PathBuf,
    size: Option<u64>,
    is_directory: bool,
}

#[derive(Clone, Copy, Debug)]
struct Outstanding {
    stream_id: u32,
    index: usize,
    size_request: bool,
}

enum Progress {
    Request(FileContentsRequest),
    Done,
}

/// Client → host file transfer with one FileContents request in flight.
struct FileDownload {
    staging: StagingDir,
    entries: Vec<DownloadEntry>,
    top_level: Vec<PathBuf>,
    data_id: Option<u32>,
    quota: u64,
    received: u64,
    /// First entry whose data may still be missing.
    cursor: usize,
    position: u64,
    next_stream_id: u32,
    outstanding: Option<Outstanding>,
}

impl FileDownload {
    /// Prepare a private staging tree for the client's (already sanitised)
    /// file list. Declared sizes are checked against the quota up front.
    fn start(files: &[FileDescriptor], data_id: Option<u32>, quota: u64) -> Result<Self, String> {
        if files.len() > MAX_FILE_ITEMS {
            return Err(format!("more than {MAX_FILE_ITEMS} file items"));
        }
        ensure_private_directory(&staging_base())?;
        let root = process_staging_root();
        ensure_private_directory(&root)?;
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        ensure_private_directory(&dir)?;
        let staging = StagingDir(dir.clone());

        let mut entries = Vec::with_capacity(files.len());
        let mut top_level = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut declared = 0u64;
        for file in files {
            let wire_name = match &file.relative_path {
                Some(directory) if !directory.is_empty() => format!("{directory}\\{}", file.name),
                _ => file.name.clone(),
            };
            #[cfg(windows)]
            if ironrdp::cliprdr::is_windows_device_name(&file.name) {
                return Err(format!("'{wire_name}' is a reserved device name"));
            }
            let path = remote_clipboard_safe_path(&dir, &wire_name)?;
            if !seen.insert(path.clone()) {
                return Err(format!("duplicate path '{wire_name}'"));
            }
            let is_directory = file
                .attributes
                .is_some_and(|attributes| attributes.contains(ClipboardFileAttributes::DIRECTORY));
            let size = if is_directory {
                Some(0)
            } else {
                file.file_size
            };
            declared = declared.saturating_add(size.unwrap_or(0));
            if declared > quota {
                return Err(format!(
                    "files exceed the {} MiB clipboard limit",
                    quota / (1024 * 1024)
                ));
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create directory '{}': {e}", parent.display()))?;
            }
            if is_directory {
                std::fs::create_dir_all(&path)
                    .map_err(|e| format!("create directory '{}': {e}", path.display()))?;
            } else {
                let mut options = std::fs::OpenOptions::new();
                options.create_new(true).write(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
                options
                    .open(&path)
                    .map_err(|e| format!("create '{}': {e}", path.display()))?;
            }
            if let Some(name) = remote_top_level_name(&wire_name) {
                let top = dir.join(name);
                if !top_level.contains(&top) {
                    top_level.push(top);
                }
            }
            entries.push(DownloadEntry {
                path,
                size,
                is_directory,
            });
        }
        Ok(Self {
            staging,
            entries,
            top_level,
            data_id,
            quota,
            received: 0,
            cursor: 0,
            position: 0,
            next_stream_id: 1,
            outstanding: None,
        })
    }

    fn issue(&mut self, index: usize, size_request: bool) -> Progress {
        let stream_id = self.next_stream_id;
        self.next_stream_id = self.next_stream_id.wrapping_add(1).max(1);
        self.outstanding = Some(Outstanding {
            stream_id,
            index,
            size_request,
        });
        let (flags, position, requested_size) = if size_request {
            (FileContentsFlags::SIZE, 0, 8)
        } else {
            let size = self.entries[index].size.unwrap_or(0);
            let chunk = size
                .saturating_sub(self.position)
                .min(u64::from(FILE_CHUNK_BYTES));
            (FileContentsFlags::RANGE, self.position, chunk as u32)
        };
        Progress::Request(FileContentsRequest {
            stream_id,
            index: index as i32,
            flags,
            position,
            requested_size,
            data_id: self.data_id,
        })
    }

    /// The next request, or `Done` once every file has its declared bytes.
    fn next_request(&mut self) -> Progress {
        while let Some(entry) = self.entries.get(self.cursor) {
            match entry.size {
                _ if entry.is_directory => {}
                None => return self.issue(self.cursor, true),
                Some(size) if self.position < size => return self.issue(self.cursor, false),
                Some(_) => {}
            }
            self.cursor += 1;
            self.position = 0;
        }
        Progress::Done
    }

    fn accept(&mut self, response: &FileContentsResponse<'_>) -> Result<Progress, String> {
        let outstanding = self
            .outstanding
            .take()
            .ok_or("file data arrived without a request")?;
        if response.stream_id() != outstanding.stream_id {
            return Err(format!("unexpected file stream {}", response.stream_id()));
        }
        let entry = &mut self.entries[outstanding.index];
        if response.is_error() {
            return Err(format!(
                "the client could not read '{}'",
                entry.path.display()
            ));
        }
        if outstanding.size_request {
            entry.size = Some(
                response
                    .data_as_size()
                    .map_err(|e| format!("bad file size response: {e}"))?,
            );
            let declared: u64 = self.entries.iter().filter_map(|entry| entry.size).sum();
            if declared > self.quota {
                return Err(format!(
                    "files exceed the {} MiB clipboard limit",
                    self.quota / (1024 * 1024)
                ));
            }
        } else {
            let data = response.data();
            let remaining = entry.size.unwrap_or(0).saturating_sub(self.position);
            if data.is_empty() {
                return Err(format!(
                    "'{}' ended before its declared size",
                    entry.path.display()
                ));
            }
            if data.len() as u64 > remaining || data.len() > FILE_CHUNK_BYTES as usize {
                return Err(format!(
                    "'{}' exceeded its requested range",
                    entry.path.display()
                ));
            }
            self.received = self.received.saturating_add(data.len() as u64);
            if self.received > self.quota {
                return Err("files exceed the clipboard limit".to_string());
            }
            write_remote_file_chunk(&entry.path, self.position, data)?;
            self.position += data.len() as u64;
        }
        Ok(self.next_request())
    }
}

struct ClipboardBackend {
    shared: Arc<Shared>,
    temp_dir: String,
    incoming: Incoming,
    requests: RequestGate,
    download: Option<FileDownload>,
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
    fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            temp_dir: process_staging_root().to_string_lossy().into_owned(),
            incoming: Incoming::default(),
            requests: RequestGate::default(),
            download: None,
        }
    }

    fn queue(&mut self, fetch: Fetch, format: ClipboardFormatId) {
        self.incoming.queue.push_back((fetch, format));
    }

    /// Ask for the next queued format; publish what arrived once none is left.
    /// Waits while an earlier request is unanswered (see [`RequestGate`]).
    fn request_next_format(&mut self) {
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
    fn publish(&self, content: HostContent) -> bool {
        if content.identity() == self.shared.snapshot().identity() {
            tracing::debug!("RDP clipboard: client content already on this computer");
            return false;
        }
        self.shared.command(Command::Write(content));
        true
    }

    fn drive_download(&mut self, progress: Progress) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_limit_counts_encoded_unicode_payload() {
        let max_ascii_chars = (MAX_CLIPBOARD_TEXT_BYTES - 2) / 2;
        assert!(unicode_payload_within_limit(&"a".repeat(max_ascii_chars)));
        assert!(!unicode_payload_within_limit(
            &"a".repeat(max_ascii_chars + 1)
        ));
        // A supplementary character occupies a UTF-16 surrogate pair.
        assert!(!unicode_payload_within_limit(&"😀".repeat(max_ascii_chars)));
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "taomni-rdp-clipboard-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn request_gate_discards_answers_to_a_superseded_copy() {
        // Copy #1 asks for text; copy #2 arrives before the answer.
        let mut gate = RequestGate::default();
        assert!(gate.idle());
        gate.sent();
        gate.supersede();
        assert!(!gate.idle(), "copy #2 waits for the outstanding answer");
        assert!(!gate.answered(), "the answer belongs to copy #1");
        assert!(gate.idle());
        // Copy #2's own request and answer.
        gate.sent();
        assert!(gate.answered());
        // A new copy with nothing in flight has nothing to discard.
        gate.supersede();
        gate.sent();
        assert!(gate.answered());
    }

    #[test]
    fn identity_ignores_paths_line_endings_and_alpha() {
        let a = temp_dir("identity-a");
        let b = temp_dir("identity-b");
        std::fs::write(a.join("report.txt"), b"12345").unwrap();
        std::fs::write(b.join("report.txt"), b"54321").unwrap();
        let files = |dir: &Path| HostContent {
            files: vec![dir.join("report.txt")],
            ..HostContent::default()
        };
        assert_eq!(files(&a).identity(), files(&b).identity());
        std::fs::write(b.join("report.txt"), b"longer").unwrap();
        assert_ne!(files(&a).identity(), files(&b).identity());

        let text = |value: &str| HostContent {
            text: Some(value.to_string()),
            ..HostContent::default()
        };
        assert_eq!(text("a\r\nb").identity(), text("a\nb").identity());
        assert_ne!(text("a").identity(), text("b").identity());

        let image = |alpha: u8| HostContent {
            image: Some(Arc::new(
                RgbaImage::new(1, 1, vec![1, 2, 3, alpha]).unwrap(),
            )),
            ..HostContent::default()
        };
        assert_eq!(image(0).identity(), image(255).identity());
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn uri_list_carriage_returns_are_not_part_of_host_paths() {
        assert_eq!(
            without_uri_list_cr(PathBuf::from("/tmp/宿主样本\r")),
            PathBuf::from("/tmp/宿主样本")
        );
        assert_eq!(
            without_uri_list_cr(PathBuf::from("/tmp/report.txt")),
            PathBuf::from("/tmp/report.txt")
        );
    }

    #[test]
    fn announced_files_expand_directories_in_name_order() {
        let root = temp_dir("announce");
        let tree = root.join("项目");
        std::fs::create_dir_all(tree.join("sub")).unwrap();
        std::fs::write(tree.join("b.txt"), b"bb").unwrap();
        std::fs::write(tree.join("sub").join("a.bin"), b"a").unwrap();
        let (descriptors, files) = collect_announced_files(&[tree.clone()], 1024).unwrap();
        let names: Vec<String> = descriptors
            .iter()
            .map(|d| match &d.relative_path {
                Some(path) => format!("{path}\\{}", d.name),
                None => d.name.clone(),
            })
            .collect();
        assert_eq!(
            names,
            ["项目", "项目\\b.txt", "项目\\sub", "项目\\sub\\a.bin"]
        );
        assert!(files[0].is_directory && files[2].is_directory);
        assert_eq!((files[1].size, files[3].size), (2, 1));
        assert_eq!(descriptors[1].file_size, Some(2));
        assert!(
            collect_announced_files(&[tree], 2)
                .unwrap_err()
                .contains("limit")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    fn descriptor(
        name: &str,
        dir: Option<&str>,
        size: Option<u64>,
        directory: bool,
    ) -> FileDescriptor {
        let mut d = FileDescriptor::new(name).with_attributes(if directory {
            ClipboardFileAttributes::DIRECTORY
        } else {
            ClipboardFileAttributes::NORMAL
        });
        if let Some(dir) = dir {
            d = d.with_relative_path(dir);
        }
        if let Some(size) = size {
            d = d.with_file_size(size);
        }
        d
    }

    fn expect_request(progress: Progress) -> FileContentsRequest {
        match progress {
            Progress::Request(request) => request,
            Progress::Done => panic!("expected another request"),
        }
    }

    #[test]
    fn download_fetches_sizes_then_ranges_into_staging() {
        let files = [
            descriptor("d", None, None, true),
            descriptor("x.txt", Some("d"), Some(3), false),
            descriptor("y.txt", None, None, false),
        ];
        let mut download = FileDownload::start(&files, Some(7), 1024).unwrap();
        let staging = download.staging.0.clone();

        let range = expect_request(download.next_request());
        assert_eq!(
            (range.index, range.position, range.requested_size),
            (1, 0, 3)
        );
        assert_eq!(range.data_id, Some(7));
        let next = download
            .accept(&FileContentsResponse::new_data_response(
                range.stream_id,
                b"abc".to_vec(),
            ))
            .unwrap();
        let size = expect_request(next);
        assert!(size.flags.contains(FileContentsFlags::SIZE));
        assert_eq!(size.index, 2);
        let next = download
            .accept(&FileContentsResponse::new_size_response(size.stream_id, 2))
            .unwrap();
        let range = expect_request(next);
        assert_eq!((range.index, range.requested_size), (2, 2));
        let done = download
            .accept(&FileContentsResponse::new_data_response(
                range.stream_id,
                b"yz".to_vec(),
            ))
            .unwrap();
        assert!(matches!(done, Progress::Done));

        assert_eq!(
            std::fs::read(staging.join("d").join("x.txt")).unwrap(),
            b"abc"
        );
        assert_eq!(std::fs::read(staging.join("y.txt")).unwrap(), b"yz");
        assert_eq!(
            download.top_level,
            vec![staging.join("d"), staging.join("y.txt")]
        );
        drop(download);
        assert!(!staging.exists(), "unpublished staging is removed");
    }

    #[test]
    fn download_rejects_oversized_or_mismatched_data() {
        let over_quota = [descriptor("big.bin", None, Some(2048), false)];
        assert!(FileDownload::start(&over_quota, None, 1024).is_err());

        let files = [descriptor("a.txt", None, Some(2), false)];
        let mut download = FileDownload::start(&files, None, 1024).unwrap();
        let request = expect_request(download.next_request());
        let error = download
            .accept(&FileContentsResponse::new_data_response(
                request.stream_id,
                b"abc".to_vec(),
            ))
            .err()
            .unwrap();
        assert!(error.contains("exceeded"));

        let mut download = FileDownload::start(&files, None, 1024).unwrap();
        let request = expect_request(download.next_request());
        assert!(
            download
                .accept(&FileContentsResponse::new_data_response(
                    request.stream_id + 1,
                    b"ab".to_vec()
                ))
                .is_err()
        );
    }

    #[test]
    fn policy_defaults_to_all_and_falls_back_to_text() {
        let (policy, warnings) = ClipboardPolicy::from_settings("", "bogus", 0);
        assert_eq!(policy.server_to_client, ClipboardLevel::All);
        assert_eq!(policy.client_to_server, ClipboardLevel::Text);
        assert_eq!(policy.file_max_bytes, 1024 * 1024);
        assert!(policy.enabled() && policy.files_enabled());
        assert_eq!(warnings.len(), 1);
        let (off, warnings) = ClipboardPolicy::from_settings("off", "OFF", 10);
        assert!(!off.enabled() && warnings.is_empty());
    }
}
