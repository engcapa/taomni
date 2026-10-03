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

fn evidence_path(name: &str) -> std::path::PathBuf {
    static PROCESS_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let process = PROCESS_ID.get_or_init(|| uuid::Uuid::new_v4().to_string());
    artifact_dir().join(format!(
        "{}-{process}-{}-{name}",
        platform(),
        EVAL_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Best-effort copy of an output into the CI artifact folder.
fn keep_artifact(src: &std::path::Path, name: &str) -> Option<String> {
    let dir = artifact_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let dest = evidence_path(name);
    std::fs::copy(src, &dest).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

fn keep_image(image: &RgbaImage, name: &str) -> Option<String> {
    let dir = artifact_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let dest = evidence_path(name);
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
    let content_width = run_js(&window, "const root = document.querySelector('[data-testid=\"screenshot-qa-fixture-ready\"]'); return root.querySelector('canvas')?.getBoundingClientRect().width ?? root.clientWidth;", Duration::from_secs(5)).await?.as_f64().context("fixture content width")?;
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
    let path = evidence_path(name);
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
        let original_index =
            id.and_then(|id| source.frames.iter().position(|frame| frame.id == id));
        let original = original_index.map(|i| &source.frames[i]);
        let visible_until = original_index
            .and_then(|i| source.frames.get(i + 1))
            .map(|f| f.at_ms);
        let ordered = previous.zip(id).is_none_or(|(last, now)| now >= last);
        let mut comparison = None;
        let matched = if let Some(original) = original {
            let raw = source_png(&original.data_url)?;
            let expected = source_region(source, &raw, expected_size)?;
            let result = qa_oracle::compare(image, &expected, true);
            let timing = timeline.observe(
                at_ms,
                original.at_ms,
                visible_until.unwrap_or(original.at_ms),
            );
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
            "originalAtMs":original.map(|f|f.at_ms),"originalVisibleUntilMs":visible_until,"ordered":ordered,"matchedOriginal":matched,"comparison":comparison,"actualArtifact":actual_artifact}));
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
        "nonce":source.nonce,"timelineMatches":timeline_ok,"worstTimelineDriftMs":timeline.worst_drift_ms,"longestFrameGapMs":timeline.longest_gap_ms,"longestUnexplainedGapMs":timeline.longest_unexplained_gap_ms,
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
      q('[data-testid="screenshot-record"]').click(); await sleep(150);
      const menu = q('[data-testid="screenshot-record-menu"]').getBoundingClientRect();
      const hint = q('[data-testid="screenshot-record-hint"]').getBoundingClientRect();
      if (menu.width < 280 || hint.height > 180 || menu.left < 0 || menu.top < 0 || menu.right > innerWidth || menu.bottom > innerHeight)
        throw new Error('record menu cramped or outside viewport: ' + JSON.stringify({menu:menu.toJSON(), hint:hint.toJSON()}));
      window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); await sleep(100);
      q('[data-testid="screenshot-tool-text"]').click(); await sleep(100);
      const font = q('[data-testid="screenshot-font-family"]');
      font.value = 'monospace'; font.dispatchEvent(new Event('change',{bubbles:true}));
      const size = q('[data-testid="screenshot-font-size"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(size,'24');
      size.dispatchEvent(new Event('input',{bubbles:true}));
      q('[data-testid="screenshot-color-green"]').click(); await sleep(100);
      fire(ann, 'click', 170, 170); await sleep(100);
      const text = q('[data-testid="screenshot-text-input"]');
      if (text.tagName !== 'TEXTAREA' || getComputedStyle(text).fontSize !== '24px' || !getComputedStyle(text).fontFamily.includes('monospace'))
        throw new Error('text font controls did not apply');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(text,'Alpha\nBeta');
      text.dispatchEvent(new Event('input',{bubbles:true})); await sleep(100);
      text.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await sleep(100);
      if (!q('[data-testid="screenshot-text-input"]')) throw new Error('Enter prematurely committed text');
      text.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); await sleep(100);
      if (q('[data-testid="screenshot-text-input"]')) throw new Error('Ctrl+Enter did not commit text');
      const info = {
        textFont: 'monospace', textSize: 24, textLines: 2, recordMenuWidth: menu.width,
        naturalWidth: img().naturalWidth, naturalHeight: img().naturalHeight,
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        undoEnabled: !q('[data-testid="screenshot-undo"]').disabled,
      };
      if (q('[data-testid="screenshot-annotation-canvas"]').getAttribute('data-shapes') !== '2') throw new Error('rectangle and multiline text not committed');
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
    let (clip_w, clip_h, red, green_lines, artifact) = match &clipboard {
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
            let green_lines: Vec<usize> = [70.0, 98.8].iter().map(|top| {
                let y0 = (top * sy).floor() as u32;
                let y1 = ((top + 24.0) * sy).ceil() as u32;
                ((y0)..y1.min(image.height())).flat_map(|y| {
                    ((70.0 * sx) as u32..(150.0 * sx) as u32).map(move |x| (x, y))
                }).filter(|&(x, y)| {
                    let p = image.get_pixel(x.min(image.width() - 1), y);
                    p[1] > 150 && p[0] < 140 && p[2] < 100
                }).count()
            }).collect();
            (
                image.width() as i64,
                image.height() as i64,
                red,
                green_lines,
                keep_image(image, "overlay-copy.png"),
            )
        }
        Err(_) => (0, 0, 0, vec![0, 0], None),
    };
    super::close_session(&app);
    let ok = hidden_main
        && closed
        && restored
        && (clip_w - expected.0).abs() <= 2
        && (clip_h - expected.1).abs() <= 2
        && red >= 50
        && green_lines.iter().all(|count| *count >= 10)
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
            "greenPixelsPerTextLine": green_lines,
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

#[cfg(any(target_os = "linux", test))]
fn x11_control_geometry(output: &str) -> Option<(super::surfaces::Rect, bool)> {
    let field = |name: &str| {
        output
            .lines()
            .find_map(|line| line.trim().strip_prefix(name).map(str::trim))
    };
    let rect = super::surfaces::Rect {
        x: field("Absolute upper-left X:")?.parse().ok()?,
        y: field("Absolute upper-left Y:")?.parse().ok()?,
        w: field("Width:")?.parse().ok()?,
        h: field("Height:")?.parse().ok()?,
    };
    let visible = match field("Map State:")? {
        "IsViewable" => true,
        "IsUnMapped" | "IsUnviewable" => false,
        _ => return None,
    };
    (rect.w > 0 && rect.h > 0).then_some((rect, visible))
}

async fn capture_surfaces(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
    label: &str,
    require_visible: bool,
) -> anyhow::Result<Value> {
    let crop = super::surfaces::region_rect(display, region);
    let bar = app
        .get_webview_window(label)
        .context("capture controls missing")?;
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let (control, bar_visible, cached_control, native_probe) = loop {
        let pos = bar.outer_position()?;
        let size = bar.outer_size()?;
        let cached = super::surfaces::Rect {
            x: pos.x,
            y: pos.y,
            w: size.width as i32,
            h: size.height as i32,
        };
        let visible = bar.is_visible()?;
        #[cfg(target_os = "linux")]
        let (control, visible, native_probe, ready) = if visible {
            // Tao initialises its outer-size cache from root_origin and only
            // refreshes geometry on configure events. Query the X server for
            // the actual mapped control instead of accepting that cache.
            let output = std::process::Command::new("xwininfo")
                .args(["-name", &bar.title()?, "-stats"])
                .env("LC_ALL", "C")
                .output()
                .context("query native capture control geometry")?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let probe = json!({"success":output.status.success(),"stdout":stdout,
                "stderr":String::from_utf8_lossy(&output.stderr)});
            if let Some((rect, mapped)) =
                x11_control_geometry(&stdout).filter(|_| output.status.success())
            {
                (rect, mapped, probe, true)
            } else {
                (cached, false, probe, false)
            }
        } else {
            (cached, false, Value::Null, true)
        };
        #[cfg(not(target_os = "linux"))]
        let (control, native_probe, ready) = (cached, Value::Null, true);
        if ready && (!require_visible || (visible && control.w > 0 && control.h > 0)) {
            break (control, visible, cached, native_probe);
        }
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "capture controls were not mapped with a nonempty size: {native_probe}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let mut border_count = 0;
    let mut borders_outside = true;
    let mut border_geometry = Vec::new();
    for (name, window) in app.windows() {
        if !name.starts_with(super::surfaces::BORDER_PREFIX) {
            continue;
        }
        let pos = window.outer_position()?;
        let size = window.outer_size()?;
        let rect = super::surfaces::Rect {
            x: pos.x,
            y: pos.y,
            w: size.width as i32,
            h: size.height as i32,
        };
        let visible = window.is_visible()?;
        borders_outside &= !crop.intersects(rect) && visible;
        border_geometry
            .push(json!({"label":name,"rect":[rect.x,rect.y,rect.w,rect.h],"visible":visible}));
        border_count += 1;
    }
    Ok(
        json!({"barVisible":bar_visible,"controlsOutside":!bar_visible || !crop.intersects(control),
        "bordersOutside":borders_outside,"borderCount":border_count,"borders":border_geometry,"region":[crop.x,crop.y,crop.w,crop.h],
        "control":[control.x,control.y,control.w,control.h],
        "cachedControl":[cached_control.x,cached_control.y,cached_control.w,cached_control.h],
        "nativeControlProbe":native_probe}),
    )
}

async fn begin_scroll_ui(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
    annotate: bool,
) -> Result<WebviewWindow, String> {
    super::open_overlay(app, Some(display.id.clone())).await?;
    let overlay = wait_window(app, super::OVERLAY_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let script = format!(
        r#"
      const q = (id) => document.querySelector('[data-testid="' + id + '"]');
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 100 && q('screenshot-overlay')?.dataset.phase !== 'select'; i++) await sleep(100);
      const img = q('screenshot-base-image');
      if (!img?.naturalWidth) throw new Error('capture background unavailable');
      const sx = window.innerWidth / img.naturalWidth, sy = window.innerHeight / img.naturalHeight;
      const x = {x} * sx, y = {y} * sy, w = {w} * sx, h = {h} * sy;
      const fire = (el, type, x, y) => el.dispatchEvent(new MouseEvent(type, {{bubbles:true,button:0,clientX:x,clientY:y}}));
      fire(q('screenshot-select-layer'), 'mousedown', x, y); await sleep(50);
      fire(window, 'mousemove', x + w, y + h); await sleep(50);
      fire(window, 'mouseup', x + w, y + h); await sleep(100);
      if ({annotate}) {{
        q('screenshot-tool-rect').click(); await sleep(100);
        fire(q('screenshot-annotation-layer'), 'mousedown', x + 20, y + 20); await sleep(50);
        fire(q('screenshot-annotation-layer'), 'mousemove', x + 80, y + 80); await sleep(50);
        fire(window, 'mouseup', x + 80, y + 80); await sleep(100);
        if (q('screenshot-annotation-canvas').dataset.shapes !== '1') throw new Error('annotation missing');
      }}
      q('screenshot-scroll-capture').click(); await sleep(100);
      if (!q('screenshot-scroll-instructions')?.textContent) throw new Error('scroll instructions missing');
      q('screenshot-scroll-start').click(); return true;
    "#,
        x = region.0,
        y = region.1,
        w = region.2,
        h = region.3,
        annotate = annotate
    );
    run_js(&overlay, &script, Duration::from_secs(20))
        .await
        .map_err(|e| e.to_string())?;
    Ok(overlay)
}

/// Real entry/window lifecycle plus stop/cancel of the production scroll UI.
#[tauri::command]
pub async fn screenshot_qa_controls(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::close_session(&app);
    let main = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    run_js(&main, "document.querySelector('[data-testid=\"system-screenshot-delay-toggle\"]').click(); await new Promise(r => setTimeout(r,100)); document.querySelector('[data-testid=\"system-screenshot-current-window\"]').click(); return true;", Duration::from_secs(5)).await.map_err(|e| e.to_string())?;
    let overlay = wait_window(&app, super::OVERLAY_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let selected = run_js(&overlay, "for (let i=0;i<100 && document.querySelector('[data-testid=\"screenshot-overlay\"]')?.dataset.phase !== 'annotate';i++) await new Promise(r=>setTimeout(r,100)); return !!document.querySelector('[data-testid=\"screenshot-selection\"]');", Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    let current_visible = main_visible(&app);
    let current_region = super::screenshot_overlay_init().await?.window_region;
    let window_artifact = keep_artifact(
        std::path::Path::new(&super::screenshot_overlay_init().await?.path),
        "current-window.png",
    );
    super::close_session(&app);
    wait_closed(&app, super::OVERLAY_LABEL, Duration::from_secs(5)).await;
    super::open_overlay(&app, None).await?;
    let default_hidden = !main_visible(&app)
        && super::screenshot_overlay_init()
            .await?
            .window_region
            .is_none();
    super::close_session(&app);
    wait_closed(&app, super::OVERLAY_LABEL, Duration::from_secs(5)).await;

    let (fixture, display, region) = open_fixture(&app, "scroll")
        .await
        .map_err(|e| e.to_string())?;
    let source = read_source(&fixture).await.map_err(|e| e.to_string())?;
    let overlay = begin_scroll_ui(&app, &display, region, false).await?;
    let bar = wait_window(&app, super::surfaces::SCROLL_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    run_js(
        &bar,
        r#"
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 100; i++) {
        if (document.querySelector('[data-testid="screenshot-scroll-stop"]')) return true;
        await sleep(100);
      }
      throw new Error('scroll Finish control missing');
    "#,
        Duration::from_secs(15),
    )
    .await
    .map_err(|e| format!("scroll controls readiness: {e}"))?;
    let progress = run_js(
        &bar,
        r#"
      for (let i = 0; i < 100; i++) {
        const status = await window.__TAURI_INTERNALS__.invoke('screenshot_scroll_status');
        if (status?.frames >= 2) return status;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('scroll did not capture a second frame');
    "#,
        Duration::from_secs(15),
    )
    .await
    .map_err(|e| format!("scroll progress: {e}"))?;
    let geometry = capture_surfaces(&app, &display, region, super::surfaces::SCROLL_LABEL, true)
        .await
        .map_err(|e| e.to_string())?;
    // Finish closes this window. Read the result from the surviving overlay,
    // rather than polling an async script slot in the window being destroyed.
    bar.eval("document.querySelector('[data-testid=\"screenshot-scroll-stop\"]').click()")
        .map_err(|e| format!("click scroll Finish: {e}"))?;
    let completed = run_js(&overlay, r#"
      const q = id => document.querySelector('[data-testid="'+id+'"]');
      const sleep = ms => new Promise(r=>setTimeout(r,ms));
      for(let i=0;i<150 && q('screenshot-overlay')?.dataset.phase!=='preview';i++) await sleep(100);
      if (q('screenshot-overlay')?.dataset.phase !== 'preview') throw new Error('scroll result preview missing');
      const image = q('screenshot-scroll-result-image');
      for(let i=0;i<50 && !image?.complete;i++) await sleep(100);
      const r = image.getBoundingClientRect();
      const container = q('screenshot-scroll-result-viewport').getBoundingClientRect();
      if (Math.abs(r.width / r.height - image.naturalWidth / image.naturalHeight) > 0.005
        || r.width > image.naturalWidth + 1 || r.height > container.height || r.left < 0 || r.right > innerWidth)
        throw new Error('scroll preview stretched or clipped');
      if (q('screenshot-hint') || q('screenshot-toolbar')) throw new Error('unexpected selection instructions');
      q('screenshot-scroll-actual').click(); await sleep(100);
      const actual = image.getBoundingClientRect();
      if (Math.abs(actual.width-image.naturalWidth)>1 || Math.abs(actual.height-image.naturalHeight)>1)
        throw new Error('original size is not 100%');
      q('screenshot-scroll-fit').click(); await sleep(100);
      q('screenshot-scroll-result-edit').click(); await sleep(100);
      if (!q('screenshot-toolbar') || q('screenshot-overlay')?.dataset.phase !== 'annotate') throw new Error('annotation unavailable');
      const base = q('screenshot-base-image').getBoundingClientRect();
      if (Math.abs(base.width/base.height-image.naturalWidth/image.naturalHeight)>0.005) throw new Error('annotation image distorted');
      return true;
    "#, Duration::from_secs(25)).await.map_err(|e| e.to_string())?;
    let result = super::screenshot_overlay_init().await?;
    let output = image::open(&result.path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let original = source_png(
        source
            .data_url
            .as_deref()
            .ok_or("original page unavailable")?,
    )
    .map_err(|e| e.to_string())?;
    let full_expected = source_crop(&source, &original).map_err(|e| e.to_string())?;
    let expected = capture::crop(&full_expected, 0, 0, full_expected.width(), output.height());
    let comparison = qa_oracle::compare(&output, &expected, false);
    let artifact = keep_artifact(std::path::Path::new(&result.path), "scroll-stopped.png");
    let original_artifact = keep_image(&original, "scroll-stop-original.png");
    let difference = keep_image(
        &qa_oracle::difference(&output, &expected),
        "scroll-stop-difference.png",
    );
    super::close_session(&app);
    wait_closed(&app, super::OVERLAY_LABEL, Duration::from_secs(5)).await;

    let (_fixture, display, region) = open_fixture(&app, "scroll")
        .await
        .map_err(|e| e.to_string())?;
    let overlay = begin_scroll_ui(&app, &display, region, true).await?;
    let bar = wait_window(&app, super::surfaces::SCROLL_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    run_js(
        &bar,
        r#"
      for (let i = 0; i < 100; i++) {
        if (document.querySelector('[data-testid="screenshot-scroll-cancel"]')) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('scroll Cancel control missing');
    "#,
        Duration::from_secs(15),
    )
    .await
    .map_err(|e| format!("scroll cancel readiness: {e}"))?;
    bar.eval("document.querySelector('[data-testid=\"screenshot-scroll-cancel\"]').click()")
        .map_err(|e| format!("click scroll Cancel: {e}"))?;
    let cancelled = run_js(&overlay, "for(let i=0;i<100 && document.querySelector('[data-testid=\"screenshot-overlay\"]')?.dataset.phase!=='annotate';i++) await new Promise(r=>setTimeout(r,100)); return document.querySelector('[data-testid=\"screenshot-overlay\"]')?.dataset.phase==='annotate' && document.querySelector('[data-testid=\"screenshot-annotation-canvas\"]')?.dataset.shapes==='1' && !!document.querySelector('[data-testid=\"screenshot-selection\"]');", Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    let cleanup = app.windows().keys().all(|name| {
        !name.starts_with(super::surfaces::BORDER_PREFIX) && name != super::surfaces::SCROLL_LABEL
    });
    Ok(report(
        current_visible
            && selected == json!(true)
            && current_region.is_some()
            && default_hidden
            && completed == json!(true)
            && output.height() > region.3
            && comparison.passed
            && geometry["controlsOutside"] == json!(true)
            && geometry["bordersOutside"] == json!(true)
            && geometry["borderCount"].as_u64().unwrap_or(0) >= 2
            && cancelled == json!(true)
            && cleanup
            && artifact.is_some(),
        json!({"currentWindowVisible":current_visible,"currentWindowSelected":selected,"currentRegion":current_region,
            "defaultHidesWindows":default_hidden,"scrollCompleted":completed,"scrollProgress":progress,"geometry":geometry,"comparison":comparison,
            "scrollCancelledPreservesAnnotations":cancelled,"controlsCleaned":cleanup,"artifact":artifact,
            "originalArtifact":original_artifact,"differenceArtifact":difference,"windowArtifact":window_artifact}),
    ))
}

/// Whole-display recording must remain stoppable with no overlapping controls.
#[tauri::command]
pub async fn screenshot_qa_full_recorder(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::close_session(&app);
    let display = capture::resolve_display(&app, None).map_err(|e| e.to_string())?;
    let started = super::screenshot_start_recording(
        app.clone(),
        Some(display.id.clone()),
        None,
        None,
        None,
        None,
        "gif".into(),
        Some(5),
    )
    .await?;
    let output =
        super::record::output_path(&started.recording_id).ok_or("recording output not tracked")?;
    let bar = wait_window(&app, super::RECORDER_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let geometry = capture_surfaces(
        &app,
        &display,
        (0, 0, display.width, display.height),
        super::RECORDER_LABEL,
        false,
    )
    .await
    .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    // Exercise the same route used by the registered global screenshot chord;
    // the separate hotkey scenario owns OS key-delivery evidence.
    super::open_overlay(&app, None).await?;
    let preview = run_js(&bar, "for(let i=0;i<150;i++){const p=document.querySelector('[data-testid=\"screenshot-recorder-preview\"]'); if(p?.complete && p.naturalWidth>0) return true; const error=document.querySelector('[data-testid=\"screenshot-recorder-error\"]'); if(error) throw new Error(error.textContent); await new Promise(r=>setTimeout(r,100));} return false;", Duration::from_secs(20)).await.map_err(|e| e.to_string())?;
    let clip = super::record::inspect_clip(&output).map_err(|e| e.to_string())?;
    let artifact = keep_artifact(&output, "whole-display-recording.gif");
    let bar_visible_after_stop = bar.is_visible().unwrap_or(false);
    bar.eval("document.querySelector('[data-testid=\"screenshot-recorder-done\"]').click()")
        .map_err(|e| e.to_string())?;
    let closed = wait_closed(&app, super::RECORDER_LABEL, Duration::from_secs(10)).await;
    Ok(report(
        geometry["controlsOutside"] == json!(true)
            && preview == json!(true)
            && bar_visible_after_stop
            && clip.frames >= 1
            && clip.duration_ms >= 800
            && closed
            && main_visible(&app)
            && !output.exists()
            && artifact.is_some(),
        json!({"geometry":geometry,"preview":preview,"clip":clip,"controlsVisibleAfterStop":bar_visible_after_stop,"closed":closed,"artifact":artifact}),
    ))
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
    let geometry = capture_surfaces(&app, &display, region, super::RECORDER_LABEL, true)
        .await
        .map_err(|e| e.to_string())?;
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
        && geometry["controlsOutside"] == json!(true)
        && geometry["bordersOutside"] == json!(true)
        && geometry["borderCount"].as_u64().unwrap_or(0) >= 2
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
        "gifCopied":copied,"previewRetained":preview_retained,"tempRemoved":output_removed,"format":format,"originalComparison":content,"artifact":artifact,"captureGeometry":geometry }),
    ))
}

/// Send real desktop mouse input; physical coordinates are never injected into
/// the DOM. Also used to verify the pin renderer's native startDragging path.
fn move_os_pointer(input: &mut enigo::Enigo, (x, y): (i32, i32)) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let _ = input;
        unsafe { windows::Win32::UI::WindowsAndMessaging::SetCursorPos(x, y) }
            .context("move pointer")?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        use enigo::Mouse;
        input
            .move_mouse(x, y, enigo::Coordinate::Abs)
            .map_err(|e| anyhow::anyhow!("move pointer: {e}"))?;
    }
    Ok(())
}

async fn park_pointer(point: (i32, i32)) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || {
        let mut input = enigo::Enigo::new(&enigo::Settings::default())
            .map_err(|e| anyhow::anyhow!("input synthesis unavailable: {e}"))?;
        move_os_pointer(&mut input, point)
    })
    .await
    .context("park desktop pointer")?
}

async fn mouse_path(points: Vec<(i32, i32)>) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        use enigo::{Button, Direction, Enigo, Mouse, Settings};
        let mut input = Enigo::new(&Settings::default())
            .map_err(|e| anyhow::anyhow!("input synthesis unavailable: {e}"))?;
        let first = *points.first().context("empty mouse path")?;
        move_os_pointer(&mut input, first)?;
        std::thread::sleep(Duration::from_millis(150));
        let result = (|| -> anyhow::Result<()> {
            input
                .button(Button::Left, Direction::Press)
                .map_err(|e| anyhow::anyhow!("mouse down: {e}"))?;
            std::thread::sleep(Duration::from_millis(250));
            for pair in points.windows(2) {
                for step in 1..=16 {
                    let x = pair[0].0 + (pair[1].0 - pair[0].0) * step / 16;
                    let y = pair[0].1 + (pair[1].1 - pair[0].1) * step / 16;
                    move_os_pointer(&mut input, (x, y))?;
                    std::thread::sleep(Duration::from_millis(18));
                }
                // Mousemoves can coalesce under WebView load. Hold each fixed
                // waypoint so the OS gesture includes the prescribed corners.
                std::thread::sleep(Duration::from_millis(120));
            }
            Ok(())
        })();
        let released = input
            .button(Button::Left, Direction::Release)
            .map_err(|e| anyhow::anyhow!("mouse up: {e}"));
        result.and(released)
    })
    .await
    .context("desktop mouse task")?
}

