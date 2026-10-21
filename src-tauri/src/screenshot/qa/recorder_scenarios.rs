use super::*;

/// Real entry/window lifecycle plus stop/cancel of the production scroll UI.
#[tauri::command]
pub async fn screenshot_qa_controls(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(&app);
    let main = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    run_js(&main, "document.querySelector('[data-testid=\"system-screenshot-delay-toggle\"]').click(); await new Promise(r => setTimeout(r,100)); document.querySelector('[data-testid=\"system-screenshot-current-window\"]').click(); return true;", Duration::from_secs(5)).await.map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    let current_window_unsupported = wayland::active();
    #[cfg(not(target_os = "linux"))]
    let current_window_unsupported = false;
    let (selected, current_region, window_artifact) = if current_window_unsupported {
        let rejected = run_js(&main, r#"
            const q=id=>document.querySelector('[data-testid="'+id+'"]');
            for(let i=0;i<100&&!q('alert-dialog-message');i++) await new Promise(r=>setTimeout(r,50));
            const message=q('alert-dialog-message')?.textContent || '';
            if(!message.includes('Wayland does not expose') || !message.includes('Screen region'))
                throw new Error('current-window failure did not explain the supported alternative: '+message);
            q('alert-dialog-ok').click(); return true;
        "#, Duration::from_secs(10)).await.map_err(|e| e.to_string())?;
        (
            rejected == true
                && app
                    .get_webview_window(super::super::OVERLAY_LABEL)
                    .is_none(),
            None,
            None,
        )
    } else {
        let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10))
            .await
            .map_err(|e| e.to_string())?;
        let selected = run_js(&overlay, "for (let i=0;i<100 && document.querySelector('[data-testid=\"screenshot-overlay\"]')?.dataset.phase !== 'select';i++) await new Promise(r=>setTimeout(r,100)); return document.querySelector('[data-testid=\"screenshot-overlay\"]')?.dataset.phase === 'select' && !document.querySelector('[data-testid=\"screenshot-selection\"]');", Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
        let current_region = super::super::screenshot_overlay_init().await?.window_region;
        let window_artifact = keep_artifact(
            std::path::Path::new(&super::super::screenshot_overlay_init().await?.path),
            "current-window.png",
        );
        (selected == true, current_region, window_artifact)
    };
    let current_visible = main_visible(&app);
    super::super::close_session(&app);
    wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await;
    super::super::open_overlay(&app, None).await?;
    let default_hidden = !main_visible(&app)
        && super::super::screenshot_overlay_init()
            .await?
            .window_region
            .is_none();
    super::super::close_session(&app);
    wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await;

    let (fixture, display, region) = open_fixture(&app, "scroll")
        .await
        .map_err(|e| e.to_string())?;
    let source = read_source(&fixture).await.map_err(|e| e.to_string())?;
    park_pointer(input_point((display.x + 16, display.y + 16), source.scale))
        .await
        .map_err(|e| e.to_string())?;
    let overlay = begin_scroll_ui(&app, &display, region, false, true).await?;
    // MouseEvent coordinates are integer CSS pixels. At fractional desktop
    // scale the renderer can select a neighbouring physical pixel; compare
    // borders and original pixels against that actual user selection.
    let requested_region = region;
    let selected_region = run_js(&overlay, r#"
      const rect=document.querySelector('[data-testid="screenshot-selection"]').getBoundingClientRect();
      const image=document.querySelector('[data-testid="screenshot-base-image"]');
      return [Math.round(rect.x*image.naturalWidth/innerWidth),Math.round(rect.y*image.naturalHeight/innerHeight),
        Math.round(rect.width*image.naturalWidth/innerWidth),Math.round(rect.height*image.naturalHeight/innerHeight)];
    "#, Duration::from_secs(5)).await.map_err(|e| e.to_string())?;
    let coordinates: Vec<u32> =
        serde_json::from_value(selected_region).map_err(|e| e.to_string())?;
    let [x, y, width, height] = coordinates.as_slice() else {
        return Err("manual selection coordinates unavailable".into());
    };
    let region = (*x, *y, *width, *height);
    let tolerance = display.scale_factor.ceil() as u32;
    for (actual, requested) in [region.0, region.1, region.2, region.3].into_iter().zip([
        requested_region.0,
        requested_region.1,
        requested_region.2,
        requested_region.3,
    ]) {
        if actual.abs_diff(requested) > tolerance {
            return Err("manual selection differs beyond CSS pixel rounding".into());
        }
    }
    let (fixture_origin, _) = observed_inner_rect(&fixture)
        .await
        .map_err(|e| e.to_string())?;
    let bar = wait_window(
        &app,
        super::super::surfaces::SCROLL_LABEL,
        Duration::from_secs(10),
    )
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
    // A frame count alone does not establish a scrollable 100% preview:
    // native wheel displacement differs across the three platforms.
    let preview_height = run_js(&overlay, "return innerHeight;", Duration::from_secs(5))
        .await
        .map_err(|e| e.to_string())?
        .as_f64()
        .ok_or("preview height missing")?;
    let progress = run_js(
        &fixture,
        &format!(r#"
      const page = document.querySelector('[data-testid="screenshot-qa-fixture-ready"]');
      for (let i = 0; i < 150; i++) {{
        const status = await window.__TAURI_INTERNALS__.invoke('screenshot_scroll_status');
        if (status?.frames >= 4 && page.scrollTop * {scale} + {region_height} > {preview_height} + 160) {{
          await new Promise(r => setTimeout(r, 700));
          return {{...status, sourceTop:page.scrollTop, sourceEnd:page.scrollHeight-page.clientHeight}};
        }}
        await new Promise(r => setTimeout(r, 100));
      }}
      throw new Error('scroll did not capture enough original content for a long preview');
    "#, scale=source.scale, region_height=region.3),
        Duration::from_secs(20),
    )
    .await
    .map_err(|e| format!("scroll progress: {e}"))?;
    let geometry = capture_surfaces(
        &app,
        &display,
        region,
        super::super::surfaces::SCROLL_LABEL,
        true,
    )
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
      if (q('screenshot-overlay')?.dataset.phase !== 'preview') throw new Error('scroll result preview missing: '+JSON.stringify({phase:q('screenshot-overlay')?.dataset.phase,error:q('screenshot-scroll-error')?.textContent}));
      const image = q('screenshot-scroll-result-image');
      for(let i=0;i<50 && !image?.complete;i++) await sleep(100);
      const r = image.getBoundingClientRect();
      const container = q('screenshot-scroll-result-viewport').getBoundingClientRect();
      if (Math.abs(r.width / r.height - image.naturalWidth / image.naturalHeight) > 0.005
        || r.width > image.naturalWidth + 1 || r.height > container.height || r.left < 0 || r.right > innerWidth)
        throw new Error('scroll preview stretched or clipped');
      if (q('screenshot-hint') || !q('screenshot-toolbar')) throw new Error('direct annotation toolbar unavailable');
      q('screenshot-scroll-actual').click(); await sleep(100);
      const actual = image.getBoundingClientRect();
      if (Math.abs(actual.width-image.naturalWidth)>1 || Math.abs(actual.height-image.naturalHeight)>1)
        throw new Error('original size is not 100%');
      q('screenshot-scroll-fit').click(); await sleep(100);
      const fire = (el,type,x,y) => el.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y}));
      const draw = async (x,y,w,h) => {
        const layer = q('screenshot-annotation-layer'), r = layer.getBoundingClientRect();
        const sx = r.width/image.naturalWidth, sy = r.height/image.naturalHeight;
        fire(layer,'mousedown',r.left+x*sx,r.top+y*sy); await sleep(50);
        fire(layer,'mousemove',r.left+(x+w)*sx,r.top+(y+h)*sy); await sleep(50);
        fire(window,'mouseup',r.left+(x+w)*sx,r.top+(y+h)*sy); await sleep(100);
      };
      q('screenshot-tool-rect').click(); await sleep(100);
      q('screenshot-color-red').click(); await sleep(50);
      await draw(40,80,100,70);
      if(q('screenshot-annotation-canvas').dataset.shapes!=='1') throw new Error('fit annotation missing');
      q('screenshot-scroll-actual').click(); await sleep(100);
      q('screenshot-undo').click(); await sleep(100);
      if(q('screenshot-annotation-canvas').dataset.shapes!=='0') throw new Error('undo lost after zoom');
      q('screenshot-redo').click(); await sleep(100);
      const viewport = q('screenshot-scroll-result-viewport');
      for (let i = 0; i < 20; i++) {
        viewport.scrollTop = viewport.scrollHeight;
        viewport.scrollTo(0, viewport.scrollHeight);
        if (viewport.scrollTop > 0) break;
        await sleep(100);
      }
      if(viewport.scrollTop<=0) throw new Error(`long preview did not scroll (image=${image.naturalWidth}x${image.naturalHeight}, viewport=${viewport.clientWidth}x${viewport.clientHeight}, scrollHeight=${viewport.scrollHeight})`);
      q('screenshot-color-green').click(); await sleep(50);
      await draw(40,image.naturalHeight-100,100,60);
      q('screenshot-scroll-fit').click(); await sleep(100);
      if(q('screenshot-annotation-canvas').dataset.shapes!=='2') throw new Error('scrolled annotation missing');
      if(viewport.scrollTop!==0) throw new Error('fit did not reset preview scroll');
      return true;
    "#, Duration::from_secs(25)).await.map_err(|e| e.to_string())?;
    let result = super::super::screenshot_overlay_init().await?;
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
    let source_x = region.0 as i64 + display.x as i64 - fixture_origin.x as i64;
    let source_y = region.1 as i64 + display.y as i64 - fixture_origin.y as i64;
    if source_x < 0
        || source_y < 0
        || source_x + region.2 as i64 > original.width() as i64
        || source_y + output.height() as i64 > original.height() as i64
    {
        return Err("manual crop lies outside the original fixture pixels".into());
    }
    let expected = capture::crop(
        &original,
        source_x as u32,
        source_y as u32,
        region.2,
        output.height(),
    );
    let comparison = qa_oracle::compare(&output, &expected, false);
    let artifact = keep_artifact(std::path::Path::new(&result.path), "scroll-stopped.png");
    let original_artifact = keep_image(&original, "scroll-stop-original.png");
    let difference = keep_image(
        &qa_oracle::difference(&output, &expected),
        "scroll-stop-difference.png",
    );
    overlay
        .eval("document.querySelector('[data-testid=\"screenshot-scroll-result-copy\"]').click()")
        .map_err(|e| e.to_string())?;
    let done_closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
    let clipboard = read_clipboard_image(&app).map_err(|e| e.to_string())?;
    let annotated_artifact = keep_image(&clipboard, "scroll-annotated-clipboard.png");
    let mut red = 0;
    let mut green = 0;
    if clipboard.dimensions() == output.dimensions() {
        for x in 45..135 {
            // MouseEvent coordinates are integer CSS pixels in WebKit.
            // At fit scale one pixel can span multiple original pixels;
            // inspect the intended stroke band rather than its antialiased
            // outermost row. Content outside these locations cannot pass.
            red += usize::from((76..=84).any(|y| {
                let a = clipboard.get_pixel(x, y);
                a[0] > 220 && a[1] < 120 && a[2] < 120
            }));
            green += usize::from((output.height() - 104..=output.height() - 96).any(|y| {
                let b = clipboard.get_pixel(x, y);
                b[0] < 120 && b[1] > 160 && b[2] < 100
            }));
        }
    }
    let marked_clipboard = done_closed
        && clipboard.dimensions() == output.dimensions()
        && red >= 85
        && green >= 85
        && annotated_artifact.is_some();

    let (_fixture, display, region) = open_fixture(&app, "scroll")
        .await
        .map_err(|e| e.to_string())?;
    let overlay = begin_scroll_ui(&app, &display, region, true, true).await?;
    let bar = wait_window(
        &app,
        super::super::surfaces::SCROLL_LABEL,
        Duration::from_secs(10),
    )
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
        !name.starts_with(super::super::surfaces::BORDER_PREFIX)
            && name != super::super::surfaces::SCROLL_LABEL
    });
    Ok(report(
        current_visible
            && selected
            && (current_window_unsupported || current_region.is_some())
            && default_hidden
            && completed == json!(true)
            && marked_clipboard
            && output.height() > region.3
            && comparison.passed
            && geometry["controlsOutside"] == json!(true)
            && geometry["bordersOutside"] == json!(true)
            && geometry["borderCount"].as_u64().unwrap_or(0) >= 2
            && cancelled == json!(true)
            && cleanup
            && artifact.is_some(),
        json!({"currentWindowVisible":current_visible,"currentWindowReadyToSelect":selected,"currentWindowUnsupported":current_window_unsupported,"currentRegion":current_region,
            "defaultHidesWindows":default_hidden,"requestedRegion":requested_region,"selectedRegion":region,"scrollCompleted":completed,"scrollProgress":progress,"geometry":geometry,"comparison":comparison,
            "markedClipboard":marked_clipboard,"redLinePixels":red,"greenLinePixels":green,"annotatedArtifact":annotated_artifact,
            "scrollCancelledPreservesAnnotations":cancelled,"controlsCleaned":cleanup,"artifact":artifact,
            "originalArtifact":original_artifact,"differenceArtifact":difference,"windowArtifact":window_artifact}),
    ))
}

