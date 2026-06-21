use super::protocol::{parse_ndjson_line, CcEvent};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const MAX_RESTART_ATTEMPTS: u32 = 3;
const HEALTH_CHECK_INTERVAL_SECS: u64 = 30;
const RESTART_COOLDOWN_SECS: u64 = 60;
/// How long to wait for the *next* line of output before declaring the turn
/// dead. This is an idle timeout, not a wall-clock budget: every line CC emits
/// (including the `--include-partial-messages` token deltas) resets the clock,
/// so a long-running `Bash` build that streams progress stays alive, while a
/// genuinely wedged process is still reaped. Default is relaxed; override per
/// process with `with_idle_timeout`.
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 600;

/// One Claude Code child per chat thread.
///
/// Lifecycle:
/// - First send() spawns the process via `ensure_running`.
/// - A background watchdog wakes every 30s and verifies the child is still
///   running; if the OS reports it exited, we mark the process unhealthy so
///   the next send() respawns (subject to the 3-failure circuit breaker).
/// - On a 3rd consecutive failure within RESTART_COOLDOWN_SECS, the breaker
///   opens and `ensure_running` returns an error that the caller surfaces to
///   the user (so they know to fall back to the secondary provider).
/// - The breaker auto-resets after the cooldown so a transiently-flapping CLI
///   can recover without a Taomni restart.
pub struct CcProcess {
    binary: String,
    args: Vec<String>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
    restart_count: AtomicU32,
    last_failure_at: Mutex<Option<Instant>>,
    /// Set by the watchdog when it observes a dead process between calls.
    needs_respawn: AtomicBool,
    /// Set by `stop()` so the watchdog stops itself.
    stopped: AtomicBool,
    watchdog_started: AtomicBool,
    /// Rolling capture of the child's stderr, used to surface spawn/runtime
    /// errors (e.g. missing flags, auth failures) that would otherwise be
    /// invisible and present as an empty assistant bubble.
    stderr_buf: Arc<Mutex<String>>,
    /// Obscure temp directory holding this session's `--settings` /
    /// `--mcp-config` files. Owned by the process so the (possibly
    /// credential-bearing) settings file is removed when the session ends —
    /// see `stop()` and the `Drop` impl. `None` when the caller manages the
    /// files itself.
    temp_dir: Option<PathBuf>,
    /// Idle timeout between successive output lines for a single turn.
    idle_timeout: Duration,
}

