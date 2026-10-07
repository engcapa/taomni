//! Open a screenshot in a real external image editor without tying the file's
//! lifetime to the capture session. No shell command strings are evaluated.

use super::{blocking, capture};
use std::path::Path;
use std::process::Command;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};

fn editor_command(path: &Path, editor: Option<&Path>) -> anyhow::Result<Command> {
    if let Some(editor) = editor {
        anyhow::ensure!(
            editor.is_absolute() && editor.exists(),
            "select an existing editor application"
        );
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
pub async fn screenshot_open_editor(
    path: String,
    editor: Option<String>,
) -> Result<String, String> {
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
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&dest);
            return Err(error);
        }
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
}

/// Re-edit a pin in a document window without capturing or hiding the desktop.
/// The pin keeps its original image; the user exports or creates a new pin.
#[tauri::command]
pub async fn screenshot_edit_pin(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if super::OPENING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("screenshot is opening".into());
    }
    let result = (|| {
        let pin = {
            let state = super::tool_state();
            if state.overlay.is_some() || state.recorder_open || state.scroll.is_some() {
                return Err("finish the current capture first".into());
            }
            state
                .pins
                .get(window.label())
                .cloned()
                .ok_or("not a pin window")?
        };
        let display = capture::display_at_cursor(&app).map_err(super::internal_error)?;
        let path = capture::temp_artifact_path("edit-pin", "png").map_err(super::internal_error)?;
        std::fs::copy(&pin.path, &path).map_err(|e| e.to_string())?;
        super::tool_state().overlay = Some(super::OverlayInit {
            path: path.to_string_lossy().into_owned(),
            width: pin.width,
            height: pin.height,
            display_id: display.id.clone(),
            scale_factor: display.scale_factor,
            window_region: None,
            document: true,
        });
        let editor = super::window_builder(
            &app,
            super::OVERLAY_LABEL,
            WebviewUrl::App("index.html#screenshot-overlay".into()),
        )
        .title("Screenshot editor")
        .inner_size(1000.0, 760.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        super::watch_session_window(&editor);
        editor.show().map_err(|e| e.to_string())?;
        editor.set_focus().map_err(|e| e.to_string())
    })();
    super::OPENING.store(false, std::sync::atomic::Ordering::SeqCst);
    if result.is_err() && app.get_webview_window(super::OVERLAY_LABEL).is_none() {
        super::tool_state().overlay = None;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_passes_one_literal_filename_without_a_shell() {
        let path = std::path::PathBuf::from("a b;$(not-a-command).png");
        let command = editor_command(&path, None).unwrap();
        assert_eq!(command.get_args().last().unwrap(), path.as_os_str());
        assert!(
            !["sh", "bash", "cmd", "powershell"]
                .iter()
                .any(|p| command.get_program() == *p)
        );
    }
    #[test]
    fn invalid_editor_is_rejected() {
        assert!(
            editor_command(Path::new("image.png"), Some(Path::new("relative-editor"))).is_err()
        );
    }
}