/// Whole-display recording must remain stoppable with no overlapping controls.
#[tauri::command]
pub async fn screenshot_qa_full_recorder(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    // A production instance may own the default chord. Use a separate test
    // binding in the isolated QA profile and restore its settings afterwards.
    let settings_path = crate::resolved_app_data_dir(&app)
        .map_err(|e| e.to_string())?
        .join("screenshot-settings.json");
    let original = std::fs::read(&settings_path).ok();
    super::super::shortcut::screenshot_shortcut_set(app.clone(), Some("Control+Shift+F10".into()))
        .await?;
    let result = full_recorder(&app).await;
    let _ = super::super::shortcut::screenshot_shortcut_set(app.clone(), Some(String::new())).await;
    if let Some(bytes) = original {
        let _ = std::fs::write(&settings_path, bytes);
    } else {
        let _ = std::fs::remove_file(&settings_path);
    }
    super::super::shortcut::init(&app);
    result
}

pub(super) async fn full_recorder(app: &AppHandle) -> Result<String, String> {
    super::super::close_session(&app);
    let display = capture::resolve_display(&app, None).map_err(|e| e.to_string())?;
    let started = super::super::screenshot_start_recording(
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
    let output = super::super::record::output_path(&started.recording_id)
        .ok_or("recording output not tracked")?;
    let bar = wait_window(&app, super::super::RECORDER_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let geometry = capture_surfaces(
        &app,
        &display,
        (0, 0, display.width, display.height),
        super::super::RECORDER_LABEL,
        false,
    )
    .await
    .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    // Exercise the same route used by the registered global screenshot chord;
    // the separate hotkey scenario owns OS key-delivery evidence.
    super::super::open_overlay(&app, None).await?;
    let preview = run_js(&bar, "for(let i=0;i<150;i++){const p=document.querySelector('[data-testid=\"screenshot-recorder-preview\"]'); if(p?.complete && p.naturalWidth>0) return true; const error=document.querySelector('[data-testid=\"screenshot-recorder-error\"]'); if(error) throw new Error(error.textContent); await new Promise(r=>setTimeout(r,100));} return false;", Duration::from_secs(20)).await.map_err(|e| e.to_string())?;
    let clip = super::super::record::inspect_clip(&output).map_err(|e| e.to_string())?;
    let artifact = keep_artifact(&output, "whole-display-recording.gif");
    let bar_visible_after_stop = bar.is_visible().unwrap_or(false);
    finish_recorder(&bar).await?;
    let closed = wait_closed(&app, super::super::RECORDER_LABEL, Duration::from_secs(10)).await;
    let restored = main_visible(&app);
    Ok(report(
        geometry["controlsOutside"] == json!(true)
            && preview == json!(true)
            && bar_visible_after_stop
            && clip.frames >= 1
            && clip.duration_ms >= 800
            && closed
            && restored
            && !output.exists()
            && artifact.is_some(),
        json!({"geometry":geometry,"preview":preview,"clip":clip,"controlsVisibleAfterStop":bar_visible_after_stop,"closed":closed,"mainRestored":restored,"artifact":artifact}),
    ))
}

pub(super) async fn finish_recorder(bar: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        return wayland::click_control(bar, "[data-testid=\"screenshot-recorder-done\"]")
            .await
            .map_err(|e| format!("{e:#}"));
    }
    bar.eval("document.querySelector('[data-testid=\"screenshot-recorder-done\"]').click()")
        .map_err(|e| e.to_string())
}

/// Recorder bar flow: start a real recording, stop it from the bar, check
/// the preview loads (asset protocol), then finish and confirm the session
/// ends with the main window restored.
#[tauri::command]
pub async fn screenshot_qa_recorder(app: AppHandle, format: String) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(&app);
    let (fixture, display, region) = open_fixture(&app, "anim")
        .await
        .map_err(|e| format!("{e:#}"))?;
    #[cfg(target_os = "linux")]
    let selection_layer_entry = wayland::active() && format == "gif";
    #[cfg(not(target_os = "linux"))]
    let selection_layer_entry = false;
    if selection_layer_entry {
        // Exercise the native selection-to-recorder lifecycle with the same
        // fixture region. Closing the transferred selection surface must not
        // unminimize main into the live recording or end the recorder session.
        super::super::open_overlay(&app, Some(display.id.clone())).await?;
        let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10))
            .await
            .map_err(|e| format!("{e:#}"))?;
        let ready = run_js(
            &overlay,
            r#"
            for(let i=0;i<100;i++) {
                const image=document.querySelector('[data-testid="screenshot-base-image"]');
                if(image?.complete && image.naturalWidth>0 && document.querySelector('[data-testid="screenshot-hint"]')) return true;
                await new Promise(r=>setTimeout(r,100));
            } return false;
        "#,
            Duration::from_secs(15),
        )
        .await
        .map_err(|e| format!("{e:#}"))?;
        if ready != json!(true) {
            return Err("native selection layer did not load before recording".into());
        }
    }
    let started = super::super::screenshot_start_recording(
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
    let output = super::super::record::output_path(&started.recording_id)
        .ok_or("recording output not tracked")?;
    let selection_layer_closed = !selection_layer_entry
        || wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
    let main_hidden = !main_visible(&app);
    let bar = wait_window(&app, super::super::RECORDER_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| format!("{e:#}"))?;
    let geometry = capture_surfaces(&app, &display, region, super::super::RECORDER_LABEL, true)
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
    super::super::open_overlay(&app, None).await?;
    let preview_retained = app
        .get_webview_window(super::super::OVERLAY_LABEL)
        .is_none();
    finish_recorder(&bar).await?;
    let closed = wait_closed(&app, super::super::RECORDER_LABEL, Duration::from_secs(10)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let restored = main_visible(&app);
    let output_removed = !output.exists();
    let timer_moved = info["timerBefore"] != info["timerAfter"];
    let preview_ok = info["naturalWidth"].as_u64() == Some(clip.width as u64)
        && info["naturalHeight"].as_u64() == Some(clip.height as u64)
        && (format != "mp4" || info["playbackMoved"] == json!(true));
    let ok = main_hidden
        && selection_layer_closed
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
        "selectionLayerEntry":selection_layer_entry,"selectionLayerClosed":selection_layer_closed,
        "gifCopied":copied,"previewRetained":preview_retained,"tempRemoved":output_removed,"format":format,"originalComparison":content,"artifact":artifact,"captureGeometry":geometry }),
    ))
}