/// Enigo uses Quartz logical points on macOS, physical screen pixels elsewhere.
fn input_point(point: (i32, i32), scale: f64) -> (i32, i32) {
    if cfg!(target_os = "macos") {
        (
            (point.0 as f64 / scale).round() as i32,
            (point.1 as f64 / scale).round() as i32,
        )
    } else {
        point
    }
}

#[cfg(any(target_os = "linux", test))]
fn x11_pin_is_above(state: &Value) -> bool {
    state["success"] == json!(true)
        && state["stdout"].as_str().is_some_and(|output| {
            output.lines().any(|line| {
                line.strip_prefix("_NET_WM_STATE(ATOM) =")
                    .is_some_and(|atoms| {
                        atoms
                            .split(',')
                            .any(|atom| atom.trim() == "_NET_WM_STATE_ABOVE")
                    })
            })
        })
}

async fn verify_pin_drag(window: &WebviewWindow, display: &DisplayInfo) -> anyhow::Result<Value> {
    let scale = window.scale_factor()?.max(0.5);
    // A deterministic visible starting point is setup, not the asserted move.
    window.set_position(tauri::PhysicalPosition::new(
        display.x + (36.0 * scale).round() as i32,
        display.y + (48.0 * scale).round() as i32,
    ))?;
    window.set_focus()?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    let before = window.outer_position()?;
    let inner = window.inner_position()?;
    let size = window.inner_size()?;
    let start = (
        inner.x + size.width as i32 / 2,
        inner.y + size.height as i32 / 2,
    );
    let delta = ((80.0 * scale).round() as i32, (64.0 * scale).round() as i32);
    let end = (start.0 + delta.0, start.1 + delta.1);
    mouse_path(vec![input_point(start, scale), input_point(end, scale)]).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = window.outer_position()?;
    let actual = (after.x - before.x, after.y - before.y);
    let moved = (actual.0 - delta.0).abs() <= 6 && (actual.1 - delta.1).abs() <= 6;
    let cached_topmost = window.is_always_on_top()?;
    #[cfg(target_os = "linux")]
    let native_state = tokio::task::spawn_blocking(|| {
        std::process::Command::new("xprop")
            .args(["-name", "Pinned Screenshot", "_NET_WM_STATE"])
            .output()
            .map(|o| {
                json!({"success":o.status.success(),"stdout":String::from_utf8_lossy(&o.stdout),
                "stderr":String::from_utf8_lossy(&o.stderr)})
            })
            .unwrap_or_else(|e| json!({"error":e.to_string()}))
    })
    .await
    .context("native pin state probe")?;
    #[cfg(not(target_os = "linux"))]
    let native_state = Value::Null;
    // Tao's GTK window-state cache can lose ABOVE after a move even when the
    // actual X11 window retains it (run36990397751). Require the WM's atom,
    // not the builder's requested flag or a fallback to the stale cache.
    #[cfg(target_os = "linux")]
    let topmost = x11_pin_is_above(&native_state);
    #[cfg(not(target_os = "linux"))]
    let topmost = cached_topmost;
    Ok(
        json!({"passed":moved && topmost,"before":[before.x,before.y],"after":[after.x,after.y],
        "expectedDelta":delta,"actualDelta":actual,"alwaysOnTop":topmost,"cachedAlwaysOnTop":cached_topmost,
        "nativeState":native_state,"input":"OS mouse down/move/up"}),
    )
}

