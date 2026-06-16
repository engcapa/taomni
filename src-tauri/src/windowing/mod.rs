//! Generic detached-session OS window builder.
//!
//! The original SFTP detach feature used a dedicated
//! `filebrowser::open_sftp_window` command. We now serve every kind of
//! detached session (sftp, rdp, vnc, terminal, database) through a single
//! `open_detached_window` command that carries a `kind` argument and
//! constructs the window label / URL fragment accordingly.
//!
//! The frontend handoff layer
//! (`src/lib/detachedSession.ts` + `DetachedSessionWindow` route) is the
//! source of truth for which `kind` strings are valid. Anything else
//! lands in the catch-all error branch below.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Default size for a detached window, picked per kind. RDP/VNC need
/// more breathing room than a shell.
fn default_size(kind: &str) -> (f64, f64, f64, f64) {
    match kind {
        "rdp" | "vnc" => (1280.0, 800.0, 800.0, 480.0),
        "terminal" => (1024.0, 680.0, 640.0, 360.0),
        "database" => (1280.0, 820.0, 780.0, 480.0),
        // A detached LanChat conversation is a compact chat window.
        "lan-chat" => (380.0, 560.0, 320.0, 400.0),
        // SFTP keeps its historical default so existing user layouts
        // don't shift after the migration.
        "sftp" => (1200.0, 760.0, 720.0, 420.0),
        _ => (1100.0, 720.0, 640.0, 360.0),
    }
}

fn label_for(kind: &str, session_id: &str) -> String {
    let safe: String = session_id
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    format!("{}-{}", kind, safe)
}

fn validate_kind(kind: &str) -> Result<(), String> {
    match kind {
        "sftp" | "rdp" | "vnc" | "terminal" | "database" | "lan-chat" => Ok(()),
        other => Err(format!("unsupported detached window kind: {}", other)),
    }
}

/// Build (or focus) a detached-session window for `(kind, session_id)`.
///
/// The frontend writes credentials to localStorage *before* invoking so
/// the new window can pick them up via `consumeDetachedHandoff`. If the
/// label already exists (re-clicking Detach for the same tab) we just
/// focus the existing window instead of duplicating it.
#[tauri::command]
pub async fn open_detached_window(
    app_handle: AppHandle,
    kind: String,
    session_id: String,
    title: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    validate_kind(&kind)?;
    let label = label_for(&kind, &session_id);
    if let Some(existing) = app_handle.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    // Path fragment routing matches the SFTP precedent: WebviewUrl::App
    // wraps a PathBuf and Tauri does NOT percent-encode the fragment,
    // so we can safely round-trip a session id with non-URL-safe chars.
    let path_str = format!("index.html#{}={}", kind, session_id);
    log::info!(
        "Opening detached window kind={} label={} path={}",
        kind,
        label,
        path_str
    );
    let url = WebviewUrl::App(std::path::PathBuf::from(path_str));
    let resolved_title = title.unwrap_or_else(|| match kind.as_str() {
        "sftp" => format!("SFTP — {}", session_id),
        "rdp" => format!("RDP — {}", session_id),
        "vnc" => format!("VNC — {}", session_id),
        "terminal" => format!("Terminal — {}", session_id),
        "database" => format!("Database — {}", session_id),
        "lan-chat" => "内网通讯".to_string(),
        _ => session_id.clone(),
    });
    let (default_w, default_h, min_w, min_h) = default_size(&kind);
    let final_w = width.unwrap_or(default_w);
    let final_h = height.unwrap_or(default_h);
    let builder = WebviewWindowBuilder::new(&app_handle, &label, url)
        .title(&resolved_title)
        .inner_size(final_w, final_h)
        .min_inner_size(min_w, min_h)
        .resizable(true)
        .enable_clipboard_access();

    // Keep the SFTP-precedent platform tweak: on Windows we let the
    // webview's HTML5 dragstart/over/drop events fire normally. Linux
    // and macOS keep Tauri file-drop enabled because it provides
    // absolute paths the SFTP/terminal panes consume.
    #[cfg(windows)]
    let builder = builder.disable_drag_drop_handler();

    builder
        .build()
        .map_err(|e| format!("failed to open detached window: {}", e))?;
    Ok(())
}

/// Close the webview that invoked the command.
///
/// The detached-session restore flow uses this instead of the JS window API so
/// it is not affected by frontend window permission or close-request lifecycle
/// quirks. `destroy` avoids dispatching another close-request reattach pass.
#[tauri::command]
pub async fn close_current_detached_window(window: WebviewWindow) -> Result<(), String> {
    window
        .destroy()
        .map_err(|e| format!("failed to close detached window: {}", e))
}
