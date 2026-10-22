use super::*;

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
    let original = source_png(source.data_url.as_deref().ok_or("missing source page")?)
        .map_err(|e| e.to_string())?;
    let margin = (6.0 * source.scale).round() as u32;
    let expected = capture::crop(&original, margin, margin, region.2, region.3);
    // Xvfb on older Ubuntu images can publish a stale root pixmap for the
    // first readback while the compositor maps the fixture. Retry the same
    // production capture command briefly so the case checks the settled
    // desktop pixels without weakening the comparison oracle.
    let mut file = super::super::screenshot_capture_region(
        app.clone(),
        Some(display.id.clone()),
        region.0,
        region.1,
        region.2,
        region.3,
    )
    .await?;
    let mut image = image::open(&file.path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let mut comparison = qa_oracle::compare(&image, &expected, false);
    for _ in 0..5 {
        if comparison.passed {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        file = super::super::screenshot_capture_region(
            app.clone(),
            Some(display.id.clone()),
            region.0,
            region.1,
            region.2,
            region.3,
        )
        .await?;
        image = image::open(&file.path)
            .map_err(|e| e.to_string())?
            .to_rgba8();
        comparison = qa_oracle::compare(&image, &expected, false);
    }
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

/// Exercise solid annotation modes and the pixel-level eraser through the
/// public overlay controls. The native browser is the real renderer; the
/// scenario intentionally does not substitute a canvas mock.
#[tauri::command]
pub async fn screenshot_qa_annotation_tools(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::open_overlay(&app, None).await?;
    let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let result = run_js(&overlay, r#"
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const q=id=>document.querySelector('[data-testid="'+id+'"]');
      for(let i=0;i<100&&!q('screenshot-hint');i++) await sleep(80);
      q('screenshot-fullscreen').click(); await sleep(120);
      for(let i=0;i<100&&(!q('screenshot-toolbar')||!q('screenshot-tool-rect'));i++) await sleep(80);
      if(!q('screenshot-toolbar')||!q('screenshot-tool-rect')) throw new Error('annotation toolbar did not load');
      for(let i=0;i<100&&!q('screenshot-annotation-layer');i++) await sleep(80);
      if(!q('screenshot-annotation-layer')) throw new Error('annotation layer did not load');
      const fire=(el,type,x,y,extra={})=>el.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,buttons:type==='mouseup'?0:1,clientX:x,clientY:y,...extra}));
      const layer=q('screenshot-annotation-layer');
      q('screenshot-tool-rect').click();
      for(let i=0;i<100&&!q('screenshot-fill');i++) await sleep(80);
      if(!q('screenshot-fill')) throw new Error('fill control did not load after selecting rectangle');
      q('screenshot-fill').click(); await sleep(80);
      fire(layer,'mousedown',80,80); fire(window,'mousemove',180,160); fire(window,'mouseup',180,160); await sleep(80);
      const filledRect=q('screenshot-fill').getAttribute('aria-pressed')==='true';
      q('screenshot-tool-ellipse').click(); await sleep(80); fire(layer,'mousedown',220,80); fire(window,'mousemove',320,180); fire(window,'mouseup',320,180); await sleep(80);
      q('screenshot-tool-pen').click(); await sleep(80); fire(layer,'mousedown',100,250); fire(window,'mousemove',150,200); fire(window,'mousemove',200,250); fire(window,'mouseup',200,250); await sleep(80);
      const beforeErase=Number(q('screenshot-annotation-canvas').dataset.shapes);
      q('screenshot-tool-eraser').click(); await sleep(80);
      fire(layer,'mousedown',145,200); fire(window,'mousemove',155,205); fire(window,'mouseup',155,205); await sleep(100);
      const afterErase=Number(q('screenshot-annotation-canvas').dataset.shapes);
      return {filledRect,beforeErase,afterErase,eraseMode:q('screenshot-eraser-mode').value,fill:filledRect};
    "#, Duration::from_secs(25)).await.map_err(|e| e.to_string())?;
    overlay
        .eval("document.querySelector('[data-testid=\"screenshot-cancel\"]')?.click()")
        .map_err(|e| e.to_string())?;
    let closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
    Ok(report(
        result["filledRect"] == json!(true)
            && result["beforeErase"] == json!(3)
            && result["afterErase"] == json!(3)
            && result["eraseMode"] == json!("partial")
            && closed,
        json!({"renderer":result,"closed":closed,"platform":platform()}),
    ))
}

