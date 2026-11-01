//! The overlay open pipeline: isolate the app windows, capture the display,
//! then present the overlay with its base image already drawn.
//!
//! Startup work overlaps where invariants allow it (see `startup_profile`):
//! the hidden overlay window is built while the desktop is isolated and
//! captured (P1-2); Windows/macOS exclude the app windows from capture
//! instead of hiding them first (P1-6); Linux opens its capturer while the
//! windows hide (P1-3); and `show()` waits, bounded, for the renderer to
//! commit the base image (P0-1). The overlay is never shown before the
//! capture, so no Taomni surface can appear in it.

use super::OVERLAY_LABEL;
use super::capture;
use super::capture::DisplayInfo;
use super::capture_exclusion;
use super::model::OverlayInit;
use super::model::PhysicalRegion;
use super::overlay_handoff;
use super::overlay_session::watch_session_window;
#[cfg(target_os = "linux")]
use super::pins;
use super::runtime::SESSION_GENERATION;
use super::runtime::blocking;
use super::runtime::internal_error;
use super::runtime::tool_state;
use super::startup_profile;
use super::startup_profile::StartupProfile;
use super::startup_timing;
use super::window_lifecycle::HIDE_SETTLE;
use super::window_lifecycle::await_hidden_windows;
use super::window_lifecycle::cover_display;
use super::window_lifecycle::focus_capture_window;
use super::window_lifecycle::hide_app_windows;
use super::window_lifecycle::window_builder;
use image::RgbaImage;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindow;

type WindowTask = tauri::async_runtime::JoinHandle<Result<WebviewWindow, String>>;

pub(super) async fn open_overlay_inner(
    app: &AppHandle,
    display_id: Option<String>,
    current_window: Option<WebviewWindow>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if current_window.is_some() && pins::native_wayland() {
        // GDK returns a synthetic origin on Wayland. It must never be used
        // as a crop of the first output (or rejected only on another output).
        return Err("Wayland does not expose the current window's screen coordinates. Use Screen region and select the window on the desired display.".into());
    }
    startup_timing::reset();
    let profile = startup_profile::current();
    startup_timing::note("profile", profile_facts(&profile));
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    overlay_handoff::begin_pending(generation);
    let mut window_task = None;
    let result = run(
        app,
        display_id,
        current_window,
        generation,
        profile,
        &mut window_task,
    )
    .await;
    overlay_handoff::end_pending(generation);
    if let Some(task) = window_task {
        // The caller closes the overlay on failure; never let a build that is
        // still in flight create the window after that.
        let _ = task.await;
    }
    result
}