impl CcProcess {
    pub fn new(binary: impl Into<String>, extra_args: Vec<String>, temp_dir: Option<PathBuf>) -> Self {
        let mut args = vec![
            "--print".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--input-format".into(),
            "stream-json".into(),
            // CC requires --verbose when combining --print with
            // --output-format stream-json; without it the CLI exits
            // immediately with an error.
            "--verbose".into(),
            // v2.6 §22: surface partial assistant tokens so the UI can stream.
            "--include-partial-messages".into(),
        ];
        args.extend(extra_args);

        Self {
            binary: binary.into(),
            args,
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            restart_count: AtomicU32::new(0),
            last_failure_at: Mutex::new(None),
            needs_respawn: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            watchdog_started: AtomicBool::new(false),
            stderr_buf: Arc::new(Mutex::new(String::new())),
            temp_dir,
            idle_timeout: Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS),
        }
    }

    /// Override the per-turn idle timeout (builder style). Lets the caller wire
    /// the value from config without changing the `new` signature.
    pub fn with_idle_timeout(mut self, timeout: Duration) -> Self {
        self.idle_timeout = timeout;
        self
    }

    /// Send a message and collect all events until Done or Error.
    /// Spawns the process if not already running.
    pub async fn send(&self, message: &str) -> Result<Vec<CcEvent>, String> {
        self.send_with_callback(message, |_| {}).await
    }

    /// Send a message with a per-event callback so callers can stream partial
    /// tokens to the UI as they arrive.
    pub async fn send_with_callback<F: FnMut(&CcEvent)>(
        &self,
        message: &str,
        mut on_event: F,
    ) -> Result<Vec<CcEvent>, String> {
        self.ensure_running().await?;

        // Write the message as a JSON line to stdin. CC's stream-json input
        // format expects `message` to be a full Anthropic message object
        // ({"role":"user","content":"..."}), not a bare string.
        let input = format!(
            "{}\n",
            serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": message }
            })
        );
        {
            let mut stdin_guard = self.stdin.lock().await;
            if let Some(stdin) = stdin_guard.as_mut() {
                stdin
                    .write_all(input.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write to CC stdin: {}", e))?;
                stdin
                    .flush()
                    .await
                    .map_err(|e| format!("Failed to flush CC stdin: {}", e))?;
            }
        }

        // Read events from stdout until Done or Error.
        self.collect_events(&mut on_event).await
    }

    async fn ensure_running(self: &Self) -> Result<(), String> {
        // Watchdog flagged a dead child since the last call — clear the slot
        // so the spawn path runs.
        if self.needs_respawn.swap(false, Ordering::SeqCst) {
            let mut child_guard = self.child.lock().await;
            if let Some(mut c) = child_guard.take() {
                let _ = c.kill().await;
            }
            *self.stdin.lock().await = None;
        }

        let mut child_guard = self.child.lock().await;
        if child_guard.is_some() {
            return Ok(());
        }

        // Circuit breaker: refuse to keep respawning a binary that just won't
        // come up. We auto-reset the counter once RESTART_COOLDOWN_SECS have
        // passed since the last failure — that lets a transiently-broken CLI
        // recover without forcing a Taomni restart.
        let count = self.restart_count.load(Ordering::SeqCst);
        if count >= MAX_RESTART_ATTEMPTS {
            let last = *self.last_failure_at.lock().await;
            let cooled_down = last
                .map(|t| t.elapsed().as_secs() >= RESTART_COOLDOWN_SECS)
                .unwrap_or(false);
            if cooled_down {
                self.restart_count.store(0, Ordering::SeqCst);
            } else {
                return Err(format!(
                    "Claude Code process failed {} times. Falling back to default provider; will retry after {}s.",
                    MAX_RESTART_ATTEMPTS,
                    RESTART_COOLDOWN_SECS,
                ));
            }
        }

        let mut cmd = Command::new(&self.binary);
        cmd.args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.record_failure().await;
                return Err(format!("Failed to spawn Claude Code: {}", e));
            }
        };

        let stdin = child.stdin.take().ok_or("Failed to get CC stdin")?;

        // Drain stderr into a rolling buffer so we can report why the CLI
        // exited if it dies without producing usable stdout.
        if let Some(stderr) = child.stderr.take() {
            let buf = self.stderr_buf.clone();
            {
                let mut g = buf.lock().await;
                g.clear();
            }
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let mut g = buf.lock().await;
                            if g.len() < 8192 {
                                g.push_str(&line);
                            }
                        }
                    }
                }
            });
        }

        *child_guard = Some(child);
        *self.stdin.lock().await = Some(stdin);
        // Drop the guard before kicking the watchdog so it can lock back in.
        drop(child_guard);

        self.start_watchdog_if_needed();
        Ok(())
    }

    async fn record_failure(&self) {
        self.restart_count.fetch_add(1, Ordering::SeqCst);
        *self.last_failure_at.lock().await = Some(Instant::now());
    }

    /// Lazily spawn one watchdog per CcProcess. The Arc<Self> is materialised
    /// from the AppState by the caller; we only need a weak self-reference to
    /// poke the atomics — no Arc handle is required at this level because the
    /// watchdog stops itself on `stopped`.
    fn start_watchdog_if_needed(self: &Self) {
        if self.watchdog_started.swap(true, Ordering::SeqCst) {
            return;
        }
        // SAFETY: we leverage the fact that AppState holds an Arc<Self> for
        // the lifetime of the process registry, so a raw pointer captured in
        // the spawned task is valid as long as we never drop the Arc in the
        // background. `cc_stop_session` removes from the registry, then calls
        // stop(), then drops the Arc — the watchdog observes `stopped` and
        // exits before any drop happens.
        let ptr = self as *const Self as usize;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(HEALTH_CHECK_INTERVAL_SECS)).await;
                let this: &Self = unsafe { &*(ptr as *const Self) };
                if this.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let mut guard = this.child.lock().await;
                let dead = match guard.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(_status)) => true, // process exited
                        Ok(None) => false,         // still running
                        Err(_) => true,
                    },
                    None => false,
                };
                if dead {
                    if let Some(mut c) = guard.take() {
                        let _ = c.kill().await;
                    }
                    drop(guard);
                    *this.stdin.lock().await = None;
                    this.needs_respawn.store(true, Ordering::SeqCst);
                    this.record_failure().await;
                }
            }
        });
    }

    async fn collect_events<F: FnMut(&CcEvent)>(
        &self,
        on_event: &mut F,
    ) -> Result<Vec<CcEvent>, String> {
        let mut events = Vec::new();
        let mut terminal_seen = false;
        let mut child_guard = self.child.lock().await;

        let child = child_guard.as_mut().ok_or("CC process not running")?;

        let stdout = child.stdout.as_mut().ok_or("CC stdout not available")?;

        let mut reader = BufReader::new(stdout);
        let mut line = String::new();

        // Captures a read error / idle timeout so we can run the shared
        // kill+respawn cleanup once, after dropping the child guard, instead
        // of returning early with a poisoned (still-running, half-read) child.
        let mut read_failure: Option<String> = None;

        loop {
            line.clear();
            match tokio::time::timeout(self.idle_timeout, reader.read_line(&mut line)).await {
                Ok(Ok(0)) => break, // EOF — process exited.
                Ok(Ok(_)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Some(event) = parse_ndjson_line(trimmed) {
                        on_event(&event);
                        let done = matches!(event, CcEvent::Done | CcEvent::Error { .. });
                        events.push(event);
                        if done {
                            terminal_seen = true;
                            break;
                        }
                    }
                }
                Ok(Err(e)) => {
                    read_failure = Some(format!("CC stdout read error: {}", e));
                    break;
                }
                Err(_) => {
                    read_failure = Some(format!(
                        "CC response timed out after {}s of inactivity",
                        self.idle_timeout.as_secs()
                    ));
                    break;
                }
            }
        }

        // A turn that ended without a terminal event — EOF (child died early
        // on bad flags / auth failure / crash), a read error, or an idle
        // timeout — leaves the child in an unusable state. Reap it, schedule a
        // respawn and trip the failure counter so the breaker can engage, then
        // surface a real error instead of an empty bubble or a poisoned next
        // turn reading this turn's leftover output.
        if !terminal_seen {
            drop(child_guard);
            if let Some(mut c) = self.child.lock().await.take() {
                let _ = c.kill().await;
            }
            *self.stdin.lock().await = None;
            self.needs_respawn.store(true, Ordering::SeqCst);
            self.record_failure().await;
            if let Some(reason) = read_failure {
                return Err(reason);
            }
            let stderr = self.stderr_buf.lock().await.trim().to_string();
            let detail = if stderr.is_empty() {
                "no stderr output".to_string()
            } else {
                stderr
            };
            return Err(format!("Claude Code exited unexpectedly: {}", detail));
        }

        Ok(events)
    }

    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill().await;
        }
        *self.stdin.lock().await = None;
        // Remove the session's temp files now that the process is gone. The
        // settings file may carry the user's ANTHROPIC_AUTH_TOKEN, so we don't
        // want it lingering in the temp directory after use.
        if let Some(dir) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

impl Drop for CcProcess {
    /// Safety net: if the process is dropped without an explicit `stop()`
    /// (e.g. the registry entry is replaced), still scrub the temp directory.
    /// `stop()` sets `stopped` before the Arc is dropped, so the watchdog has
    /// already exited by the time this runs.
    fn drop(&mut self) {
        if let Some(dir) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