/// macOS regression guard: recording must use CoreGraphics one-shot snapshots
/// and never construct the display stream that can destabilize WindowServer.
#[tauri::command]
pub async fn screenshot_qa_macos_capture_source(
    app: AppHandle,
    format: String,
) -> Result<String, String> {
    ensure_qa(&app)?;
    #[cfg(not(all(debug_assertions, target_os = "macos")))]
    {
        let _ = format;
        return Err("macOS capture source scenario requires macOS".into());
    }
    #[cfg(all(debug_assertions, target_os = "macos"))]
    {
        let _cleanup = ScenarioCleanup(app.clone());
        let format =
            super::super::record::RecordFormat::parse(&format).map_err(|e| format!("{e:#}"))?;
        let (window, display, region) = open_fixture(&app, "anim")
            .await
            .map_err(|e| format!("{e:#}"))?;
        let source_before = capture::qa_source_counts();
        let worker = app.clone();
        let id = tokio::task::spawn_blocking(move || {
            super::super::record::start_recording(&worker, display, Some(region), format, Some(10))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))?;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let info = tokio::task::spawn_blocking(move || super::super::record::stop_recording(&id))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("{e:#}"))?;
        let source = read_source(&window).await.map_err(|e| format!("{e:#}"))?;
        close_fixture(&app);
        let source_after = capture::qa_source_counts();
        let stream_opens = source_after.0.saturating_sub(source_before.0);
        let snapshot_reads = source_after.1.saturating_sub(source_before.1);
        let ext = if format == super::super::record::RecordFormat::Gif {
            "gif"
        } else {
            "mp4"
        };
        let artifact = keep_artifact(&info.path, &format!("macos-coregraphics.{ext}"));
        let (clip, content) =
            compare_record_original(&info.path, &source).map_err(|e| format!("{e:#}"))?;
        let ok = stream_opens == 0
            && snapshot_reads >= 2
            && clip.frames >= 2
            && clip.distinct_frames >= 2
            && content["passed"] == json!(true)
            && artifact.is_some();
        Ok(report(
            ok,
            json!({
                "format": ext,
                "streamOpens": stream_opens,
                "snapshotReads": snapshot_reads,
                "clip": clip,
                "originalComparison": content,
                "artifact": artifact,
            }),
        ))
    }
}

/// The full overlay flow as a user does it: open (hides app windows), the
/// captured background loads, drag a region, draw a red rectangle, copy.
/// Verified from outside: the overlay closed, the main window is back, and
/// the OS clipboard holds an image of the selected size with the red stroke.
#[tauri::command]
pub async fn screenshot_qa_overlay_copy(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(&app);
    super::super::open_overlay(&app, None).await?;
    let hidden_main = !main_visible(&app);
    let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10))
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
      q('[data-testid="screenshot-watermark"]').click(); await sleep(150);
      const watermarkPanel = q('[data-testid="screenshot-watermark-panel"]').getBoundingClientRect();
      const watermarkSlider = q('[data-testid="screenshot-watermark-opacity"]').getBoundingClientRect();
      if ([watermarkPanel, watermarkSlider].some((r) => r.left < 8 || r.top < 8 || r.right > innerWidth - 8 || r.bottom > innerHeight - 8))
        throw new Error('watermark panel or slider outside viewport: ' + JSON.stringify({panel:watermarkPanel.toJSON(),slider:watermarkSlider.toJSON()}));
      window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); await sleep(100);
      if (q('[data-testid="screenshot-watermark-panel"]')) throw new Error('Escape did not close watermark panel');
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
        watermarkPanel: watermarkPanel.toJSON(), watermarkSlider: watermarkSlider.toJSON(),
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
            super::super::close_session(&app);
            return Err(format!("{e:#}"));
        }
    };
    overlay
        .eval("document.querySelector('[data-testid=\"screenshot-copy\"]').click()")
        .map_err(|e| e.to_string())?;
    let closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
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
            let green_lines: Vec<usize> = [70.0, 98.8]
                .iter()
                .map(|top| {
                    let y0 = (top * sy).floor() as u32;
                    let y1 = ((top + 24.0) * sy).ceil() as u32;
                    ((y0)..y1.min(image.height()))
                        .flat_map(|y| {
                            ((70.0 * sx) as u32..(150.0 * sx) as u32).map(move |x| (x, y))
                        })
                        .filter(|&(x, y)| {
                            let p = image.get_pixel(x.min(image.width() - 1), y);
                            p[1] > 150 && p[0] < 140 && p[2] < 100
                        })
                        .count()
                })
                .collect();
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
    super::super::close_session(&app);
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

