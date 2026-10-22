use super::diagnostics::sanitize_diagnostic;
use super::diagnostics::spawn_stderr_reader;
use super::limits::EVENT_CHANNEL_CAPACITY;
use super::model::AcpProcessConfig;
use super::model::AcpRuntimeError;
use super::model::AcpRuntimeEvent;
use super::permissions::ClosedPermissionSessions;
use super::permissions::PendingPermissionMap;
use super::permissions::cancel_all_permissions;
use super::permissions::clear_pending_permissions;
use super::permissions::lock_unpoisoned;
use super::reader::spawn_stdout_reader;
use super::requests::PendingMap;
use super::requests::SharedStdin;
use super::requests::fail_pending;
use std::collections::HashMap;
use std::collections::HashSet;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use tokio::process::Child;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::sync::broadcast;

/// One long-lived ACP agent subprocess. The runtime is intentionally provider
/// neutral; Grok-specific command discovery and authentication selection live
/// in profile configuration, not in the request router.
pub struct AcpProcess {
    /// Opaque per-process identity used only to scope frontend permission
    /// cards. A thread can temporarily have a reusable chat ACP process and
    /// a short-lived media process at the same time.
    pub(super) permission_owner_id: String,
    pub(super) child: Mutex<Option<Child>>,
    pub(super) stdin: SharedStdin,
    pub(super) pending: PendingMap,
    pub(super) pending_permissions: PendingPermissionMap,
    /// Serializes permission registration against cancellation/stop. It is
    /// never held while awaiting a human decision.
    pub(super) permission_registration: Arc<Mutex<()>>,
    /// Sessions whose current prompt has completed or been cancelled. A late
    /// `session/request_permission` for one of these sessions gets the ACP
    /// cancelled outcome directly rather than reviving a stale UI gate.
    pub(super) closed_permission_sessions: ClosedPermissionSessions,
    pub(super) accepts_permissions: Arc<AtomicBool>,
    pub(super) events: broadcast::Sender<AcpRuntimeEvent>,
    pub(super) next_id: AtomicU64,
    pub(super) stopped: Arc<AtomicBool>,
    pub(super) request_timeout: Duration,
    pub(super) stderr_buf: Arc<Mutex<String>>,
    pub(super) unknown_notifications: Arc<AtomicU64>,
    pub(super) turn_active: AtomicBool,
    pub last_active_at: StdMutex<Instant>,
}

impl AcpProcess {
    pub async fn spawn(config: AcpProcessConfig) -> Result<Self, AcpRuntimeError> {
        let command = config.command.trim();
        if command.is_empty() {
            return Err(AcpRuntimeError::InvalidCommand);
        }

        let mut cmd = Command::new(command);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(current_dir) = &config.current_dir {
            cmd.current_dir(current_dir);
        }
        for key in &config.env_remove {
            cmd.env_remove(key);
        }
        for (key, value) in &config.env {
            if !key.trim().is_empty() {
                cmd.env(key, value);
            }
        }
        no_console_window(&mut cmd);

        let mut child = cmd.spawn().map_err(|error| {
            AcpRuntimeError::SpawnFailed(sanitize_diagnostic(&error.to_string()))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or(AcpRuntimeError::StdioUnavailable("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(AcpRuntimeError::StdioUnavailable("stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or(AcpRuntimeError::StdioUnavailable("stderr"))?;

        let stdin = Arc::new(Mutex::new(Some(stdin)));
        let pending = Arc::new(StdMutex::new(HashMap::new()));
        let pending_permissions = Arc::new(StdMutex::new(HashMap::new()));
        let permission_registration = Arc::new(Mutex::new(()));
        let closed_permission_sessions = Arc::new(StdMutex::new(HashSet::new()));
        let accepts_permissions = Arc::new(AtomicBool::new(true));
        let permission_owner_id = uuid::Uuid::new_v4().to_string();
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let stopped = Arc::new(AtomicBool::new(false));
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        let unknown_notifications = Arc::new(AtomicU64::new(0));

        spawn_stdout_reader(
            stdout,
            stdin.clone(),
            pending.clone(),
            pending_permissions.clone(),
            permission_registration.clone(),
            closed_permission_sessions.clone(),
            accepts_permissions.clone(),
            events.clone(),
            stopped.clone(),
            unknown_notifications.clone(),
            config.request_timeout,
        );
        spawn_stderr_reader(stderr, stderr_buf.clone(), config.stderr_limit);

        Ok(Self {
            permission_owner_id,
            child: Mutex::new(Some(child)),
            stdin,
            pending,
            pending_permissions,
            permission_registration,
            closed_permission_sessions,
            accepts_permissions,
            events,
            next_id: AtomicU64::new(1),
            stopped,
            request_timeout: config.request_timeout,
            stderr_buf,
            unknown_notifications,
            turn_active: AtomicBool::new(false),
            last_active_at: StdMutex::new(Instant::now()),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AcpRuntimeEvent> {
        self.events.subscribe()
    }

    /// Opaque identity for routing this process's permission cards in the UI.
    pub fn permission_owner_id(&self) -> &str {
        &self.permission_owner_id
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub fn is_turn_active(&self) -> bool {
        self.turn_active.load(Ordering::SeqCst)
    }

    pub fn unknown_notification_count(&self) -> u64 {
        self.unknown_notifications.load(Ordering::Relaxed)
    }

    pub async fn stderr(&self) -> String {
        self.stderr_buf.lock().await.clone()
    }

    pub async fn stop(&self) {
        // Stop accepting permission requests before draining the current set.
        // Holding the registration lock through the flush means a request that
        // was already being registered is included, while any later request
        // observes the stopped process and fails closed.
        self.accepts_permissions.store(false, Ordering::SeqCst);
        let registration = self.permission_registration.lock().await;
        cancel_all_permissions(&self.pending_permissions).await;
        self.stopped.store(true, Ordering::SeqCst);
        *self.stdin.lock().await = None;
        fail_pending(&self.pending, AcpRuntimeError::Stopped);
        clear_pending_permissions(&self.pending_permissions);
        drop(registration);
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.touch();
    }

    pub(super) fn touch(&self) {
        *lock_unpoisoned(&self.last_active_at) = Instant::now();
    }
}

impl Drop for AcpProcess {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        fail_pending(&self.pending, AcpRuntimeError::Stopped);
        clear_pending_permissions(&self.pending_permissions);
        if let Ok(mut stdin) = self.stdin.try_lock() {
            stdin.take();
        }
        if let Ok(mut child) = self.child.try_lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        }
    }
}

pub(super) fn no_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
