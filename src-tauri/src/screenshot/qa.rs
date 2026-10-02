//! QA-only end-to-end scenarios for the screenshot tool.
//!
//! Native UI tests drive only the main window, but the screenshot tool lives
//! in other windows (overlay, recorder bar, pins). These commands run each
//! real flow end to end from the backend: they open the real windows, drive
//! their DOM with the same events a user produces, inject real OS input
//! (wheel, hotkey) and verify outputs from outside the UI (clipboard, decoded
//! files, window visibility). Artifacts are written to
//! `$RUNNER_TEMP/taomni-qa-artifacts` for CI upload.
//!
//! Every command refuses to run outside the isolated debug QA app.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::Context;
use image::RgbaImage;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};

use super::capture::{self, DisplayInfo};
use super::qa_oracle;

/// Window label of the QA content fixture (scrollable page / animation).
pub const QA_WINDOW_LABEL: &str = "screenshot-qa-fixture";

fn ensure_qa(app: &AppHandle) -> Result<(), String> {
    if !cfg!(debug_assertions) || app.config().identifier != crate::QA_APP_ID {
        return Err("screenshot QA scenarios require the isolated QA app".into());
    }
    Ok(())
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn artifact_dir() -> std::path::PathBuf {
    std::env::var("RUNNER_TEMP")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("taomni-qa-artifacts")
}

/// Best-effort copy of an output into the CI artifact folder.
fn keep_artifact(src: &std::path::Path, name: &str) -> Option<String> {
    let dir = artifact_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let dest = dir.join(format!(
        "{}-{}-{name}",
        platform(),
        EVAL_ID.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::copy(src, &dest).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

fn keep_image(image: &RgbaImage, name: &str) -> Option<String> {
    let dir = artifact_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let dest = dir.join(format!(
        "{}-{}-{name}",
        platform(),
        EVAL_ID.fetch_add(1, Ordering::Relaxed)
    ));
    image.save(&dest).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

fn report(ok: bool, details: Value) -> String {
    format!("{} {}", if ok { "OK" } else { "FAIL" }, details)
}

struct ScenarioCleanup(AppHandle);

impl Drop for ScenarioCleanup {
    fn drop(&mut self) {
        close_fixture(&self.0);
        for (label, window) in self.0.webview_windows() {
            if label.starts_with(super::PIN_LABEL_PREFIX) {
                let _ = window.destroy();
            }
        }
        super::close_session(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Webview scripting
// ---------------------------------------------------------------------------

static EVAL_ID: AtomicU64 = AtomicU64::new(1);

/// One `eval_with_callback` round trip; `None` if the page never answered
/// (e.g. still navigating).
async fn eval_raw(window: &WebviewWindow, js: String, wait: Duration) -> Option<Value> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    // Keep expression completion explicit on WebView2 and preserve JS errors
    // as data instead of silently interpreting them as an unready window.
    let script = format!(
        "(() => {{ try {{ return ({js}); }} catch (e) {{ return {{qaEvalError:String(e)}}; }} }})()"
    );
    window
        .eval_with_callback(script, move |result| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(result);
            }
        })
        .ok()?;
    let raw = tokio::time::timeout(wait, rx).await.ok()?.ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    // Some engines hand back a JSON-encoded string of the JSON value.
    match value {
        Value::String(s) => serde_json::from_str(&s).ok().or(Some(Value::String(s))),
        other => Some(other),
    }
}

/// Run an async script body in `window` and return its value. Promises are
/// settled into a window slot and polled, so this works on every engine.
async fn run_js(window: &WebviewWindow, body: &str, timeout: Duration) -> anyhow::Result<Value> {
    let deadline = Instant::now() + timeout;
    // Wait for a loaded document that has run the app bundle.
    loop {
        let ready = eval_raw(
            window,
            "document.readyState === 'complete' && !!document.getElementById('root') && document.getElementById('root').childElementCount > 0".into(),
            Duration::from_secs(2),
        )
        .await;
        if ready == Some(Value::Bool(true)) {
            break;
        }
        if Instant::now() >= deadline {
            let diagnostic = eval_raw(window,
                "({url:location.href,readyState:document.readyState,root:document.getElementById('root')?.innerHTML?.slice(0,1000),tauri:!!window.__TAURI_INTERNALS__})".into(),
                Duration::from_secs(2)).await;
            anyhow::bail!(
                "window '{}' did not finish loading; last={ready:?}; document={diagnostic:?}; nativeUrl={:?}",
                window.label(),
                window.url()
            );
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let id = EVAL_ID.fetch_add(1, Ordering::Relaxed);
    let install = format!(
        r#"(() => {{
          const slots = (window.__qaShot = window.__qaShot || {{}});
          slots[{id}] = {{ done: false }};
          try {{
            (async () => {{ {body} }})().then(
              (v) => {{ slots[{id}] = {{ done: true, value: v === undefined ? null : v }}; }},
              (e) => {{ slots[{id}] = {{ done: true, error: String((e && e.message) || e) }}; }});
          }} catch (e) {{ slots[{id}] = {{ done: true, error: String(e) }}; }}
          return true;
        }})()"#
    );
    window.eval(install).context("inject QA script")?;
    loop {
        tokio::time::sleep(Duration::from_millis(120)).await;
        let slot = eval_raw(
            window,
            format!("(window.__qaShot || {{}})[{id}] || null"),
            Duration::from_secs(2),
        )
        .await;
        if let Some(slot) = slot {
            if slot.get("done") == Some(&Value::Bool(true)) {
                if let Some(err) = slot.get("error").and_then(Value::as_str) {
                    anyhow::bail!("script error in '{}': {err}", window.label());
                }
                return Ok(slot.get("value").cloned().unwrap_or(Value::Null));
            }
        }
        if Instant::now() >= deadline {
            anyhow::bail!("script in '{}' timed out", window.label());
        }
    }
}

async fn wait_window(
    app: &AppHandle,
    label: &str,
    timeout: Duration,
) -> anyhow::Result<WebviewWindow> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(window) = app.get_webview_window(label) {
            return Ok(window);
        }
        if Instant::now() >= deadline {
            anyhow::bail!("window '{label}' did not open");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_closed(app: &AppHandle, label: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while app.get_webview_window(label).is_some() {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    true
}

fn main_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Content fixtures
// ---------------------------------------------------------------------------

/// Open the fixture page `route` (`scroll` or `anim`) on the primary display
/// and return it with its display-relative physical content rect.
async fn open_fixture(
    app: &AppHandle,
    route: &str,
) -> anyhow::Result<(WebviewWindow, DisplayInfo, (u32, u32, u32, u32))> {
    if let Some(old) = app.get_webview_window(QA_WINDOW_LABEL) {
        let _ = old.destroy();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let display = capture::resolve_display(app, None)?;
    let s = display.scale_factor.max(0.5);
    let url = WebviewUrl::App(format!("index.html#screenshot-qa-{route}").into());
    let window = super::window_builder(app, QA_WINDOW_LABEL, url)
        .title("Screenshot QA fixture")
        .inner_size(520.0, 440.0)
        .position(display.x as f64 / s + 120.0, display.y as f64 / s + 120.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .focused(true)
        .build()
        .context("open QA fixture window")?;
    let ready = run_js(
        &window,
        "const ready = () => { const root = document.querySelector('[data-testid=\"screenshot-qa-fixture-ready\"]'); return !!root && (!root.querySelector('canvas') || root.dataset.sourceReady === 'true'); }; for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 100)); return ready();",
        Duration::from_secs(20),
    )
    .await?;
    if ready != Value::Bool(true) {
        anyhow::bail!("QA fixture '{route}' did not render");
    }
    let _ = window.set_focus();
    // Let the window manager map and raise it.
    tokio::time::sleep(Duration::from_millis(700)).await;
    let pos = window.inner_position().context("fixture position")?;
    let size = window.inner_size().context("fixture size")?;
    let content_width = run_js(&window, "return document.querySelector('[data-testid=\"screenshot-qa-fixture-ready\"]').clientWidth;", Duration::from_secs(5)).await?.as_f64().context("fixture content width")?;
    let margin = (6.0 * s).round() as u32;
    let rx = (pos.x - display.x).max(0) as u32 + margin;
    let ry = (pos.y - display.y).max(0) as u32 + margin;
    let region = (
        rx,
        ry,
        size.width
            .min((content_width * s).round() as u32)
            .saturating_sub(margin * 2),
        size.height.saturating_sub(margin * 2),
    );
    Ok((window, display, region))
}

fn close_fixture(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QA_WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceFrame {
    id: u32,
    at_ms: f64,
    data_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceEvidence {
    kind: String,
    css_width: f64,
    css_height: f64,
    width: u32,
    height: u32,
    scale: f64,
    nonce: u32,
    frames: Vec<SourceFrame>,
    data_url: Option<String>,
}

async fn read_source(window: &WebviewWindow) -> anyhow::Result<SourceEvidence> {
    let value = run_js(
        window,
        "return window.__qaScreenshotSource || null;",
        Duration::from_secs(10),
    )
    .await?;
    serde_json::from_value(value).context("fixture did not retain original pixel evidence")
}

fn source_png(data_url: &str) -> anyhow::Result<RgbaImage> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let data = data_url
        .strip_prefix("data:image/png;base64,")
        .context("source evidence is not a PNG")?;
    let bytes = STANDARD
        .decode(data)
        .context("decode original source PNG")?;
    Ok(image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)?.to_rgba8())
}

fn keep_json(value: &Value, name: &str) -> anyhow::Result<String> {
    let path = artifact_dir().join(format!(
        "{}-{}-{name}",
        platform(),
        EVAL_ID.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(artifact_dir())?;
    std::fs::write(&path, serde_json::to_vec_pretty(value)?)?;
    Ok(path.to_string_lossy().into_owned())
}

fn source_crop_size(source: &SourceEvidence) -> anyhow::Result<(u32, u32)> {
    if !source.scale.is_finite()
        || source.scale <= 0.0
        || (source.css_width * source.scale).round() as u32 != source.width
        || (source.css_height * source.scale).round() as u32 != source.height
    {
        anyhow::bail!("invalid original source geometry");
    }
    let margin = (6.0 * source.scale).round() as u32;
    let width = source.width.checked_sub(margin * 2).filter(|w| *w >= 2);
    let height = source.height.checked_sub(margin * 2).filter(|h| *h >= 2);
    Ok((
        width.context("original source too narrow")?,
        height.context("original source too short")?,
    ))
}

fn source_crop(source: &SourceEvidence, image: &RgbaImage) -> anyhow::Result<RgbaImage> {
    if image.dimensions() != (source.width, source.height) {
        anyhow::bail!("original PNG does not match its declared dimensions");
    }
    let (width, height) = source_crop_size(source)?;
    let margin = (6.0 * source.scale).round() as u32;
    Ok(capture::crop(image, margin, margin, width, height))
}

/// Derive the contract from the original geometry, never decoded dimensions.
fn record_expected_size(source: &SourceEvidence, is_mp4: bool) -> anyhow::Result<(u32, u32)> {
    let (width, height) = source_crop_size(source)?;
    let cap = if is_mp4 { 1920 } else { 960 };
    let (width, height) = if width > cap {
        (
            cap,
            ((height as f64 * cap as f64 / width as f64).round() as u32).max(2),
        )
    } else {
        (width, height)
    };
    Ok(((width & !1).max(2), (height & !1).max(2)))
}

fn source_region(
    source: &SourceEvidence,
    image: &RgbaImage,
    dimensions: (u32, u32),
) -> anyhow::Result<RgbaImage> {
    let crop = source_crop(source, image)?;
    Ok(if crop.dimensions() == dimensions {
        crop
    } else {
        image::imageops::resize(
            &crop,
            dimensions.0,
            dimensions.1,
            image::imageops::FilterType::Triangle,
        )
    })
}

fn compare_scroll_original(actual: &RgbaImage, source: &SourceEvidence) -> anyhow::Result<Value> {
    if source.kind != "scroll" {
        anyhow::bail!("expected original scroll page");
    }
    let original = source_png(
        source
            .data_url
            .as_deref()
            .context("missing original page PNG")?,
    )?;
    let expected = source_crop(source, &original)?;
    let comparison = qa_oracle::compare(actual, &expected, false);
    let source_artifact =
        keep_image(&original, "scroll-original-full.png").context("save full source page")?;
    let expected_artifact =
        keep_image(&expected, "scroll-expected.png").context("save expected scroll crop")?;
    let difference = keep_image(
        &qa_oracle::difference(actual, &expected),
        "scroll-difference.png",
    )
    .context("save scroll difference")?;
    Ok(
        json!({"passed":comparison.passed,"comparison":comparison,"sourceArtifact":source_artifact,
        "expectedArtifact":expected_artifact,"differenceArtifact":difference,"sourceSize":[source.width,source.height],
        "cssSize":[source.css_width,source.css_height],"scale":source.scale}),
    )
}

fn compare_record_original(
    path: &std::path::Path,
    source: &SourceEvidence,
) -> anyhow::Result<(super::record::ClipInfo, Value)> {
    if source.kind != "anim" || source.frames.is_empty() {
        anyhow::bail!("missing drawn animation originals");
    }
    let expected_size = record_expected_size(
        source,
        path.extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("mp4")),
    )?;
    let source_manifest = keep_json(
        &json!({"kind":source.kind,"nonce":source.nonce,"scale":source.scale,
        "dimensions":[source.width,source.height],"expectedSize":expected_size,"frames":source.frames.iter().map(|f|json!({"id":f.id,"atMs":f.at_ms})).collect::<Vec<_>>()}),
        "record-original-timeline.json",
    )?;
    // Save references before decoding so corrupt or unidentified output still
    // leaves evidence that can be inspected without regenerating the scene.
    let mut originals = Vec::new();
    for original in &source.frames {
        let image = source_png(&original.data_url)?;
        let artifact = keep_image(&image, &format!("record-original-{}.png", original.id))
            .context("save original frame")?;
        originals.push(json!({"id":original.id,"atMs":original.at_ms,"artifact":artifact}));
    }
    let mut observations = Vec::new();
    let mut pairs = Vec::new();
    let mut matched_ids = std::collections::HashSet::new();
    let mut previous = None;
    let mut failures = 0u32;
    let mut timeline = qa_oracle::Timeline::default();
    let source_size = (source.css_width - 12.0, source.css_height - 12.0);
    let inspected = super::record::inspect_clip_frames(path, &mut |image, at_ms| {
        let id = qa_oracle::decode_code(image, source_size, 12, 64.0);
        let nonce = qa_oracle::decode_code(image, source_size, 16, 112.0);
        let original = id.and_then(|id| source.frames.iter().find(|frame| frame.id == id));
        let ordered = previous.zip(id).is_none_or(|(last, now)| now >= last);
        let mut comparison = None;
        let matched = if let Some(original) = original {
            let raw = source_png(&original.data_url)?;
            let expected = source_region(source, &raw, expected_size)?;
            let result = qa_oracle::compare(image, &expected, true);
            let timing = timeline.observe(at_ms, original.at_ms);
            let passed = result.passed && nonce == Some(source.nonce) && ordered && timing;
            if pairs.len() < 8 {
                pairs.push((image.clone(), expected.clone()));
            }
            if passed {
                matched_ids.insert(original.id);
            }
            comparison = Some(result);
            passed
        } else {
            false
        };
        if !matched {
            failures += 1;
        }
        if id.is_some() {
            previous = id;
        }
        let actual_artifact =
            keep_image(image, &format!("record-decoded-{}.png", observations.len()))
                .context("save decoded frame")?;
        observations.push(json!({"decodedFrame":observations.len(),"atMs":at_ms,"sourceId":id,"nonce":nonce,
            "originalAtMs":original.map(|f|f.at_ms),"ordered":ordered,"matchedOriginal":matched,"comparison":comparison,"actualArtifact":actual_artifact}));
        Ok(())
    });
    let checks = keep_json(
        &json!({"frames":observations,"drawnOriginals":originals,"expectedSize":expected_size,"decodeError":inspected.as_ref().err().map(|e|format!("{e:#}"))}),
        "record-pixel-comparison.json",
    )?;
    let clip = inspected?;
    let mut contact = RgbaImage::new(320 * 3, 200 * pairs.len() as u32);
    for (row, (actual, expected)) in pairs.iter().enumerate() {
        let difference = qa_oracle::difference(actual, expected);
        for (col, image) in [expected, actual, &difference].iter().enumerate() {
            let thumb =
                image::imageops::resize(*image, 320, 200, image::imageops::FilterType::Triangle);
            image::imageops::replace(&mut contact, &thumb, col as i64 * 320, row as i64 * 200);
        }
    }
    let contact_artifact = if pairs.is_empty() {
        None
    } else {
        keep_image(&contact, "record-original-actual-difference.png")
    };
    let timeline_ok = timeline.complete(clip.duration_ms);
    let passed =
        failures == 0 && matched_ids.len() >= 4 && timeline_ok && contact_artifact.is_some();
    Ok((
        clip,
        json!({"passed":passed,"mismatchedFrames":failures,"matchedDistinctOriginals":matched_ids.len(),"expectedSize":expected_size,
        "nonce":source.nonce,"timelineMatches":timeline_ok,"worstTimelineDriftMs":timeline.worst_drift_ms,"longestFrameGapMs":timeline.longest_gap_ms,
        "sourceTimeline":source_manifest,"comparisonArtifact":checks,"contactArtifact":contact_artifact}),
    ))
}

// Scroll fixture rows: index i is encoded in the background as
// R = 30 + (i % 8) * 28, G = 30 + (i / 8) * 28, B = 210. Rows are 48 CSS px
// tall with a 4 px white separator.
const ROW_STEP: f64 = 28.0;

fn decode_row(px: [u8; 4]) -> Option<u32> {
    if px[2] < 160 {
        return None;
    }
    let r = ((px[0] as f64 - 30.0) / ROW_STEP).round();
    let g = ((px[1] as f64 - 30.0) / ROW_STEP).round();
    if !(0.0..8.0).contains(&r) || !(0.0..8.0).contains(&g) {
        return None;
    }
    // Reject pixels far from any code (anti-aliased edges, text).
    let er = (px[0] as f64 - (30.0 + r * ROW_STEP)).abs();
    let eg = (px[1] as f64 - (30.0 + g * ROW_STEP)).abs();
    (er <= 9.0 && eg <= 9.0).then_some((g * 8.0 + r) as u32)
}

/// Runs of decoded row indices down column `x`: `(index, run_length)`.
fn row_runs(image: &RgbaImage, x: u32) -> Vec<(u32, u32)> {
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for y in 0..image.height() {
        let Some(index) = decode_row(image.get_pixel(x, y).0) else {
            continue;
        };
        match runs.last_mut() {
            Some((last, len)) if *last == index => *len += 1,
            _ => runs.push((index, 1)),
        }
    }
    // Drop single-pixel noise runs.
    runs.retain(|(_, len)| *len >= 3);
    runs
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/// Capture the primary display and check the image matches the display's
/// physical size and is not blank.
#[tauri::command]
pub async fn screenshot_qa_capture(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let worker = app.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let display = capture::resolve_display(&worker, None)?;
        let image = capture::capture_display(&worker, &display)?;
        let (w, h) = image.dimensions();
        let mut distinct = std::collections::HashSet::new();
        for y in (0..h).step_by(17) {
            for x in (0..w).step_by(23) {
                distinct.insert(image.get_pixel(x, y).0);
                if distinct.len() > 64 {
                    break;
                }
            }
        }
        let artifact = keep_image(&image, "capture-full.png");
        let ok = (w, h) == (display.width, display.height) && distinct.len() >= 2 && artifact.is_some();
        Ok(report(
            ok,
            json!({ "width": w, "height": h, "display": display, "distinctColors": distinct.len(), "artifact": artifact }),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))
}

/// Compare captured pixels with the actual native fixture's encoded rows.
#[tauri::command]
pub async fn screenshot_qa_capture_fidelity(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let (window, display, region) = open_fixture(&app, "scroll")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let source = read_source(&window).await.map_err(|e| format!("{e:#}"))?;
    let file = super::screenshot_capture_region(
        app.clone(),
        Some(display.id),
        region.0,
        region.1,
        region.2,
        region.3,
    )
    .await?;
    let image = image::open(&file.path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let runs = row_runs(&image, image.width() * 3 / 4);
    let ordered = runs.first().is_some_and(|r| r.0 == 0)
        && runs.len() >= 7
        && runs.windows(2).all(|r| r[1].0 == r[0].0 + 1);
    let heights = runs
        .iter()
        .skip(1)
        .take(runs.len().saturating_sub(2))
        .all(|r| (r.1 as f64 - 44.0 * scale).abs() <= 3.0 * scale.max(1.0));
    let artifact = keep_artifact(std::path::Path::new(&file.path), "capture-fidelity.png");
    let original = source_png(source.data_url.as_deref().ok_or("missing source page")?)
        .map_err(|e| e.to_string())?;
    let margin = (6.0 * source.scale).round() as u32;
    let expected = capture::crop(&original, margin, margin, region.2, region.3);
    let comparison = qa_oracle::compare(&image, &expected, false);
    let source_artifact = keep_image(&expected, "capture-original.png");
    let diff_artifact = keep_image(
        &qa_oracle::difference(&image, &expected),
        "capture-difference.png",
    );
    Ok(report(
        ordered
            && heights
            && comparison.passed
            && image.dimensions() == (region.2, region.3)
            && artifact.is_some()
            && source_artifact.is_some()
            && diff_artifact.is_some(),
        json!({"region":region,"rows":runs,"ordered":ordered,"rowHeights":heights,"originalComparison":comparison,"sourceArtifact":source_artifact,"differenceArtifact":diff_artifact,"artifact":artifact}),
    ))
}

/// Real OCR and automatic-redaction UI over a native text fixture.
#[tauri::command]
pub async fn screenshot_qa_ocr_redact(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let (_fixture, display, region) = open_fixture(&app, "ocr")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let source = super::screenshot_capture_region(
        app.clone(),
        Some(display.id.clone()),
        region.0,
        region.1,
        region.2,
        region.3,
    )
    .await?;
    let ocr = super::screenshot_ocr(source.path.clone()).await?;
    let boxes = super::screenshot_auto_redact(source.path.clone()).await?;
    let ocr_ok = ocr.text.contains("user@example.com") && ocr.text.contains("13812345678");
    let boxes_ok = boxes.boxes.iter().any(|b| b.kind == "email")
        && boxes.boxes.iter().any(|b| b.kind == "phone")
        && !boxes.boxes.iter().any(|b| b.kind == "id");
    let source_artifact = keep_artifact(std::path::Path::new(&source.path), "ocr-source.png");
    super::open_overlay(&app, Some(display.id)).await?;
    let overlay = wait_window(&app, super::OVERLAY_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let body = format!(
        r#"
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const q = id => document.querySelector('[data-testid="' + id + '"]');
      for (let i=0;i<100 && !(q('screenshot-base-image') && q('screenshot-base-image').complete);i++) await sleep(100);
      const image = q('screenshot-base-image');
      const sx = image.naturalWidth / innerWidth, sy = image.naturalHeight / innerHeight;
      const fire = (type,x,y) => q('screenshot-select-layer').dispatchEvent(new MouseEvent(type, {{bubbles:true,button:0,clientX:x,clientY:y}}));
      fire('mousedown', {x}/sx, {y}/sy);
      fire('mouseup', ({x}+{w})/sx, ({y}+{h})/sy);
      for(let i=0;i<40 && !q('screenshot-toolbar');i++) await sleep(100);
      q('screenshot-ocr').click();
      for(let i=0;i<150 && !(q('screenshot-ocr-text') && q('screenshot-ocr-text').value.includes('user@example.com'));i++) await sleep(100);
      const text = q('screenshot-ocr-text')?.value || '';
      q('screenshot-ocr-close').click();
      q('screenshot-auto-redact').click();
      for(let i=0;i<150 && !(Number(q('screenshot-annotation-canvas').getAttribute('data-shapes')) >= 2 && !q('screenshot-undo').disabled);i++) await sleep(100);
      const count = Number(q('screenshot-annotation-canvas').getAttribute('data-shapes'));
      q('screenshot-undo').click(); await sleep(150);
      const afterUndo = Number(q('screenshot-annotation-canvas').getAttribute('data-shapes'));
      q('screenshot-redo').click(); await sleep(150);
      const afterRedo = Number(q('screenshot-annotation-canvas').getAttribute('data-shapes'));
      return {{text,count,afterUndo,afterRedo}};
    "#,
        x = region.0,
        y = region.1,
        w = region.2,
        h = region.3
    );
    let page = run_js(&overlay, &body, Duration::from_secs(45))
        .await
        .map_err(|e| format!("{e:#}"))?;
    overlay
        .eval("document.querySelector('[data-testid=\"screenshot-copy\"]').click()")
        .map_err(|e| e.to_string())?;
    let closed = wait_closed(&app, super::OVERLAY_LABEL, Duration::from_secs(10)).await;
    let clipboard = read_clipboard_image(&app).map_err(|e| format!("{e:#}"))?;
    let artifact = keep_image(&clipboard, "ocr-redacted.png");
    let original = image::open(
        &source_artifact
            .clone()
            .ok_or("OCR source evidence missing")?,
    )
    .map_err(|e| e.to_string())?
    .to_rgba8();
    let changed = original.dimensions() == clipboard.dimensions()
        && original
            .pixels()
            .zip(clipboard.pixels())
            .filter(|(a, b)| a != b)
            .count()
            >= 50;
    let count = page["count"].as_u64().unwrap_or(0);
    let ok = ocr_ok
        && boxes_ok
        && page["text"]
            .as_str()
            .is_some_and(|s| s.contains("user@example.com"))
        && count >= 2
        && page["afterUndo"] == json!(0)
        && page["afterRedo"] == json!(count)
        && closed
        && main_visible(&app)
        && changed
        && artifact.is_some();
    Ok(report(
        ok,
        json!({"ocr":ocr,"boxes":boxes,"page":page,"pixelsChanged":changed,"overlayClosed":closed,
        "sourceArtifact":source_artifact,"artifact":artifact}),
    ))
}

/// Real scroll capture over a known page: wheel input, complete original
/// pixel comparison and row decoding reject duplicated, skipped or squashed
/// content.
#[tauri::command]
pub async fn screenshot_qa_scroll(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let (window, display, region) = open_fixture(&app, "scroll")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let source = read_source(&window).await.map_err(|e| format!("{e:#}"))?;
    let worker = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        super::scroll::scroll_capture_with(&worker, &display, region, 40)
    })
    .await
    .map_err(|e| e.to_string())?;
    close_fixture(&app);
    let result = result.map_err(|e| format!("{e:#}"))?;
    let image = image::open(&result.path)
        .map_err(|e| format!("open stitched: {e}"))?
        .to_rgba8();
    let artifact = keep_artifact(std::path::Path::new(&result.path), "scroll-stitched.png");
    let content = compare_scroll_original(&image, &source).map_err(|e| format!("{e:#}"))?;
    let runs = row_runs(&image, image.width() * 3 / 4);
    let indices: Vec<u32> = runs.iter().map(|(i, _)| *i).collect();
    let consecutive = indices.windows(2).all(|w| w[1] == w[0] + 1);
    // Full rows (not the first/last, which may be cut by the region edge)
    // must keep their 48 CSS px height minus the 4 px separator.
    let expected = 44.0 * scale;
    let interior = if runs.len() > 2 {
        &runs[1..runs.len() - 1]
    } else {
        &[][..]
    };
    let bad_heights: Vec<u32> = interior
        .iter()
        .filter(|(_, len)| (*len as f64 - expected).abs() > 3.0 * scale.max(1.0))
        .map(|(_, len)| *len)
        .collect();
    let ok = result.frames >= 3
        && result.height as f64 >= region.3 as f64 * 1.8
        && consecutive
        && indices.len() >= 10
        && bad_heights.is_empty()
        && content["passed"] == json!(true)
        && artifact.is_some();
    Ok(report(
        ok,
        json!({
            "frames": result.frames,
            "width": result.width,
            "height": result.height,
            "regionHeight": region.3,
            "rows": indices,
            "consecutive": consecutive,
            "badRowHeights": bad_heights,
            "expectedRowHeight": expected,
            "originalComparison": content,
            "artifact": artifact,
        }),
    ))
}

/// Record an animated page for `secs` seconds and compare every decoded
/// frame with its actual original pixels, identity and draw timeline.
#[tauri::command]
pub async fn screenshot_qa_record(
    app: AppHandle,
    format: String,
    secs: u64,
) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let format = super::record::RecordFormat::parse(&format).map_err(|e| format!("{e:#}"))?;
    let secs = secs.clamp(1, 8);
    let fps = 10;
    let (window, display, region) = open_fixture(&app, "anim")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let worker = app.clone();
    let id = tokio::task::spawn_blocking(move || {
        super::record::start_recording(&worker, display, Some(region), format, Some(fps))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"));
    let id = match id {
        Ok(id) => id,
        Err(e) => {
            close_fixture(&app);
            return Err(e);
        }
    };
    tokio::time::sleep(Duration::from_secs(secs)).await;
    let info = tokio::task::spawn_blocking(move || super::record::stop_recording(&id))
        .await
        .map_err(|e| e.to_string())?;
    let source = read_source(&window).await.map_err(|e| format!("{e:#}"))?;
    close_fixture(&app);
    let info = info.map_err(|e| format!("{e:#}"))?;
    let ext = if format == super::record::RecordFormat::Gif {
        "gif"
    } else {
        "mp4"
    };
    let artifact = keep_artifact(&info.path, &format!("recording.{ext}"));
    let (clip, content) =
        compare_record_original(&info.path, &source).map_err(|e| format!("{e:#}"))?;
    let expected_ms = secs * 1000;
    let ok = clip.duration_ms as f64 >= expected_ms as f64 * 0.75
        && clip.duration_ms as f64 <= expected_ms as f64 * 1.4
        && clip.frames as f64 >= (secs * fps as u64) as f64 * 0.4
        && clip.distinct_frames >= 4
        && clip.width >= region.2.min(1920) / 2
        && clip.height >= region.3 / 2
        && content["passed"] == json!(true)
        && artifact.is_some();
    Ok(report(
        ok,
        json!({ "clip": clip, "expectedMs": expected_ms, "region": region, "originalComparison": content, "artifact": artifact }),
    ))
}

/// The full overlay flow as a user does it: open (hides app windows), the
/// captured background loads, drag a region, draw a red rectangle, copy.
/// Verified from outside: the overlay closed, the main window is back, and
/// the OS clipboard holds an image of the selected size with the red stroke.
#[tauri::command]
pub async fn screenshot_qa_overlay_copy(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::close_session(&app);
    super::open_overlay(&app, None).await?;
    let hidden_main = !main_visible(&app);
    let overlay = wait_window(&app, super::OVERLAY_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| format!("{e:#}"))?;
    let script = r#"
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const img = () => q('[data-testid="screenshot-base-image"]');
      for (let i = 0; i < 150 && !(img() && img().complete && img().naturalWidth > 0); i++) {
        const err = q('[data-testid="screenshot-overlay-error"]');
        if (err) throw new Error('overlay error: ' + err.textContent);
        await sleep(100);
      }
      if (!img() || !img().naturalWidth) throw new Error('captured background did not load');
      const fire = (el, type, x, y) => el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, button: 0,
        buttons: type === 'mouseup' ? 0 : 1, clientX: x, clientY: y }));
      const sel = q('[data-testid="screenshot-select-layer"]');
      fire(sel, 'mousedown', 100, 100);
      fire(sel, 'mousemove', 250, 200);
      fire(sel, 'mousemove', 400, 300);
      fire(sel, 'mouseup', 400, 300);
      for (let i = 0; i < 30 && !q('[data-testid="screenshot-toolbar"]'); i++) await sleep(100);
      if (!q('[data-testid="screenshot-toolbar"]')) throw new Error('toolbar did not appear');
      q('[data-testid="screenshot-tool-rect"]').click();
      q('[data-testid="screenshot-color-red"]').click();
      await sleep(150);
      const ann = q('[data-testid="screenshot-annotation-layer"]');
      fire(ann, 'mousedown', 150, 150);
      fire(ann, 'mousemove', 220, 200);
      fire(ann, 'mouseup', 300, 250);
      await sleep(200);
      const info = {
        naturalWidth: img().naturalWidth, naturalHeight: img().naturalHeight,
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        undoEnabled: !q('[data-testid="screenshot-undo"]').disabled,
      };
      if (q('[data-testid="screenshot-annotation-canvas"]').getAttribute('data-shapes') !== '1') throw new Error('rectangle not committed');
      return info;
    "#;
    let info = run_js(&overlay, script, Duration::from_secs(25)).await;
    let info = match info {
        Ok(info) => info,
        Err(e) => {
            super::close_session(&app);
            return Err(format!("{e:#}"));
        }
    };
    overlay
        .eval("document.querySelector('[data-testid=\"screenshot-copy\"]').click()")
        .map_err(|e| e.to_string())?;
    let closed = wait_closed(&app, super::OVERLAY_LABEL, Duration::from_secs(10)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let restored = main_visible(&app);
    let natural_w = info["naturalWidth"].as_f64().unwrap_or(0.0);
    let inner_w = info["innerWidth"].as_f64().unwrap_or(1.0).max(1.0);
    let sx = natural_w / inner_w;
    let sy = info["naturalHeight"].as_f64().unwrap_or(0.0)
        / info["innerHeight"].as_f64().unwrap_or(1.0).max(1.0);
    let expected = ((300.0 * sx).round() as i64, (200.0 * sy).round() as i64);

    let clipboard = read_clipboard_image(&app);
    let (clip_w, clip_h, red, artifact) = match &clipboard {
        Ok(image) => {
            // The top edge of the rectangle is at (50,50) in the crop,
            // not just anywhere a red desktop pixel happened to be.
            let left = (50.0 * sx).round() as u32;
            let top = (50.0 * sy).round() as u32;
            let right = (200.0 * sx).round() as u32;
            let band = (4.0 * sy).ceil() as u32;
            let red = (top.saturating_sub(band)..(top + band).min(image.height()))
                .flat_map(|y| (left..right.min(image.width())).map(move |x| (x, y)))
                .filter(|&(x, y)| {
                    let p = image.get_pixel(x, y);
                    p[0] > 200 && p[1] < 130 && p[2] < 130
                })
                .count();
            (
                image.width() as i64,
                image.height() as i64,
                red,
                keep_image(image, "overlay-copy.png"),
            )
        }
        Err(_) => (0, 0, 0, None),
    };
    super::close_session(&app);
    let ok = hidden_main
        && closed
        && restored
        && (clip_w - expected.0).abs() <= 2
        && (clip_h - expected.1).abs() <= 2
        && red >= 50
        && info["undoEnabled"] == Value::Bool(true)
        && artifact.is_some();
    Ok(report(
        ok,
        json!({
            "mainHiddenDuringCapture": hidden_main,
            "overlayClosed": closed,
            "mainRestored": restored,
            "page": info,
            "expected": [expected.0, expected.1],
            "clipboard": [clip_w, clip_h],
            "clipboardError": clipboard.as_ref().err().map(|e| format!("{e:#}")),
            "redPixels": red,
            "artifact": artifact,
        }),
    ))
}

fn read_clipboard_image(app: &AppHandle) -> anyhow::Result<RgbaImage> {
    let state = app.state::<crate::state::AppState>();
    let mut guard = state
        .clipboard
        .lock()
        .map_err(|_| anyhow::anyhow!("clipboard lock poisoned"))?;
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new().context("open clipboard")?);
    }
    let data = guard
        .as_mut()
        .expect("clipboard initialised")
        .get_image()
        .context("clipboard has no image")?;
    RgbaImage::from_raw(
        data.width as u32,
        data.height as u32,
        data.bytes.into_owned(),
    )
    .context("clipboard image size mismatch")
}

/// Recorder bar flow: start a real recording, stop it from the bar, check
/// the preview loads (asset protocol), then finish and confirm the session
/// ends with the main window restored.
#[tauri::command]
pub async fn screenshot_qa_recorder(app: AppHandle, format: String) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::close_session(&app);
    let (fixture, display, region) = open_fixture(&app, "anim")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let started = super::screenshot_start_recording(
        app.clone(),
        Some(display.id.clone()),
        Some(region.0),
        Some(region.1),
        Some(region.2),
        Some(region.3),
        format.clone(),
        Some(10),
    )
    .await?;
    let output =
        super::record::output_path(&started.recording_id).ok_or("recording output not tracked")?;
    let main_hidden = !main_visible(&app);
    let bar = wait_window(&app, super::RECORDER_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| format!("{e:#}"))?;
    let script = r#"
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      for (let i = 0; i < 50 && !(q('[data-testid="screenshot-recorder-stop"]') && !q('[data-testid="screenshot-recorder-stop"]').disabled); i++) await sleep(100);
      const timerBefore = (q('[data-testid="screenshot-recorder-timer"]') || {}).textContent;
      await sleep(2300);
      const timerAfter = (q('[data-testid="screenshot-recorder-timer"]') || {}).textContent;
      q('[data-testid="screenshot-recorder-stop"]').click();
      let preview = null;
      for (let i = 0; i < 100; i++) {
        preview = q('[data-testid="screenshot-recorder-preview"]');
        if (preview && (preview.tagName === 'VIDEO'
            ? preview.readyState >= 2 && preview.videoWidth > 0 && Number.isFinite(preview.duration) && !preview.error
            : preview.complete && preview.naturalWidth > 0)) break;
        const err = q('[data-testid="screenshot-recorder-error"]');
        if (err) throw new Error('recorder error: ' + err.textContent);
        await sleep(100);
      }
      if (!preview) throw new Error('no preview after stop');
      let playbackMoved = false;
      if (preview.tagName === 'VIDEO') {
        if (preview.readyState < 2 || preview.videoWidth <= 0 || preview.error) throw new Error('MP4 preview did not decode');
        preview.loop = false;
        preview.currentTime = 0;
        await preview.play();
        await sleep(600);
        playbackMoved = preview.currentTime > 0.1;
        if (!playbackMoved) throw new Error('MP4 preview did not play');
      } else if (!preview.complete || preview.naturalWidth <= 0) throw new Error('GIF preview did not load');
      return {
        timerBefore, timerAfter, tag: preview.tagName,
        naturalWidth: preview.naturalWidth || preview.videoWidth || 0,
        naturalHeight: preview.naturalHeight || preview.videoHeight || 0,
        duration: preview.duration || 0, playbackMoved,
        meta: (q('[data-testid="screenshot-recorder-meta"]') || {}).textContent || '',
      };
    "#;
    let page_result = run_js(&bar, script, Duration::from_secs(25)).await;
    // Keep the clip even if the WebView preview fails to decode it.
    let artifact = keep_artifact(&output, &format!("recorder-preview.{format}"));
    let source = read_source(&fixture).await.map_err(|e| format!("{e:#}"))?;
    let (clip, content) =
        compare_record_original(&output, &source).map_err(|e| format!("{e:#}"))?;
    let info = page_result.map_err(|e| format!("{e:#}"))?;
    let mut copied = format != "gif";
    if format == "gif" {
        run_js(&bar, "document.querySelector('[data-testid=\"screenshot-recorder-copy\"]').click(); await new Promise(r => setTimeout(r,400)); return true;", Duration::from_secs(5)).await.map_err(|e| e.to_string())?;
        copied = read_clipboard_image(&app)
            .is_ok_and(|image| image.dimensions() == (clip.width, clip.height));
    }
    // A new screenshot request must focus the preview rather than replace it.
    super::open_overlay(&app, None).await?;
    let preview_retained = app.get_webview_window(super::OVERLAY_LABEL).is_none();
    bar.eval("document.querySelector('[data-testid=\"screenshot-recorder-done\"]').click()")
        .map_err(|e| e.to_string())?;
    let closed = wait_closed(&app, super::RECORDER_LABEL, Duration::from_secs(10)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let restored = main_visible(&app);
    let output_removed = !output.exists();
    let timer_moved = info["timerBefore"] != info["timerAfter"];
    let preview_ok = info["naturalWidth"].as_u64() == Some(clip.width as u64)
        && info["naturalHeight"].as_u64() == Some(clip.height as u64)
        && (format != "mp4" || info["playbackMoved"] == json!(true));
    let ok = main_hidden
        && closed
        && restored
        && timer_moved
        && preview_ok
        && copied
        && preview_retained
        && output_removed
        && clip.frames >= 8
        && clip.distinct_frames >= 4
        && content["passed"] == json!(true)
        && (1800..=4200).contains(&clip.duration_ms)
        && artifact.is_some();
    Ok(report(
        ok,
        json!({ "page":info,"clip":clip,"barClosed":closed,"mainHidden":main_hidden,"mainRestored":restored,
        "gifCopied":copied,"previewRetained":preview_retained,"tempRemoved":output_removed,"format":format,"originalComparison":content,"artifact":artifact }),
    ))
}

/// Pin a capture: the pin window shows the image, closing it removes the
/// pinned copy.
#[tauri::command]
pub async fn screenshot_qa_pin(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let worker = app.clone();
    let file = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let display = capture::resolve_display(&worker, None)?;
        let image = capture::capture_display(&worker, &display)?;
        let small = capture::crop(&image, 0, 0, 320, 200);
        let (path, _, _) = capture::save_png(&small, "qa-pin")?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))?;
    let destination = artifact_dir().join(format!("{}-saved-screenshot.png", platform()));
    std::fs::create_dir_all(artifact_dir()).map_err(|e| e.to_string())?;
    super::screenshot_save_image(file.clone(), destination.to_string_lossy().into_owned()).await?;
    let saved_identical = std::fs::read(&file).map_err(|e| e.to_string())?
        == std::fs::read(&destination).map_err(|e| e.to_string())?;
    let label = super::screenshot_pin_to_screen(app.clone(), file).await?;
    let window = wait_window(&app, &label, Duration::from_secs(10))
        .await
        .map_err(|e| format!("{e:#}"))?;
    let pinned_path = super::tool_state().pins.get(&label).map(|p| p.path.clone());
    let script = r#"
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      for (let i = 0; i < 100 && !(q('[data-testid="screenshot-pin-image"]') && q('[data-testid="screenshot-pin-image"]').complete && q('[data-testid="screenshot-pin-image"]').naturalWidth > 0); i++) await sleep(100);
      const img = q('[data-testid="screenshot-pin-image"]');
      return { naturalWidth: img ? img.naturalWidth : 0, naturalHeight: img ? img.naturalHeight : 0 };
    "#;
    let info = run_js(&window, script, Duration::from_secs(20)).await;
    super::screenshot_close_pin(app.clone(), label.clone()).await?;
    let closed = wait_closed(&app, &label, Duration::from_secs(10)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let removed = pinned_path
        .as_ref()
        .is_some_and(|p| !std::path::Path::new(p).exists());
    let info = info.map_err(|e| format!("{e:#}"))?;
    let ok = info["naturalWidth"].as_u64() == Some(320)
        && info["naturalHeight"].as_u64() == Some(200)
        && closed
        && removed
        && saved_identical;
    Ok(report(
        ok,
        json!({ "page":info,"closed":closed,"pinCopyRemoved":removed,
        "savedBytesIdentical":saved_identical,"artifact":destination }),
    ))
}

async fn press_hotkey() -> Result<(), String> {
    tokio::task::spawn_blocking(|| -> anyhow::Result<()> {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| anyhow::anyhow!("input synthesis unavailable: {e}"))?;
        // Ctrl+Alt+Fn is reserved for Linux virtual-terminal switching.
        let keys = [Key::Control, Key::Shift];
        let result = (|| -> anyhow::Result<()> {
            for key in keys {
                enigo
                    .key(key, Direction::Press)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            std::thread::sleep(Duration::from_millis(60));
            enigo
                .key(Key::F9, Direction::Click)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            std::thread::sleep(Duration::from_millis(60));
            Ok(())
        })();
        // Always release modifiers, including a failed F9/second modifier.
        for key in keys.iter().rev() {
            let _ = enigo.key(*key, Direction::Release);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))
}

/// The OS-global hotkey: register a test chord, press it with real OS key
/// events, and verify the overlay opens; then restore the default chord.
#[tauri::command]
pub async fn screenshot_qa_hotkey(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::close_session(&app);
    let chord = "Control+Shift+F9";
    let previous = super::shortcut::screenshot_shortcut_status().await?;
    let settings_path = crate::resolved_app_data_dir(&app)
        .map_err(|e| e.to_string())?
        .join("screenshot-settings.json");
    let original_settings = std::fs::read(&settings_path).ok();
    let result = async {
        let status = super::shortcut::screenshot_shortcut_set(app.clone(), Some(chord.into())).await?;
        press_hotkey().await?;
        let overlay = wait_window(&app, super::OVERLAY_LABEL, Duration::from_secs(10)).await.map_err(|e|e.to_string())?;
        let ready = run_js(&overlay, "for(let i=0;i<100 && !document.querySelector('[data-testid=\"screenshot-hint\"]');i++) await new Promise(r=>setTimeout(r,100)); return !!document.querySelector('[data-testid=\"screenshot-hint\"]');", Duration::from_secs(15)).await.map_err(|e|e.to_string())?;
        // Closing through the native window lifecycle must restore the app.
        overlay.close().map_err(|e|e.to_string())?;
        let closed = wait_closed(&app, super::OVERLAY_LABEL, Duration::from_secs(10)).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        let restored = main_visible(&app);
        let disabled = super::shortcut::screenshot_shortcut_set(app.clone(), Some(String::new())).await?;
        press_hotkey().await?;
        tokio::time::sleep(Duration::from_millis(800)).await;
        let did_not_open = app.get_webview_window(super::OVERLAY_LABEL).is_none();
        Ok::<_,String>((status.registered, ready == json!(true), closed, restored, !disabled.enabled && did_not_open))
    }.await;
    super::close_session(&app);
    let restored_status =
        super::shortcut::screenshot_shortcut_set(app.clone(), Some(previous.accelerator.clone()))
            .await;
    let settings_restored = match original_settings {
        Some(bytes) => std::fs::write(&settings_path, bytes).is_ok(),
        None => std::fs::remove_file(&settings_path).is_ok(),
    };
    let (registered, opened, closed, restored, disabled) = result?;
    let same_shortcut = restored_status
        .as_ref()
        .is_ok_and(|s| s.accelerator == previous.accelerator);
    Ok(report(
        registered
            && opened
            && closed
            && restored
            && disabled
            && same_shortcut
            && settings_restored,
        json!({"registered":registered,"overlayLoaded":opened,"nativeCloseRestoredMain":closed && restored,
            "disabledDoesNotTrigger":disabled,"originalShortcutRestored":same_shortcut,"originalSettingsRestored":settings_restored}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_color(i: u32) -> [u8; 4] {
        [30 + (i % 8) as u8 * 28, 30 + (i / 8) as u8 * 28, 210, 255]
    }

    fn evidence(kind: &str, css_width: f64, css_height: f64, scale: f64) -> SourceEvidence {
        SourceEvidence {
            kind: kind.into(),
            css_width,
            css_height,
            width: (css_width * scale).round() as u32,
            height: (css_height * scale).round() as u32,
            scale,
            nonce: 1,
            frames: Vec::new(),
            data_url: None,
        }
    }

    #[test]
    fn full_page_expected_width_cannot_follow_a_truncated_output() {
        let source = evidence("scroll", 520.0, 1536.0, 1.0);
        let original = RgbaImage::from_pixel(520, 1536, image::Rgba([80, 110, 210, 255]));
        let expected = source_crop(&source, &original).unwrap();
        assert_eq!(expected.dimensions(), (508, 1524));
        let truncated = capture::crop(&expected, 0, 0, 400, expected.height());
        assert!(!qa_oracle::compare(&truncated, &expected, false).passed);
        assert!(source_crop(&source, &truncated).is_err());
    }

    #[test]
    fn recording_expected_dimensions_are_derived_from_original_scale_and_format() {
        let source = evidence("anim", 1012.0, 512.0, 1.0);
        assert_eq!(record_expected_size(&source, false).unwrap(), (960, 480));
        assert_eq!(record_expected_size(&source, true).unwrap(), (1000, 500));
        let source = evidence("anim", 1012.0, 512.0, 2.0);
        assert_eq!(record_expected_size(&source, false).unwrap(), (960, 480));
        assert_eq!(record_expected_size(&source, true).unwrap(), (1920, 960));
        let mut invalid = source;
        invalid.width = 400;
        assert!(record_expected_size(&invalid, true).is_err());
    }

    #[test]
    fn rows_decode_with_color_tolerance() {
        for i in 0..64 {
            let mut c = row_color(i);
            assert_eq!(decode_row(c), Some(i));
            c[0] = c[0].saturating_add(6);
            c[1] = c[1].saturating_sub(5);
            assert_eq!(decode_row(c), Some(i));
        }
        assert_eq!(decode_row([255, 255, 255, 255]), None);
        assert_eq!(decode_row([44, 44, 210, 255]), None);
    }

    #[test]
    fn row_runs_detect_order_and_heights() {
        let mut rows = Vec::new();
        for i in 3..9u32 {
            for _ in 0..44 {
                rows.push(row_color(i));
            }
            for _ in 0..4 {
                rows.push([255, 255, 255, 255]);
            }
        }
        let image = RgbaImage::from_fn(10, rows.len() as u32, |_, y| image::Rgba(rows[y as usize]));
        let runs = row_runs(&image, 5);
        assert_eq!(
            runs.iter().map(|r| r.0).collect::<Vec<_>>(),
            vec![3, 4, 5, 6, 7, 8]
        );
        assert!(runs.iter().all(|r| r.1 == 44));
    }
}
