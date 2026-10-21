use super::*;

/// Real scroll capture over a known page: wheel input, complete original
/// pixel comparison and row decoding reject duplicated, skipped or squashed
/// content.
#[tauri::command]
pub async fn screenshot_qa_scroll(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let mut trace = ScenarioTrace::new("scroll-auto-phases.json");
    let (window, display, region) = open_fixture(&app, "scroll")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let source = read_source(&window).await.map_err(|e| format!("{e:#}"))?;
    park_pointer(input_point((display.x + 16, display.y + 16), source.scale))
        .await
        .map_err(|e| e.to_string())?;
    let control = std::sync::Arc::new(super::super::scroll::ScrollControl::new(
        super::super::scroll::ScrollMode::Auto,
    ));
    let worker_control = control.clone();
    let worker_display = display.clone();
    let worker = app.clone();
    let task = tokio::task::spawn_blocking(move || {
        super::super::scroll::scroll_capture_controlled(
            &worker,
            &worker_display,
            region,
            40,
            &worker_control,
        )
    });
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut interrupted = false;
    while !task.is_finished() {
        trace.mark("capture", control.status());
        if control.mode() == super::super::scroll::ScrollMode::Manual || Instant::now() >= deadline
        {
            interrupted = true;
            trace.mark("automatic-interrupted", control.status());
            if let Ok(last) = read_desktop(&app, &display).await {
                keep_image(&last, "scroll-auto-interrupted-desktop.png");
            }
            control.request_stop(false);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let result = task.await.map_err(|e| e.to_string())?;
    trace.mark(
        "finished",
        json!({"status":control.status(),"interrupted":interrupted}),
    );
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
    let ok = !interrupted
        && result.frames >= 3
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
            "interrupted": interrupted,
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
    let format =
        super::super::record::RecordFormat::parse(&format).map_err(|e| format!("{e:#}"))?;
    let secs = secs.clamp(1, 8);
    let fps = 10;
    let (window, display, region) = open_fixture(&app, "anim")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let worker = app.clone();
    let id = tokio::task::spawn_blocking(move || {
        super::super::record::start_recording(&worker, display, Some(region), format, Some(fps))
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
    let info = tokio::task::spawn_blocking(move || super::super::record::stop_recording(&id))
        .await
        .map_err(|e| e.to_string())?;
    let source = read_source(&window).await.map_err(|e| format!("{e:#}"))?;
    close_fixture(&app);
    let info = info.map_err(|e| format!("{e:#}"))?;
    let ext = if format == super::super::record::RecordFormat::Gif {
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

pub(super) async fn begin_scroll_ui(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
    annotate: bool,
    start: bool,
) -> Result<WebviewWindow, String> {
    super::super::open_overlay(app, Some(display.id.clone())).await?;
    let overlay = wait_window(app, super::super::OVERLAY_LABEL, Duration::from_secs(10))
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
      if ({start}) {{ q('screenshot-scroll-mode-auto').click(); await sleep(100); q('screenshot-scroll-start').click(); }}
      return true;
    "#,
        x = region.0,
        y = region.1,
        w = region.2,
        h = region.3,
        annotate = annotate,
        start = start
    );
    run_js(&overlay, &script, Duration::from_secs(20))
        .await
        .map_err(|e| e.to_string())?;
    Ok(overlay)
}

/// macOS permission regression: a denied Accessibility check must leave the
/// selected image and annotations visible while presenting a persistent,
/// closeable error instead of hiding the overlay or retrying in a loop.
#[tauri::command]
pub async fn screenshot_qa_scroll_permission_error(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    #[cfg(not(all(debug_assertions, target_os = "macos")))]
    {
        return Err("macOS permission scenario requires macOS".into());
    }
    #[cfg(all(debug_assertions, target_os = "macos"))]
    {
        let _cleanup = ScenarioCleanup(app.clone());
        let mut attempts = Vec::new();
        for escape in [false, true] {
            super::super::close_session(&app);
            let (_fixture, display, region) = open_fixture(&app, "scroll")
                .await
                .map_err(|e| format!("{e:#}"))?;
            let _denial = super::super::scroll::QaPermissionDenial::new(&app)
                .map_err(|e| format!("{e:#}"))?;
            let overlay = begin_scroll_ui(&app, &display, region, true, false).await?;
            let result = run_js(
            &overlay,
            r#"
              const q = (id) => document.querySelector('[data-testid="' + id + '"]');
              const before = q('screenshot-selection').getBoundingClientRect().toJSON();
              q('screenshot-scroll-mode-auto').click();
              await new Promise(r => setTimeout(r, 100));
              if (!q('screenshot-scroll-mode-auto').checked) throw new Error('automatic scroll mode was not selected');
              for (let i = 0; i < 50 && q('screenshot-scroll-start').disabled; i++) await new Promise(r => setTimeout(r, 100));
              if (q('screenshot-scroll-start').disabled) throw new Error('scroll region planning did not finish');
              q('screenshot-scroll-start').click();
              for (let i = 0; i < 100 && !q('screenshot-scroll-error'); i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 3500));
              const error = q('screenshot-scroll-error');
              if (!error) throw new Error('scroll permission error did not remain visible');
              const text = error.textContent || '';
              const annotation = q('screenshot-annotation-canvas');
              const selection = q('screenshot-selection');
              const after = selection?.getBoundingClientRect().toJSON();
              const preserved = !!after && ['x','y','width','height'].every(k => after[k] === before[k]) && annotation?.dataset.shapes === '1';
              return { text, accessibility: /Accessibility|Privacy & Security/.test(text), preserved, before, after };
            "#,
            Duration::from_secs(20),
        )
        .await
        .map_err(|e| format!("{e:#}"))?;
            let overlay_visible = overlay.is_visible().unwrap_or(false);
            let no_controls = app
                .get_webview_window(super::super::surfaces::SCROLL_LABEL)
                .is_none()
                && super::super::screenshot_scroll_status().await?.is_none();
            let worker = app.clone();
            let captured =
                tokio::task::spawn_blocking(move || capture::capture_display(&worker, &display))
                    .await
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?;
            let artifact = keep_image(&captured, "macos-scroll-permission-error.png");
            if escape {
                overlay.eval("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))")
                .map_err(|e| e.to_string())?;
            } else {
                overlay.eval("document.querySelector('[data-testid=\"screenshot-scroll-error-close\"]').click()")
            .map_err(|e| e.to_string())?;
            }
            let closed =
                wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
            let accessibility = result["accessibility"] == json!(true);
            let preserved = result["preserved"] == json!(true);
            let ok = accessibility
                && preserved
                && overlay_visible
                && no_controls
                && closed
                && artifact.is_some();
            attempts.push(
                json!({ "passed": ok, "escape": escape, "error": result, "closed": closed,
            "overlayVisible": overlay_visible, "noControls": no_controls, "artifact": artifact }),
            );
        }
        Ok(report(
            attempts.iter().all(|a| a["passed"] == json!(true)),
            json!({"attempts": attempts}),
        ))
    }
}
