use super::*;

#[cfg(target_os = "linux")]
pub(super) fn x11_window_id(window: &WebviewWindow) -> Option<u32> {
    use gtk::glib::translate::ToGlibPtr;
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            use gtk::prelude::*;
            let xid = target.gtk_window().ok().and_then(|gtk| {
                if gtk.display().type_().name() != "GdkX11Display" {
                    return None;
                }
                gtk.realize();
                let surface = gtk.window()?;
                // SAFETY: the live surface is a GdkX11 window owned by this thread.
                Some(unsafe { gdk_x11_window_get_xid(surface.to_glib_none().0) })
            });
            let _ = tx.send(xid);
        })
        .ok()?;
    rx.recv_timeout(Duration::from_secs(5)).ok().flatten()
}

/// Read-only desktop probe (xprop, xrandr, gsettings, gdbus).
#[cfg(target_os = "linux")]
pub(super) async fn desktop_probe(program: &'static str, args: Vec<String>) -> Value {
    let echoed = args.clone();
    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new(program)
            .args(&args)
            .output()
            .map(|output| {
                json!({
                    "success": output.status.success(),
                    "stdout": String::from_utf8_lossy(&output.stdout).trim().to_string(),
                    "stderr": String::from_utf8_lossy(&output.stderr).trim().to_string(),
                })
            })
            .unwrap_or_else(|e| json!({"success": false, "error": e.to_string()}))
    })
    .await;
    match result {
        Ok(mut value) => {
            value["program"] = json!(program);
            value["args"] = json!(echoed);
            value
        }
        Err(error) => {
            json!({"program": program, "args": echoed, "success": false, "error": error.to_string()})
        }
    }
}

/// Parses "_NET_WM_BYPASS_COMPOSITOR(CARDINAL) = 2".
///
/// The atom name before the type suffix must match exactly: a lookalike such as
/// _NET_WM_BYPASS_COMPOSITOR_FAKE must never satisfy the real property.
#[cfg(any(target_os = "linux", test))]
pub(super) fn x11_cardinal(stdout: &str, name: &str) -> Option<u32> {
    stdout.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        let atom = key.trim().split('(').next().unwrap_or("").trim();
        if atom != name {
            return None;
        }
        value.trim().parse::<u32>().ok()
    })
}

/// Parses "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3e00007".
#[cfg(any(target_os = "linux", test))]
pub(super) fn x11_parse_window_id(stdout: &str) -> Option<u32> {
    let text = stdout.split('#').nth(1)?.trim();
    u32::from_str_radix(text.trim_start_matches("0x"), 16).ok()
}

/// X screen size exactly as the X11 capturer reads the root window.
#[cfg(target_os = "linux")]
pub(super) fn x11_screen_size() -> Option<(u16, u16)> {
    use x11rb::connection::Connection;
    let (connection, screen) = x11rb::connect(None).ok()?;
    let root = &connection.setup().roots[screen];
    Some((root.width_in_pixels, root.height_in_pixels))
}

/// Displays as the product enumerates them, including per-display scale.
pub(super) fn display_facts(app: &AppHandle) -> Value {
    capture::list_displays(app)
        .map(|displays| {
            json!(
                displays
                    .iter()
                    .map(|d| json!({
                        "id": d.id,
                        "name": d.name,
                        "x": d.x,
                        "y": d.y,
                        "width": d.width,
                        "height": d.height,
                        "scaleFactor": d.scale_factor,
                        "primary": d.primary,
                    }))
                    .collect::<Vec<_>>()
            )
        })
        .unwrap_or(Value::Null)
}

/// One desktop-state sample shared by both overlay scenarios: X screen size
/// (X11), the product's display geometry/scale, and the raw RandR mode list.
pub(super) async fn display_state_sample(app: &AppHandle) -> Value {
    let mut sample = json!({ "displays": display_facts(app) });
    #[cfg(target_os = "linux")]
    if !wayland::active() {
        if let Some((width, height)) = x11_screen_size() {
            sample["screenSize"] = json!([width, height]);
        }
        let randr = desktop_probe("xrandr", vec!["--current".into()]).await;
        let text = randr["stdout"].as_str().unwrap_or("");
        sample["randr"] = json!(text.chars().take(4000).collect::<String>());
    }
    sample
}