pub(super) fn read_clipboard_image(app: &AppHandle) -> anyhow::Result<RgbaImage> {
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

/// Portal capture owns a synchronous runtime and must run outside Tokio's
/// asynchronous workers, including diagnostic snapshots on failure paths.
pub(super) async fn read_desktop(
    app: &AppHandle,
    display: &DisplayInfo,
) -> anyhow::Result<RgbaImage> {
    let app = app.clone();
    let display = display.clone();
    tokio::task::spawn_blocking(move || capture::capture_display(&app, &display))
        .await
        .context("desktop observation worker")?
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn x11_control_geometry(output: &str) -> Option<(super::super::surfaces::Rect, bool)> {
    let field = |name: &str| {
        output
            .lines()
            .find_map(|line| line.trim().strip_prefix(name).map(str::trim))
    };
    let rect = super::super::surfaces::Rect {
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

pub(super) async fn capture_surfaces(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
    label: &str,
    require_visible: bool,
) -> anyhow::Result<Value> {
    let crop = super::super::surfaces::region_rect(display, region);
    let bar = app
        .get_webview_window(label)
        .context("capture controls missing")?;
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let (control, bar_visible, cached_control, native_probe) = loop {
        let pos = bar.outer_position()?;
        let size = bar.outer_size()?;
        let cached = super::super::surfaces::Rect {
            x: pos.x,
            y: pos.y,
            w: size.width as i32,
            h: size.height as i32,
        };
        let visible = bar.is_visible()?;
        #[cfg(target_os = "linux")]
        let (control, visible, native_probe, ready) = if visible {
            if wayland::active() {
                let (rect, mapped, probe) = wayland::control_geometry(&bar).await?;
                (rect, mapped, probe, true)
            } else {
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
        if !name.starts_with(super::super::surfaces::BORDER_PREFIX) {
            continue;
        }
        let pos = window.outer_position()?;
        let size = window.outer_size()?;
        #[allow(unused_mut)]
        let mut rect = super::super::surfaces::Rect {
            x: pos.x,
            y: pos.y,
            w: size.width as i32,
            h: size.height as i32,
        };
        #[allow(unused_mut)]
        let mut visible = window.is_visible()?;
        #[cfg(target_os = "linux")]
        if wayland::active() {
            let native = wayland::command(json!({"command":"geometry",
                "application":std::env::current_exe()?, "title":window.title()?}))
            .await?;
            let (pos, size) = wayland::rect(
                &native["client"],
                wayland::output_scale(app, &native["client"])?,
            )?;
            rect = super::super::surfaces::Rect {
                x: pos.x,
                y: pos.y,
                w: size.width as i32,
                h: size.height as i32,
            };
            visible = native["visible"] == true;
        }
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

/// Verify the real still-capture commands and screenshot entry points reject a
/// denied permission before hiding any app windows or writing a partial image.
#[tauri::command]
pub async fn screenshot_qa_capture_permission_error(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    #[cfg(not(all(debug_assertions, target_os = "macos")))]
    {
        Err("macOS permission scenario requires macOS".into())
    }
    #[cfg(all(debug_assertions, target_os = "macos"))]
    {
        let _cleanup = ScenarioCleanup(app.clone());
        super::super::close_session(&app);
        let main = app
            .get_webview_window("main")
            .ok_or("main window missing")?;
        let display = capture::resolve_display(&app, None).map_err(|e| e.to_string())?;
        let actual_permission = capture::capture_permission_granted();
        let _denial = capture::QaPermissionDenial::new(&app).map_err(|e| e.to_string())?;
        let hide_calls_before = super::super::QA_WINDOW_HIDE_CALLS.load(Ordering::SeqCst);
        let artifact_dir = capture::artifact_dir().map_err(|e| e.to_string())?;
        let artifacts_before: Vec<_> = std::fs::read_dir(&artifact_dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .collect();
        let full_error =
            super::super::screenshot_capture_full(app.clone(), Some(display.id.clone()))
                .await
                .err();
        let region_error = super::super::screenshot_capture_region(
            app.clone(),
            Some(display.id.clone()),
            0,
            0,
            10,
            10,
        )
        .await
        .err();
        let mut attempts = Vec::new();
        for entry in ["button", "current-window", "global-shortcut"] {
            let trigger_error = if entry == "global-shortcut" {
                super::super::shortcut::open_from_shortcut(&app).await.err()
            } else {
                let script = if entry == "button" {
                    "document.querySelector('[data-testid=\"system-screenshot\"]').click(); return true;"
                } else {
                    "document.querySelector('[data-testid=\"system-screenshot-delay-toggle\"]').click(); await new Promise(r=>setTimeout(r,100)); document.querySelector('[data-testid=\"system-screenshot-current-window\"]').click(); return true;"
                };
                run_js(&main, script, Duration::from_secs(5))
                    .await
                    .map_err(|e| e.to_string())?;
                None
            };
            let ui = run_js(&main, r#"
                const q = id => document.querySelector('[data-testid="'+id+'"]');
                for(let i=0;i<100 && !q('alert-dialog-message');i++) await new Promise(r=>setTimeout(r,50));
                const text = q('alert-dialog-message')?.textContent || '';
                const visible = !!q('alert-dialog') && q('alert-dialog').getBoundingClientRect().width > 0;
                return {text, visible, remediation:/Screen Recording/.test(text) && /System Settings/.test(text) && /re-add/.test(text) && /reopen/.test(text)};
            "#, Duration::from_secs(10)).await.map_err(|e| e.to_string())?;
            let no_overlay = app
                .get_webview_window(super::super::OVERLAY_LABEL)
                .is_none()
                && super::super::tool_state().overlay.is_none();
            let hide_calls =
                super::super::QA_WINDOW_HIDE_CALLS.load(Ordering::SeqCst) - hide_calls_before;
            let main_visible = main.is_visible().unwrap_or(false);
            let no_new_artifacts = std::fs::read_dir(&artifact_dir)
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .all(|e| artifacts_before.contains(&e.path()));
            let passed = ui["visible"] == json!(true)
                && ui["remediation"] == json!(true)
                && no_overlay
                && hide_calls == 0
                && main_visible
                && no_new_artifacts
                && (entry != "global-shortcut" || trigger_error.is_some());
            let recovered = run_js(&main, r#"
                document.querySelector('[data-testid="alert-dialog-ok"]').click();
                for(let i=0;i<100 && (document.querySelector('[data-testid="alert-dialog"]') || document.querySelector('[data-testid="system-screenshot"]').disabled);i++) await new Promise(r=>setTimeout(r,50));
                return !document.querySelector('[data-testid="alert-dialog"]') && !document.querySelector('[data-testid="system-screenshot"]').disabled;
            "#, Duration::from_secs(10)).await.map_err(|e| e.to_string())?;
            attempts.push(
                json!({"entry":entry,"passed":passed && recovered == json!(true),
                "ui":ui,"noOverlay":no_overlay,"windowHideCalls":hide_calls,
                "mainVisible":main_visible,"noNewArtifacts":no_new_artifacts,
                "triggerError":trigger_error,"recovered":recovered}),
            );
        }
        let command_errors = [&full_error, &region_error].iter().all(|error| {
            error
                .as_ref()
                .is_some_and(|error| error.contains("Screen Recording"))
        });
        Ok(report(
            command_errors && attempts.iter().all(|a| a["passed"] == json!(true)),
            json!({"actualPermissionBeforeDenial":actual_permission,"fullError":full_error,
                "regionError":region_error,"attempts":attempts,"denialOnly":true}),
        ))
    }
}
