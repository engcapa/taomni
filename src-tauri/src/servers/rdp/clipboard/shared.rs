use super::files::AnnouncedFile;
use super::files::StagingDir;
use super::files::collect_announced_files;
use super::host_content::HostContent;
use super::limits::CF_UNICODETEXT;
use super::policy::ClipboardPolicy;
use super::policy::html_format;
use crate::servers::engine::LogEmitter;
use ironrdp::cliprdr::backend::ClipboardMessage;
use ironrdp::cliprdr::pdu::ClipboardFormat;
use ironrdp::cliprdr::pdu::ClipboardFormatId;
use ironrdp::server::ServerEvent;
use ironrdp::server::tokio::sync::mpsc::UnboundedSender;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;

pub(super) enum Command {
    /// A client channel became ready: advertise what the host holds now.
    Advertise,
    /// Publish content received from the client.
    Write(HostContent),
}

/// Host-side state shared by the worker and the per-connection backend.
#[derive(Default)]
pub(super) struct HostState {
    pub(super) snapshot: HostContent,
    pub(super) announced: Arc<Vec<AnnouncedFile>>,
    /// Announced lists frozen by client Lock PDUs (clipDataId → files).
    pub(super) locks: HashMap<u32, Arc<Vec<AnnouncedFile>>>,
    /// Files most recently received from the client stay staged while the
    /// host clipboard references them, until the next transfer replaces them.
    pub(super) published_staging: Option<StagingDir>,
}

pub(super) struct Shared {
    pub(super) log: LogEmitter,
    pub(super) policy: ClipboardPolicy,
    pub(super) sender: Mutex<Option<UnboundedSender<ServerEvent>>>,
    /// A client CLIPRDR channel is up.
    pub(super) ready: AtomicBool,
    /// The client negotiated CB_STREAM_FILECLIP_ENABLED.
    pub(super) files_negotiated: AtomicBool,
    pub(super) host: Mutex<HostState>,
    pub(super) worker: Mutex<Option<Sender<Command>>>,
    pub(super) advertisements: AtomicU64,
}

impl Shared {
    pub(super) fn send(&self, message: ClipboardMessage) {
        if let Ok(sender) = self.sender.lock()
            && let Some(sender) = sender.as_ref()
        {
            let _ = sender.send(ServerEvent::Clipboard(message));
        }
    }

    pub(super) fn command(&self, command: Command) {
        if let Ok(worker) = self.worker.lock()
            && let Some(worker) = worker.as_ref()
        {
            let _ = worker.send(command);
        }
    }

    pub(super) fn snapshot(&self) -> HostContent {
        self.host
            .lock()
            .map(|host| host.snapshot.clone())
            .unwrap_or_default()
    }

    pub(super) fn set_snapshot(&self, content: HostContent) {
        if let Ok(mut host) = self.host.lock() {
            host.snapshot = content;
        }
    }

    /// Offer `content` to the client within the host → client policy.
    pub(super) fn advertise(&self, content: &HostContent) {
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
    pub(super) fn announced_file(&self, index: i32, data_id: Option<u32>) -> Option<AnnouncedFile> {
        let host = self.host.lock().ok()?;
        let list = data_id
            .and_then(|id| host.locks.get(&id))
            .unwrap_or(&host.announced);
        usize::try_from(index)
            .ok()
            .and_then(|index| list.get(index).cloned())
    }
}
