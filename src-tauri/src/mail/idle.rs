//! IMAP IDLE push for an open mail tab (TASK-12).
//!
//! One watcher per account holds a dedicated connection (not the pooled
//! command session) in IDLE on INBOX and emits `mail://idle` when the server
//! reports a change; the frontend then runs its normal gap-free catch-up.
//! Watchers exist only while a mail tab is open (DEC-01: no background
//! receiving after the tab closes): the tab starts one and stops it on close.
//! Stopping shuts the socket down so a blocked IDLE wait returns at once.

use std::collections::HashMap;
#[cfg(any(test, feature = "legacy-mail-imap"))]
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use taomni_mail_api::imap_exchange::ImapIdleNotice;
#[cfg(any(test, feature = "legacy-mail-imap"))]
use taomni_mail_engine::imap_idle as engine;
use taomni_plugin_stream::CancellationToken;
use tauri::{AppHandle, Emitter, State};

#[cfg(any(test, feature = "legacy-mail-imap"))]
use super::{ActiveImapSession, connect_imap_with_socket, retire_imap_session};
use super::{
    MailAccountConfig, ResolvedMailAccount,
    module_host::imap_idle::{HostedIdle, available},
    resolve_config,
};
use crate::plugin::PluginRegistry;
use crate::state::AppState;

pub const MAIL_IDLE_EVENT: &str = "mail://idle";
const RECONNECT_DELAYS_SECS: [u64; 5] = [2, 5, 15, 30, 60];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailIdleEvent {
    pub account_id: String,
    pub folder: String,
    /// "ready" (IDLE active), "changed", "unsupported", "error" or "stopped".
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Watcher {
    folder: String,
    stop: Arc<AtomicBool>,
    cancel: CancellationToken,
    #[cfg(any(test, feature = "legacy-mail-imap"))]
    socket: Arc<Mutex<Option<TcpStream>>>,
}

impl Watcher {
    fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.cancel.cancel();
        #[cfg(any(test, feature = "legacy-mail-imap"))]
        if let Ok(mut socket) = self.socket.lock() {
            if let Some(socket) = socket.take() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
}

fn watchers() -> &'static Mutex<HashMap<String, Watcher>> {
    static WATCHERS: OnceLock<Mutex<HashMap<String, Watcher>>> = OnceLock::new();
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(any(test, feature = "legacy-mail-imap"))]
impl ActiveImapSession {
    fn prepare_idle(&mut self, folder: &str) -> Result<bool, String> {
        match self {
            Self::Tls { session, .. } => engine::prepare(session, folder),
            Self::Plain { session, .. } => engine::prepare(session, folder),
        }
    }

    fn idle_changed(&mut self) -> Result<bool, String> {
        match self {
            Self::Tls { session, .. } => engine::wait(session),
            Self::Plain { session, .. } => engine::wait(session),
        }
    }
}

fn emit(app: &AppHandle, account_id: &str, folder: &str, kind: &str, error: Option<String>) {
    let _ = app.emit(
        MAIL_IDLE_EVENT,
        MailIdleEvent {
            account_id: account_id.to_string(),
            folder: folder.to_string(),
            kind: kind.to_string(),
            error,
        },
    );
}

#[cfg(any(test, feature = "legacy-mail-imap"))]
fn run_watcher(
    app: AppHandle,
    account: ResolvedMailAccount,
    runtime: tokio::runtime::Handle,
    folder: String,
    stop: Arc<AtomicBool>,
    socket_slot: Arc<Mutex<Option<TcpStream>>>,
) {
    let account_id = account.config.session_id.clone();
    let mut failures = 0usize;
    while !stop.load(Ordering::SeqCst) {
        let connected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            connect_imap_with_socket(&account, &runtime)
        }))
        .unwrap_or_else(|_| Err("IMAP protocol desync".into()));
        let (mut session, socket) = match connected {
            Ok(pair) => pair,
            Err(e) => {
                emit(&app, &account_id, &folder, "error", Some(e));
                if !backoff(&stop, &mut failures) {
                    break;
                }
                continue;
            }
        };
        if let Ok(mut slot) = socket_slot.lock() {
            *slot = socket;
        }
        if stop.load(Ordering::SeqCst) {
            retire_imap_session(session);
            break;
        }
        match session.prepare_idle(&folder) {
            Ok(true) => {}
            Ok(false) => {
                emit(&app, &account_id, &folder, "unsupported", None);
                retire_imap_session(session);
                break;
            }
            Err(error) => {
                emit(&app, &account_id, &folder, "error", Some(error));
                retire_imap_session(session);
                if !backoff(&stop, &mut failures) {
                    break;
                }
                continue;
            }
        }
        emit(&app, &account_id, &folder, "ready", None);
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let outcome =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| session.idle_changed()))
                    .unwrap_or_else(|_| Err("IMAP protocol desync".into()));
            match outcome {
                Ok(true) => {
                    failures = 0;
                    emit(&app, &account_id, &folder, "changed", None);
                }
                Ok(false) => failures = 0,
                Err(e) => {
                    if !stop.load(Ordering::SeqCst) {
                        emit(&app, &account_id, &folder, "error", Some(e));
                    }
                    break;
                }
            }
        }
        // The socket may already be shut down; a failed logout is expected.
        drop(session);
        if stop.load(Ordering::SeqCst) || !backoff(&stop, &mut failures) {
            break;
        }
    }
    emit(&app, &account_id, &folder, "stopped", None);
}

