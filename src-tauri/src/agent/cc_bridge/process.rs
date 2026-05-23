use super::protocol::{CcEvent, parse_ndjson_line};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const MAX_RESTART_ATTEMPTS: u32 = 3;

pub struct CcProcess {
    binary: String,
    args: Vec<String>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
    restart_count: AtomicU32,
}

impl CcProcess {
    pub fn new(binary: impl Into<String>, extra_args: Vec<String>) -> Self {
        let mut args = vec![
            "--print".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--input-format".into(),
            "stream-json".into(),
        ];
        args.extend(extra_args);

        Self {
            binary: binary.into(),
            args,
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            restart_count: AtomicU32::new(0),
        }
    }

    /// Send a message and collect all events until Done or Error.
    /// Spawns the process if not already running.
    pub async fn send(&self, message: &str) -> Result<Vec<CcEvent>, String> {
        self.ensure_running().await?;

        // Write the message as a JSON line to stdin.
        let input = format!("{}\n", serde_json::json!({ "type": "user", "message": message }));
        {
            let mut stdin_guard = self.stdin.lock().await;
            if let Some(stdin) = stdin_guard.as_mut() {
                stdin.write_all(input.as_bytes()).await
                    .map_err(|e| format!("Failed to write to CC stdin: {}", e))?;
                stdin.flush().await
                    .map_err(|e| format!("Failed to flush CC stdin: {}", e))?;
            }
        }

        // Read events from stdout until Done or Error.
        self.collect_events().await
    }

    async fn ensure_running(&self) -> Result<(), String> {
        let mut child_guard = self.child.lock().await;
        if child_guard.is_some() {
            return Ok(());
        }

        let count = self.restart_count.load(Ordering::SeqCst);
        if count >= MAX_RESTART_ATTEMPTS {
            return Err(format!(
                "Claude Code process failed {} times. Falling back to default provider.",
                MAX_RESTART_ATTEMPTS
            ));
        }

        let mut cmd = Command::new(&self.binary);
        cmd.args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to spawn Claude Code: {}", e))?;

        let stdin = child.stdin.take()
            .ok_or("Failed to get CC stdin")?;

        *child_guard = Some(child);
        *self.stdin.lock().await = Some(stdin);
        self.restart_count.fetch_add(1, Ordering::SeqCst);

        Ok(())
    }

    async fn collect_events(&self) -> Result<Vec<CcEvent>, String> {
        let mut events = Vec::new();
        let mut child_guard = self.child.lock().await;

        let child = child_guard.as_mut()
            .ok_or("CC process not running")?;

        let stdout = child.stdout.as_mut()
            .ok_or("CC stdout not available")?;

        let mut reader = BufReader::new(stdout);
        let mut line = String::new();

        loop {
            line.clear();
            match tokio::time::timeout(
                std::time::Duration::from_secs(30),
                reader.read_line(&mut line),
            ).await {
                Ok(Ok(0)) => break, // EOF
                Ok(Ok(_)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() { continue; }
                    match parse_ndjson_line(trimmed) {
                        Some(event) => {
                            let done = matches!(event, CcEvent::Done | CcEvent::Error { .. });
                            events.push(event);
                            if done { break; }
                        }
                        None => {} // Skip unparseable lines
                    }
                }
                Ok(Err(e)) => return Err(format!("CC stdout read error: {}", e)),
                Err(_) => return Err("CC response timed out after 30s".into()),
            }
        }

        Ok(events)
    }

    pub async fn stop(&self) {
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill().await;
        }
        *self.stdin.lock().await = None;
    }
}
