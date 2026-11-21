//! Supervise an external binary as a "server", streaming its stdout+stderr to
//! the frontend as log lines. Reused by the `vnc`, `nfs` and `iperf` leaves
//! (which wrap system daemons / tools) rather than implementing a protocol
//! in-process.

use std::{process::Stdio, sync::Arc};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub mod vnc;

pub type Log = Arc<dyn Fn(String) + Send + Sync>;

pub struct Started {
    pub pid: Option<u32>,
    pub task: JoinHandle<()>,
}

/// Resolve `program` on `PATH`, spawn it with `args`, stream both stdout and
/// stderr to the provided log sink, and return the OS pid plus a supervisor task.
///
/// The supervisor task exits when either the child process terminates or
/// the owner cancels the token (in which case the child is killed —
/// `kill_on_drop(true)` guarantees cleanup even on abrupt drops).
pub async fn spawn_supervised(
    program: &str,
    args: Vec<String>,
    cancel: CancellationToken,
    log: Log,
) -> Result<Started, String> {
    let resolved = which::which(program)
        .map_err(|_| format!("{program} not found in PATH — install it to use this server"))?;

    let mut child = Command::new(&resolved)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", resolved.display(), e))?;

    let pid = child.id();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Pump stdout lines.
    if let Some(stdout) = stdout {
        let log = log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log(line);
            }
        });
    }
    // Pump stderr lines.
    if let Some(stderr) = stderr {
        let log = log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log(line);
            }
        });
    }

    let task = tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                match status {
                    Ok(s) => log(format!("process exited: {}", s)),
                    Err(e) => log(format!("process wait error: {}", e)),
                }
            }
            _ = cancel.cancelled() => {
                // Ask the child to terminate; kill_on_drop handles the rest.
                let _ = child.kill().await;
                log("process stopped".into());
            }
        }
    });

    Ok(Started { pid, task })
}
