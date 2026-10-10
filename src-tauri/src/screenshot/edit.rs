//! Open a screenshot in a real external image editor without tying the file's
//! lifetime to the capture session. No shell command strings are evaluated.

use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewUrl};
use std::process::Command;
use super::{blocking, capture};

fn editor_command(path: &Path, editor: Option<&Path>) -> anyhow::Result<Command> {
    if let Some(editor) = editor {
        anyhow::ensure!(editor.is_absolute() && editor.exists(), "select an existing editor application");
        #[cfg(target_os = "macos")]
        if editor.extension().is_some_and(|e| e == "app") {
            let mut cmd = Command::new("/usr/bin/open");
            cmd.arg("-a").arg(editor).arg(path);
            return Ok(cmd);
        }
        #[cfg(target_os = "linux")]
        if editor.extension().is_some_and(|e| e == "desktop") {
            let mut cmd = Command::new("gio");
            cmd.arg("launch").arg(editor).arg(path);
            return Ok(cmd);
        }
        anyhow::ensure!(editor.is_file(), "editor is not an executable file");
        let mut cmd = Command::new(editor);
        cmd.arg(path);
        return Ok(cmd);
    }
    #[cfg(target_os = "windows")]
    let mut cmd = Command::new("mspaint.exe");
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = Command::new("/usr/bin/open");
        cmd.args(["-a", "Preview"]);
        cmd
    };
    #[cfg(target_os = "linux")]
    let mut cmd = Command::new("xdg-open");
    cmd.arg(path);
    Ok(cmd)
}