async fn run(
    app: &AppHandle,
    display_id: Option<String>,
    current_window: Option<WebviewWindow>,
    generation: u64,
    profile: StartupProfile,
    window_task: &mut Option<WindowTask>,
) -> Result<(), String> {
    capture::request_capture_permission(app)
        .await
        .map_err(internal_error)?;
    startup_timing::mark("permission");
    ensure_current(generation)?;
    // Start building only once capture is permitted: a denied permission
    // must not create (and then tear down) any overlay surface.
    if profile.early_window {
        *window_task = Some(spawn_overlay_window(app, profile.transparent));
    }
    let display = {
        let app = app.clone();
        blocking("display lookup", move || match display_id {
            Some(id) if !id.trim().is_empty() => capture::resolve_display(&app, Some(&id)),
            _ => capture::display_at_cursor(&app),
        })
        .await?
    };
    startup_timing::mark("display");
    let window_region = match &current_window {
        Some(window) => Some(current_window_region(window, &display)?),
        None => None,
    };
    tool_state().include_current_window = current_window.is_some();
    let (image, exclusion) = if current_window.is_some() {
        // Let the invoking options menu disappear before freezing the window.
        tokio::time::sleep(HIDE_SETTLE).await;
        startup_timing::note("isolation", json!("current-window"));
        startup_timing::mark("hide");
        (capture_now(app, &display).await?, None)
    } else {
        isolate_and_capture(app, &display, profile).await?
    };
    startup_timing::mark("capture");
    let (path, width, height) =
        blocking("save_png", move || capture::save_png(&image, "shot")).await?;
    startup_timing::mark("save_png");
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        std::fs::remove_file(path).ok();
        return Err("screenshot opening was cancelled".into());
    }
    let init = OverlayInit {
        path: path.to_string_lossy().into_owned(),
        display_id: display.id.clone(),
        width,
        height,
        scale_factor: display.scale_factor,
        window_region,
        document: false,
        source_pin: None,
        generation,
    };
    // Keep the pending payload out of ToolState until presentation. Otherwise
    // a repeated trigger can enter the active-overlay branch ahead of OPENING
    // and show this window before cover/ready complete.
    overlay_handoff::publish(init.clone())?;

    let window = match window_task.take() {
        Some(task) => task
            .await
            .map_err(|e| format!("open overlay window: {e}"))??,
        None => {
            let app = app.clone();
            let transparent = profile.transparent;
            tauri::async_runtime::spawn_blocking(move || open_window(&app, transparent))
                .await
                .map_err(|e| format!("open overlay window: {e}"))??
        }
    };
    startup_timing::mark("window_joined");
    cover_display(&window, &display).await?;
    startup_timing::mark("cover");
    if profile.ready_handshake {
        let ready = overlay_handoff::wait_ready(generation, profile.ready_timeout).await;
        startup_timing::note("readyBeforeShow", json!(ready));
        startup_timing::mark(if ready { "ready" } else { "ready_timeout" });
    }
    ensure_current(generation)?;
    window
        .show()
        .map_err(|e| format!("show overlay window: {e}"))?;
    tool_state().overlay = Some(init);
    startup_timing::note("showWallMs", json!(startup_timing::wall_clock_ms()));
    startup_timing::mark("show");
    if let Some(exclusion) = exclusion {
        // The overlay now covers the display: hide the excluded windows
        // behind it (session restore owns them from here) and drop the
        // exclusion only after their hide is queued.
        hide_app_windows(app);
        exclusion.release();
        startup_timing::mark("hide_after_show");
    }
    focus_capture_window(&window).await;
    startup_timing::mark("focus");
    Ok(())
}

fn ensure_current(generation: u64) -> Result<(), String> {
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("screenshot opening was cancelled".into());
    }
    Ok(())
}

