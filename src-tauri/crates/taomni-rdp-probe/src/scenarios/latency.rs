use super::dispatch::usage;
use super::readiness::open;
use super::readiness::settle;
use crate::Args;
use crate::ProbeError;
use crate::ScenarioResult;
use crate::session::ChannelPlan;
use crate::session::ProbeSession;
use crate::stats;
use serde_json::json;
use std::collections::HashSet;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub(super) fn grid_colors(session: &ProbeSession) -> usize {
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

pub(super) fn color_delta(a: [u8; 4], b: [u8; 4]) -> u32 {
    (0..3).map(|i| u32::from(a[i].abs_diff(b[i]))).sum()
}

pub(super) async fn latency(args: &Args) -> ScenarioResult {
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
    let mut sample_events = Vec::with_capacity(count);
    let mut timeouts = 0usize;
    let mut transitions = Vec::new();
    let initial_pixel = session.pixel(sx, sy);
    for index in 0..warmup + count {
        let base = session.pixel(sx, sy).unwrap_or([0; 4]);
        let sent_unix_us = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_micros())
            .unwrap_or(0);
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
                let observed_unix_us = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_micros())
                    .unwrap_or(0);
                sample_events.push(json!({
                    "index": index,
                    "sent_unix_us": sent_unix_us,
                    "observed_unix_us": observed_unix_us,
                }));
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
    report["sample_events"] = json!(sample_events);
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

pub(super) fn parse_rect(text: &str) -> Result<(u16, u16, u16, u16), String> {
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