/// A separate working copy survives closing the overlay or pin. The existing
/// 24h stale-artifact cleanup removes abandoned files on a later startup.
#[tauri::command]
pub async fn screenshot_open_editor(path: String, editor: Option<String>) -> Result<String, String> {
    blocking("open image editor", move || {
        let src = capture::ensure_artifact_path(&path)?;
        let dest = capture::untracked_artifact_path("external-edit", "png")?;
        std::fs::copy(src, &dest)?;
        let result = (|| -> anyhow::Result<()> {
            let mut cmd = editor_command(&dest, editor.as_deref().map(Path::new))?;
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            let mut child = cmd.spawn()?;
            // Reap the launcher without blocking the UI for the editor's lifetime.
            std::thread::spawn(move || { let _ = child.wait(); });
            Ok(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&dest);
            return Err(error);
        }
        Ok(dest.to_string_lossy().into_owned())
    }).await
}

/// Re-edit a pin in a document window without capturing the desktop.
/// Remember the source pin so Done can replace it or create another pin.
#[tauri::command]
pub async fn screenshot_edit_pin(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if super::OPENING.swap(true, std::sync::atomic::Ordering::SeqCst) { return Err("screenshot is opening".into()); }
    let mut owns_session = false;
    let result = (|| {
        let pin = {
            let state = super::tool_state();
            if state.overlay.is_some() || state.recorder_open || state.scroll.is_some() { return Err("finish the current capture first".into()); }
            state.pins.get(window.label()).cloned().ok_or("not a pin window")?
        };
        let display = capture::display_at_cursor(&app).map_err(super::internal_error)?;
        let lease = super::session::SessionLease::acquire()?.ok_or("another screenshot session is active")?;
        owns_session = true;
        super::tool_state().session_lease = Some(std::sync::Arc::new(lease));
        let path = capture::temp_artifact_path("edit-pin", "png").map_err(super::internal_error)?;
        std::fs::copy(&pin.path, &path).map_err(|e| e.to_string())?;
        super::tool_state().overlay = Some(super::OverlayInit {
            path: path.to_string_lossy().into_owned(), width: pin.width, height: pin.height,
            display_id: display.id.clone(), scale_factor: display.scale_factor, window_region: None, document: true,
            source_pin: Some(window.label().to_string()),
        });
        let editor = super::window_builder(&app, super::OVERLAY_LABEL, WebviewUrl::App("index.html#screenshot-overlay".into()))
            .title("Screenshot editor").inner_size(1000.0, 760.0).visible(false).build().map_err(|e| e.to_string())?;
        super::watch_session_window(&editor);
        configure_document_window(&editor, &display)?;
        // Topmost pins and their options must not cover the document editor.
        // Restore the visible windows on Done, Cancel or a native close.
        for (label, pin_window) in app.webview_windows() {
            if (label.starts_with(super::PIN_LABEL_PREFIX) || label.starts_with("screenshot-tools-"))
                && pin_window.is_visible().unwrap_or(false)
            {
                pin_window.hide().map_err(|e| e.to_string())?;
                super::tool_state().hidden.push(label);
            }
        }
        editor.show().map_err(|e| e.to_string())?;
        editor.set_focus().map_err(|e| e.to_string())
    })();
    if result.is_err() && owns_session {
        super::close_session(&app);
    }
    super::OPENING.store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

/// Turn the fullscreen selection surface into an ordinary resizable document.
pub(super) fn configure_document_window(window: &WebviewWindow, display: &capture::DisplayInfo) -> Result<(), String> {
    let scale = display.scale_factor.max(1.0);
    let width = (display.width as f64 / scale * 0.8).min(1100.0);
    let height = (display.height as f64 / scale * 0.8).min(800.0);
    // AppKit restores fullscreen/decorations with queued style masks. Set the
    // shared resizable flag first so those masks cannot restore the old fixed
    // selection-window style after set_resizable has already completed.
    window.set_resizable(true).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    window.set_simple_fullscreen(false).map_err(|e| e.to_string())?;
    window.set_fullscreen(false).map_err(|e| e.to_string())?;
    window.unmaximize().map_err(|e| e.to_string())?;
    window.set_always_on_top(false).map_err(|e| e.to_string())?;
    window.set_skip_taskbar(false).map_err(|e| e.to_string())?;
    window.set_decorations(true).map_err(|e| e.to_string())?;
    window.set_min_size(Some(tauri::LogicalSize::new(480.0_f64.min(width), 360.0_f64.min(height)))).map_err(|e| e.to_string())?;
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    window.set_position(tauri::PhysicalPosition::new(
        display.x + ((display.width as f64 - width * scale) / 2.0).round() as i32,
        display.y + ((display.height as f64 - height * scale) / 2.0).round() as i32,
    )).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn screenshot_update_pin(app: AppHandle, window: WebviewWindow, path: String) -> Result<(), String> {
    if window.label() != super::OVERLAY_LABEL { return Err("not a screenshot editor".into()); }
    let label = super::tool_state().overlay.as_ref().and_then(|o| o.source_pin.clone()).ok_or("editor has no source pin")?;
    let (dest, width, height) = blocking("update pin", move || {
        let source = capture::ensure_artifact_path(&path)?;
        let image = image::open(&source)?;
        let dest = capture::untracked_artifact_path("pin", "png")?;
        std::fs::copy(source, &dest)?;
        Ok((dest, image.width(), image.height()))
    }).await?;
    let changed = {
        let mut state = super::tool_state();
        if let Some(pin) = state.pins.get_mut(&label) {
            let old = std::mem::replace(&mut pin.path, dest.to_string_lossy().into_owned());
            pin.width = width; pin.height = height;
            // The saved favorite is a separate snapshot of the old pixels.
            pin.favorite_id = None;
            Some((old, pin.clone()))
        } else { None }
    };
    let Some((old, pin)) = changed else {
        let _ = std::fs::remove_file(dest);
        return Err("source pin is closed; create a new pin instead".into());
    };
    let _ = std::fs::remove_file(old);
    app.emit_to(&label, "screenshot://pin-updated", pin).map_err(|e| e.to_string())?;
    let _ = app.emit(super::pins::PINS_CHANGED_EVENT, ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_passes_one_literal_filename_without_a_shell() {
        let path = std::path::PathBuf::from("a b;$(not-a-command).png");
        let command = editor_command(&path, None).unwrap();
        assert_eq!(command.get_args().last().unwrap(), path.as_os_str());
        assert!(!["sh", "bash", "cmd", "powershell"].iter().any(|p| command.get_program() == *p));
    }
    #[test]
    fn invalid_editor_is_rejected() {
        assert!(editor_command(Path::new("image.png"), Some(Path::new("relative-editor"))).is_err());
    }
}
