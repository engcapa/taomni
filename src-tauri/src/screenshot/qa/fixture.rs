use super::*;

/// One `eval_with_callback` round trip; `None` if the page never answered
/// (e.g. still navigating).
pub(super) async fn eval_raw(window: &WebviewWindow, js: String, wait: Duration) -> Option<Value> {
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
pub(super) async fn run_js(
    window: &WebviewWindow,
    body: &str,
    timeout: Duration,
) -> anyhow::Result<Value> {
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

pub(super) async fn wait_window(
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

pub(super) async fn wait_closed(app: &AppHandle, label: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while app.get_webview_window(label).is_some() {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    true
}

pub(super) fn main_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| {
            #[cfg(target_os = "linux")]
            if wayland::active() {
                return wayland::visible(&w).ok();
            }
            let visible = w.is_visible().ok()?;
            #[cfg(target_os = "linux")]
            let visible = visible && !w.is_minimized().ok()?;
            Some(visible)
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Content fixtures
// ---------------------------------------------------------------------------

/// Open the fixture page `route` (`scroll` or `anim`) on the primary display
/// and return it with its display-relative physical content rect.
pub(super) async fn open_fixture(
    app: &AppHandle,
    route: &str,
) -> anyhow::Result<(WebviewWindow, DisplayInfo, (u32, u32, u32, u32))> {
    if let Some(old) = app.get_webview_window(QA_WINDOW_LABEL) {
        let _ = old.destroy();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let display = capture::resolve_display(app, None)?;
    // Keep the fixture above the X11 main surface, but use the same hidden
    // window ledger as capture. Closing the real tool must restore the app;
    // fixture cleanup must not manufacture a passing lifecycle assertion.
    if cfg!(target_os = "linux")
        && std::env::var_os("DISPLAY").is_some()
        && std::env::var_os("WAYLAND_DISPLAY").is_none()
    {
        super::super::hide_app_windows(app);
        super::super::await_hidden_windows(app)
            .await
            .map_err(anyhow::Error::msg)?;
    }
    let s = display.scale_factor.max(0.5);
    let url = WebviewUrl::App(format!("index.html#screenshot-qa-{route}").into());
    let window = super::super::window_builder(app, QA_WINDOW_LABEL, url)
        .title("Screenshot QA fixture")
        .inner_size(520.0, 440.0)
        .position(display.x as f64 / s + 120.0, display.y as f64 / s + 120.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .focused(true)
        .build()
        .context("open QA fixture window")?;
    // X11/LXQt and Xtigervnc can map a newly created WebView below the main
    // surface even when the builder requests focus/topmost. Re-assert both
    // after mapping so the OS capture region contains this fixture rather
    // than the stale window underneath it.
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    let ready = run_js(
        &window,
        "const ready = () => { const root = document.querySelector('[data-testid=\"screenshot-qa-fixture-ready\"]'); return !!root && (!root.querySelector('canvas') || root.dataset.sourceReady === 'true'); }; for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 100)); return ready();",
        Duration::from_secs(20),
    )
    .await?;
    if ready != Value::Bool(true) {
        anyhow::bail!("QA fixture '{route}' did not render");
    }
    #[cfg(target_os = "linux")]
    if wayland::active() {
        let (x, y, width, height) = display.logical_rect();
        wayland::command(
            json!({"command":"place", "application":std::env::current_exe()?,
            "title":window.title()?, "rect":{"x":x+120,"y":y+120,"width":520,"height":440}}),
        )
        .await?;
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let observed = wayland::window(&window).await?;
            let frame = &observed["frame"];
            let left = frame["x"].as_f64().context("fixture left")?;
            let top = frame["y"].as_f64().context("fixture top")?;
            if left >= x as f64
                && top >= y as f64
                && left + frame["width"].as_f64().context("fixture width")? <= (x + width) as f64
                && top + frame["height"].as_f64().context("fixture height")? <= (y + height) as f64
                && (window.scale_factor()? - s).abs() < 0.01
            {
                break;
            }
            anyhow::ensure!(
                Instant::now() < until,
                "fixture did not map to the selected output/DPI: {observed}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // The original canvas was drawn before compositor placement, possibly
        // at another output's DPI. Reload only this QA scene to retain fresh
        // originals drawn at the confirmed native scale, before OS capture.
        window.eval("window.location.reload()")?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let ready = run_js(
            &window,
            &format!(r#"
            for(let i=0;i<100;i++) {{
                const root=document.querySelector('[data-testid="screenshot-qa-fixture-ready"]');
                if(root && (!root.querySelector('canvas') ||
                    (root.dataset.sourceReady==='true' && window.__qaScreenshotSource?.scale==={s}))) return true;
                await new Promise(r=>setTimeout(r,50));
            }} return false;
        "#),
            Duration::from_secs(10),
        )
        .await?;
        anyhow::ensure!(
            ready == true,
            "fixture original did not redraw at target DPI {s}"
        );
    }
    let _ = window.set_focus();
    // Let the window manager map and raise it.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    if route == "anim" {
        // A previous scroll scenario leaves the OS cursor over the fixture.
        // CoreGraphics snapshots include it even when a different WebView has
        // focus, so park it outside the source for every recording scenario.
        park_pointer(input_point((display.x + 16, display.y + 16), s)).await?;
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    let (pos, size) = observed_inner_rect(&window).await?;
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

pub(super) async fn observed_inner_rect(
    window: &WebviewWindow,
) -> anyhow::Result<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        return wayland::inner_rect(window).await;
    }
    Ok((window.inner_position()?, window.inner_size()?))
}

pub(super) async fn observed_outer_rect(
    window: &WebviewWindow,
) -> anyhow::Result<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        let native = wayland::window(window).await?;
        return wayland::rect(
            &native["frame"],
            wayland::output_scale(window.app_handle(), &native["frame"])?,
        );
    }
    Ok((window.outer_position()?, window.outer_size()?))
}

pub(super) async fn os_wheel(point: (i32, i32), steps: i32) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        return wayland::wheel(point, steps).await;
    }
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        use enigo::Mouse;
        let mut input = enigo::Enigo::new(&enigo::Settings::default())?;
        move_os_pointer(&mut input, point)?;
        input.scroll(steps, enigo::Axis::Vertical)?;
        Ok(())
    })
    .await
    .context("OS wheel task")?
}

pub(super) async fn os_stop_input(right_click: bool) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        if right_click {
            wayland::command(json!({"command":"button","button":"right"})).await?;
        } else {
            wayland::keys(vec![vec![0xff1b]]).await?;
        }
        return Ok(());
    }
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
    .await
    .context("OS stop input task")?
}

pub(super) async fn observed_pointer(
    app: &AppHandle,
) -> anyhow::Result<tauri::PhysicalPosition<f64>> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        let value = wayland::command(json!({"command":"pointer_position"})).await?;
        return Ok(tauri::PhysicalPosition::new(
            value[0].as_f64().context("Mutter pointer x")?,
            value[1].as_f64().context("Mutter pointer y")?,
        ));
    }
    Ok(app.cursor_position()?)
}

pub(super) fn close_fixture(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QA_WINDOW_LABEL) {
        let _ = window.destroy();
    }
    if cfg!(target_os = "linux")
        && std::env::var_os("DISPLAY").is_some()
        && std::env::var_os("WAYLAND_DISPLAY").is_none()
    {
        super::super::restore_app_windows(app);
    }
}