/// The values that must stay identical while the overlay is open. A display
/// reconfiguration (the #718 failure) changes the screen size or a scale.
pub(super) fn display_state_signature(sample: &Value) -> Value {
    json!({
        "screenSize": sample.get("screenSize").cloned().unwrap_or(Value::Null),
        "displays": sample.get("displays").cloned().unwrap_or(Value::Null),
    })
}

/// Real window-manager foreground state for one of our windows.
pub(super) async fn x11_foreground(window: &WebviewWindow) -> Value {
    #[cfg(target_os = "linux")]
    if !wayland::active() {
        let xid = x11_window_id(window);
        let active =
            desktop_probe("xprop", vec!["-root".into(), "_NET_ACTIVE_WINDOW".into()]).await;
        let active_id = x11_parse_window_id(active["stdout"].as_str().unwrap_or(""));
        return json!({
            "windowId": xid,
            "activeWindowId": active_id,
            "isActiveWindow": xid.is_some() && xid == active_id,
            "activeWindowProperty": active,
        });
    }
    let _ = window;
    Value::Null
}

/// Focus evidence for the overlay before any pointer interaction: the WM's
/// active window, the toolkit state and the renderer's own document focus.
pub(super) async fn overlay_focus_state(overlay: &WebviewWindow) -> Value {
    let mut state = json!({
        "windowFocused": overlay.is_focused().unwrap_or(false),
        "windowVisible": overlay.is_visible().unwrap_or(false),
        "dom": eval_raw(
            overlay,
            "({hasFocus:document.hasFocus(),activeTestId:document.activeElement?.dataset?.testid ?? null})"
                .into(),
            Duration::from_secs(5),
        )
        .await,
    });
    #[cfg(target_os = "linux")]
    if !wayland::active() {
        let xid = x11_window_id(overlay);
        let active =
            desktop_probe("xprop", vec!["-root".into(), "_NET_ACTIVE_WINDOW".into()]).await;
        let active_id = x11_parse_window_id(active["stdout"].as_str().unwrap_or(""));
        state["x11"] = json!({
            "windowId": xid,
            "activeWindowId": active_id,
            "activeWindowProperty": active,
            "isActiveWindow": xid.is_some() && xid == active_id,
        });
    }
    state
}

/// The regression guard for SHOT-N24: the overlay must own keyboard focus on
/// open. On X11 the window manager's active window and the toolkit state must
/// both agree; elsewhere the toolkit state is the available evidence.
pub(super) fn focus_is_established(state: &Value) -> bool {
    if state["windowFocused"] != json!(true) {
        return false;
    }
    match state.get("x11") {
        Some(x11) if !x11.is_null() => x11["isActiveWindow"] == json!(true),
        _ => true,
    }
}

/// Any window the screenshot tool owns and must clean up after itself.
pub(super) fn capture_window_label(label: &str) -> bool {
    label == super::super::OVERLAY_LABEL
        || label == super::super::RECORDER_LABEL
        || label == super::super::surfaces::SCROLL_LABEL
        || label.starts_with(super::super::surfaces::BORDER_PREFIX)
        || label.starts_with(super::super::PIN_LABEL_PREFIX)
}

/// How the single Escape below reaches the OS, recorded with the evidence.
pub(super) fn os_input_transport() -> &'static str {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        return "OS keyboard via owned Mutter broker";
    }
    if cfg!(target_os = "windows") {
        "OS keyboard via SendInput"
    } else if cfg!(target_os = "macos") {
        "OS keyboard via CGEvent"
    } else {
        "OS keyboard via XTest"
    }
}

