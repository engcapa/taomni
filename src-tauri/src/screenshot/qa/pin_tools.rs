use super::*;

async fn choose_save_destination(destination: std::path::PathBuf) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        use enigo::{Direction, Key, Keyboard};
        let mut input = enigo::Enigo::new(&enigo::Settings::default())
            .map_err(|e| anyhow::anyhow!("OS input: {e}"))?;
        let chord = |input: &mut enigo::Enigo, modifiers: &[Key], key: Key| -> anyhow::Result<()> {
            for modifier in modifiers {
                input
                    .key(*modifier, Direction::Press)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            let result = input
                .key(key, Direction::Click)
                .map_err(|e| anyhow::anyhow!("{e}"));
            for modifier in modifiers.iter().rev() {
                let _ = input.key(*modifier, Direction::Release);
            }
            result
        };
        #[cfg(target_os = "macos")]
        {
            chord(&mut input, &[Key::Meta], Key::Unicode('a'))?;
            input
                .text(destination.file_name().unwrap().to_string_lossy().as_ref())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            chord(&mut input, &[Key::Meta, Key::Shift], Key::Unicode('g'))?;
            std::thread::sleep(Duration::from_millis(500));
            input
                .text(destination.parent().unwrap().to_string_lossy().as_ref())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            input
                .key(Key::Return, Direction::Click)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            std::thread::sleep(Duration::from_millis(700));
        }
        #[cfg(target_os = "linux")]
        {
            chord(&mut input, &[Key::Control], Key::Unicode('l'))?;
            std::thread::sleep(Duration::from_millis(250));
            input
                .text(destination.to_string_lossy().as_ref())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
        }
        #[cfg(target_os = "windows")]
        {
            chord(&mut input, &[Key::Control], Key::Unicode('a'))?;
            input
                .text(destination.to_string_lossy().as_ref())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
        }
        input
            .key(Key::Return, Direction::Click)
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok(())
    })
    .await
    .context("native save dialog input")?
}

