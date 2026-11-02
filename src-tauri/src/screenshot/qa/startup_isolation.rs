use super::*;
use crate::screenshot::capture_exclusion;
use crate::screenshot::startup_timing;

// ---------------------------------------------------------------------------
// Startup isolation (I1 / P1-6 / P1-3 / P1-2 evidence, TC-SHOT-N28)
// ---------------------------------------------------------------------------
//
// The main window paints a full-window magenta marker. A direct capture with
// the window visible must contain the marker (otherwise the absence checks
// below would prove nothing). Where the OS supports capture exclusion, the
// production exclusion must remove the marker from a direct capture and its
// release must bring it back. Then several production opens (whatever
// isolation path the platform uses: exclusion, overlapped hide, serial hide)
// must store base images without a single marker pixel, and closing each
// session must restore the main window.

const OPENS: usize = 5;
/// Sampled marker pixels a visible main window must produce at least.
const VISIBLE_MIN: usize = 400;

const INSTALL_MARKER: &str = r#"
  let m = document.getElementById('qa-isolation-marker');
  if (!m) { m = document.createElement('div'); m.id = 'qa-isolation-marker'; document.body.appendChild(m); }
  m.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#ff00ff;pointer-events:none';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 250));
  return true;
"#;
const REMOVE_MARKER: &str =
    "document.getElementById('qa-isolation-marker')?.remove(); return true;";

struct MarkerOwner(WebviewWindow);
impl Drop for MarkerOwner {
    fn drop(&mut self) {
        // eval executes a script, not run_js's async function body. A
        // top-level `return true` is a WebKit SyntaxError on RAII cleanup.
        let _ = self
            .0
            .eval("document.getElementById('qa-isolation-marker')?.remove();");
    }
}

/// All pixels close to the magenta marker (not just a sparse grid).
pub(super) fn marker_pixels(image: &RgbaImage) -> usize {
    let (w, h) = image.dimensions();
    let mut count = 0;
    for y in 0..h {
        for x in 0..w {
            let [r, g, b, _] = image.get_pixel(x, y).0;
            // #ff00ff with a small tolerance, not arbitrary desktop purple
            // (the hosted Windows Firefox icon contains purple pixels).
            if r >= 240 && b >= 240 && g <= 15 {
                count += 1;
            }
        }
    }
    count
}

async fn capture_direct(app: &AppHandle, display: &DisplayInfo) -> Result<RgbaImage, String> {
    let app = app.clone();
    let display = display.clone();
    tokio::task::spawn_blocking(move || capture::capture_display(&app, &display))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

async fn raise_main(main: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    tokio::time::sleep(Duration::from_millis(400)).await;
}

/// Direct check of the production exclusion API, where supported.
async fn exclusion_check(app: &AppHandle, display: &DisplayInfo) -> Result<Value, String> {
    let Some(api) = capture_exclusion::supported() else {
        return Ok(json!({"supported": false}));
    };
    let exclusion = capture_exclusion::exclude_app_windows(app).await?;
    let labels = exclusion.labels();
    let excluded = capture_direct(app, display).await?;
    exclusion.release();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let released = capture_direct(app, display).await?;
    let excluded_pixels = marker_pixels(&excluded);
    let released_pixels = marker_pixels(&released);
    let artifact = keep_image(&excluded, "startup-isolation-excluded.png");
    Ok(json!({
        "supported": true,
        "api": api,
        "windows": labels,
        "excludedMarkerPixels": excluded_pixels,
        "releasedMarkerPixels": released_pixels,
        "passed": labels.iter().any(|l| l == "main") && excluded_pixels == 0 && released_pixels >= VISIBLE_MIN,
        "artifact": artifact,
    }))
}

async fn production_open(
    app: &AppHandle,
    main: &WebviewWindow,
    index: usize,
) -> Result<Value, String> {
    raise_main(main).await;
    super::super::screenshot_open_overlay(app.clone(), main.clone(), None, None).await?;
    let overlay = wait_window(app, super::super::OVERLAY_LABEL, Duration::from_secs(15))
        .await
        .map_err(|e| format!("{e:#}"))?;
    run_js(
        &overlay,
        "for (let i = 0; i < 150; i++) { if (document.querySelector('[data-testid=\"screenshot-overlay\"]')?.dataset.phase === 'select') return true; await new Promise(r => setTimeout(r, 100)); } throw new Error('overlay never reached select');",
        Duration::from_secs(20),
    )
    .await
    .map_err(|e| e.to_string())?;
    let path = super::super::tool_state()
        .overlay
        .as_ref()
        .map(|o| o.path.clone())
        .ok_or("overlay payload missing")?;
    let base = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
    let pixels = marker_pixels(&base);
    let notes = startup_timing::snapshot().notes;
    let hidden_main = super::super::tool_state()
        .hidden
        .iter()
        .any(|l| l == "main")
        && !main_visible(app);
    let artifact = (pixels > 0 || index == 0)
        .then(|| keep_image(&base, &format!("startup-isolation-open-{index}.png")))
        .flatten();
    super::super::close_session(app);
    let closed = wait_closed(app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let restored = main_visible(app);
    Ok(json!({
        "index": index,
        "markerPixels": pixels,
        "isolation": notes.get("isolation"),
        "exclusionFallback": notes.get("exclusionFallback"),
        "mainHiddenDuringSession": hidden_main,
        "closed": closed,
        "mainRestored": restored,
        "passed": pixels == 0 && hidden_main && closed && restored,
        "artifact": artifact,
    }))
}

/// Pixel evidence that no startup path captures Taomni's own windows.
#[tauri::command]
pub async fn screenshot_qa_startup_isolation(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _profile = crate::screenshot::startup_profile::QaProfile::install(
        crate::screenshot::startup_profile::StartupProfile::DEFAULT,
    );
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(&app);
    wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await;
    let main = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    raise_main(&main).await;
    let _marker = MarkerOwner(main.clone());
    run_js(&main, INSTALL_MARKER, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let outcome = async {
        let display = {
            let worker = app.clone();
            tokio::task::spawn_blocking(move || capture::display_at_cursor(&worker))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("{e:#}"))?
        };
        let control = capture_direct(&app, &display).await?;
        let control_pixels = marker_pixels(&control);
        let control_artifact = keep_image(&control, "startup-isolation-control.png");
        let exclusion = exclusion_check(&app, &display).await?;
        let mut opens = Vec::new();
        for index in 0..OPENS {
            opens.push(production_open(&app, &main, index).await?);
        }
        Ok::<_, String>(json!({
            "display": display,
            "controlMarkerPixels": control_pixels,
            "controlArtifact": control_artifact,
            "exclusion": exclusion,
            "opens": opens,
        }))
    }
    .await;
    let _ = run_js(&main, REMOVE_MARKER, Duration::from_secs(5)).await;
    let details = outcome?;
    let control_ok = details["controlMarkerPixels"].as_u64().unwrap_or(0) >= VISIBLE_MIN as u64;
    let exclusion_ok = details["exclusion"]["supported"] == json!(false)
        || details["exclusion"]["passed"] == json!(true);
    let opens_ok = details["opens"].as_array().is_some_and(|opens| {
        opens.len() == OPENS && opens.iter().all(|o| o["passed"] == json!(true))
    });
    Ok(report(
        control_ok && exclusion_ok && opens_ok && main_visible(&app),
        json!({"scenario": "startup-isolation", "platform": platform(), "details": details,
            "controlVisible": control_ok, "exclusionVerified": exclusion_ok, "opensIsolated": opens_ok}),
    ))
}
