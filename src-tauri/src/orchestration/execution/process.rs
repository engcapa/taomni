//! Bounded stdin/stdout protocol and process-tree cleanup for supervised launchers.
use futures::StreamExt;
use std::process::Stdio;
use tokio::{
    io::AsyncWriteExt,
    process::{Child, Command},
};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    sync::CancellationToken,
};

const MAX_LINE: usize = 1024 * 1024;
const MAX_SUMMARY: usize = 256 * 1024;

pub async fn supervise(
    mut child: Child,
    prompt: String,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let pid = child.id();
    #[cfg(windows)]
    let job = match super::windows_job::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("HARNESS_IO")?;
    let write = async move {
        if let Some(mut stdin) = stdin {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|_| "HARNESS_STDIN".to_string())?;
            stdin
                .shutdown()
                .await
                .map_err(|_| "HARNESS_STDIN".to_string())?;
        }
        Ok::<_, String>(())
    };
    let read = async move {
        let mut lines = FramedRead::new(stdout, LinesCodec::new_with_max_length(MAX_LINE));
        let mut summary = None;
        while let Some(line) = lines.next().await {
            let line = line.map_err(|_| "HARNESS_OUTPUT_LIMIT_OR_ENCODING".to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value =
                serde_json::from_str(&line).map_err(|_| "HARNESS_PROTOCOL".to_string())?;
            if value["type"] != "result" {
                continue;
            }
            if summary.is_some() || value["is_error"] != false || value["subtype"] != "success" {
                return Err(
                    "HARNESS_FAILED: worker did not report one successful terminal result".into(),
                );
            }
            let text = value["result"].as_str().ok_or("HARNESS_EMPTY_RESULT")?;
            if text.trim().is_empty() || text.len() > MAX_SUMMARY {
                return Err("HARNESS_RESULT_LIMIT".into());
            }
            summary = Some(text.to_owned());
        }
        summary.ok_or_else(|| "HARNESS_EMPTY_RESULT: successful terminal record required".into())
    };
    let work = async {
        let (_, summary) = tokio::try_join!(write, read)?;
        let exit = child.wait().await.map_err(|_| "HARNESS_EXIT".to_string())?;
        if !exit.success() {
            return Err("HARNESS_FAILED: worker exited unsuccessfully; inspect the retained private worker log".into());
        }
        Ok(summary)
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(900), async {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("CANCELLED".to_string()),
            result = work => result,
        }
    })
    .await
    .unwrap_or_else(|_| Err("HARNESS_TIMEOUT".into()));
    // Even a successful leader can leave descendants running. Release capacity
    // only after the process tree is stopped, not merely on a final JSON record.
    #[cfg(windows)]
    {
        job.terminate_and_wait().await?;
        tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .map_err(|_| "WORKER_STOP_UNKNOWN")?
            .map_err(|_| "WORKER_STOP_UNKNOWN")?;
    }
    #[cfg(not(windows))]
    stop_tree(&mut child, pid).await?;
    result
}

#[cfg(not(windows))]
async fn stop_tree(child: &mut Child, pid: Option<u32>) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        if tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
            .await
            .is_err()
        {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        // Always stop remaining same-group descendants after reaping the leader.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| "WORKER_STOP_UNKNOWN")?
        .map_err(|_| "WORKER_STOP_UNKNOWN")?;
    Ok(())
}

pub fn configure(command: &mut Command) {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
}