/// Sleep before reconnecting; false when stopped or out of attempts.
#[cfg(any(test, feature = "legacy-mail-imap"))]
fn backoff(stop: &AtomicBool, failures: &mut usize) -> bool {
    let Some(delay) = RECONNECT_DELAYS_SECS.get(*failures).copied() else {
        return false;
    };
    *failures += 1;
    for _ in 0..(delay * 10) {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

async fn watch_host(
    app: AppHandle,
    registry: Arc<PluginRegistry>,
    account: ResolvedMailAccount,
    folder: String,
    cancel: CancellationToken,
) {
    let account_id = &account.config.session_id;
    let mut failures = 0;
    while available(&registry) {
        let one_connection = async {
            let mut watch = HostedIdle::open(registry.clone(), &account, &folder).await?;
            loop {
                match watch.next().await? {
                    ImapIdleNotice::Ready => emit(&app, account_id, &folder, "ready", None),
                    ImapIdleNotice::Changed => {
                        failures = 0;
                        emit(&app, account_id, &folder, "changed", None);
                    }
                    ImapIdleNotice::Refresh => failures = 0,
                    ImapIdleNotice::Unsupported => {
                        emit(&app, account_id, &folder, "unsupported", None);
                        return Ok(());
                    }
                    ImapIdleNotice::Error(error) => return Err(error),
                }
            }
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            result = one_connection => result,
        };
        let Err(error) = result else { break };
        if !available(&registry) {
            break;
        }
        emit(&app, account_id, &folder, "error", Some(error));
        let Some(delay) = RECONNECT_DELAYS_SECS.get(failures) else {
            break;
        };
        failures += 1;
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(*delay)) => {},
        }
    }
    emit(&app, account_id, &folder, "stopped", None);
}

fn remove_watcher(account_id: &str, owner: &Arc<AtomicBool>) {
    if let Ok(mut map) = watchers().lock()
        && map
            .get(account_id)
            .is_some_and(|watcher| Arc::ptr_eq(&watcher.stop, owner))
    {
        map.remove(account_id);
    }
}

/// Start (or keep) the IDLE watcher of an open mail tab.
#[tauri::command]
pub async fn mail_idle_start(
    app: AppHandle,
    config: MailAccountConfig,
    folder: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if super::pop3::is_pop3(&config) {
        // POP3 has no push; the tab keeps polling.
        let _ = (&app, &folder);
        return Ok(false);
    }
    let account = resolve_config(&state, config)?;
    let account_id = account.config.session_id.clone();
    let folder = folder
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| "INBOX".to_string());
    {
        let mut map = watchers().lock().map_err(|e| e.to_string())?;
        if let Some(existing) = map.get(&account_id) {
            if existing.folder == folder && !existing.stop.load(Ordering::SeqCst) {
                return Ok(true);
            }
        }
        if let Some(old) = map.remove(&account_id) {
            old.shutdown();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = CancellationToken::new();
        #[cfg(any(test, feature = "legacy-mail-imap"))]
        let socket = Arc::new(Mutex::new(None));
        map.insert(
            account_id.clone(),
            Watcher {
                folder: folder.clone(),
                stop: Arc::clone(&stop),
                cancel: cancel.clone(),
                #[cfg(any(test, feature = "legacy-mail-imap"))]
                socket: Arc::clone(&socket),
            },
        );
        if available(&state.plugins) {
            let registry = state.plugins.clone();
            tokio::spawn(async move {
                watch_host(app, registry, account, folder, cancel).await;
                remove_watcher(&account_id, &stop);
            });
            return Ok(true);
        }
        let started: Result<(), String> = legacy_imap!({
            let runtime = tokio::runtime::Handle::current();
            let thread_account_id = account_id.clone();
            std::thread::Builder::new()
                .name(format!("mail-idle-{account_id}"))
                .spawn(move || {
                    run_watcher(app, account, runtime, folder, Arc::clone(&stop), socket);
                    remove_watcher(&thread_account_id, &stop);
                })
                .map(|_| ())
                .map_err(|error| format!("failed to start mail IDLE thread: {error}"))
        });
        if started.is_err() {
            map.remove(&account_id);
        }
        started?;
    }
    Ok(true)
}

/// Stop the account's IDLE watcher (mail tab closed).
#[tauri::command]
pub async fn mail_idle_stop(account_id: String) -> Result<bool, String> {
    let watcher = watchers()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&account_id);
    Ok(match watcher {
        Some(watcher) => {
            watcher.shutdown();
            true
        }
        None => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_stops_when_requested_or_exhausted() {
        let stop = AtomicBool::new(true);
        let mut failures = 0;
        assert!(!backoff(&stop, &mut failures));
        let running = AtomicBool::new(false);
        let mut exhausted = RECONNECT_DELAYS_SECS.len();
        assert!(!backoff(&running, &mut exhausted));
    }

    #[test]
    fn idle_on_fake_server_reports_changes() {
        let fake = super::super::fake_imap::FakeImap::start(false);
        let mut session = fake.session();
        session.examine("INBOX").unwrap();
        let delivery = {
            let fake = fake.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                fake.deliver("INBOX", 1, "pushed");
            })
        };
        let mut handle = session.idle().unwrap();
        handle.set_keepalive(Duration::from_secs(10));
        let outcome = handle.wait_with_timeout(Duration::from_secs(10)).unwrap();
        delivery.join().unwrap();
        assert!(matches!(
            outcome,
            imap::extensions::idle::WaitOutcome::MailboxChanged
        ));
    }
}
