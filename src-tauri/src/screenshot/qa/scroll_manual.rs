use super::*;

/// Public manual mode, real user-equivalent OS wheel input, pauses, Finish
/// and Cancel. The complete PNG is compared with the retained source page.
#[tauri::command]
pub async fn screenshot_qa_scroll_manual(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let mut trace = ScenarioTrace::new("scroll-manual-phases.json");
    let (fixture, display, region) = open_fixture(&app, "scroll")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let source = read_source(&fixture).await.map_err(|e| format!("{e:#}"))?;
    let parked = input_point((display.x + 16, display.y + 16), source.scale);
    park_pointer(parked).await.map_err(|e| e.to_string())?;
    trace.mark("fixture-ready", json!({"region":region}));
    let overlay = begin_scroll_ui(&app, &display, region, false, false).await?;
    run_js(
        &overlay,
        r#"
      document.querySelector('[data-testid="screenshot-scroll-mode-manual"]').click();
      await new Promise(r => setTimeout(r, 100));
      document.querySelector('[data-testid="screenshot-scroll-start"]').click();
      return true;
    "#,
        Duration::from_secs(10),
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    let bar = wait_window(
        &app,
        super::super::surfaces::SCROLL_LABEL,
        Duration::from_secs(10),
    )
    .await
    .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(1800)).await;
    let paused = super::super::tool_state()
        .scroll
        .as_ref()
        .map(|c| c.status());
    if !paused
        .as_ref()
        .is_some_and(|s| s["mode"] == "manual" && s["frames"] == 1)
    {
        return Err(format!("manual pause ended early: {paused:?}"));
    }
    trace.mark("initial-pause", json!(paused));
    run_js(&bar, "document.querySelector('[data-testid=\"screenshot-scroll-switch-mode\"]').click(); return true;", Duration::from_secs(5)).await.map_err(|e| e.to_string())?;
    let mut switched_auto = false;
    for _ in 0..100 {
        switched_auto = super::super::tool_state().scroll.as_ref().is_some_and(|c| {
            c.mode() == super::super::scroll::ScrollMode::Auto
                && c.frames.load(Ordering::SeqCst) >= 2
        });
        if switched_auto {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !switched_auto {
        return Err("switching from manual to automatic did not scroll the page".into());
    }
    run_js(&bar, "const button=document.querySelector('[data-testid=\"screenshot-scroll-switch-mode\"]'); for(let i=0;i<50 && button.disabled;i++) await new Promise(r=>setTimeout(r,100)); button.click(); return true;", Duration::from_secs(10)).await.map_err(|e| e.to_string())?;
    let mut switched_manual = false;
    for _ in 0..50 {
        switched_manual = super::super::tool_state()
            .scroll
            .as_ref()
            .is_some_and(|c| c.mode() == super::super::scroll::ScrollMode::Manual);
        if switched_manual {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !switched_manual {
        return Err("switching back to manual did not stop automatic input".into());
    }
    trace.mark("switched-back-to-manual", json!(true));
    let center = input_point(
        (
            display.x + (region.0 + region.2 / 2) as i32,
            display.y + (region.1 + region.3 / 2) as i32,
        ),
        source.scale,
    );
    let mut positions = Vec::new();
    #[cfg(target_os = "linux")]
    let wayland_input = wayland::active();
    #[cfg(not(target_os = "linux"))]
    let wayland_input = false;
    let mut input = if wayland_input {
        None
    } else {
        Some(tokio::task::spawn_blocking(|| enigo::Enigo::new(&enigo::Settings::default()))
            .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?)
    };
    for _ in 0..70 {
        if wayland_input {
            os_wheel(center, 1).await.map_err(|e| e.to_string())?;
        } else {
            let mut session = input.take().context("manual wheel input session").map_err(|e| e.to_string())?;
            input = Some(tokio::task::spawn_blocking(move || -> anyhow::Result<enigo::Enigo> {
                use enigo::Mouse;
                move_os_pointer(&mut session, center)?;
                session.scroll(1, enigo::Axis::Vertical)?;
                Ok(session)
            }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?);
        }
        tokio::time::sleep(Duration::from_millis(220)).await;
        let position = run_js(&fixture, "const el = document.querySelector('[data-testid=\"screenshot-qa-fixture-ready\"]'); return {top:el.scrollTop, end:el.scrollHeight-el.clientHeight};", Duration::from_secs(5)).await.map_err(|e| e.to_string())?;
        let bottom = position["top"].as_f64().unwrap_or(0.0)
            >= position["end"].as_f64().unwrap_or(f64::MAX) - 1.0;
        trace.mark("manual-wheel", position.clone());
        positions.push(position);
        if bottom {
            break;
        }
    }
    trace.mark("bottom-pause", json!(true));
    tokio::time::sleep(Duration::from_millis(1800)).await;
    let at_bottom = super::super::tool_state()
        .scroll
        .as_ref()
        .map(|c| c.status());
    let bottom_still_active = at_bottom
        .as_ref()
        .is_some_and(|s| s["mode"] == "manual" && s["frames"].as_u64().unwrap_or(0) > 2);
    bar.eval("document.querySelector('[data-testid=\"screenshot-scroll-stop\"]').click()")
        .map_err(|e| e.to_string())?;
    let preview = run_js(&overlay, r#"
      for (let i=0;i<100 && !document.querySelector('[data-testid="screenshot-scroll-result"]');i++) await new Promise(r=>setTimeout(r,100));
      const img=document.querySelector('[data-testid="screenshot-scroll-result-image"]');
      return {preview:!!img,width:img?.naturalWidth,height:img?.naturalHeight};
    "#, Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    let output = super::super::tool_state()
        .overlay
        .clone()
        .ok_or("scroll result missing")?;
    let image = image::open(&output.path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let comparison = compare_scroll_original(&image, &source).map_err(|e| e.to_string())?;
    let artifact = keep_image(&image, "scroll-manual.png");
    trace.mark("finished-original", comparison.clone());
    super::super::close_session(&app);
    if !wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await {
        return Err("finished overlay did not close before the next capture".into());
    }
    trace.mark("finished-overlay-closed", json!(true));
    // A second public capture exercises explicit cancellation, retaining the
    // selected original instead of installing a partial result.
    let original = begin_scroll_ui(&app, &display, region, false, false).await?;
    trace.mark("cancel-selection-ready", json!(true));
    run_js(&original, "document.querySelector('[data-testid=\"screenshot-scroll-mode-manual\"]').click(); await new Promise(r=>setTimeout(r,100)); document.querySelector('[data-testid=\"screenshot-scroll-start\"]').click(); return true;", Duration::from_secs(10)).await.map_err(|e| e.to_string())?;
    let cancel_bar = wait_window(
        &app,
        super::super::surfaces::SCROLL_LABEL,
        Duration::from_secs(10),
    )
    .await
    .map_err(|e| e.to_string())?;
    run_js(&cancel_bar, "for(let i=0;i<100 && !document.querySelector('[data-testid=\"screenshot-scroll-cancel\"]');i++) await new Promise(r=>setTimeout(r,100)); if(!document.querySelector('[data-testid=\"screenshot-scroll-cancel\"]')) throw new Error('manual Cancel control missing'); return true;", Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    trace.mark("cancel-controls-ready", json!(true));
    tokio::time::sleep(Duration::from_millis(600)).await;
    cancel_bar
        .eval("document.querySelector('[data-testid=\"screenshot-scroll-cancel\"]').click()")
        .map_err(|e| e.to_string())?;
    trace.mark("cancel-clicked", json!(true));
    let cancelled = run_js(&original, "for(let i=0;i<100 && document.querySelector('[data-testid=\"screenshot-overlay\"]')?.dataset.phase!=='annotate';i++) await new Promise(r=>setTimeout(r,100)); return document.querySelector('[data-testid=\"screenshot-overlay\"]')?.dataset.phase==='annotate' && !document.querySelector('[data-testid=\"screenshot-scroll-result\"]');", Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    trace.mark("cancelled", cancelled.clone());
    Ok(report(
        bottom_still_active
            && preview["preview"] == true
            && comparison["passed"] == true
            && cancelled == true
            && artifact.is_some(),
        json!({"pause":paused,"switchedAuto":switched_auto,"switchedManual":switched_manual,"bottomStatus":at_bottom,"positions":positions,"preview":preview,"originalComparison":comparison,"cancelReturnedOriginal":cancelled,"artifact":artifact}),
    ))
}
