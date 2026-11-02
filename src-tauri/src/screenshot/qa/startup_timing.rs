use super::*;
use crate::screenshot::startup_timing;

// ---------------------------------------------------------------------------
// Screenshot startup timing (P0-0 / P0-0b measurement, TC-SHOT-N27)
// ---------------------------------------------------------------------------
//
// Measurement, not an absolute millisecond budget: CI runners and the
// user's slow machines have no common budget. The case fails only when a run
// never reaches the select phase, when a required backend stage is missing,
// or when the QA build's renderer marks are missing, because each of those
// means the open (or the measurement) is broken rather than slow.
//
// Each run opens the overlay through the production command entry and
// records, relative to the backend start of that open:
//   - backend stages (cumulative and per-stage deltas, record order); the
//     order is not asserted because the window build and the capture overlap
//   - renderer marks from the QA build (`window.__TAOMNI_OVERLAY_TIMING__`),
//     converted from wall-clock epoch milliseconds
//   - window/image/select times polled from outside, comparable with the
//     P0-0 baseline, and firstMs = max(show, renderer commit): the overlay
//     is visible with its base image and ready for selection
//   - whether the ready handshake beat its timeout (item 6)
// Three matched groups: serial hidden-handshake, early parallel, resident.
// Run 0 follows a closed session (same-process first open, not a process
// cold start); later runs are warm opens. A resident renderer keeps original
// navigation/entry epochs; its remount/decode/commit marks belong to this open.

const RUNS: usize = 60;
/// Stages every open records, in any order.
const REQUIRED_STAGES: &[&str] = &[
    "start",
    "permission",
    "display",
    "hide",
    "capture",
    "save_png",
    "window_joined",
    "cover",
    "show",
    "focus",
];
/// Renderer marks of the QA build, in their natural order.
const RENDERER_MARKS: &[&str] = &["entry", "app", "mount", "init", "read", "decode", "commit"];

fn stage_deltas(stages: &[(String, u64)]) -> Vec<Value> {
    let mut previous = 0u64;
    stages
        .iter()
        .map(|(name, elapsed)| {
            let delta = elapsed.saturating_sub(previous);
            previous = *elapsed;
            json!({"stage": name, "elapsedMs": elapsed, "deltaMs": delta})
        })
        .collect()
}

fn percentile(values: &mut [u64], p: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let rank = ((values.len() as f64 - 1.0) * p).round() as usize;
    values.get(rank).copied()
}

fn stage_ms(stages: &[(String, u64)], name: &str) -> Option<u64> {
    stages
        .iter()
        .find(|(stage, _)| stage == name)
        .map(|(_, ms)| *ms)
}

async fn renderer_marks(
    overlay: &WebviewWindow,
    start_wall_ms: u64,
) -> serde_json::Map<String, Value> {
    let raw = eval_raw(
        overlay,
        "(window.__TAOMNI_OVERLAY_TIMING__ || {marks:{}})".to_string(),
        Duration::from_millis(800),
    )
    .await
    .unwrap_or(Value::Null);
    let mut marks = serde_json::Map::new();
    if let Some(object) = raw.get("marks").and_then(Value::as_object) {
        for (name, value) in object {
            if let Some(wall) = value.as_f64() {
                // Relative to the backend start; negative = before the open.
                marks.insert(
                    name.clone(),
                    json!((wall - start_wall_ms as f64).round() as i64),
                );
            }
        }
    }
    marks
}