#[tauri::command]
pub async fn screenshot_qa_pin_tools(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let source = RgbaImage::from_pixel(800, 600, image::Rgba([200, 20, 40, 255]));
    let (source_path, _, _) =
        capture::save_png(&source, "qa-pin-tools").map_err(|e| e.to_string())?;
    let label = super::super::screenshot_pin_to_screen(
        app.clone(),
        source_path.to_string_lossy().into_owned(),
    )
    .await?;
    let pin = wait_window(&app, &label, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    run_js(&pin, "for(let i=0;i<100 && !document.querySelector('[data-testid=\"screenshot-pin-image\"]')?.naturalWidth;i++) await new Promise(r=>setTimeout(r,100)); return !!document.querySelector('[data-testid=\"screenshot-pin-copy\"]');", Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    let display = capture::resolve_display(&app, None).map_err(|e| e.to_string())?;
    let drag = verify_pin_drag(&pin, &display)
        .await
        .map_err(|e| e.to_string())?;
    let scale = pin.scale_factor().map_err(|e| e.to_string())?;
    let before = pin.inner_size().map_err(|e| e.to_string())?;
    let controls = run_js(&pin, r#"
      const q=id=>document.querySelector('[data-testid="'+id+'"]');
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      q('screenshot-pin-window').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2})); await wait(100);
      const help=!!q('screenshot-pin-help')?.textContent;
      const opacity=q('screenshot-pin-opacity');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(opacity,'50');
      opacity.dispatchEvent(new Event('input',{bubbles:true})); opacity.dispatchEvent(new Event('change',{bubbles:true})); await wait(150);
      q('screenshot-pin-zoom-in').click(); await wait(500);
      const result={help,opacity:Number(getComputedStyle(q('screenshot-pin-surface')).opacity),zoom:q('screenshot-pin-zoom').textContent};
      q('screenshot-pin-menu-toggle').click(); await wait(100); return result;
    "#, Duration::from_secs(10)).await.map_err(|e| e.to_string())?;
    let zoomed = pin.inner_size().map_err(|e| e.to_string())?;
    // Verify the compositor really reveals the desktop, rather than merely
    // accepting a CSS opacity value inside an opaque native window.
    pin.hide().map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(350)).await;
    let background = capture::capture_display(&app, &display).map_err(|e| e.to_string())?;
    pin.show().map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let composited = capture::capture_display(&app, &display).map_err(|e| e.to_string())?;
    let position = pin.inner_position().map_err(|e| e.to_string())?;
    let sample = (
        (position.x - display.x + (100.0 * scale) as i32) as u32,
        (position.y - display.y + (100.0 * scale) as i32) as u32,
    );
    let underlying = background.get_pixel(sample.0, sample.1).0;
    let actual = composited.get_pixel(sample.0, sample.1).0;
    let expected = [
        ((200u16 + underlying[0] as u16) / 2) as u8,
        ((20u16 + underlying[1] as u16) / 2) as u8,
        ((40u16 + underlying[2] as u16) / 2) as u8,
    ];
    let opacity_pixels = (0..3).all(|c| (actual[c] as i32 - expected[c] as i32).abs() <= 4);
    let composite_artifact = keep_image(&composited, "pin-opacity-desktop.png");
    pin.eval("document.querySelector('[data-testid=\"screenshot-pin-copy\"]').click()")
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(350)).await;
    let copied = read_clipboard_image(&app).map_err(|e| e.to_string())?;
    let copy_identical = copied == source;
    let copy_artifact = keep_image(&copied, "pin-tools-clipboard.png");
    pin.eval("document.querySelector('[data-testid=\"screenshot-pin-collapse\"]').click()")
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(450)).await;
    let small = pin.inner_size().map_err(|e| e.to_string())?;
    pin.eval("document.querySelector('[data-testid=\"screenshot-pin-expand\"]').click()")
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(450)).await;
    let restored = pin.inner_size().map_err(|e| e.to_string())?;
    let restored_opacity = run_js(&pin, "return Number(getComputedStyle(document.querySelector('[data-testid=\"screenshot-pin-surface\"]')).opacity);", Duration::from_secs(5)).await.map_err(|e| e.to_string())?;
    let destination = evidence_path("pin-ui-saved.png");
    std::fs::create_dir_all(artifact_dir()).map_err(|e| e.to_string())?;
    pin.set_focus().map_err(|e| e.to_string())?;
    pin.eval("document.querySelector('[data-testid=\"screenshot-pin-save\"]').click()")
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    choose_save_destination(destination.clone())
        .await
        .map_err(|e| e.to_string())?;
    for _ in 0..60 {
        if destination.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let saved_identical = std::fs::read(&destination).ok() == std::fs::read(&source_path).ok()
        && destination.exists();
    if !saved_identical {
        return Ok(report(
            false,
            json!({"nativeSaveDialog":"did not save original PNG","destination":destination,"controls":controls,"drag":drag}),
        ));
    }
    run_js(&pin, "document.querySelector('[data-testid=\"screenshot-pin-favorite\"]').click(); for(let i=0;i<100 && document.querySelector('[data-testid=\"screenshot-pin-favorite\"]').getAttribute('aria-pressed')!=='true';i++) await new Promise(r=>setTimeout(r,100)); return document.querySelector('[data-testid=\"screenshot-pin-favorite\"]').getAttribute('aria-pressed');", Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    let items = super::super::favorites::screenshot_list_favorites(app.clone()).await?;
    let favorite = items.first().ok_or("favorite write missing")?.clone();
    pin.eval("document.querySelector('[data-testid=\"screenshot-pin-close\"]').click()")
        .map_err(|e| e.to_string())?;
    let closed = wait_closed(&app, &label, Duration::from_secs(10)).await;
    capture::purge_tracked();
    // Reopen through the main app's public collection entry after the
    // original capture and pin artifacts have gone away.
    let main = app.get_webview_window("main").ok_or("main missing")?;
    main.show().map_err(|e| e.to_string())?;
    run_js(&main, r#"
      const q=id=>document.querySelector('[data-testid="'+id+'"]');
      q('system-screenshot-delay-toggle').click(); await new Promise(r=>setTimeout(r,100));
      q('system-screenshot-favorites').click();
      for(let i=0;i<100 && !q('screenshot-favorite-open');i++) await new Promise(r=>setTimeout(r,100));
      q('screenshot-favorite-open').click(); return true;
    "#, Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    let mut reopened_label = None;
    for _ in 0..50 {
        reopened_label = super::super::tool_state().pins.keys().next().cloned();
        if reopened_label.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let reopened_label = reopened_label.ok_or("favorite did not reopen")?;
    let reopened = wait_window(&app, &reopened_label, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let reopened_info = run_js(&reopened, r#"
      const q=id=>document.querySelector('[data-testid="'+id+'"]');
      for(let i=0;i<100 && !q('screenshot-pin-image')?.naturalWidth;i++) await new Promise(r=>setTimeout(r,100));
      return {width:q('screenshot-pin-image')?.naturalWidth,height:q('screenshot-pin-image')?.naturalHeight,favorite:q('screenshot-pin-favorite')?.getAttribute('aria-pressed')};
    "#, Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    let payload = super::super::tool_state()
        .pins
        .get(&reopened_label)
        .cloned()
        .ok_or("favorite pin payload missing")?;
    let reopened_pixels = image::open(&payload.path)
        .map_err(|e| e.to_string())?
        .to_rgba8()
        == source;
    let favorite_artifact = keep_artifact(
        std::path::Path::new(&payload.path),
        "pin-favorite-reopened.png",
    );
    super::super::favorites::screenshot_remove_favorite(app.clone(), favorite.id.clone()).await?;
    let removed = !super::super::favorites::screenshot_list_favorites(app.clone())
        .await?
        .iter()
        .any(|item| item.id == favorite.id);
    let independent_pin = std::path::Path::new(&payload.path).exists();
    let ok = drag["passed"] == true
        && controls["help"] == true
        && controls["opacity"] == json!(0.5)
        && zoomed.width > before.width
        && opacity_pixels
        && copy_identical
        && (small.width as f64 / scale - 64.0).abs() < 2.0
        && (small.height as f64 / scale - 64.0).abs() < 2.0
        && restored == zoomed
        && restored_opacity == json!(0.5)
        && saved_identical
        && closed
        && reopened_info["favorite"] == "true"
        && reopened_pixels
        && removed
        && independent_pin
        && copy_artifact.is_some()
        && favorite_artifact.is_some();
    Ok(report(
        ok,
        json!({"drag":drag,"controls":controls,"before":before,"zoomed":zoomed,"collapsed":small,"restored":restored,"restoredOpacity":restored_opacity,"opacityPixels":{"passed":opacity_pixels,"underlying":underlying,"expected":expected,"actual":actual,"artifact":composite_artifact},"clipboardOriginal":copy_identical,"clipboardArtifact":copy_artifact,"savedOriginal":saved_identical,"savedArtifact":destination,"closed":closed,"favorite":favorite,"reopened":reopened_info,"reopenedOriginalPixels":reopened_pixels,"favoriteArtifact":favorite_artifact,"removed":removed,"openPinSurvivesRemoval":independent_pin}),
    ))
}
