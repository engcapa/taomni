use super::labels::OVERLAY_LABEL;
use super::labels::RECORDER_LABEL;
use crate::screenshot::capture;
use crate::screenshot::model::PhysicalRegion;
use crate::screenshot::model::RecordingFile;
use crate::screenshot::model::RecordingStarted;
use crate::screenshot::record;
use crate::screenshot::recording_controls::open_recorder_bar;
use crate::screenshot::recording_controls::recording_region;
use crate::screenshot::runtime::RecordingStartGuard;
use crate::screenshot::runtime::SESSION_GENERATION;
use crate::screenshot::runtime::STARTING_RECORDING;
use crate::screenshot::runtime::blocking;
use crate::screenshot::runtime::capture_lease;
use crate::screenshot::runtime::internal_error;
use crate::screenshot::runtime::tool_state;
use crate::screenshot::scroll_controls::capture_control_position;
use crate::screenshot::surfaces;
use crate::screenshot::window_lifecycle::HIDE_SETTLE;
use crate::screenshot::window_lifecycle::focus_capture_window;
use crate::screenshot::window_lifecycle::hide_app_windows;
use crate::screenshot::window_lifecycle::restore_app_windows;
use crate::screenshot::window_lifecycle::restore_app_windows_for_preview;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;

/// Start recording a display region (physical pixels; all of `x/y/w/h`
/// absent = whole display). The overlay closes; the hidden app windows stay
/// hidden until the session ends so the recorded area matches the frozen
/// screenshot the region was chosen on.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn screenshot_start_recording(
    app: AppHandle,
    display_id: Option<String>,
    x: Option<u32>,
    y: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
    format: String,
    fps: Option<u32>,
) -> Result<RecordingStarted, String> {
    let format = record::RecordFormat::parse(&format).map_err(internal_error)?;
    let region = recording_region(x, y, width, height)?;
    if STARTING_RECORDING.swap(true, Ordering::SeqCst) {
        return Err("screen recording is already starting".into());
    }
    let _start_guard = RecordingStartGuard;
    if tool_state().recorder_open {
        return Err("finish the current recording session first".into());
    }
    let capture_lease = capture_lease()?;
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let had_overlay = tool_state().overlay.is_some();
    let display = capture::resolve_display(&app, display_id.as_deref()).map_err(internal_error)?;
    let bounded = capture::clamp_region(
        display.width,
        display.height,
        region.unwrap_or((0, 0, display.width, display.height)),
    );
    capture_control_position(&app, &display, surfaces::region_rect(&display, bounded))?;
    if !tool_state().include_current_window {
        hide_app_windows(&app);
    }
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
    }
    if let Err(error) = open_recorder_bar(&app, &display, bounded).await {
        surfaces::close_borders(&app);
        if let Some(window) = app.get_webview_window(RECORDER_LABEL) {
            let _ = window.close();
        }
        if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = window.show();
        }
        if !had_overlay {
            restore_app_windows(&app);
        }
        return Err(error);
    }
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("screen recording start was cancelled".into());
    }
    let worker = app.clone();
    let started = blocking("start recording", move || {
        std::thread::sleep(HIDE_SETTLE);
        let id = record::start_recording(&worker, display.clone(), region, format, fps)?;
        Ok((id, display))
    })
    .await;
    let (recording_id, display) = match started {
        Ok(started) => started,
        Err(e) => {
            surfaces::close_borders(&app);
            if let Some(window) = app.get_webview_window(RECORDER_LABEL) {
                let _ = window.close();
            }
            if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
                let _ = window.show();
                focus_capture_window(&window).await;
            }
            if !had_overlay {
                restore_app_windows(&app);
            }
            return Err(e);
        }
    };
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        let id = recording_id.clone();
        let _ = blocking("cancel recording", move || record::cancel_recording(&id)).await;
        return Err("screen recording start was cancelled".into());
    }
    {
        let mut state = tool_state();
        state.recording = Some(recording_id.clone());
        state.recording_preview = None;
        state.session_lease = Some(capture_lease);
        state.recorder_open = true;
        state.overlay = None;
        let r = capture::clamp_region(
            display.width,
            display.height,
            region.unwrap_or((0, 0, display.width, display.height)),
        );
        state.recording_region = Some(PhysicalRegion {
            x: r.0,
            y: r.1,
            width: r.2,
            height: r.3,
        });
    }
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.close();
    }
    if capture_control_position(&app, &display, surfaces::region_rect(&display, bounded))?.is_some()
    {
        if let Some(window) = app.get_webview_window(RECORDER_LABEL) {
            let _ = window.show();
        }
    }
    Ok(RecordingStarted { recording_id })
}

#[tauri::command]
pub async fn screenshot_stop_recording(
    app: AppHandle,
    recording_id: String,
) -> Result<RecordingFile, String> {
    if tool_state().recording.as_deref() != Some(&recording_id) {
        return Err("unknown recording id".into());
    }
    let current_id = recording_id.clone();
    let info = blocking("stop recording", move || {
        record::stop_recording(&recording_id)
    })
    .await;
    {
        let mut state = tool_state();
        if state.recording.as_deref() == Some(&current_id) {
            state.recording = None;
            if info.is_ok() {
                state.recording_preview = Some(current_id.clone());
            }
        }
    }
    surfaces::close_borders(&app);
    // The recorder preview remains open after Stop, but the application
    // windows hidden for the capture session must become available again.
    // Without this, the process stays alive while its main window is hidden,
    // so macOS app switching has no visible Taomni window to activate.
    restore_app_windows_for_preview(&app);
    let info = info?;
    Ok(RecordingFile {
        path: info.path.to_string_lossy().into_owned(),
        width: info.width,
        height: info.height,
        frames: info.frames,
        duration_ms: info.duration_ms,
    })
}

#[tauri::command]
pub async fn screenshot_cancel_recording(
    app: AppHandle,
    recording_id: String,
) -> Result<(), String> {
    if tool_state().recording.as_deref() != Some(&recording_id) {
        return Err("unknown recording id".into());
    }
    let current_id = recording_id.clone();
    surfaces::close_borders(&app);
    let result = blocking("cancel recording", move || {
        record::cancel_recording(&recording_id)
    })
    .await;
    {
        let mut state = tool_state();
        if state.recording.as_deref() == Some(&current_id) {
            state.recording = None;
        }
    }
    result
}

/// The recorder bar window reads this to learn which recording it controls.
#[tauri::command]
pub async fn screenshot_current_recording() -> Result<Option<String>, String> {
    while STARTING_RECORDING.load(Ordering::SeqCst) && tool_state().recording.is_none() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(tool_state().recording.clone())
}

#[tauri::command]
pub async fn screenshot_recording_status() -> Result<Option<serde_json::Value>, String> {
    let (id, region) = {
        let state = tool_state();
        (state.recording.clone(), state.recording_region.clone())
    };
    Ok(id.map(|id| {
        let (finished, stopped_by_user) = record::recording_status(&id);
        serde_json::json!({ "recordingId": id, "finished": finished, "stoppedByUser": stopped_by_user, "region": region })
    }))
}
