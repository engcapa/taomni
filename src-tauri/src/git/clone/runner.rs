use super::progress::parse_progress_line;
use super::*;
use std::collections::VecDeque;
use std::io::Read;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub(super) struct CloneRuntime {
    pub(super) emit: Box<dyn Fn(GitCloneProgress) + Send>,
    pub(super) cancel: Arc<AtomicBool>,
    pub(super) vault: Option<Arc<Vault>>,
}

fn emit_progress(runtime: &CloneRuntime, payload: GitCloneProgress) {
    (runtime.emit)(payload);
}

fn drain_progress(receiver: &mpsc::Receiver<Vec<u8>>, pending: &mut Vec<u8>) -> Vec<String> {
    while let Ok(chunk) = receiver.try_recv() {
        pending.extend_from_slice(&chunk);
    }
    let mut lines = Vec::new();
    let mut start = 0;
    for index in 0..pending.len() {
        if pending[index] == b'\r' || pending[index] == b'\n' {
            let line = String::from_utf8_lossy(&pending[start..index]).into_owned();
            if !line.trim().is_empty() {
                lines.push(line);
            }
            start = index + 1;
        }
    }
    if start > 0 {
        pending.drain(..start);
    }
    lines
}

pub(super) fn run_clone(
    request: GitCloneRequest,
    proxy: (Option<String>, Option<String>),
    token: Option<(String, Zeroizing<String>)>,
    runtime: CloneRuntime,
) -> Result<GitCloneResult, String> {
    let started = Instant::now();
    let url = normalized_url(&request.url)?;
    let branch = normalized_branch(request.branch.as_deref())?;
    normalized_name(&request.workspace_name)?;
    let destination = normalized_destination(&request.destination)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Clone destination has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create clone parent directory: {error}"))?;

    let created = match fs::metadata(&destination) {
        Ok(metadata) if metadata.is_dir() => {
            let mut entries = fs::read_dir(&destination)
                .map_err(|error| format!("Cannot inspect clone destination: {error}"))?;
            if entries.next().is_some() {
                return Err(format!(
                    "Destination already exists and is not empty: {}",
                    destination.display()
                ));
            }
            false
        }
        Ok(_) => return Err("Clone destination is not a directory".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&destination)
                .map_err(|error| format!("Cannot create clone destination: {error}"))?;
            true
        }
        Err(error) => return Err(format!("Cannot inspect clone destination: {error}")),
    };

    emit_progress(
        &runtime,
        progress_payload(
            &request.task_id,
            "preparing",
            None,
            format!("Preparing {}", destination.display()),
            None,
            None,
        ),
    );

    let (mut command, askpass) = network_command(&proxy, token.as_ref())?;
    command.arg("clone").arg("--progress");
    if let Some(branch) = &branch {
        command.arg("--branch").arg(branch);
    }
    command
        .arg("--")
        .arg(&url)
        .arg(&destination)
        .current_dir(parent)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(askpass) = askpass {
                let _ = fs::remove_file(askpass);
            }
            cleanup_failed_clone(&destination, created);
            return Err(format!("failed to start git clone: {error}"));
        }
    };
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "git clone stderr pipe is unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    let reader = std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut buffer = [0u8; 4096];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if sender.send(buffer[..read].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut pending = Vec::new();
    let mut recent: VecDeque<String> = VecDeque::new();
    let mut cancelled = false;
    let mut last_emit = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    let mut last_phase = String::new();
    let mut last_percent: Option<f64> = None;

    loop {
        if runtime.cancel.load(Ordering::SeqCst) && !cancelled {
            cancelled = true;
            let _ = child.kill();
        }
        for line in drain_progress(&receiver, &mut pending) {
            if recent.len() >= 20 {
                recent.pop_front();
            }
            recent.push_back(line.chars().take(MAX_PROGRESS_LINE).collect());
            if let Some(update) = parse_progress_line(&line) {
                let changed_phase = update.phase != last_phase;
                let advanced = match (update.percent, last_percent) {
                    (Some(current), Some(previous)) => (current - previous).abs() >= 1.0,
                    (Some(_), None) => true,
                    _ => last_emit.elapsed() >= Duration::from_millis(250),
                };
                if changed_phase || advanced || last_emit.elapsed() >= Duration::from_millis(250) {
                    emit_progress(
                        &runtime,
                        progress_payload(
                            &request.task_id,
                            update.phase,
                            update.percent,
                            update.message,
                            update.objects_done,
                            update.objects_total,
                        ),
                    );
                    last_emit = Instant::now();
                    last_phase = update.phase.to_string();
                    last_percent = update.percent.or(last_percent);
                }
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                recent.push_back(format!("failed to wait for git clone: {error}"));
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(60));
    }

    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for git clone: {error}"))?;
    let _ = reader.join();
    for line in drain_progress(&receiver, &mut pending) {
        if recent.len() >= 20 {
            recent.pop_front();
        }
        recent.push_back(line.chars().take(MAX_PROGRESS_LINE).collect());
    }
    if let Some(askpass) = askpass {
        let _ = fs::remove_file(askpass);
    }

    if cancelled {
        let cleanup = cleanup_failed_clone(&destination, created);
        let mut message = "Git clone cancelled".to_string();
        if let Some(cleanup) = cleanup {
            message.push_str(&format!(" ({cleanup})"));
        }
        emit_progress(
            &runtime,
            progress_payload(
                &request.task_id,
                "cancelled",
                None,
                message.clone(),
                None,
                None,
            ),
        );
        return Err(message);
    }
    if !status.success() {
        let detail = recent
            .iter()
            .filter(|line| !line.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let cleanup = cleanup_failed_clone(&destination, created);
        let mut message = if detail.is_empty() {
            format!("git clone failed with {status}")
        } else {
            detail
        };
        if let Some(cleanup) = cleanup {
            message.push('\n');
            message.push_str(&cleanup);
        }
        emit_progress(
            &runtime,
            progress_payload(
                &request.task_id,
                "failed",
                None,
                message.clone(),
                None,
                None,
            ),
        );
        return Err(message);
    }

    emit_progress(
        &runtime,
        progress_payload(
            &request.task_id,
            "finalizing",
            Some(99.0),
            "Writing repository configuration".into(),
            None,
            None,
        ),
    );
    let remembered = apply_repo_config(
        &request,
        &destination,
        &proxy,
        token.as_ref(),
        request.remember_token,
        runtime.vault.as_deref(),
    )
    .map_err(|error| {
        format!(
            "Repository cloned to {} but its configuration failed: {error}",
            destination.display()
        )
    })?;
    let branch_now = current_branch_name(&destination);
    let head_oid = run_git_in(Some(&destination), ["rev-parse", "HEAD"])
        .ok()
        .and_then(|value| non_empty_string(&value));
    let default_branch = default_remote_branch(&destination);
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    emit_progress(
        &runtime,
        progress_payload(
            &request.task_id,
            "completed",
            Some(100.0),
            format!("Cloned into {}", destination.display()),
            None,
            None,
        ),
    );
    Ok(GitCloneResult {
        task_id: request.task_id,
        destination: destination.to_string_lossy().into_owned(),
        repo_root: destination.to_string_lossy().into_owned(),
        branch: branch_now,
        default_branch,
        head_oid,
        remote_url: url,
        duration_ms,
        token_remembered: remembered,
    })
}
