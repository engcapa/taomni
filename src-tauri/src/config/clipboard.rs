use super::paths::clipboard_paths_from_uri_text;
use super::platform;
use crate::state::AppState;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn clipboard_read_text(state: State<'_, AppState>) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    if let Some(text) = platform::clipboard_read_text_fallback()? {
        return Ok(text);
    }

    let mut guard = state
        .clipboard
        .lock()
        .map_err(|e| format!("clipboard lock: {}", e))?;
    if guard.is_none() {
        *guard = arboard::Clipboard::new().ok();
    }
    let Some(clipboard) = guard.as_mut() else {
        #[cfg(target_os = "linux")]
        if let Some(text) = platform::clipboard_read_text_fallback()? {
            return Ok(text);
        }
        return Err("clipboard unavailable".to_string());
    };
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(error) => {
            #[cfg(target_os = "linux")]
            if let Some(text) = platform::clipboard_read_text_fallback()? {
                return Ok(text);
            }
            Err(format!("clipboard read: {}", error))
        }
    }
}

#[tauri::command]
pub fn clipboard_write_text(text: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state
        .clipboard
        .lock()
        .map_err(|e| format!("clipboard lock: {}", e))?;
    if guard.is_none() {
        *guard = arboard::Clipboard::new().ok();
    }
    let Some(clipboard) = guard.as_mut() else {
        #[cfg(target_os = "linux")]
        if platform::clipboard_write_text_fallback(&text).is_ok() {
            return Ok(());
        }
        return Err("clipboard unavailable".to_string());
    };
    match clipboard.set_text(text.clone()) {
        Ok(()) => Ok(()),
        Err(error) => {
            #[cfg(target_os = "linux")]
            if platform::clipboard_write_text_fallback(&text).is_ok() {
                return Ok(());
            }
            Err(format!("clipboard write: {}", error))
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardCapabilities {
    pub platform: String,
    pub display_backend: String,
    pub webkit_api_expected: bool,
    pub native_backend: String,
    pub wl_paste: bool,
    pub wl_copy: bool,
    pub xclip: bool,
    pub xsel: bool,
    pub html_rtf_native: bool,
}

/// Read-only diagnostics for the Linux WebKitGTK clipboard path. Helper
/// presence is reported separately from the current selection owner, because
/// probing ownership would change or block on user clipboard state.
#[tauri::command]
pub fn clipboard_capabilities() -> ClipboardCapabilities {
    #[cfg(target_os = "linux")]
    {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        let x11 = std::env::var_os("DISPLAY").is_some();
        return ClipboardCapabilities {
            platform: "linux".into(),
            display_backend: if wayland && x11 {
                "wayland+x11".into()
            } else if wayland {
                "wayland".into()
            } else if x11 {
                "x11".into()
            } else {
                "headless".into()
            },
            webkit_api_expected: true,
            native_backend: "arboard".into(),
            wl_paste: which::which("wl-paste").is_ok(),
            wl_copy: which::which("wl-copy").is_ok(),
            xclip: which::which("xclip").is_ok(),
            xsel: which::which("xsel").is_ok(),
            html_rtf_native: false,
        };
    }

    #[cfg(target_os = "windows")]
    {
        ClipboardCapabilities {
            platform: "windows".into(),
            display_backend: "win32".into(),
            webkit_api_expected: true,
            native_backend: "arboard".into(),
            wl_paste: false,
            wl_copy: false,
            xclip: false,
            xsel: false,
            html_rtf_native: false,
        }
    }

    #[cfg(target_os = "macos")]
    {
        ClipboardCapabilities {
            platform: "macos".into(),
            display_backend: "appkit".into(),
            webkit_api_expected: true,
            native_backend: "arboard".into(),
            wl_paste: false,
            wl_copy: false,
            xclip: false,
            xsel: false,
            html_rtf_native: false,
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        ClipboardCapabilities {
            platform: "unknown".into(),
            display_backend: "unknown".into(),
            webkit_api_expected: false,
            native_backend: "unknown".into(),
            wl_paste: false,
            wl_copy: false,
            xclip: false,
            xsel: false,
            html_rtf_native: false,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardMultiFormat {
    pub text: String,
    pub html: Option<String>,
    pub rtf: Option<String>,
}

#[tauri::command]
pub fn clipboard_read_multi_format() -> Result<ClipboardMultiFormat, String> {
    #[cfg(target_os = "macos")]
    {
        platform::clipboard_read_multi_format()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("native multi-format clipboard is only available on macOS".to_string())
    }
}

#[tauri::command]
pub fn clipboard_write_multi_format(payload: ClipboardMultiFormat) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::clipboard_write_multi_format(&payload)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = payload;
        Err("native multi-format clipboard is only available on macOS".to_string())
    }
}

#[tauri::command]
pub fn clipboard_read_files(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let _ = state;
    let native = platform::clipboard_read_files().unwrap_or_default();
    Ok(native)
}

#[tauri::command]
pub fn clipboard_parse_file_paths(text: String) -> Result<Vec<String>, String> {
    let files = clipboard_paths_from_uri_text(&text)
        .into_iter()
        .filter(|path| PathBuf::from(path.as_str()).exists())
        .collect();
    Ok(files)
}

#[tauri::command]
pub fn clipboard_write_files(paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    if platform::clipboard_write_files(&paths).is_ok() {
        return Ok(());
    }

    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    clipboard_write_text(crate::rdp::cliprdr::paths_to_uri_list(&path_bufs), state)
}
