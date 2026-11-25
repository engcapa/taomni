use super::dispatch::plain;
use super::dispatch::usage;
use super::latency::grid_colors;
use crate::Args;
use crate::ProbeError;
use crate::ScenarioResult;
use crate::audio::ProbeRdpsnd;
use crate::audio_input::AudioInputClient;
use crate::clipboard::LocalContent;
use crate::clipboard::ProbeClipboard;
use crate::session::ChannelPlan;
use crate::session::ConnectOptions;
use crate::session::ProbeSession;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;

/// Whether the host target state file at `path` reports `"ready": true`.
pub(super) fn target_ready(path: &str) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|state| state["ready"] == json!(true))
}

/// The files next to a state file (small logs and JSON inline), attached
/// when a target never became ready so the report shows why.
pub(super) fn ready_diagnostics(path: &str) -> Value {
    let Some(dir) = Path::new(path).parent() else {
        return json!(null);
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return json!({ "dir": dir.display().to_string(), "readable": false });
    };
    let files: Vec<Value> = entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let text = matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("log" | "json" | "txt")
            ) && size <= 4096;
            json!({
                "name": entry.file_name().to_string_lossy(),
                "size": size,
                "content": text.then(|| std::fs::read_to_string(&path).ok()).flatten(),
            })
        })
        .collect();
    json!({ "dir": dir.display().to_string(), "files": files })
}

pub(super) fn not_ready(path: &str, limit: Duration) -> ProbeError {
    ProbeError::unmet(format!(
        "{path} did not report ready within {} s",
        limit.as_secs()
    ))
}

/// `--wait-ready STATE.json`: wait (up to `--wait-ready-sec`, default 120)
/// until a host target reports `"ready": true` in its state file — used when
/// the target starts inside another session (the TermService baseline).
/// With `--wait-ready-connected` the `connect` scenario waits inside its
/// session instead, which keeps a first logon progressing.
pub(super) async fn wait_ready(args: &Args) -> Result<Option<u64>, (ProbeError, Value)> {
    let Some(path) = args.opt("wait-ready") else {
        return Ok(None);
    };
    if args.flag("wait-ready-connected") {
        return Ok(None);
    }
    let limit = Duration::from_secs(args.u64("wait-ready-sec", 120).map_err(usage)?);
    let started = Instant::now();
    loop {
        if target_ready(&path) {
            return Ok(Some(started.elapsed().as_millis() as u64));
        }
        if started.elapsed() >= limit {
            return Err((
                not_ready(&path, limit),
                json!({ "wait_ready": ready_diagnostics(&path) }),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub(super) async fn open(
    args: &Args,
    plan: ChannelPlan,
) -> Result<ProbeSession, (ProbeError, Value)> {
    let opts = ConnectOptions::from_args(args).map_err(plain)?;
    let mut session = ProbeSession::connect(&opts, plan).await.map_err(plain)?;
    let first_frame = args.duration_ms("first-frame-ms", 20_000).map_err(usage)?;
    if let Err(error) = session.wait_first_frame(first_frame).await {
        let summary = session.summary();
        return Err((error, summary));
    }
    Ok(session)
}

/// Keep receiving for `duration` so the framebuffer reflects the desktop.
pub(super) async fn settle(
    session: &mut ProbeSession,
    duration: Duration,
) -> Result<(), (ProbeError, Value)> {
    let deadline = Instant::now() + duration;
    if let Err(error) = session.pump_until(deadline).await {
        return Err((error, session.summary()));
    }
    Ok(())
}

pub(super) async fn connect(args: &Args) -> ScenarioResult {
    let plan = ChannelPlan {
        clipboard: args
            .flag("clipboard")
            .then(|| ProbeClipboard::new(LocalContent::default())),
        audio: args.flag("audio").then(|| ProbeRdpsnd::new(48_000)),
        audio_input: args.flag("audio-input").then(AudioInputClient::default),
    };
    let mut session = open(args, plan).await?;
    let mut waited_ms = None;
    if let (Some(path), true) = (args.opt("wait-ready"), args.flag("wait-ready-connected")) {
        let limit = Duration::from_secs(args.u64("wait-ready-sec", 120).map_err(usage)?);
        let started = Instant::now();
        while !target_ready(&path) {
            if started.elapsed() >= limit {
                let mut report = session.summary();
                report["wait_ready"] = ready_diagnostics(&path);
                return Err((not_ready(&path, limit), report));
            }
            if let Err(error) = session.pump(Duration::from_millis(250)).await {
                let mut report = session.summary();
                report["wait_ready"] = ready_diagnostics(&path);
                return Err((error, report));
            }
        }
        waited_ms = Some(started.elapsed().as_millis() as u64);
    }
    let seconds = args.f64("seconds", 5.0).map_err(usage)?;
    settle(&mut session, Duration::from_secs_f64(seconds)).await?;
    let mut report = session.summary();
    report["distinct_grid_colors"] = json!(grid_colors(&session));
    if let Some(waited_ms) = waited_ms {
        report["wait_ready_connected_ms"] = json!(waited_ms);
    }
    Ok(report)
}