/// Environment precondition for the #718 acceptance: Ubuntu's X11 fractional
/// scaling feature is enabled and at least one monitor uses a fractional scale.
#[cfg(target_os = "linux")]
pub(super) async fn x11_fractional_scaling_evidence() -> Value {
    let features = desktop_probe(
        "gsettings",
        vec![
            "get".into(),
            "org.gnome.mutter".into(),
            "experimental-features".into(),
        ],
    )
    .await;
    let config = desktop_probe(
        "gdbus",
        vec![
            "call".into(),
            "--session".into(),
            "--dest".into(),
            "org.gnome.Mutter.DisplayConfig".into(),
            "--object-path".into(),
            "/org/gnome/Mutter/DisplayConfig".into(),
            "--method".into(),
            "org.gnome.Mutter.DisplayConfig.GetCurrentState".into(),
        ],
    )
    .await;
    let text = config["stdout"].as_str().unwrap_or("");
    let mut scales: Vec<String> = Vec::new();
    for part in text.split("'scale':").skip(1) {
        let value: String = part
            .trim_start()
            .trim_start_matches('<')
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if !value.is_empty() && !scales.contains(&value) {
            scales.push(value);
        }
    }
    let enabled = features["stdout"]
        .as_str()
        .is_some_and(|text| text.contains("x11-randr-fractional-scaling"));
    json!({
        "experimentalFeatures": features,
        "displayConfigOk": config["success"],
        "displayConfig": text.chars().take(4000).collect::<String>(),
        "x11FractionalScalingEnabled": enabled,
        "scales": scales,
        "hasFractionalScale": scales
            .iter()
            .any(|scale| scale.parse::<f64>().is_ok_and(|value| value.fract() != 0.0)),
    })
}

/// Whether any real scale is fractional, from the compositor's DisplayConfig
/// scales and the product's per-display scale samples.
///
/// This is an observation, not a gate: false only records that this run never
/// exercised the fractional-scaling path (for example the Xvfb CI desktop).
#[cfg(any(target_os = "linux", test))]
pub(super) fn has_fractional_scale(evidence: &Value, samples: &[Value]) -> bool {
    let from_config = evidence["scales"].as_array().is_some_and(|scales| {
        scales.iter().any(|scale| {
            scale
                .as_str()
                .and_then(|text| text.parse::<f64>().ok())
                .is_some_and(|value| value.fract() != 0.0)
        })
    });
    from_config
        || samples.iter().any(|sample| {
            sample["displays"].as_array().is_some_and(|displays| {
                displays.iter().any(|display| {
                    display["scaleFactor"]
                        .as_f64()
                        .is_some_and(|scale| scale.fract() != 0.0)
                })
            })
        })
}

/// Real OS Escape with no pointer interaction at all.
///
/// The decisive assertion is the focus state *before* the key: on the reporting
/// GNOME/X11 machine Escape worked only after the user clicked the overlay, so
/// "Escape closes it" alone proves nothing there. The three display samples
/// distinguish "the focus policy refused activation" from "a display
/// reconfiguration (#718) took focus away".
#[tauri::command]
pub async fn screenshot_qa_escape_entry(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(&app);
    let main = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    let main_before = json!({
        "visible": main_visible(&app),
        "focused": main.is_focused().unwrap_or(false),
    });
    let sample_before = display_state_sample(&app).await;
    super::super::open_overlay(&app, None).await?;
    let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(15))
        .await
        .map_err(|e| format!("{e:#}"))?;
    // Readiness observation only. The scenario never clicks, drags or types
    // before the Escape, so the key must work from the product's own focus.
    run_js(
        &overlay,
        r#"
      for (let i = 0; i < 150; i++) {
        if (document.querySelector('[data-testid="screenshot-overlay"]')?.dataset.phase === 'select') return true;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('overlay never reached the select phase');
    "#,
        Duration::from_secs(20),
    )
    .await
    .map_err(|e| e.to_string())?;
    let sample_after_open = display_state_sample(&app).await;
    // Give the product's own focus handoff its bounded window, then record the
    // state a user would rely on before pressing Escape.
    let focus_deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < focus_deadline && !overlay.is_focused().unwrap_or(false) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let focus = overlay_focus_state(&overlay).await;
    let sample_before_key = display_state_sample(&app).await;
    let stable = display_state_signature(&sample_before)
        == display_state_signature(&sample_after_open)
        && display_state_signature(&sample_before) == display_state_signature(&sample_before_key);
    let focused = focus_is_established(&focus);
    let started = Instant::now();
    os_stop_input(false)
        .await
        .map_err(|e| format!("OS Escape delivery failed: {e:#}"))?;
    let delivery_ms = started.elapsed().as_millis() as u64;
    let closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let leftover: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| capture_window_label(label))
        .cloned()
        .collect();
    let main_after = json!({
        "visible": main_visible(&app),
        "focused": main.is_focused().unwrap_or(false),
        "x11": x11_foreground(&main).await,
    });
    let restored = main_after["visible"] == json!(true);
    let ok = focused && stable && closed && leftover.is_empty() && restored;
    Ok(report(
        ok,
        json!({
            "scenario": "escape-entry",
            "platform": platform(),
            "appPid": std::process::id(),
            "pointerInput": "none",
            "mainBefore": main_before,
            "mainAfter": main_after,
            "overlay": {"label": super::super::OVERLAY_LABEL, "title": overlay.title().unwrap_or_default()},
            "focus": focus,
            "focusEstablished": focused,
            "displayStable": stable,
            "displaySamples": {
                "before": sample_before,
                "afterOpen": sample_after_open,
                "beforeKey": sample_before_key,
            },
            "keyDelivery": {
                "key": "Escape",
                "pid": std::process::id(),
                "transport": os_input_transport(),
                "elapsedMs": delivery_ms,
            },
            "overlayClosed": closed,
            "leftoverWindows": leftover,
        }),
    ))
}

