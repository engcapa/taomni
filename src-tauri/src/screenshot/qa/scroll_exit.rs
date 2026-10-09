use super::*;

/// Exact current-window selection, large selections without a start hotkey,
/// pointer escape, and real OS Escape/right-button delivery on Windows.
#[tauri::command]
pub async fn screenshot_qa_scroll_exit(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    if !cfg!(target_os = "windows") {
        return Err("Windows scroll input scenario".into());
    }
    let _cleanup = ScenarioCleanup(app.clone());
    let original_shortcut = super::super::shortcut::current_status().accelerator;
    super::super::shortcut::screenshot_shortcut_set(app.clone(), Some(String::new())).await?;
    let result = run(&app).await;
    let _ = super::super::shortcut::screenshot_shortcut_set(app, Some(original_shortcut)).await;
    result
        .map(|details| report(true, details))
        .map_err(|e| format!("{e:#}"))
}

async fn run(app: &AppHandle) -> anyhow::Result<Value> {
    let mut observations = Vec::new();
    let mut trace = ScenarioTrace::new("scroll-exit-phases.json");
    for (fullscreen, manual, right_click) in [
        (false, false, false),
        (true, false, true),
        (true, true, false),
    ] {
        super::super::close_session(app);
        wait_closed(app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await;
        let (fixture, display, _) = open_fixture(app, "scroll").await?;
        if fullscreen {
            fixture.set_fullscreen(true)?;
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
        let source = read_source(&fixture).await?;
        let inner = fixture.inner_position()?;
        let size = fixture.inner_size()?;
        super::super::open_overlay_with_window(
            app,
            Some(display.id.clone()),
            Some(fixture.clone()),
        )
        .await
        .map_err(anyhow::Error::msg)?;
        let overlay =
            wait_window(app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await?;
        let initial = super::super::screenshot_overlay_init()
            .await
            .map_err(anyhow::Error::msg)?;
        let region = initial
            .window_region
            .context("current window was not selected")?;
        let plan = super::super::screenshot_scroll_plan(
            app.clone(),
            Some(display.id.clone()),
            region.x,
            region.y,
            region.width,
            region.height,
        )
        .await
        .map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            plan.x == region.x
                && plan.y == region.y
                && plan.width == region.width
                && plan.height == region.height,
            "selection was reduced for controls"
        );
        let script = format!(
            r#"
          const q = id => document.querySelector('[data-testid="'+id+'"]');
          const sleep = ms => new Promise(r=>setTimeout(r,ms));
          for(let i=0;i<100&&!q('screenshot-scroll-capture');i++) await sleep(100);
          q('screenshot-scroll-capture').click();
          for(let i=0;i<100&&(!q('screenshot-scroll-start')||q('screenshot-scroll-start').disabled);i++) await sleep(100);
          q('screenshot-scroll-mode-{mode}').click(); await sleep(100);
          q('screenshot-scroll-start').click(); return true;
        "#,
            mode = if manual { "manual" } else { "auto" }
        );
        run_js(&overlay, &script, Duration::from_secs(20)).await?;
        wait_frames(app, if manual { 1 } else { 2 }).await?;
        trace.mark("capturing", json!({"fullscreen":fullscreen,"manual":manual,"status":super::super::screenshot_scroll_status().await}));
        let bar = wait_window(
            app,
            super::super::surfaces::SCROLL_LABEL,
            Duration::from_secs(5),
        )
        .await?;
        if fullscreen && capture::list_displays(app)?.len() == 1 {
            anyhow::ensure!(!bar.is_visible()?, "full-display controls must be hidden");
        }
        if manual {
            let position = run_js(&fixture, "return document.querySelector('[data-testid=\"screenshot-qa-fixture-ready\"]').scrollTop;", Duration::from_secs(5)).await?;
            anyhow::ensure!(
                position == json!(0),
                "manual capture moved without user input"
            );
            let point = input_point(
                (
                    inner.x + size.width as i32 / 2,
                    inner.y + size.height as i32 / 2,
                ),
                source.scale,
            );
            tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                use enigo::Mouse;
                let mut input = enigo::Enigo::new(&enigo::Settings::default())?;
                move_os_pointer(&mut input, point)?;
                input.scroll(1, enigo::Axis::Vertical)?;
                Ok(())
            })
            .await??;
            wait_frames(app, 2).await?;
        } else if !fullscreen {
            let outside = input_point((display.x + 16, display.y + 16), source.scale);
            park_pointer(outside).await?;
            tokio::time::sleep(Duration::from_millis(800)).await;
            let before = run_js(&fixture, "return document.querySelector('[data-testid=\"screenshot-qa-fixture-ready\"]').scrollTop;", Duration::from_secs(5)).await?;
            tokio::time::sleep(Duration::from_millis(900)).await;
            let after = run_js(&fixture, "return document.querySelector('[data-testid=\"screenshot-qa-fixture-ready\"]').scrollTop;", Duration::from_secs(5)).await?;
            let pointer = app.cursor_position()?;
            anyhow::ensure!(
                before == after && (pointer.x - (display.x + 16) as f64).abs() < 3.0,
                "automatic capture stole the pointer or kept scrolling outside the region"
            );
        }
        let edge_reference = if !fullscreen {
            let app = app.clone();
            let display = display.clone();
            Some(
                tokio::task::spawn_blocking(move || capture::capture_display(&app, &display))
                    .await??,
            )
        } else {
            None
        };
        // The Start path must not finish an active scroll capture.
        super::super::open_overlay(app, None)
            .await
            .map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            super::super::tool_state()
                .scroll
                .as_ref()
                .is_some_and(|s| !s.stop.load(Ordering::SeqCst)),
            "Start was reused as Stop"
        );
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            use enigo::{Keyboard, Mouse};
            let mut input = enigo::Enigo::new(&enigo::Settings::default())?;
            if right_click {
                input.button(enigo::Button::Right, enigo::Direction::Click)?;
            } else {
                input.key(enigo::Key::Escape, enigo::Direction::Click)?;
            }
            Ok(())
        })
        .await??;
        tokio::time::sleep(Duration::from_millis(300)).await;
        trace.mark("stop-input", json!({"rightClick":right_click,"status":super::super::screenshot_scroll_status().await,
            "stop":super::super::tool_state().scroll.as_ref().map(|s| s.stop.load(Ordering::SeqCst))}));
        let preview = run_js(&overlay, r#"
          const q = id => document.querySelector('[data-testid="'+id+'"]');
          for(let i=0;i<120&&!q('screenshot-scroll-result-image')?.naturalWidth;i++) await new Promise(r=>setTimeout(r,100));
          return {ready:!!q('screenshot-scroll-result-image')?.naturalWidth, phase:q('screenshot-overlay')?.dataset.phase,
            error:q('screenshot-scroll-error')?.textContent, image:q('screenshot-scroll-result-image')?.src};
        "#, Duration::from_secs(15)).await?;
        trace.mark("preview", preview.clone());
        anyhow::ensure!(
            preview["ready"] == true && overlay.is_visible()?,
            "stop input lost the result preview: {preview}"
        );
        let output = super::super::screenshot_overlay_init()
            .await
            .map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            output.width == region.width && output.height > region.height,
            "expected full-width long result"
        );
        let actual = image::open(&output.path)?.to_rgba8();
        let original = source_png(
            source
                .data_url
                .as_deref()
                .context("original page missing")?,
        )?;
        let dx = (inner.x - display.x - region.x as i32).max(0) as u32;
        let dy = (inner.y - display.y - region.y as i32).max(0) as u32;
        let content_height = (actual.height() - region.height + size.height).min(original.height());
        let inset = (32.0 * source.scale).ceil() as u32;
        let width = original.width().saturating_sub(2 * inset);
        let comparison = qa_oracle::compare(
            &capture::crop(&actual, dx + inset, dy, width, content_height),
            &capture::crop(&original, inset, 0, width, content_height),
            false,
        );
        let artifact = keep_artifact(std::path::Path::new(&output.path), "scroll-exit.png");
        let edge_comparison = if let Some(reference) = edge_reference {
            // Native scrollbar's bottom button used to repeat at every join.
            // Compare the entire glyph, not just the center of the page.
            let sx = (inner.x - display.x) as u32 + size.width - 16;
            let sy = (inner.y - display.y) as u32 + size.height - 16;
            let arrow = capture::crop(&reference, sx, sy, 16, 16);
            let ax = dx + size.width - 16;
            let count = (0..=actual.height() - 16)
                .filter(|&y| capture::crop(&actual, ax, y, 16, 16) == arrow)
                .count();
            anyhow::ensure!(
                count == 1,
                "native bottom scrollbar button occurred {count} times"
            );
            let grey = |p: &image::Rgba<u8>| {
                (50..200).contains(&p[0]) && p[0].abs_diff(p[1]) < 8 && p[1].abs_diff(p[2]) < 8
            };
            let expected_ink = (0..size.height)
                .filter(|&y| grey(reference.get_pixel(sx + 8, sy + 16 - size.height + y)))
                .count();
            let actual_ink = (dy..actual.height() - region.height + dy + size.height)
                .filter(|&y| grey(actual.get_pixel(ax + 8, y)))
                .count();
            anyhow::ensure!(
                actual_ink == expected_ink,
                "scrollbar thumb/arrow ink repeated: {actual_ink} pixels, expected {expected_ink}"
            );
            Some(
                json!({"bottomArrowOccurrences":count,"scrollbarInk":actual_ink,"expectedScrollbarInk":expected_ink}),
            )
        } else {
            None
        };
        anyhow::ensure!(
            comparison.passed,
            "scrolling body contains missing/duplicated/transient pixels: {comparison:?}"
        );
        observations.push(
            json!({"fullscreen":fullscreen,"manual":manual,"rightClick":right_click,
            "selection":region,"plan":plan,"output":[output.width,output.height],"preview":preview,
            "originalComparison":comparison,"edgeComparison":edge_comparison,"artifact":artifact}),
        );
    }
    Ok(json!({"scenarios":observations,"platform":platform()}))
}

async fn wait_frames(_app: &AppHandle, frames: u32) -> anyhow::Result<()> {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        if super::super::tool_state()
            .scroll
            .as_ref()
            .is_some_and(|c| c.frames.load(Ordering::SeqCst) >= frames)
        {
            return Ok(());
        }
        anyhow::ensure!(
            Instant::now() < until,
            "scroll capture did not reach {frames} frames"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
