use super::*;
use crate::screenshot::startup_timing;

mod sampler;
use sampler::{Sample, Sampler};
#[cfg(test)]
mod tests;

// Independent fresh OS snapshots, not the product's stream or cached frames.
// Every sample retains its actual capture-time bracket. Sampling is evidence
// only when the conservative maximum gap (including show/end) is <=100 ms.
const UNIFORM_SHARE: f64 = 0.97;
const MAX_GAP_MS: f64 = 100.0;
const AFTER_OPEN: Duration = Duration::from_millis(900);

fn sampling_evidence(samples: &[Sample], start: f64, show: f64, end: f64) -> Value {
    let before: Vec<_> = samples
        .iter()
        .filter(|sample| sample.capture_ended_ms < start)
        .collect();
    let desktop_varied = !before.is_empty()
        && before
            .iter()
            .all(|sample| sample.modal_share < UNIFORM_SHARE);
    let post: Vec<_> = samples
        .iter()
        // A bracket straddling show cannot be silently classified as pre-show.
        .filter(|sample| sample.capture_ended_ms >= show && sample.capture_started_ms <= end)
        .collect();
    let flashes: Vec<_> = post
        .iter()
        .filter(|sample| sample.modal_share >= UNIFORM_SHARE)
        .map(|sample| {
            json!({"index":sample.index,"captureStartedMs":sample.capture_started_ms-start,
                "captureEndedMs":sample.capture_ended_ms-start,
                "share":sample.modal_share,"color":sample.modal_color})
        })
        .collect();
    let durations: Vec<f64> = samples
        .iter()
        .map(|sample| sample.capture_ended_mono_ms - sample.capture_started_mono_ms)
        .collect();
    let monotonic = samples.windows(2).all(|pair| {
        pair[1].capture_started_mono_ms >= pair[0].capture_ended_mono_ms
            && pair[1].capture_started_ms >= pair[0].capture_ended_ms
    });
    // The wall clock aligns backend show with native snapshots. Compare its
    // differences to the monotonic clock instead of accepting a clock jump as
    // an apparent fast sampling interval.
    let clock_stable = samples.windows(2).all(|pair| {
        let wall = pair[1].capture_started_ms - pair[0].capture_started_ms;
        let mono = pair[1].capture_started_mono_ms - pair[0].capture_started_mono_ms;
        (wall - mono).abs() <= 10.0
    }) && samples.iter().all(|sample| {
        ((sample.capture_ended_ms - sample.capture_started_ms)
            - (sample.capture_ended_mono_ms - sample.capture_started_mono_ms))
            .abs()
            <= 10.0
    });
    let gaps: Vec<f64> = samples
        .windows(2)
        // Worst-case actual gap: preceding pixels could be from bracket start,
        // following pixels from bracket end. Never use poll/delivery timestamps.
        .map(|pair| pair[1].capture_ended_mono_ms - pair[0].capture_started_mono_ms)
        .collect();
    let first = samples
        .iter()
        .find(|sample| sample.capture_started_ms >= show);
    let last = samples
        .iter()
        .rev()
        .find(|sample| sample.capture_ended_ms <= end);
    let first_gap = first.map(|sample| sample.capture_ended_ms - show);
    let last_gap = last.map(|sample| end - sample.capture_started_ms);
    let max_gap = gaps
        .iter()
        .copied()
        .chain(durations.iter().copied())
        .chain(first_gap)
        .chain(last_gap)
        .reduce(f64::max);
    let coverage = first_gap.is_some_and(|gap| gap <= MAX_GAP_MS)
        && last_gap.is_some_and(|gap| gap <= MAX_GAP_MS)
        && max_gap.is_some_and(|gap| gap <= MAX_GAP_MS)
        && monotonic
        && clock_stable;
    let trace: Vec<_> = samples
        .iter()
        .map(|sample| {
            json!({"index":sample.index,"captureStartedMs":sample.capture_started_ms-start,
                "captureEndedMs":sample.capture_ended_ms-start,
                "captureDurationMs":sample.capture_ended_mono_ms-sample.capture_started_mono_ms,
                "share":sample.modal_share,"color":sample.modal_color,
                "size":[sample.width,sample.height],"transport":sample.transport})
        })
        .collect();
    json!({
        "sampled":true,"samples":samples.len(),"samplesBeforeOpen":before.len(),
        "samplesAfterShow":post.len(),"desktopVaried":desktop_varied,
        "showMs":show-start,"sampledThroughMs":end-start,"flashFrames":flashes,
        "maximumAllowedGapMs":MAX_GAP_MS,"maxGapMs":max_gap,
        "captureGapsUpperBoundMs":gaps,"captureDurationsMs":durations,
        "firstAfterShowGapUpperBoundMs":first_gap,"lastBeforeEndGapUpperBoundMs":last_gap,
        "clockStable":clock_stable,"monotonic":monotonic,"samplingCoverage":coverage,
        "trace":trace,
        "passed":desktop_varied && post.len() >= 5 && flashes.is_empty() && coverage,
    })
}

/// No platform skips: missing or >100ms independent pixel sampling is a failure.
#[tauri::command]
pub async fn screenshot_qa_startup_flash(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _profile = crate::screenshot::startup_profile::QaProfile::install(
        crate::screenshot::startup_profile::StartupProfile::OPTIMIZED,
    );
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(&app);
    if !wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await {
        return Ok(report(
            false,
            json!({"scenario":"startup-flash","platform":platform(),
            "sampled":false,"error":"previous overlay did not close"}),
        ));
    }
    let (_fixture, display, _region) = open_fixture(&app, "scroll")
        .await
        .map_err(|error| format!("{error:#}"))?;
    let main = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    let mut sampler = match Sampler::start(&display) {
        Ok(sampler) => sampler,
        Err(error) => {
            return Ok(report(
                false,
                json!({"scenario":"startup-flash",
            "platform":platform(),"sampled":false,"error":format!("{error:#}")}),
            ));
        }
    };
    let artifacts = sampler.artifacts();
    let outcome = async {
        sampler.ready().await?;
        let opened = tokio::time::timeout(
            Duration::from_secs(25),
            super::super::screenshot_open_overlay(app.clone(), main, None, None),
        )
        .await;
        tokio::time::sleep(AFTER_OPEN).await;
        let end = startup_timing::wall_clock_ms() as f64;
        let samples = sampler.finish().await?;
        opened
            .context("production open exceeded sampler's bounded observation window")?
            .map_err(anyhow::Error::msg)?;
        let timing = startup_timing::snapshot();
        let show = timing
            .notes
            .get("showWallMs")
            .and_then(Value::as_u64)
            .context("production show timestamp missing")? as f64;
        let mut evidence = sampling_evidence(&samples, timing.start_wall_ms as f64, show, end);
        evidence["notes"] = json!(timing.notes);
        evidence["display"] = json!(display);
        Ok::<_, anyhow::Error>(evidence)
    }
    .await;
    let (ok, evidence) = match outcome {
        Ok(evidence) => (evidence["passed"] == true, evidence),
        Err(error) => (false, json!({"sampled":false,"error":format!("{error:#}")})),
    };
    // Drop kills/reaps the owned helper even when readiness/open/join failed.
    drop(sampler);
    Ok(report(
        ok,
        json!({"scenario":"startup-flash","platform":platform(),
        "evidence":evidence,"artifacts":artifacts,
        "note":"Fresh independent OS pixels, conservative capture brackets, no observation gap above 100ms; shorter flashes remain below the sampling resolution."}),
    ))
}
