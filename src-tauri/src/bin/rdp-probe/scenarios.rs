//! Scenario implementations. Each returns a JSON report; failures keep the
//! partial observations so a red run still carries its raw evidence.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ironrdp::cliprdr::CliprdrClient;
use ironrdp::cliprdr::pdu::{
    ClipboardFormatId, FileContentsFlags, FileContentsRequest, FormatDataResponse,
};
use ironrdp::dvc::DrdynvcClient;
use ironrdp::pdu::rdp::autodetect::AutoDetectRequest;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::audio::ProbeRdpsnd;
use crate::audio_input::{self, AudioInputClient};
use crate::clipboard::{self, Advert, ClipAction, LocalContent, LocalFile, ProbeClipboard};
use crate::session::{ChannelPlan, ConnectOptions, ProbeSession, PumpEvent};
use crate::{Args, ProbeError, ScenarioResult, host_audio, stats};

fn plain(error: ProbeError) -> (ProbeError, Value) {
    (error, json!({}))
}

fn usage(message: String) -> (ProbeError, Value) {
    plain(ProbeError::usage(message))
}

/// Whether the host target state file at `path` reports `"ready": true`.
fn target_ready(path: &str) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|state| state["ready"] == json!(true))
}

/// The files next to a state file (small logs and JSON inline), attached
/// when a target never became ready so the report shows why.
fn ready_diagnostics(path: &str) -> Value {
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

fn not_ready(path: &str, limit: Duration) -> ProbeError {
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
async fn wait_ready(args: &Args) -> Result<Option<u64>, (ProbeError, Value)> {
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

pub(crate) async fn run(args: &Args) -> ScenarioResult {
    let waited_ms = wait_ready(args).await?;
    let limit = Duration::from_secs(args.u64("timeout-sec", 120).map_err(usage)?);
    let work = async {
        match args.scenario.as_str() {
            "connect" => connect(args).await,
            "latency" => latency(args).await,
            "throughput" => throughput(args).await,
            "clipboard-send" => clipboard_send(args).await,
            "clipboard-receive" => clipboard_receive(args).await,
            "audio-capture" => audio_capture(args).await,
            "mic-send" => mic_send(args).await,
            "autodetect" => autodetect(args).await,
            "host-play" => host_play(args),
            "host-record" => host_record(args),
            "image-digest" => image_digest(args),
            "image-make" => image_make(args),
            other => Err(usage(format!("unknown scenario {other:?}"))),
        }
    };
    let mut result = match tokio::time::timeout(limit, work).await {
        Ok(result) => result,
        Err(_) => Err(plain(ProbeError::unmet(format!(
            "scenario exceeded --timeout-sec {}",
            limit.as_secs()
        )))),
    };
    if let Some(waited_ms) = waited_ms {
        let report = match &mut result {
            Ok(report) | Err((_, report)) => report,
        };
        if report.is_object() {
            report["wait_ready_ms"] = json!(waited_ms);
        }
    }
    result
}

async fn open(args: &Args, plan: ChannelPlan) -> Result<ProbeSession, (ProbeError, Value)> {
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
async fn settle(session: &mut ProbeSession, duration: Duration) -> Result<(), (ProbeError, Value)> {
    let deadline = Instant::now() + duration;
    if let Err(error) = session.pump_until(deadline).await {
        return Err((error, session.summary()));
    }
    Ok(())
}

fn grid_colors(session: &ProbeSession) -> usize {
    let mut colors = HashSet::new();
    let (w, h) = (session.width(), session.height());
    for gy in 0..24u16 {
        for gx in 0..32u16 {
            let x = (u32::from(w) * u32::from(gx) / 32) as u16;
            let y = (u32::from(h) * u32::from(gy) / 24) as u16;
            if let Some(px) = session.pixel(x, y) {
                colors.insert([px[0], px[1], px[2]]);
            }
        }
    }
    colors.len()
}

async fn connect(args: &Args) -> ScenarioResult {
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

fn color_delta(a: [u8; 4], b: [u8; 4]) -> u32 {
    (0..3).map(|i| u32::from(a[i].abs_diff(b[i]))).sum()
}

async fn latency(args: &Args) -> ScenarioResult {
    let x = args.u64("x", 0).map_err(usage)? as i64;
    let y = args.u64("y", 0).map_err(usage)? as i64;
    let dx = args.i64("sample-dx", -40).map_err(usage)?;
    let dy = args.i64("sample-dy", -40).map_err(usage)?;
    let count = args.u64("samples", 40).map_err(usage)? as usize;
    let warmup = args.u64("warmup", 3).map_err(usage)? as usize;
    let interval = args.duration_ms("interval-ms", 250).map_err(usage)?;
    let per_sample = args.duration_ms("sample-timeout-ms", 3000).map_err(usage)?;
    let threshold = args.u64("threshold", 96).map_err(usage)? as u32;
    let mode = args.str("mode", "click");
    if mode != "click" && mode != "key" {
        return Err(usage(format!("--mode must be click or key, got {mode}")));
    }
    let (sx, sy) = ((x + dx).max(0) as u16, (y + dy).max(0) as u16);

    let mut session = open(args, ChannelPlan::default()).await?;
    settle(&mut session, Duration::from_millis(1500)).await?;
    if let Err(error) = session.request_refresh().await {
        return Err((error, session.summary()));
    }
    settle(&mut session, Duration::from_millis(500)).await?;
    if session.pixel(sx, sy).is_none() {
        return Err((
            ProbeError::usage(format!("sample point {sx},{sy} is outside the desktop")),
            session.summary(),
        ));
    }

    let mut samples = Vec::with_capacity(count);
    let mut timeouts = 0usize;
    let mut transitions = Vec::new();
    let initial_pixel = session.pixel(sx, sy);
    for index in 0..warmup + count {
        let base = session.pixel(sx, sy).unwrap_or([0; 4]);
        let started = Instant::now();
        let sent = if mode == "click" {
            session.click(x as u16, y as u16).await
        } else {
            session.type_char('f').await
        };
        if let Err(error) = sent {
            return Err((error, session.summary()));
        }
        let mut observed = None;
        while started.elapsed() < per_sample {
            if let Err(error) = session.pump(Duration::from_millis(20)).await {
                return Err((error, session.summary()));
            }
            if let Some(now) = session.pixel(sx, sy) {
                if color_delta(base, now) > threshold {
                    observed = Some((started.elapsed().as_secs_f64() * 1000.0, now));
                    break;
                }
            }
        }
        match observed {
            Some((ms, now)) if index >= warmup => {
                samples.push(ms);
                if transitions.len() < 4 {
                    transitions.push(json!({ "from": base, "to": now }));
                }
            }
            Some(_) => {}
            None if index >= warmup => {
                timeouts += 1;
                // The verdict below is already failed; stop spending the
                // scenario budget so the partial report is still written.
                if timeouts * 4 > count {
                    break;
                }
            }
            None => {}
        }
        // Spacing keeps the target from coalescing two flips into one frame.
        let rest = Instant::now() + interval;
        if let Err(error) = session.pump_until(rest).await {
            return Err((error, session.summary()));
        }
    }
    let mut report = session.summary();
    report["latency_ms"] = stats::summary(&samples);
    report["samples_ms"] = json!(samples);
    report["timeouts"] = json!(timeouts);
    report["mode"] = json!(mode);
    report["target"] = json!({
        "x": x,
        "y": y,
        "sample_x": sx,
        "sample_y": sy,
        "initial_pixel": initial_pixel,
        "final_pixel": session.pixel(sx, sy),
    });
    report["transitions"] = json!(transitions);
    if samples.is_empty() || timeouts * 4 > count {
        return Err((
            ProbeError::unmet(format!(
                "{} of {count} samples timed out waiting for the target to change",
                timeouts
            )),
            report,
        ));
    }
    Ok(report)
}

fn parse_rect(text: &str) -> Result<(u16, u16, u16, u16), String> {
    let parts: Vec<u16> = text
        .split(',')
        .map(|p| p.trim().parse::<u16>())
        .collect::<Result<_, _>>()
        .map_err(|_| format!("--rect expects x,y,w,h, got {text:?}"))?;
    match parts.as_slice() {
        [x, y, w, h] if *w > 0 && *h > 0 => Ok((*x, *y, *w, *h)),
        _ => Err(format!(
            "--rect expects x,y,w,h with positive size, got {text:?}"
        )),
    }
}

async fn throughput(args: &Args) -> ScenarioResult {
    let seconds = args.f64("seconds", 10.0).map_err(usage)?;
    let mut session = open(args, ChannelPlan::default()).await?;
    settle(&mut session, Duration::from_millis(1000)).await?;
    let rect = match args.opt("rect") {
        Some(text) => parse_rect(&text).map_err(usage)?,
        None => (0, 0, session.width(), session.height()),
    };
    let marker = match args.opt("marker") {
        Some(text) => {
            let parts: Vec<u16> = text
                .split(',')
                .filter_map(|p| p.trim().parse().ok())
                .collect();
            match parts.as_slice() {
                [x, y] => Some((*x, *y)),
                _ => return Err(usage(format!("--marker expects x,y, got {text:?}"))),
            }
        }
        None => None,
    };
    let bytes_start = session.bytes_in;
    let updates_start = session.graphics_updates;
    let started = Instant::now();
    let deadline = started + Duration::from_secs_f64(seconds);
    let mut last = session.region_signature(rect);
    let mut change_times = Vec::new();
    // The target's marker steps through 16 grey levels, one per animation
    // frame; summing the level steps counts delivered frames even when the
    // codec splits one frame into several updates or the server skips some.
    let level_of = |session: &ProbeSession, (x, y): (u16, u16)| {
        session.pixel(x, y).map(|px| {
            // Levels are drawn at 16·n + 8, so integer division tolerates
            // ±7 of codec error.
            let grey = (u32::from(px[0]) + u32::from(px[1]) + u32::from(px[2])) / 3;
            (grey / 16).min(15)
        })
    };
    let mut marker_level = marker.and_then(|m| level_of(&session, m));
    let mut marker_frames = 0u32;
    let mut marker_skips = 0u32;
    while Instant::now() < deadline {
        let events = match session.pump(Duration::from_millis(50)).await {
            Ok(events) => events,
            Err(error) => return Err((error, session.summary())),
        };
        if events.iter().any(|e| matches!(e, PumpEvent::Graphics(_))) {
            let signature = session.region_signature(rect);
            if signature != last {
                last = signature;
                change_times.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            if let Some(m) = marker {
                let level = level_of(&session, m);
                if let (Some(previous), Some(now)) = (marker_level, level)
                    && now != previous
                {
                    let step = (now + 16 - previous) % 16;
                    marker_frames += step;
                    marker_skips += step - 1;
                }
                if level.is_some() {
                    marker_level = level;
                }
            }
        }
    }
    let elapsed = started.elapsed().as_secs_f64();
    let gaps: Vec<f64> = change_times.windows(2).map(|w| w[1] - w[0]).collect();
    let bytes = session.bytes_in - bytes_start;
    let mut report = session.summary();
    report["window_s"] = json!(elapsed);
    report["rect"] = json!(rect);
    report["visible_changes"] = json!(change_times.len());
    report["fps"] = json!(change_times.len() as f64 / elapsed);
    report["kbps"] = json!(bytes as f64 * 8.0 / 1000.0 / elapsed);
    report["graphics_updates_in_window"] = json!(session.graphics_updates - updates_start);
    report["frame_gap_ms"] = stats::summary(&gaps);
    if marker.is_some() {
        report["marker"] = json!({
            "frames": marker_frames,
            "fps": f64::from(marker_frames) / elapsed,
            // Frames the client never saw (level jumped by more than one).
            "skipped": marker_skips,
        });
    }
    Ok(report)
}

fn collect_files(paths: &str) -> Result<Vec<LocalFile>, String> {
    let mut files = Vec::new();
    for raw in paths.split(',').filter(|p| !p.trim().is_empty()) {
        let root = PathBuf::from(raw.trim());
        let base = root
            .file_name()
            .ok_or_else(|| format!("bad file path {raw:?}"))?
            .to_string_lossy()
            .into_owned();
        walk(&root, &base, &mut files)?;
    }
    if files.is_empty() {
        return Err("--files did not name any file".to_string());
    }
    Ok(files)
}

fn walk(path: &Path, name: &str, out: &mut Vec<LocalFile>) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.is_dir() {
        out.push(LocalFile {
            name: name.to_string(),
            path: None,
            is_dir: true,
            size: 0,
        });
        let mut entries: Vec<_> = std::fs::read_dir(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let child = format!("{name}\\{}", entry.file_name().to_string_lossy());
            walk(&entry.path(), &child, out)?;
        }
    } else {
        out.push(LocalFile {
            name: name.to_string(),
            path: Some(path.to_path_buf()),
            is_dir: false,
            size: meta.len(),
        });
    }
    Ok(())
}

async fn drain_clipboard(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
) -> Result<(), ProbeError> {
    let actions: Vec<ClipAction> = clip.with(|s| s.actions.drain(..).collect());
    for action in actions {
        let messages = {
            let Some(cliprdr) = session
                .active_stage
                .get_svc_processor_mut::<CliprdrClient>()
            else {
                return Err(ProbeError::unmet("CLIPRDR channel was not negotiated"));
            };
            match action {
                ClipAction::Advertise(Advert::Formats(formats)) => cliprdr.initiate_copy(&formats),
                ClipAction::Advertise(Advert::Files(files)) => cliprdr.initiate_file_copy(files),
                ClipAction::SubmitFormatData(response) => cliprdr.submit_format_data(response),
                ClipAction::SubmitFileContents(response) => cliprdr.submit_file_contents(response),
            }
            .map_err(|e| ProbeError::connection(format!("CLIPRDR encode: {e}")))?
        };
        session.send_svc_messages(messages).await?;
    }
    Ok(())
}

async fn pump_clipboard(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
    wait: Duration,
) -> Result<(), ProbeError> {
    session.pump(wait).await?;
    drain_clipboard(session, clip).await
}

async fn clipboard_send(args: &Args) -> ScenarioResult {
    let mut local = LocalContent::default();
    local.text = args.opt("text");
    local.html = args.opt("html");
    if let Some(png) = args.opt("image-png") {
        let image = image::open(&png)
            .map_err(|e| usage(format!("--image-png {png}: {e}")))?
            .to_rgba8();
        local.dib = Some(clipboard::rgba_to_dib(
            image.width(),
            image.height(),
            image.as_raw(),
        ));
    }
    if let Some(files) = args.opt("files") {
        local.files = collect_files(&files).map_err(usage)?;
    }
    // ironrdp-cliprdr answers the file-list request itself; file transfers
    // are judged by the file contents the server pulls.
    let expected: Vec<u32> = if !local.files.is_empty() {
        Vec::new()
    } else if local.dib.is_some() {
        vec![8]
    } else if local.html.is_some() {
        vec![clipboard::HTML_FORMAT_ID]
    } else if local.text.is_some() {
        vec![13]
    } else {
        return Err(usage(
            "clipboard-send needs --text, --html, --image-png or --files".into(),
        ));
    };
    let total_file_bytes: u64 = local.files.iter().map(|f| f.size).sum();
    let wait = Duration::from_secs(args.u64("wait-sec", 20).map_err(usage)?);
    let clip = ProbeClipboard::new(local.clone());
    let mut session = open(
        args,
        ChannelPlan {
            clipboard: Some(clip.clone()),
            ..ChannelPlan::default()
        },
    )
    .await?;
    let deadline = Instant::now() + wait;
    let mut advertised = false;
    let mut last_activity = Instant::now();
    let mut last_requests = 0u64;
    loop {
        if let Err(error) = pump_clipboard(&mut session, &clip, Duration::from_millis(50)).await {
            return Err((error, clipboard_report(&mut session, &clip)));
        }
        if !advertised && clip.with(|s| s.ready) {
            // Only when Monitor Ready did not already announce it: a second
            // format list would be a second copy.
            clip.with(|s| {
                if !s.announced {
                    s.actions.push_back(ClipAction::Advertise(local.advert()));
                    s.announced = true;
                }
            });
            advertised = true;
        }
        let (requested, file_requests, served) = clip.with(|s| {
            (
                s.requested_formats.clone(),
                s.file_requests,
                s.file_bytes_served,
            )
        });
        if file_requests != last_requests {
            last_requests = file_requests;
            last_activity = Instant::now();
        }
        let got_format = expected.iter().all(|id| requested.contains(id));
        let done = if local.files.is_empty() {
            got_format
        } else {
            file_requests > 0
                && served >= total_file_bytes
                && last_activity.elapsed() > Duration::from_millis(800)
        };
        if done || Instant::now() >= deadline {
            let mut report = clipboard_report(&mut session, &clip);
            report["expected_formats"] = json!(expected);
            report["total_file_bytes"] = json!(total_file_bytes);
            if !done {
                return Err((
                    ProbeError::unmet("server did not fetch the advertised clipboard data in time"),
                    report,
                ));
            }
            // Give the server a moment to apply the data to the host clipboard.
            let _ = session
                .pump_until(Instant::now() + Duration::from_millis(800))
                .await;
            return Ok(report);
        }
    }
}

fn clipboard_report(session: &mut ProbeSession, clip: &ProbeClipboard) -> Value {
    let mut report = session.summary();
    clip.with(|s| {
        report["clipboard"] = json!({
            "ready": s.ready,
            "negotiated_flags": s.negotiated,
            "remote_copies": s.remote_copies.iter().map(|formats| formats.iter().map(|f| json!({
                "id": f.id().value(),
                "name": f.name().map(|n| n.value().to_string()),
            })).collect::<Vec<_>>()).collect::<Vec<_>>(),
            "requested_formats": s.requested_formats,
            "file_requests": s.file_requests,
            "file_bytes_served": s.file_bytes_served,
            "format_list_acks": s.format_list_acks,
            "locks": s.locks,
            "log": s.log,
        });
    });
    report
}

fn find_format(clip: &ProbeClipboard, kind: &str) -> Option<u32> {
    clip.with(|s| {
        let formats = s.remote_copies.last()?;
        formats.iter().find_map(|f| {
            let id = f.id().value();
            let name = f.name().map(|n| n.value().to_string()).unwrap_or_default();
            let hit = match kind {
                "text" => id == 13,
                "html" => name == clipboard::HTML_FORMAT_NAME,
                "image" => id == 8 || id == 17,
                "files" => name == clipboard::FILE_LIST_FORMAT_NAME,
                _ => false,
            };
            hit.then_some(id)
        })
    })
}

async fn paste(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
    format: u32,
    wait: Duration,
) -> Result<Vec<u8>, ProbeError> {
    clip.with(|s| s.pending_paste = Some(format));
    let messages = {
        let Some(cliprdr) = session
            .active_stage
            .get_svc_processor_mut::<CliprdrClient>()
        else {
            return Err(ProbeError::unmet("CLIPRDR channel was not negotiated"));
        };
        cliprdr
            .initiate_paste(ClipboardFormatId::new(format))
            .map_err(|e| ProbeError::connection(format!("CLIPRDR paste: {e}")))?
    };
    session.send_svc_messages(messages).await?;
    let deadline = Instant::now() + wait;
    loop {
        pump_clipboard(session, clip, Duration::from_millis(50)).await?;
        if let Some((_, result)) = clip.with(|s| {
            s.responses
                .iter()
                .rev()
                .find(|(id, _)| *id == format)
                .cloned()
        }) {
            return result.map_err(ProbeError::unmet);
        }
        if Instant::now() >= deadline {
            return Err(ProbeError::unmet(format!(
                "no data response for format {format}"
            )));
        }
    }
}

/// Paste the server's FileGroupDescriptorW, then download every file with
/// SIZE + RANGE requests against the lock ironrdp took for the list.
async fn receive_files(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
    format: u32,
    wait: Duration,
    out_dir: Option<&Path>,
) -> ScenarioResult {
    clip.with(|s| s.remote_file_list = None);
    let messages = {
        let Some(cliprdr) = session
            .active_stage
            .get_svc_processor_mut::<CliprdrClient>()
        else {
            return Err((
                ProbeError::unmet("CLIPRDR channel was not negotiated"),
                clipboard_report(session, clip),
            ));
        };
        match cliprdr.initiate_paste(ClipboardFormatId::new(format)) {
            Ok(messages) => messages,
            Err(e) => {
                return Err((
                    ProbeError::connection(format!("CLIPRDR paste: {e}")),
                    clipboard_report(session, clip),
                ));
            }
        }
    };
    if let Err(error) = session.send_svc_messages(messages).await {
        return Err((error, clipboard_report(session, clip)));
    }
    let deadline = Instant::now() + wait;
    let (descriptors, data_id) = loop {
        if let Err(error) = pump_clipboard(session, clip, Duration::from_millis(50)).await {
            return Err((error, clipboard_report(session, clip)));
        }
        if let Some(list) = clip.with(|s| s.remote_file_list.clone()) {
            break list;
        }
        if Instant::now() >= deadline {
            return Err((
                ProbeError::unmet("server never answered the file list request"),
                clipboard_report(session, clip),
            ));
        }
    };
    let mut stream_id = 0u32;
    let mut files = Vec::new();
    for (index, descriptor) in descriptors.iter().enumerate() {
        let name = clipboard::wire_name(descriptor);
        let is_dir = descriptor
            .attributes
            .is_some_and(|a| a.contains(ironrdp::cliprdr::pdu::ClipboardFileAttributes::DIRECTORY));
        if is_dir {
            files.push(json!({ "name": name, "dir": true }));
            continue;
        }
        match fetch_file(session, clip, index as i32, data_id, &mut stream_id, wait).await {
            Ok(bytes) => {
                if let Some(dir) = out_dir {
                    let target = dir.join(name.replace('\\', "/"));
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&target, &bytes);
                }
                files.push(
                    json!({ "name": name, "size": bytes.len(), "sha256": sha256_hex(&bytes) }),
                );
            }
            Err(error) => {
                let mut report = clipboard_report(session, clip);
                report["files"] = json!(files);
                return Err((error, report));
            }
        }
    }
    let mut report = clipboard_report(session, clip);
    report["format"] = json!(format);
    report["lock_id"] = json!(data_id);
    report["received"] = json!({ "files": files });
    Ok(report)
}

async fn fetch_file(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
    index: i32,
    data_id: Option<u32>,
    stream_id: &mut u32,
    wait: Duration,
) -> Result<Vec<u8>, ProbeError> {
    async fn request(
        session: &mut ProbeSession,
        clip: &ProbeClipboard,
        request: FileContentsRequest,
        wait: Duration,
    ) -> Result<Vec<u8>, ProbeError> {
        let id = request.stream_id;
        let messages = {
            let Some(cliprdr) = session
                .active_stage
                .get_svc_processor_mut::<CliprdrClient>()
            else {
                return Err(ProbeError::unmet("CLIPRDR channel was not negotiated"));
            };
            cliprdr
                .request_file_contents(request)
                .map_err(|e| ProbeError::connection(format!("file contents request: {e}")))?
        };
        session.send_svc_messages(messages).await?;
        let deadline = Instant::now() + wait;
        loop {
            pump_clipboard(session, clip, Duration::from_millis(50)).await?;
            let found = clip.with(|s| {
                let position = s.file_responses.iter().position(|r| r.stream_id() == id)?;
                s.file_responses.remove(position)
            });
            if let Some(response) = found {
                if response.is_error() {
                    return Err(ProbeError::unmet(format!(
                        "server failed file contents stream {id}"
                    )));
                }
                return Ok(response.data().to_vec());
            }
            if Instant::now() >= deadline {
                return Err(ProbeError::unmet(format!(
                    "no file contents response for stream {id}"
                )));
            }
        }
    }

    *stream_id += 1;
    let size_bytes = request(
        session,
        clip,
        FileContentsRequest {
            stream_id: *stream_id,
            index,
            flags: FileContentsFlags::SIZE,
            position: 0,
            requested_size: 8,
            data_id,
        },
        wait,
    )
    .await?;
    let size = size_bytes
        .get(..8)
        .map(|b| u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
        .ok_or_else(|| ProbeError::unmet("short SIZE response"))?;
    let mut data = Vec::with_capacity(size as usize);
    while (data.len() as u64) < size {
        *stream_id += 1;
        let chunk = (size - data.len() as u64).min(1024 * 1024) as u32;
        let bytes = request(
            session,
            clip,
            FileContentsRequest {
                stream_id: *stream_id,
                index,
                flags: FileContentsFlags::RANGE,
                position: data.len() as u64,
                requested_size: chunk,
                data_id,
            },
            wait,
        )
        .await?;
        if bytes.is_empty() {
            return Err(ProbeError::unmet(
                "server returned an empty RANGE before EOF",
            ));
        }
        data.extend_from_slice(&bytes);
    }
    Ok(data)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn clipboard_receive(args: &Args) -> ScenarioResult {
    let kind = args.str("expect", "text");
    let out_dir = args.opt("out-dir").map(PathBuf::from);
    let wait = Duration::from_secs(args.u64("wait-sec", 20).map_err(usage)?);
    let clip = ProbeClipboard::new(LocalContent::default());
    let mut session = open(
        args,
        ChannelPlan {
            clipboard: Some(clip.clone()),
            ..ChannelPlan::default()
        },
    )
    .await?;
    let deadline = Instant::now() + wait;
    let format = loop {
        if let Err(error) = pump_clipboard(&mut session, &clip, Duration::from_millis(50)).await {
            return Err((error, clipboard_report(&mut session, &clip)));
        }
        if let Some(id) = find_format(&clip, &kind) {
            break id;
        }
        if Instant::now() >= deadline {
            return Err((
                ProbeError::unmet(format!("server never announced a {kind} clipboard format")),
                clipboard_report(&mut session, &clip),
            ));
        }
    };
    if let Some(dir) = &out_dir {
        let _ = std::fs::create_dir_all(dir);
    }
    if kind == "files" {
        return receive_files(&mut session, &clip, format, wait, out_dir.as_deref()).await;
    }
    let data = match paste(&mut session, &clip, format, wait).await {
        Ok(data) => data,
        Err(error) => return Err((error, clipboard_report(&mut session, &clip))),
    };
    let mut report = clipboard_report(&mut session, &clip);
    report["format"] = json!(format);
    let result = match kind.as_str() {
        "text" => {
            let text = FormatDataResponse::new_data(data.clone())
                .to_unicode_string()
                .map_err(|e| ProbeError::unmet(format!("text decode: {e}")));
            text.map(|text| {
                let text = text.trim_end_matches('\0').to_string();
                if let Some(dir) = &out_dir {
                    let _ = std::fs::write(dir.join("text.txt"), text.as_bytes());
                }
                json!({ "text": text, "sha256": sha256_hex(text.as_bytes()) })
            })
        }
        "html" => clipboard::cf_html_fragment(&data)
            .ok_or_else(|| ProbeError::unmet("CF_HTML payload has no fragment offsets"))
            .map(|fragment| {
                if let Some(dir) = &out_dir {
                    let _ = std::fs::write(dir.join("fragment.html"), fragment.as_bytes());
                }
                json!({ "fragment": fragment })
            }),
        "image" => clipboard::dib_to_rgba(&data)
            .map_err(ProbeError::unmet)
            .map(|(w, h, rgba)| {
                if let Some(dir) = &out_dir {
                    if let Some(img) = image::RgbaImage::from_raw(w, h, rgba.clone()) {
                        let _ = img.save(dir.join("image.png"));
                    }
                }
                json!({ "width": w, "height": h, "rgba_sha256": sha256_hex(&rgba) })
            }),
        other => Err(ProbeError::usage(format!(
            "--expect must be text|html|image|files, got {other}"
        ))),
    };
    match result {
        Ok(value) => {
            report["received"] = value;
            Ok(report)
        }
        Err(error) => Err((error, report)),
    }
}

async fn audio_capture(args: &Args) -> ScenarioResult {
    let seconds = args.f64("seconds", 4.0).map_err(usage)?;
    let expected = args.opt("freq").and_then(|f| f.parse::<f64>().ok());
    let rate = u32::try_from(args.u64("rdpsnd-rate", 48_000).map_err(usage)?)
        .map_err(|_| usage("--rdpsnd-rate is out of range".to_string()))?;
    let audio = ProbeRdpsnd::new(rate);
    let capture = audio.capture.clone();
    let formats: Vec<_> = audio.format(0).cloned().into_iter().collect();
    let mut session = open(
        args,
        ChannelPlan {
            audio: Some(audio),
            ..ChannelPlan::default()
        },
    )
    .await?;
    settle(&mut session, Duration::from_secs_f64(seconds)).await?;
    let mut report = session.summary();
    let captured = capture.lock().expect("audio capture");
    let format = captured.format_no.and_then(|n| formats.get(n)).cloned();
    report["audio"] = json!({
        "waves": captured.waves,
        "format_no": captured.format_no,
        "format_changes": captured.format_changes,
        "rate": format.as_ref().map(|f| f.n_samples_per_sec),
        "channels": format.as_ref().map(|f| f.n_channels),
        "volume": captured.volume,
        "closed": captured.closed,
        "first_wave_after_connect_ms": captured.first_wave_at.map(|t| t.saturating_duration_since(session.connected_at).as_millis() as u64),
    });
    let Some(format) = format else {
        drop(captured);
        return Err((ProbeError::unmet("server sent no RDPSND wave data"), report));
    };
    let mono = stats::mono_from_i16(&captured.samples, format.n_channels);
    if let Some(path) = args.opt("wav-out") {
        let _ = write_wav(
            Path::new(&path),
            &captured.samples,
            format.n_samples_per_sec,
            format.n_channels,
        );
    }
    report["tone"] = stats::tone_report(&mono, format.n_samples_per_sec, expected);
    if expected.is_some() && report["tone"]["frequency_matches"] != json!(true) {
        drop(captured);
        return Err((
            ProbeError::unmet("received audio does not contain the expected tone"),
            report,
        ));
    }
    Ok(report)
}

fn write_wav(path: &Path, samples: &[i16], rate: u32, channels: u16) -> std::io::Result<()> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
    out.extend_from_slice(&(channels * 2).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, out)
}

async fn mic_send(args: &Args) -> ScenarioResult {
    let seconds = args.f64("seconds", 4.0).map_err(usage)?;
    let freq = args.f64("freq", 440.0).map_err(usage)?;
    let client = AudioInputClient::default();
    let state = client.state.clone();
    let mut session = open(
        args,
        ChannelPlan {
            audio_input: Some(client),
            ..ChannelPlan::default()
        },
    )
    .await?;
    let open_deadline =
        Instant::now() + Duration::from_secs(args.u64("open-wait-sec", 15).map_err(usage)?);
    loop {
        if let Err(error) = session.pump(Duration::from_millis(50)).await {
            return Err((error, mic_report(&mut session, &state, 0, 0)));
        }
        if state.lock().expect("audio input").open {
            break;
        }
        if Instant::now() >= open_deadline {
            return Err((
                ProbeError::unmet("server did not open the AUDIO_INPUT channel"),
                mic_report(&mut session, &state, 0, 0),
            ));
        }
    }
    let (format, channel_id) = {
        let s = state.lock().expect("audio input");
        (s.current.expect("open implies a format"), s.channel_id)
    };
    let channel_id = channel_id
        .or_else(|| {
            session
                .active_stage
                .get_svc_processor::<DrdynvcClient>()
                .and_then(|dvc| dvc.get_dvc_by_type_id::<AudioInputClient>())
                .and_then(|channel| channel.channel_id())
        })
        .unwrap_or_default();
    let frames_per_packet = (format.rate / 50) as usize; // 20 ms
    let mut phase = 0.0;
    let packets = (seconds * 50.0) as usize;
    let mut bytes_sent = 0usize;
    let started = Instant::now();
    for index in 0..packets {
        let pcm = stats::sine_pcm(
            freq,
            format.rate,
            format.channels,
            frames_per_packet,
            &mut phase,
        );
        bytes_sent += pcm.len();
        if let Err(error) = session
            .send_dvc_messages(channel_id, audio_input::data_pdus(&pcm))
            .await
        {
            return Err((error, mic_report(&mut session, &state, index, bytes_sent)));
        }
        let due = started + Duration::from_millis(20 * (index as u64 + 1));
        if let Err(error) = session.pump_until(due).await {
            return Err((error, mic_report(&mut session, &state, index, bytes_sent)));
        }
    }
    let _ = session
        .pump_until(Instant::now() + Duration::from_millis(300))
        .await;
    Ok(mic_report(&mut session, &state, packets, bytes_sent))
}

fn mic_report(
    session: &mut ProbeSession,
    state: &std::sync::Arc<std::sync::Mutex<audio_input::AudioInputState>>,
    packets: usize,
    bytes: usize,
) -> Value {
    let mut report = session.summary();
    let s = state.lock().expect("audio input");
    report["audio_input"] = json!({
        "channel_id": s.channel_id,
        "server_version": s.server_version,
        "server_formats": s.server_formats.iter().map(|f| json!({"tag": f.tag, "channels": f.channels, "rate": f.rate, "bits": f.bits})).collect::<Vec<_>>(),
        "accepted_formats": s.client_formats.len(),
        "frames_per_packet": s.frames_per_packet,
        "current": s.current.map(|f| json!({"channels": f.channels, "rate": f.rate})),
        "open": s.open,
        "packets_sent": packets,
        "bytes_sent": bytes,
        "log": s.log,
    });
    report
}

async fn autodetect(args: &Args) -> ScenarioResult {
    let seconds = args.f64("seconds", 8.0).map_err(usage)?;
    let mut session = open(args, ChannelPlan::default()).await?;
    let deadline = Instant::now() + Duration::from_secs_f64(seconds);
    let mut counts: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut netchar = Vec::new();
    while Instant::now() < deadline {
        let events = match session.pump(Duration::from_millis(100)).await {
            Ok(events) => events,
            Err(error) => return Err((error, session.summary())),
        };
        for event in events {
            if let PumpEvent::AutoDetect(request) = event {
                let name = match &request {
                    AutoDetectRequest::RttRequest { .. } => "rtt_request",
                    AutoDetectRequest::BandwidthMeasureStart { .. } => "bandwidth_start",
                    AutoDetectRequest::BandwidthMeasurePayload { .. } => "bandwidth_payload",
                    AutoDetectRequest::BandwidthMeasureStop { .. } => "bandwidth_stop",
                    AutoDetectRequest::NetworkCharacteristicsResult {
                        base_rtt_ms,
                        bandwidth_kbps,
                        average_rtt_ms,
                        ..
                    } => {
                        netchar.push(json!({
                            "base_rtt_ms": base_rtt_ms,
                            "bandwidth_kbps": bandwidth_kbps,
                            "average_rtt_ms": average_rtt_ms,
                        }));
                        "network_characteristics"
                    }
                };
                *counts.entry(name).or_default() += 1;
            }
        }
    }
    let mut report = session.summary();
    report["autodetect"] = json!({ "counts": counts, "network_characteristics": netchar });
    Ok(report)
}

/// Pixel digest of a PNG (RGB only, so an alpha-dropping clipboard path still
/// compares equal for opaque reference images).
fn image_digest(args: &Args) -> ScenarioResult {
    let path = args
        .opt("png")
        .ok_or_else(|| usage("--png is required".into()))?;
    let image = image::open(&path)
        .map_err(|e| plain(ProbeError::unmet(format!("{path}: {e}"))))?
        .to_rgba8();
    let rgb: Vec<u8> = image
        .as_raw()
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    Ok(json!({
        "width": image.width(),
        "height": image.height(),
        "rgb_sha256": sha256_hex(&rgb),
        "rgba_sha256": sha256_hex(image.as_raw()),
    }))
}

/// Write a deterministic, opaque test picture (RGB gradient with a bright
/// diagonal) for clipboard image cases, then report its digest. Opaque on
/// purpose: CF_DIB carries no alpha, so only RGB is compared across formats.
fn image_make(args: &Args) -> ScenarioResult {
    let path = args
        .opt("out-png")
        .ok_or_else(|| usage("--out-png is required".into()))?;
    let width = args.u64("width", 96).map_err(usage)?.clamp(1, 4096) as u32;
    let height = args.u64("height", 64).map_err(usage)?.clamp(1, 4096) as u32;
    let image = image::RgbaImage::from_fn(width, height, |x, y| {
        if x * height / width.max(1) == y {
            image::Rgba([255, 255, 255, 255])
        } else {
            image::Rgba([
                (x * 255 / width.max(1)) as u8,
                (y * 255 / height.max(1)) as u8,
                ((x + y) % 256) as u8,
                255,
            ])
        }
    });
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    image
        .save(&path)
        .map_err(|e| plain(ProbeError::unmet(format!("{path}: {e}"))))?;
    let mut digest = image_digest(&Args::with_value("png", &path))?;
    digest["path"] = json!(path);
    Ok(digest)
}

fn host_play(args: &Args) -> ScenarioResult {
    let freq = args.f64("freq", 1000.0).map_err(usage)?;
    let seconds = args.f64("seconds", 3.0).map_err(usage)?;
    host_audio::play(freq, seconds, args.opt("device").as_deref())
        .map_err(|e| plain(ProbeError::unmet(e)))
}

fn host_record(args: &Args) -> ScenarioResult {
    let seconds = args.f64("seconds", 3.0).map_err(usage)?;
    let expected = args.opt("freq").and_then(|f| f.parse::<f64>().ok());
    let report = host_audio::record(
        seconds,
        args.opt("device").as_deref(),
        args.flag("loopback"),
        args.flag("taomni-mic"),
        expected,
    )
    .map_err(|e| plain(ProbeError::unmet(e)))?;
    if expected.is_some() && report["frequency_matches"] != json!(true) {
        return Err((
            ProbeError::unmet("recorded audio does not contain the expected tone"),
            report,
        ));
    }
    Ok(report)
}
