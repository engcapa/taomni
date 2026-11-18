use super::dispatch::usage;
use super::latency::parse_rect;
use super::readiness::open;
use super::readiness::settle;
use crate::Args;
use crate::ProbeError;
use crate::ScenarioResult;
use crate::session::ChannelPlan;
use crate::session::ProbeSession;
use crate::session::PumpEvent;
use crate::stats;
use serde_json::Value;
use serde_json::json;
use std::time::Duration;
use std::time::Instant;

pub(super) fn throughput_comparison(report: &Value, baseline: &Value) -> Result<Value, ProbeError> {
    let ratio = |key: &str| {
        let current = report
            .pointer(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0);
        let previous = baseline
            .pointer(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0);
        match (current, previous) {
            (Some(current), Some(previous)) => Ok(current / previous),
            _ => Err(ProbeError::usage(format!(
                "throughput comparison requires finite, positive baseline {key}"
            ))),
        }
    };
    // Update PDUs can divide one animation frame into several rectangles.
    // Compare distinct decoded frames, the same M3 measurement as PERF-01.
    // The source animation is time based, so two codecs can deliver different
    // frame counts during the fixed ten-second window. Preserve the raw wire
    // ratio, but also report bytes per delivered frame; that is the fair
    // bandwidth comparison used by the photo contract.
    let kbps_ratio = ratio("/kbps")?;
    let fps_ratio = ratio("/marker/observed_fps")?;
    Ok(json!({
        "kbps_ratio": kbps_ratio,
        "kbps_per_frame_ratio": kbps_ratio / fps_ratio,
        "fps_ratio": fps_ratio,
    }))
}

pub(super) async fn throughput(args: &Args) -> ScenarioResult {
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
    // RemoteFX statistics describe the measured window, not the first frame.
    session.reset_rfx_stats();
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
        let observed = marker_frames.saturating_sub(marker_skips);
        report["marker"] = json!({
            "frames": marker_frames,
            "fps": f64::from(marker_frames) / elapsed,
            // Frames the client never saw (level jumped by more than one).
            "skipped": marker_skips,
            // Distinct animation frames the client displayed (M3): unlike
            // `fps` above it is not inflated when one frame arrives as
            // several partial updates.
            "observed": observed,
            "observed_fps": f64::from(observed) / elapsed,
        });
    }
    if let Some(path) = args.opt("baseline-report") {
        let baseline: Value = std::fs::read_to_string(&path)
            .map_err(|e| {
                (
                    ProbeError::usage(format!("read baseline {path}: {e}")),
                    report.clone(),
                )
            })
            .and_then(|text| {
                serde_json::from_str(&text).map_err(|e| {
                    (
                        ProbeError::usage(format!("parse baseline {path}: {e}")),
                        report.clone(),
                    )
                })
            })?;
        report["vs_baseline"] =
            throughput_comparison(&report, &baseline).map_err(|e| (e, report.clone()))?;
    }
    Ok(report)
}
