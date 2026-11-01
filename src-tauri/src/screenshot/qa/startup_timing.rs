use super::*;

// ---------------------------------------------------------------------------
// Screenshot startup timing (P0-0 measurement, TC-SHOT-N27)
// ---------------------------------------------------------------------------
//
// This scenario measures, it does not gate on an absolute millisecond
// budget: CI runners and the user's slow machines have no common budget yet,
// and the point of P0-0 is to collect the segmented numbers first. The case
// fails only when a run never reaches the select phase or when the backend
// timing snapshot is incomplete, because either means the measurement itself
// (or the overlay open) is broken, not merely slow.
//
// Each run opens the overlay through the production entry, records:
//   - window_ms: the overlay WebviewWindow exists in the app (creation, not
//     mapped/first-frame)
//   - image_ms: the base image element is in the overlay DOM
//   - select_ms: the overlay reports phase "select" (ready for interaction)
//   - backend stages: the P0-0 snapshot from `open_overlay_inner`, with
//     per-stage deltas computed from its cumulative elapsed values
// Run 0 is the cold open after a closed session; runs 1-2 are warm opens.
// The scenario does not sample desktop pixels, so it cannot by itself
// quantify the camera-flash frames; that stays a native-driver observation
// in the case file until a pixel sampler exists.

const EXPECTED_STAGES: &[&str] = &[
    "start",
    "permission",
    "display",
    "hide",
    "capture",
    "save_png",
    "window_built",
    "cover",
    "show",
    "focus",
];

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

async fn run_once(app: &AppHandle, run: usize) -> anyhow::Result<Value> {
    let started = Instant::now();
    super::super::open_overlay(app, None)
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
        if let Some(state) = state {
            if state.get("qaEvalError").is_none() {
                if image_ms.is_none() && state.get("hasImage") == Some(&Value::Bool(true)) {
                    image_ms = Some(started.elapsed().as_millis() as u64);
                }
                if select_ms.is_none()
                    && state.get("phase") == Some(&Value::String("select".into()))
                {
                    select_ms = Some(started.elapsed().as_millis() as u64);
                }
            }
        }
        if image_ms.is_none() || select_ms.is_none() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    let backend = super::super::runtime::startup_timing_snapshot();
    let backend_names: Vec<String> = backend.iter().map(|(name, _)| name.clone()).collect();
    let backend_complete =
        backend_names.iter().map(String::as_str).collect::<Vec<_>>() == EXPECTED_STAGES;
    let deltas = stage_deltas(&backend);
    let total_ms = select_ms.unwrap_or_else(|| started.elapsed().as_millis() as u64);
    Ok(json!({
        "run": run,
        "cold": run == 0,
        "windowMs": window_ms,
        "overlayVisible": visible,
        "imageMs": image_ms,
        "selectMs": select_ms,
        "totalMs": total_ms,
        "backendComplete": backend_complete,
        "backendStages": backend_names,
        "backendDeltas": deltas,
    }))
}

/// Open the overlay three times and report segmented startup timing.
/// QA-only: `ensure_qa` refuses to run outside the isolated debug QA app.
#[tauri::command]
pub async fn screenshot_qa_startup_timing(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(&app);
    let mut runs = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for run in 0..3 {
        match run_once(&app, run).await {
            Ok(value) => runs.push(value),
            Err(error) => {
                errors.push(error.to_string());
                break;
            }
        }
        super::super::close_session(&app);
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let reached_select = runs.iter().all(|run| run["selectMs"].is_number());
    let backend_complete = runs
        .iter()
        .all(|run| run["backendComplete"] == Value::Bool(true));
    let mut select_times: Vec<u64> = runs
        .iter()
        .filter_map(|run| run["selectMs"].as_u64())
        .collect();
    select_times.sort_unstable();
    let median_select_ms = select_times.get(select_times.len() / 2).copied();
    let ok = runs.len() == 3 && errors.is_empty() && reached_select && backend_complete;
    Ok(report(
        ok,
        json!({
            "scenario": "startup-timing",
            "platform": platform(),
            "appPid": std::process::id(),
            "displays": super::platform_evidence::display_facts(&app),
            "runs": runs,
            "medianSelectMs": median_select_ms,
            "coldSelectMs": runs.first().and_then(|run| run["selectMs"].as_u64()),
            "errors": errors,
            "note": "Measurement only: no absolute millisecond budget is asserted. windowMs is window creation, not first frame; flash frames are not pixel-sampled by this scenario.",
        }),
    ))
}