fn current_window_region(
    window: &WebviewWindow,
    display: &DisplayInfo,
) -> Result<PhysicalRegion, String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let left = (pos.x - display.x).max(0) as u32;
    let top = (pos.y - display.y).max(0) as u32;
    let right =
        (pos.x as i64 + size.width as i64 - display.x as i64).clamp(0, display.width as i64) as u32;
    let bottom = (pos.y as i64 + size.height as i64 - display.y as i64)
        .clamp(0, display.height as i64) as u32;
    if right <= left || bottom <= top {
        return Err("current window is outside the selected display".into());
    }
    Ok(PhysicalRegion {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

async fn capture_now(app: &AppHandle, display: &DisplayInfo) -> Result<RgbaImage, String> {
    let app = app.clone();
    let display = display.clone();
    blocking("capture", move || {
        crate::servers::rdp::capture::stage_trace::observe(startup_timing::mark, || {
            capture::capture_display(&app, &display)
        })
    })
    .await
}

/// Keep the app windows out of the capture and take it. Returns the active
/// exclusion when the windows are still visible (Windows/macOS).
async fn isolate_and_capture(
    app: &AppHandle,
    display: &DisplayInfo,
    profile: StartupProfile,
) -> Result<(RgbaImage, Option<capture_exclusion::Exclusion>), String> {
    if profile.capture_exclusion && capture_exclusion::supported().is_some() {
        match capture_exclusion::exclude_app_windows(app).await {
            Ok(exclusion) => {
                startup_timing::note(
                    "isolation",
                    json!({"path": "exclusion", "api": capture_exclusion::supported(), "windows": exclusion.labels()}),
                );
                startup_timing::mark("hide");
                let image = capture_now(app, display).await?;
                return Ok((image, Some(exclusion)));
            }
            Err(error) => {
                log::warn!("screenshot capture exclusion unavailable, hiding instead: {error}");
                startup_timing::note("exclusionFallback", json!(error));
            }
        }
    }
    startup_timing::note("isolation", json!({"path": "hide"}));
    #[cfg(target_os = "linux")]
    if profile.capture_overlap {
        return Ok((capture_while_hiding(app, display).await?, None));
    }
    if hide_app_windows(app) {
        await_hidden_windows(app).await?;
    }
    startup_timing::mark("hide");
    Ok((capture_now(app, display).await?, None))
}

/// P1-3: the capturer opens on its own thread while the windows hide.
#[cfg(target_os = "linux")]
async fn capture_while_hiding(app: &AppHandle, display: &DisplayInfo) -> Result<RgbaImage, String> {
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let (hidden_tx, hidden_rx) = std::sync::mpsc::channel();
    let (image_tx, image_rx) = tokio::sync::oneshot::channel();
    let worker = app.clone();
    let target = display.clone();
    let cancel = tokio_util::sync::CancellationToken::new();
    let worker_cancel = cancel.clone();
    let lease = tool_state().session_lease.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        // close_session may cancel while portal consent is pending. Keep the
        // process lease alive until this worker's native resources are gone.
        let _lease = lease;
        capture::capture_after_hidden(&worker, &target, hidden_rx, image_tx, worker_cancel)
    });
    let hidden = if hide_app_windows(app) {
        await_hidden_windows(app).await
    } else {
        Ok(())
    };
    startup_timing::mark("hide");
    if let Err(error) = hidden {
        cancel.cancel();
        let _ = hidden_tx.send(None);
        // Retire native resources before the caller restores windows and
        // releases the process-wide session lease.
        let _ = task.await;
        return Err(error);
    }
    let hidden_at = std::time::Instant::now();
    let _ = hidden_tx.send(Some(hidden_at));
    tokio::pin!(image_rx);
    let result = loop {
        tokio::select! {
            result = &mut image_rx => break result
                .map_err(|_| "capture task failed".to_string())
                .and_then(|result| result.map_err(internal_error)),
            _ = tokio::time::sleep(Duration::from_millis(25)) => {
                if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
                    cancel.cancel();
                    break Err("screenshot opening was cancelled".into());
                }
            },
        }
    };
    // This includes portal closure, so a subsequent open never overlaps an
    // orphaned authorization session from this attempt.
    task.await
        .map_err(|e| format!("capture task failed: {e}"))?;
    result
}

/// P1-2: build the hidden overlay window concurrently with the capture.
fn spawn_overlay_window(app: &AppHandle, transparent: bool) -> WindowTask {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || open_window(&app, transparent))
}

/// Build the hidden overlay surface and attach the session close handling.
fn open_window(app: &AppHandle, transparent: bool) -> Result<WebviewWindow, String> {
    wait_for_closed_overlay(app);
    // Only the exact `#screenshot-overlay` route makes the page transparent
    // (index.html); an opaque window keeps the theme background.
    let route = if transparent {
        "index.html#screenshot-overlay"
    } else {
        "index.html#screenshot-overlay-opaque"
    };
    let url = WebviewUrl::App(route.into());
    let window = window_builder(app, OVERLAY_LABEL, url)
        .title("Screenshot")
        .visible(false)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(transparent)
        .build()
        .map_err(|e| format!("open overlay window: {e}"))?;
    startup_timing::mark("window_built");
    watch_session_window(&window);
    Ok(window)
}

/// A previous overlay can still be closing when the next open starts early.
fn wait_for_closed_overlay(app: &AppHandle) {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while app.get_webview_window(OVERLAY_LABEL).is_some() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(15));
    }
}

fn profile_facts(profile: &StartupProfile) -> serde_json::Value {
    json!({
        "earlyWindow": profile.early_window,
        "readyHandshake": profile.ready_handshake,
        "readyTimeoutMs": profile.ready_timeout.as_millis() as u64,
        "transparent": profile.transparent,
        "captureOverlap": profile.capture_overlap,
        "captureExclusion": profile.capture_exclusion,
        "exclusionApi": capture_exclusion::supported(),
    })
}