async fn run_once(app: &AppHandle, run: usize) -> anyhow::Result<Value> {
    let started = Instant::now();
    let main = app
        .get_webview_window("main")
        .context("main window missing")?;
    super::super::screenshot_open_overlay(app.clone(), main, None, None)
        .await
        .map_err(|e| anyhow::anyhow!("open_overlay failed on run {run}: {e}"))?;
    let overlay = wait_window(app, super::super::OVERLAY_LABEL, Duration::from_secs(15))
        .await
        .map_err(|e| anyhow::anyhow!("overlay window missing on run {run}: {e:#}"))?;
    let window_ms = started.elapsed().as_millis() as u64;
    let visible = overlay.is_visible().unwrap_or(false);

    let mut image_ms: Option<u64> = None;
    let mut select_ms: Option<u64> = None;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && (image_ms.is_none() || select_ms.is_none()) {
        let state = eval_raw(
            &overlay,
            "({hasImage: !!document.querySelector('[data-testid=\"screenshot-base-image\"]'), phase: document.querySelector('[data-testid=\"screenshot-overlay\"]')?.dataset.phase ?? null})".to_string(),
            Duration::from_millis(500),
        )
        .await;
        if let Some(state) = state.filter(|state| state.get("qaEvalError").is_none()) {
            if image_ms.is_none() && state.get("hasImage") == Some(&Value::Bool(true)) {
                image_ms = Some(started.elapsed().as_millis() as u64);
            }
            if select_ms.is_none() && state.get("phase") == Some(&Value::String("select".into())) {
                select_ms = Some(started.elapsed().as_millis() as u64);
            }
        }
        if image_ms.is_none() || select_ms.is_none() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    let backend = startup_timing::snapshot();
    let names: Vec<&str> = backend
        .stages
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    let missing: Vec<&str> = REQUIRED_STAGES
        .iter()
        .copied()
        .filter(|stage| !names.contains(stage))
        .collect();
    let handshake = backend
        .notes
        .get("profile")
        .and_then(|p| p["readyHandshake"].as_bool())
        == Some(true);
    let ready_recorded = names.contains(&"ready") || names.contains(&"ready_timeout");
    let mut required_capture = vec![
        "capture_open_start",
        "capture_open_end",
        "capture_grab",
        "capture_drain_end",
        "capture_drop_start",
        "capture_drop_end",
    ];
    #[cfg(target_os = "linux")]
    if wayland::active() {
        required_capture.extend([
            "portal_create_session",
            "portal_select_sources",
            "portal_start",
            "portal_pipewire_remote",
            "pipewire_first_frame",
        ]);
    }
    let missing_capture: Vec<_> = required_capture
        .into_iter()
        .filter(|stage| !names.contains(stage))
        .collect();
    let marks = renderer_marks(&overlay, backend.start_wall_ms).await;
    let missing_marks: Vec<&str> = RENDERER_MARKS
        .iter()
        .copied()
        .filter(|mark| !marks.contains_key(*mark))
        .collect();
    let show = stage_ms(&backend.stages, "show");
    let commit = marks
        .get("commit")
        .and_then(Value::as_i64)
        .map(|v| v.max(0) as u64);
    let first_ms = show.zip(commit).map(|(show, commit)| show.max(commit));
    Ok(json!({
        "run": run,
        "group": if run < 20 { "handshake-probe" } else if run < 40 { "optimized" } else { "resident" },
        "cold": run == 0,
        "windowMs": window_ms,
        "overlayVisible": visible,
        "imageMs": image_ms,
        "selectMs": select_ms,
        "firstMs": first_ms,
        "backendComplete": missing.is_empty() && missing_capture.is_empty() && (!handshake || ready_recorded)
            && (names.contains(&"window_built") || names.contains(&"window_reused")),
        "missingStages": missing,
        "missingCaptureStages": missing_capture,
        "backendStages": names,
        "backendDeltas": stage_deltas(&backend.stages),
        "notes": backend.notes,
        "entryOrigin": backend.entry_origin,
        "entryLeadMs": backend.entry_lead_ms,
        "renderer": marks,
        "rendererComplete": missing_marks.is_empty(),
        "missingRendererMarks": missing_marks,
        "readyBeforeShow": backend.notes.get("readyBeforeShow"),
    }))
}

fn summarize(runs: &[Value]) -> Value {
    let mut stages: std::collections::BTreeMap<String, Vec<u64>> = Default::default();
    for run in runs {
        for delta in run["backendDeltas"].as_array().into_iter().flatten() {
            if let (Some(name), Some(ms)) = (delta["stage"].as_str(), delta["elapsedMs"].as_u64()) {
                stages.entry(name.to_string()).or_default().push(ms);
            }
        }
    }
    let stages: serde_json::Map<String, Value> = stages
        .into_iter()
        .map(|(name, mut values)| {
            let p50 = percentile(&mut values, 0.5);
            let p95 = percentile(&mut values, 0.95);
            (name, json!({"p50": p50, "p95": p95, "n": values.len()}))
        })
        .collect();
    let column = |key: &str| -> Value {
        let mut values: Vec<u64> = runs.iter().filter_map(|run| run[key].as_u64()).collect();
        let p50 = percentile(&mut values, 0.5);
        let p95 = percentile(&mut values, 0.95);
        json!({"p50": p50, "p95": p95, "n": values.len()})
    };
    let renderer = |mark: &str| -> Value {
        let mut values: Vec<u64> = runs
            .iter()
            .filter_map(|run| run["renderer"][mark].as_i64())
            .map(|v| v.max(0) as u64)
            .collect();
        let p50 = percentile(&mut values, 0.5);
        let p95 = percentile(&mut values, 0.95);
        json!({"p50": p50, "p95": p95, "n": values.len()})
    };
    let handshakes: Vec<bool> = runs
        .iter()
        .filter_map(|run| run["readyBeforeShow"].as_bool())
        .collect();
    let ready = handshakes.iter().filter(|ready| **ready).count();
    json!({
        "elapsedByStage": stages,
        "selectMs": column("selectMs"),
        "firstMs": column("firstMs"),
        "renderer": RENDERER_MARKS.iter().map(|mark| (mark.to_string(), renderer(mark))).collect::<serde_json::Map<_, _>>(),
        "readyHandshake": {
            "runs": handshakes.len(),
            "readyBeforeShow": ready,
            "timeouts": handshakes.len() - ready,
            "ratio": (!handshakes.is_empty()).then(|| ready as f64 / handshakes.len() as f64),
        },
    })
}

/// Open the overlay `RUNS` times and report segmented startup timing.
/// QA-only: `ensure_qa` refuses to run outside the isolated debug QA app.
#[tauri::command]
pub async fn screenshot_qa_startup_timing(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _profile = crate::screenshot::startup_profile::QaProfile::install(
        crate::screenshot::startup_profile::StartupProfile::OPTIMIZED,
    );
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(&app);
    wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await;
    let mut runs = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for run in 0..RUNS {
        let profile = if run < 20 {
            // First measure the hidden-renderer handshake without early build
            // or exclusion. Later samples exercise the dependent P1 candidate.
            crate::screenshot::startup_profile::StartupProfile {
                early_window: false,
                capture_exclusion: false,
                ..crate::screenshot::startup_profile::StartupProfile::OPTIMIZED
            }
        } else if run < 40 {
            crate::screenshot::startup_profile::StartupProfile::OPTIMIZED
        } else {
            crate::screenshot::startup_profile::StartupProfile {
                reuse_window: true,
                ..crate::screenshot::startup_profile::StartupProfile::OPTIMIZED
            }
        };
        let _run_profile = crate::screenshot::startup_profile::QaProfile::install(profile);
        match run_once(&app, run).await {
            Ok(value) => runs.push(value),
            Err(error) => {
                errors.push(format!("{error:#}"));
                break;
            }
        }
        super::super::close_session(&app);
        let closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let restored = main_visible(&app);
        if let Some(value) = runs.last_mut() {
            value["closed"] = json!(closed);
            value["mainRestored"] = json!(restored);
        }
        let _ = keep_json(
            &json!({"runs": runs, "errors": errors}),
            "startup-timing-incremental.json",
        );
        if !closed || !restored {
            errors.push(format!("session did not close/restore on run {run}"));
            break;
        }
    }
    let reached_select = runs.iter().all(|run| {
        run["selectMs"].is_number()
            && run["imageMs"].is_number()
            && run["firstMs"].is_number()
            && run["overlayVisible"] == true
            && run["closed"] == true
            && run["mainRestored"] == true
    });
    let backend_complete = runs.iter().all(|run| run["backendComplete"] == json!(true));
    let renderer_complete = runs
        .iter()
        .all(|run| run["rendererComplete"] == json!(true));
    let summary = summarize(&runs);
    let ok = runs.len() == RUNS
        && errors.is_empty()
        && reached_select
        && backend_complete
        && renderer_complete
        && main_visible(&app);
    let details = json!({
        "scenario": "startup-timing",
        "platform": platform(),
        "appPid": std::process::id(),
        "displays": super::platform_evidence::display_facts(&app),
        "summary": summary,
        "groups": {
            "handshakeProbe": summarize(&runs.iter().filter(|run| run["group"] == "handshake-probe").cloned().collect::<Vec<_>>()),
            "optimized": summarize(&runs.iter().filter(|run| run["group"] == "optimized").cloned().collect::<Vec<_>>()),
            "resident": summarize(&runs.iter().filter(|run| run["group"] == "resident").cloned().collect::<Vec<_>>()),
        },
        "medianSelectMs": summary["selectMs"]["p50"],
        "coldSelectMs": runs.first().and_then(|run| run["selectMs"].as_u64()),
        "runs": runs,
        "errors": errors,
        "note": "Measurement only: no absolute millisecond budget is asserted. Run 0 is the same-process first open, not a process cold start. CI runners are not slow machines.",
    });
    let _ = keep_json(&details, "startup-timing.json");
    Ok(report(ok, details))
}