/// _NET_WM_BYPASS_COMPOSITOR = 2 on the overlay plus identical display samples:
/// the #718 fix must keep mutter from unredirecting the surface, which is what
/// re-applies the whole display configuration on Ubuntu X11.
///
/// Any X11 session can prove the property and the display stability (the Xvfb CI
/// desktop included). Whether that session also uses fractional scaling is
/// recorded as [fractionalScaling]; false means the fractional-scaling path was
/// not exercised by this run and is an explicit audit note, not a failure.
/// Only a non-X11 session (Wayland) is unavailable.
#[tauri::command]
pub async fn screenshot_qa_x11_compositor_bypass(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = &app;
        return Ok(report(
            false,
            json!({
                "scenario": "x11-compositor-bypass",
                "reason": "_NET_WM_BYPASS_COMPOSITOR and X screen sampling require an X11 Linux session",
                "platform": platform(),
            }),
        ));
    }
    #[cfg(target_os = "linux")]
    {
        let x11_session = !wayland::active() && std::env::var_os("DISPLAY").is_some();
        if !x11_session {
            return Ok(report(
                false,
                json!({
                    "scenario": "x11-compositor-bypass",
                    "reason": "requires an X11 (non-Wayland) Linux session",
                    "platform": platform(),
                    "wayland": wayland::active(),
                    "display": std::env::var("DISPLAY").ok(),
                }),
            ));
        }
        let _cleanup = ScenarioCleanup(app.clone());
        super::super::close_session(&app);
        let main = app
            .get_webview_window("main")
            .ok_or("main window unavailable")?;
        let scaling = x11_fractional_scaling_evidence().await;
        let sample_before = display_state_sample(&app).await;
        super::super::open_overlay(&app, None).await?;
        let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(15))
            .await
            .map_err(|e| format!("{e:#}"))?;
        run_js(
            &overlay,
            r#"
      for (let i = 0; i < 150; i++) {
        if (document.querySelector('[data-testid="screenshot-overlay"]')?.dataset.phase === 'select') return true;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('overlay never reached the select phase');
    "#,
            Duration::from_secs(20),
        )
        .await
        .map_err(|e| e.to_string())?;
        let sample_after_open = display_state_sample(&app).await;
        // Repaint the frozen surface the way the reporter does (pointer motion
        // without buttons) so mutter's unredirect path would engage unfixed.
        let display = capture::resolve_display(&app, None).map_err(|e| e.to_string())?;
        let scale = display.scale_factor.max(1.0);
        let center = (
            (display.x as f64 + display.width as f64 / 2.0) as i32,
            (display.y as f64 + display.height as f64 / 2.0) as i32,
        );
        let mut motion = Vec::new();
        for point in [
            (center.0 - 24, center.1 - 16),
            (center.0 + 24, center.1 + 16),
            (center.0 - 16, center.1 + 8),
            center,
        ] {
            motion.push(point);
            park_pointer(input_point(point, scale))
                .await
                .map_err(|e| format!("OS pointer motion failed: {e:#}"))?;
            tokio::time::sleep(Duration::from_millis(140)).await;
        }
        // mutter only unredirects a fullscreen window after ~100 full-damage
        // frames, so sample after that window has certainly passed.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let sample_during = display_state_sample(&app).await;
        let xid = x11_window_id(&overlay);
        let properties = match xid {
            Some(id) => {
                let id_text = id.to_string();
                json!({
                    "xid": id,
                    "bypassCompositor": desktop_probe(
                        "xprop",
                        vec!["-id".into(), id_text.clone(), "_NET_WM_BYPASS_COMPOSITOR".into()],
                    )
                    .await,
                    "netWmState": desktop_probe(
                        "xprop",
                        vec!["-id".into(), id_text, "_NET_WM_STATE".into()],
                    )
                    .await,
                })
            }
            None => json!({"xid": Value::Null, "error": "overlay has no X11 window id"}),
        };
        let bypass = properties["bypassCompositor"]["stdout"]
            .as_str()
            .and_then(|stdout| x11_cardinal(stdout, "_NET_WM_BYPASS_COMPOSITOR"));
        let fullscreen = properties["netWmState"]["stdout"]
            .as_str()
            .is_some_and(|stdout| stdout.contains("_NET_WM_STATE_FULLSCREEN"));
        let started = Instant::now();
        os_stop_input(false)
            .await
            .map_err(|e| format!("OS Escape delivery failed: {e:#}"))?;
        let delivery_ms = started.elapsed().as_millis() as u64;
        let closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let sample_after = display_state_sample(&app).await;
        let leftover: Vec<String> = app
            .webview_windows()
            .keys()
            .filter(|label| capture_window_label(label))
            .cloned()
            .collect();
        let main_after = json!({
            "visible": main_visible(&app),
            "focused": main.is_focused().unwrap_or(false),
            "x11": x11_foreground(&main).await,
        });
        let stable = display_state_signature(&sample_before)
            == display_state_signature(&sample_after_open)
            && display_state_signature(&sample_before) == display_state_signature(&sample_during)
            && display_state_signature(&sample_before) == display_state_signature(&sample_after);
        let fractional = has_fractional_scale(
            &scaling,
            &[
                sample_before.clone(),
                sample_after_open.clone(),
                sample_during.clone(),
                sample_after.clone(),
            ],
        );
        let ok = bypass == Some(2)
            && stable
            && closed
            && leftover.is_empty()
            && main_after["visible"] == json!(true);
        Ok(report(
            ok,
            json!({
                "scenario": "x11-compositor-bypass",
                "platform": platform(),
                "appPid": std::process::id(),
                "scalingEvidence": scaling,
                "fractionalScaling": fractional,
                "fractionalScalingNote": if fractional {
                    Value::Null
                } else {
                    json!("no fractional monitor scale observed in this run; the fractional-scaling path was not exercised, which is recorded rather than passed")
                },
                "displayStable": stable,
                "displaySamples": {
                    "before": sample_before,
                    "afterOpen": sample_after_open,
                    "during": sample_during,
                    "after": sample_after,
                },
                "overlay": properties,
                "bypassCompositor": bypass,
                "fullscreen": fullscreen,
                "pointerMotion": {"kind": "OS pointer motion only, no buttons", "points": motion},
                "keyDelivery": {
                    "key": "Escape",
                    "pid": std::process::id(),
                    "transport": os_input_transport(),
                    "elapsedMs": delivery_ms,
                },
                "overlayClosed": closed,
                "mainAfter": main_after,
                "leftoverWindows": leftover,
            }),
        ))
    }
}
