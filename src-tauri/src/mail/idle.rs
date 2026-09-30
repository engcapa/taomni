//! IMAP IDLE push for an open mail tab (TASK-12).
//!
//! One watcher per account holds a dedicated connection (not the pooled
//! command session) in IDLE on INBOX and emits `mail://idle` when the server
//! reports a change; the frontend then runs its normal gap-free catch-up.
//! Watchers exist only while a mail tab is open (DEC-01: no background
//! receiving after the tab closes): the tab starts one and stops it on close.
//! Stopping shuts the socket down so a blocked IDLE wait returns at once.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{
    ActiveImapSession, MailAccountConfig, ResolvedMailAccount, connect_imap_with_socket,
    resolve_config, retire_imap_session,
};
use crate::state::AppState;

pub const MAIL_IDLE_EVENT: &str = "mail://idle";
/// Re-issue IDLE well inside the 30-minute server timeout (RFC 2177).
const IDLE_REFRESH: Duration = Duration::from_secs(25 * 60);
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
    socket: Arc<Mutex<Option<TcpStream>>>,
}

impl Watcher {
    fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
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

enum IdleOutcome {
    Changed,
    TimedOut,
}

fn imap_idle_once<T: Read + Write + imap::extensions::idle::SetReadTimeout>(
    session: &mut imap::Session<T>,
) -> Result<IdleOutcome, String> {
    let mut handle = session
        .idle()
        .map_err(|e| format!("IMAP IDLE failed: {e}"))?;
    handle.set_keepalive(IDLE_REFRESH);
    match handle.wait_with_timeout(IDLE_REFRESH) {
        Ok(imap::extensions::idle::WaitOutcome::MailboxChanged) => Ok(IdleOutcome::Changed),
        Ok(imap::extensions::idle::WaitOutcome::TimedOut) => Ok(IdleOutcome::TimedOut),
        Err(e) => Err(format!("IMAP IDLE wait failed: {e}")),
    }
}

impl ActiveImapSession {
    fn supports_idle(&mut self) -> bool {
        self.has_capability("IDLE")
    }

    fn examine_folder(&mut self, folder: &str) -> Result<(), String> {
        let result = match self {
            Self::Tls { session, .. } => session.examine(folder).map(|_| ()),
            Self::Plain { session, .. } => session.examine(folder).map(|_| ()),
        };
        result.map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))
    }

    fn idle_once(&mut self) -> Result<IdleOutcome, String> {
        match self {
            Self::Tls { session, .. } => imap_idle_once(session),
            Self::Plain { session, .. } => imap_idle_once(session),
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
        if !session.supports_idle() {
            emit(&app, &account_id, &folder, "unsupported", None);
            retire_imap_session(session);
            break;
        }
        if let Err(e) = session.examine_folder(&folder) {
            emit(&app, &account_id, &folder, "error", Some(e));
            retire_imap_session(session);
            if !backoff(&stop, &mut failures) {
                break;
            }
            continue;
        }
        emit(&app, &account_id, &folder, "ready", None);
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let outcome =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| session.idle_once()))
                    .unwrap_or_else(|_| Err("IMAP protocol desync".into()));
            match outcome {
                Ok(IdleOutcome::Changed) => {
                    failures = 0;
                    emit(&app, &account_id, &folder, "changed", None);
                }
                Ok(IdleOutcome::TimedOut) => failures = 0,
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
        let socket = Arc::new(Mutex::new(None));
        map.insert(
            account_id.clone(),
            Watcher {
                folder: folder.clone(),
                stop: Arc::clone(&stop),
                socket: Arc::clone(&socket),
            },
        );
        let runtime = tokio::runtime::Handle::current();
        let thread_account_id = account_id.clone();
        std::thread::Builder::new()
            .name(format!("mail-idle-{account_id}"))
            .spawn(move || {
                run_watcher(app, account, runtime, folder, Arc::clone(&stop), socket);
                if let Ok(mut map) = watchers().lock() {
                    if map
                        .get(&thread_account_id)
                        .is_some_and(|watcher| Arc::ptr_eq(&watcher.stop, &stop))
                    {
                        map.remove(&thread_account_id);
                    }
                }
            })
            .map_err(|e| format!("failed to start mail IDLE thread: {e}"))?;
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