/// Real freehand gesture -> public Pin/Copy -> independent original RGBA oracle.
#[tauri::command]
pub async fn screenshot_qa_freehand(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::close_session(&app);
    let (fixture, display, _) = open_fixture(&app, "scroll")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let source = read_source(&fixture).await.map_err(|e| format!("{e:#}"))?;
    let original = source_png(source.data_url.as_deref().ok_or("missing original page")?)
        .map_err(|e| format!("{e:#}"))?;
    let scale = source.scale;
    let offset = (24.0 * scale).round() as u32;
    let width = (320.0 * scale).round() as u32;
    let height = (240.0 * scale).round() as u32;
    let notch_x = (128.0 * scale).round() as u32;
    let notch_y = (96.0 * scale).round() as u32;
    let polygon = vec![
        (0.0, 0.0),
        (width as f64, 0.0),
        (width as f64, notch_y as f64),
        (notch_x as f64, notch_y as f64),
        (notch_x as f64, height as f64),
        (0.0, height as f64),
    ];
    // This geometry is a fixed testcase input, never read from the exported path.
    let cropped_original = capture::crop(&original, offset, offset, width, height);
    let expected = qa_oracle::masked_original(&cropped_original, &polygon);
    let mut results = Vec::new();
    let parked_cursor = (display.x + 16, display.y + 16);
    for action in ["pin", "copy"] {
        fixture.set_focus().map_err(|e| e.to_string())?;
        // The still capture can include the system cursor on macOS. Keep the
        // source scene equal to the original canvas; the preceding pin drag
        // otherwise leaves that cursor inside the second capture's polygon.
        park_pointer(input_point(parked_cursor, scale))
            .await
            .map_err(|e| format!("{e:#}"))?;
        tokio::time::sleep(Duration::from_millis(350)).await;
        let origin = fixture.inner_position().map_err(|e| e.to_string())?;
        super::open_overlay(&app, Some(display.id.clone())).await?;
        let overlay = wait_window(&app, super::OVERLAY_LABEL, Duration::from_secs(10))
            .await
            .map_err(|e| format!("{e:#}"))?;
        let init = super::screenshot_overlay_init().await?;
        run_js(&overlay, r#"
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const q = id => document.querySelector('[data-testid="' + id + '"]');
          for (let i = 0; i < 100 && !(q('screenshot-base-image')?.complete && q('screenshot-hint')); i++) await sleep(100);
          if (!q('screenshot-base-image')?.naturalWidth) throw new Error('background not loaded');
          q('screenshot-selection-freehand').click();
          await sleep(150);
          return q('screenshot-overlay').dataset.selectionMode === 'freehand';
        "#, Duration::from_secs(20)).await.map_err(|e| format!("{e:#}"))?;
        let points = polygon
            .iter()
            .map(|&(x, y)| {
                input_point(
                    (
                        origin.x + offset as i32 + x.round() as i32,
                        origin.y + offset as i32 + y.round() as i32,
                    ),
                    scale,
                )
            })
            .collect();
        mouse_path(points).await.map_err(|e| format!("{e:#}"))?;
        let page = run_js(&overlay, r#"
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const q = id => document.querySelector('[data-testid="' + id + '"]');
          for (let i = 0; i < 50 && !q('screenshot-toolbar'); i++) await sleep(100);
          const path = q('screenshot-freehand-contour')?.getAttribute('d') || '';
          return {closed: path.endsWith(' Z'), contour:path, scrollDisabled:q('screenshot-scroll-capture')?.disabled,
            recordDisabled:q('screenshot-record')?.disabled, mode:q('screenshot-overlay')?.dataset.selectionMode};
        "#, Duration::from_secs(10)).await.map_err(|e| format!("{e:#}"))?;
        overlay
            .eval(format!(
                "document.querySelector('[data-testid=\"screenshot-{action}\"]').click()"
            ))
            .map_err(|e| e.to_string())?;
        let overlay_closed = wait_closed(&app, super::OVERLAY_LABEL, Duration::from_secs(10)).await;
        let (actual, pin) = if action == "pin" {
            let label = super::tool_state()
                .pins
                .keys()
                .next()
                .cloned()
                .ok_or("public Pin did not open")?;
            let path = super::tool_state()
                .pins
                .get(&label)
                .ok_or("missing pin payload")?
                .path
                .clone();
            let window = wait_window(&app, &label, Duration::from_secs(10))
                .await
                .map_err(|e| format!("{e:#}"))?;
            let page = run_js(&window, r#"
              const q = () => document.querySelector('[data-testid="screenshot-pin-image"]');
              for (let i = 0; i < 100 && !(q()?.complete && q()?.naturalWidth); i++) await new Promise(r => setTimeout(r,100));
              return {width:q()?.naturalWidth,height:q()?.naturalHeight};
            "#, Duration::from_secs(20)).await.map_err(|e| format!("{e:#}"))?;
            let actual = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
            let drag = verify_pin_drag(&window, &display)
                .await
                .map_err(|e| format!("{e:#}"))?;
            let survived = std::path::Path::new(&path).exists() && overlay_closed;
            window.eval("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))")
                .map_err(|e| e.to_string())?;
            let closed = wait_closed(&app, &label, Duration::from_secs(10)).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let removed = !std::path::Path::new(&path).exists();
            (
                actual,
                json!({"passed":drag["passed"] == json!(true) && survived && closed && removed
                && page["width"] == json!(width) && page["height"] == json!(height),
                "page":page,"drag":drag,"survivedOverlayClose":survived,"closed":closed,"copyRemoved":removed}),
            )
        } else {
            (
                read_clipboard_image(&app).map_err(|e| format!("{e:#}"))?,
                Value::Null,
            )
        };
        let comparison = qa_oracle::compare_masked(&actual, &expected, &polygon);
        let artifacts = json!({
            "original":keep_image(&original, &format!("freehand-{action}-original-full.png")),
            "sourceCrop":keep_image(&cropped_original, &format!("freehand-{action}-source-crop.png")),
            "expected":keep_image(&expected, &format!("freehand-{action}-expected.png")),
            "actual":keep_image(&actual, &format!("freehand-{action}-actual.png")),
            "difference":keep_image(&qa_oracle::mask_difference(&actual, &expected), &format!("freehand-{action}-difference.png")),
        });
        let passed = comparison.passed
            && overlay_closed
            && main_visible(&app)
            && !std::path::Path::new(&init.path).exists()
            && page["closed"] == json!(true)
            && page["mode"] == json!("freehand")
            && page["scrollDisabled"] == json!(true)
            && page["recordDisabled"] == json!(true)
            && (action != "pin" || pin["passed"] == json!(true))
            && artifacts
                .as_object()
                .is_some_and(|a| a.values().all(Value::is_string));
        results.push(json!({"action":action,"passed":passed,"comparison":comparison,"polygon":polygon,
            "sourceOffset":[offset,offset],"expectedSize":[width,height],"page":page,"pin":pin,
            "overlayClosed":overlay_closed,"sessionSourceRemoved":!std::path::Path::new(&init.path).exists(),
            "artifacts":artifacts}));
    }
    let passed = results.iter().all(|r| r["passed"] == json!(true));
    let details = json!({"passed":passed,"scale":scale,"results":results,
        "boundaryTolerancePixels":2,"initialCursor":parked_cursor,"input":"OS mouse down/move/up"});
    let metrics =
        keep_json(&details, "freehand-rgba-comparison.json").map_err(|e| format!("{e:#}"))?;
    Ok(report(
        passed,
        json!({"comparison":details,"metricsArtifact":metrics}),
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

    #[test]
    fn native_x11_geometry_uses_absolute_coordinates_and_requires_complete_mapping() {
        let output = "  Absolute upper-left X: -400\n  Absolute upper-left Y: 562\n  Relative upper-left X: 0\n  Relative upper-left Y: 0\n  Width: 360\n  Height: 200\n  Map State: IsViewable\n";
        let (rect, visible) = x11_control_geometry(output).unwrap();
        assert_eq!((rect.x, rect.y, rect.w, rect.h), (-400, 562, 360, 200));
        assert!(visible);
        assert!(
            !x11_control_geometry(&output.replace("IsViewable", "IsUnMapped"))
                .unwrap()
                .1
        );
        for incomplete in [
            output.replace("Absolute upper-left X:", "Unknown X:"),
            output.replace("Width: 360", "Width: 0"),
            output.replace("Map State: IsViewable", "Map State: unknown"),
        ] {
            assert!(x11_control_geometry(&incomplete).is_none());
        }
    }

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
    fn native_x11_topmost_requires_the_actual_above_atom_and_a_successful_probe() {
        let above = "_NET_WM_STATE(ATOM) = _NET_WM_STATE_SKIP_TASKBAR, _NET_WM_STATE_SKIP_PAGER, _NET_WM_STATE_ABOVE\n";
        assert!(x11_pin_is_above(&json!({"success":true,"stdout":above})));
        assert!(!x11_pin_is_above(&json!({"success":false,"stdout":above})));
        for output in [
            "_NET_WM_STATE(ATOM) = _NET_WM_STATE_SKIP_TASKBAR\n",
            "_NET_WM_STATE: not found.\n",
            "_NET_WM_STATE(ATOM) = _NET_WM_STATE_ABOVE_FAKE\n",
            "unrelated _NET_WM_STATE_ABOVE\n",
        ] {
            assert!(!x11_pin_is_above(&json!({"success":true,"stdout":output})));
        }
        assert!(!x11_pin_is_above(&json!({"error":"xprop unavailable"})));
    }

    #[test]
    fn evidence_names_cannot_collide_after_app_restarts_between_cases() {
        let first = evidence_path("recording.gif");
        let second = evidence_path("recording.gif");
        assert_ne!(first, second);
        let name = first.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with(platform()));
        let process = &name[platform().len() + 1..platform().len() + 37];
        assert!(uuid::Uuid::parse_str(process).is_ok());
        assert!(name.ends_with("-recording.gif"));
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
