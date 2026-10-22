use super::*;

/// Send real desktop mouse input; physical coordinates are never injected into
/// the DOM. Also used to verify the pin renderer's native startDragging path.
pub(super) fn move_os_pointer(input: &mut enigo::Enigo, (x, y): (i32, i32)) -> anyhow::Result<()> {
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

pub(super) async fn park_pointer(point: (i32, i32)) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        return wayland::pointer(point).await;
    }
    tokio::task::spawn_blocking(move || {
        let mut input = enigo::Enigo::new(&enigo::Settings::default())
            .map_err(|e| anyhow::anyhow!("input synthesis unavailable: {e}"))?;
        move_os_pointer(&mut input, point)
    })
    .await
    .context("park desktop pointer")?
}

pub(super) async fn mouse_path(points: Vec<(i32, i32)>) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        return wayland::mouse_path(points).await;
    }
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

/// Quartz and the owned Mutter broker use logical points. Enigo/X11/Win32
/// receive physical pixels. Tao's Linux coordinates are per-monitor scaled.
pub(super) fn input_point(point: (i32, i32), scale: f64) -> (i32, i32) {
    #[cfg(target_os = "linux")]
    let logical = wayland::active();
    #[cfg(not(target_os = "linux"))]
    let logical = false;
    if cfg!(target_os = "macos") || logical {
        (
            (point.0 as f64 / scale).round() as i32,
            (point.1 as f64 / scale).round() as i32,
        )
    } else {
        point
    }
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn x11_pin_is_above(state: &Value) -> bool {
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

pub(super) async fn verify_pin_drag(
    window: &WebviewWindow,
    display: &DisplayInfo,
) -> anyhow::Result<Value> {
    let scale = window.scale_factor()?.max(0.5);
    // A deterministic visible starting point is setup, not the asserted move.
    #[cfg(target_os = "linux")]
    if wayland::active() {
        let current = wayland::window(window).await?;
        let mut rect = current["frame"].clone();
        let (x, y, _, _) = display.logical_rect();
        rect["x"] = json!(x + 36);
        rect["y"] = json!(y + 48);
        wayland::command(
            json!({"command":"place","application":std::env::current_exe()?,
            "title":window.title()?,"rect":rect}),
        )
        .await?;
    } else {
        window.set_position(tauri::PhysicalPosition::new(
            display.x + (36.0 * scale).round() as i32,
            display.y + (48.0 * scale).round() as i32,
        ))?;
    }
    #[cfg(not(target_os = "linux"))]
    window.set_position(tauri::PhysicalPosition::new(
        display.x + (36.0 * scale).round() as i32,
        display.y + (48.0 * scale).round() as i32,
    ))?;
    window.set_focus()?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    #[cfg(target_os = "linux")]
    let scale = if wayland::active() {
        wayland::output_scale(
            window.app_handle(),
            &wayland::window(window).await?["client"],
        )?
    } else {
        scale
    };
    let before = observed_outer_rect(window).await?.0;
    let (inner, size) = observed_inner_rect(window).await?;
    let start = (
        inner.x + size.width as i32 / 2,
        inner.y + size.height as i32 / 2,
    );
    let delta = ((80.0 * scale).round() as i32, (64.0 * scale).round() as i32);
    let end = (start.0 + delta.0, start.1 + delta.1);
    mouse_path(vec![input_point(start, scale), input_point(end, scale)]).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = observed_outer_rect(window).await?.0;
    let actual = (after.x - before.x, after.y - before.y);
    let moved = (actual.0 - delta.0).abs() <= 6 && (actual.1 - delta.1).abs() <= 6;
    let cached_topmost = window.is_always_on_top()?;
    #[cfg(target_os = "linux")]
    let native_state = if wayland::active() {
        wayland::window(window).await?
    } else {
        tokio::task::spawn_blocking(|| {
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
        .context("native pin state probe")?
    };
    #[cfg(not(target_os = "linux"))]
    let native_state = Value::Null;
    // Tao's GTK window-state cache can lose ABOVE after a move even when the
    // actual X11 window retains it (run36990397751). Require the WM's atom,
    // not the builder's requested flag or a fallback to the stale cache.
    #[cfg(target_os = "linux")]
    let topmost = if wayland::active() {
        native_state["above"] == true
    } else {
        x11_pin_is_above(&native_state)
    };
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
    super::super::close_session(&app);
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
        let origin = observed_inner_rect(&fixture)
            .await
            .map_err(|e| e.to_string())?
            .0;
        super::super::open_overlay(&app, Some(display.id.clone())).await?;
        let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10))
            .await
            .map_err(|e| format!("{e:#}"))?;
        let init = super::super::screenshot_overlay_init().await?;
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
        let overlay_closed =
            wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
        let (actual, pin) = if action == "pin" {
            let label = super::super::tool_state()
                .pins
                .keys()
                .next()
                .cloned()
                .ok_or("public Pin did not open")?;
            let path = super::super::tool_state()
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
        let restore_deadline = Instant::now() + Duration::from_secs(5);
        while !main_visible(&app) && Instant::now() < restore_deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let main_restored = main_visible(&app);
        let passed = comparison.passed
            && overlay_closed
            && main_restored
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
            "overlayClosed":overlay_closed,"mainRestored":main_restored,"sessionSourceRemoved":!std::path::Path::new(&init.path).exists(),
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
    super::super::screenshot_save_image(file.clone(), destination.to_string_lossy().into_owned())
        .await?;
    let saved_identical = std::fs::read(&file).map_err(|e| e.to_string())?
        == std::fs::read(&destination).map_err(|e| e.to_string())?;
    let label = super::super::screenshot_pin_to_screen(app.clone(), file).await?;
    let window = wait_window(&app, &label, Duration::from_secs(10))
        .await
        .map_err(|e| format!("{e:#}"))?;
    let pinned_path = super::super::tool_state()
        .pins
        .get(&label)
        .map(|p| p.path.clone());
    let script = r#"
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      for (let i = 0; i < 100 && !(q('[data-testid="screenshot-pin-image"]') && q('[data-testid="screenshot-pin-image"]').complete && q('[data-testid="screenshot-pin-image"]').naturalWidth > 0); i++) await sleep(100);
      const img = q('[data-testid="screenshot-pin-image"]');
      return { naturalWidth: img ? img.naturalWidth : 0, naturalHeight: img ? img.naturalHeight : 0 };
    "#;
    let info = run_js(&window, script, Duration::from_secs(20)).await;
    super::super::screenshot_close_pin(app.clone(), label.clone()).await?;
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

pub(super) async fn press_hotkey() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        return wayland::keys(vec![vec![0xffe3, 0xffe1, 0xffc6]])
            .await
            .map_err(|e| e.to_string());
    }
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
    super::super::close_session(&app);
    let chord = "Control+Shift+F9";
    let previous = super::super::shortcut::screenshot_shortcut_status().await?;
    let settings_path = crate::resolved_app_data_dir(&app)
        .map_err(|e| e.to_string())?
        .join("screenshot-settings.json");
    let original_settings = std::fs::read(&settings_path).ok();
    let result = async {
        let status = super::super::shortcut::screenshot_shortcut_set(app.clone(), Some(chord.into())).await?;
        press_hotkey().await?;
        let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await.map_err(|e|e.to_string())?;
        let ready = run_js(&overlay, "for(let i=0;i<100 && !document.querySelector('[data-testid=\"screenshot-hint\"]');i++) await new Promise(r=>setTimeout(r,100)); return !!document.querySelector('[data-testid=\"screenshot-hint\"]');", Duration::from_secs(15)).await.map_err(|e|e.to_string())?;
        // Exercise an OS window-close action with its real input serial.
        // Programmatic close has no Wayland user activation context.
        #[cfg(target_os = "linux")]
        if wayland::active() {
            wayland::click_control(&overlay, "[data-testid=\"screenshot-hint\"]")
                .await.map_err(|e| e.to_string())?;
            wayland::keys(vec![vec![0xffe9, 0xffc1]])
                .await.map_err(|e| e.to_string())?;
        } else {
            overlay.close().map_err(|e|e.to_string())?;
        }
        #[cfg(not(target_os = "linux"))]
        overlay.close().map_err(|e|e.to_string())?;
        let closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        let restored = main_visible(&app);
        let disabled = super::super::shortcut::screenshot_shortcut_set(app.clone(), Some(String::new())).await?;
        press_hotkey().await?;
        tokio::time::sleep(Duration::from_millis(800)).await;
        let did_not_open = app.get_webview_window(super::super::OVERLAY_LABEL).is_none();
        Ok::<_,String>((status.registered, ready == json!(true), closed, restored, !disabled.enabled && did_not_open))
    }.await;
    super::super::close_session(&app);
    let restored_status = super::super::shortcut::screenshot_shortcut_set(
        app.clone(),
        Some(previous.accelerator.clone()),
    )
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
