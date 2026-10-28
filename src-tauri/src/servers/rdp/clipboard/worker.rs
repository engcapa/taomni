use super::backend::ClipboardBackend;
use super::change_token::ChangeToken;
use super::files::cleanup_stale_staging;
use super::host_content::HostBusy;
use super::host_content::read_host;
use super::host_content::write_host;
use super::host_poll::HostPoll;
use super::limits::CONTENT_POLL;
use super::limits::TOKEN_POLL;
use super::policy::ClipboardPolicy;
use super::shared::Command;
use super::shared::HostState;
use super::shared::Shared;
use crate::servers::engine::LogEmitter;
use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::backend::CliprdrBackendFactory;
use ironrdp::server::CliprdrServerFactory;
use ironrdp::server::ServerEvent;
use ironrdp::server::ServerEventSender;
use ironrdp::server::tokio::sync::mpsc::UnboundedSender;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Instant;

/// The host worker: owns arboard, watches for changes, performs writes.
pub(super) fn run_worker(shared: Arc<Shared>, commands: Receiver<Command>) {
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
    let initial_token = token.current();
    let mut host_poll = HostPoll::new(initial_token, Instant::now());
    let poll = if initial_token.is_some() {
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
                let now = token.current();
                match read_host(&mut clipboard, level) {
                    Ok(content) if !content.is_empty() => {
                        host_poll.observed(now, false, Instant::now());
                        known = Some(content.identity());
                        // The client can request a format as soon as its list
                        // is queued. Publish the payload first, as on the
                        // polling path, or a fast first paste reads the old
                        // empty snapshot and receives CB_RESPONSE_FAIL.
                        shared.set_snapshot(content.clone());
                        shared.advertise(&content);
                    }
                    // A format declaration can precede its data without a
                    // second token change. Empty snapshots keep a rate-limited
                    // content check; busy reads leave the token unconsumed.
                    Ok(content) => {
                        host_poll.observed(now, true, Instant::now());
                        shared
                            .log
                            .line("clipboard: nothing to offer on this computer's clipboard yet");
                        known = Some(content.identity());
                        shared.set_snapshot(content);
                    }
                    Err(HostBusy) => {}
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
                let now = token.current();
                known = Some(content.identity());
                let current = read_host(&mut clipboard, level).unwrap_or(content);
                host_poll.observed(now, current.is_empty(), Instant::now());
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
        if !host_poll.should_read(now, Instant::now()) {
            continue;
        }
        // Busy: keep the old token so the next tick reads again.
        let Ok(content) = read_host(&mut clipboard, level) else {
            continue;
        };
        host_poll.observed(now, content.is_empty(), Instant::now());
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
    pub(super) shared: Arc<Shared>,
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
