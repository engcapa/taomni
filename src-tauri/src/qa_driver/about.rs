use super::model::DriverState;
use super::response::error;
use super::response::ok;
use super::session::session_is_valid;
use axum::extract::Path;
use axum::extract::State;
use axum::response::Response;
use serde_json::json;
use std::time::Duration;
use tauri::Runtime;
use tokio::sync::oneshot;

/// Activate the installed AppKit About item, including its real menu event and
/// frontend callback. No renderer state or app command is synthesized.
pub(super) async fn native_about<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    if !session_is_valid(&session_id)
        || !cfg!(debug_assertions)
        || state.app.config().identifier != crate::QA_APP_ID
    {
        return error("native About activation requires the isolated QA session");
    }
    #[cfg(target_os = "macos")]
    {
        let window = match state.current_window() {
            Ok(window) => window,
            Err(message) => return error(message),
        };
        let (tx, rx) = oneshot::channel();
        if let Err(err) = state.app.run_on_main_thread(move || {
            let result = (|| -> Result<String, String> {
                use objc2::{
                    class, msg_send,
                    rc::Retained,
                    runtime::{AnyObject, Sel},
                    sel,
                };
                use objc2_foundation::NSString;
                // SAFETY: AppKit access occurs on the main thread. Objects
                // remain retained by the installed menu. Do not enumerate
                // Tauri Menu::get/items: their temporary wrappers remove the
                // JS menu channels on Drop, before the queued event arrives.
                unsafe {
                    let application: Retained<AnyObject> =
                        msg_send![class!(NSApplication), sharedApplication];
                    let _: () = msg_send![&*application, activateIgnoringOtherApps: true];
                    window.show().map_err(|e| e.to_string())?;
                    window.set_focus().map_err(|e| e.to_string())?;
                    let menu: Option<Retained<AnyObject>> = msg_send![&*application, mainMenu];
                    let menu = menu.ok_or("application menu is not installed yet")?;
                    let count: isize = msg_send![&*menu, numberOfItems];
                    if count == 0 {
                        return Err("application submenu is not installed yet".into());
                    }
                    // buildAppMenuSpec installs About first in the first
                    // application submenu. Verify the actual custom selector
                    // so the predefined system About panel is never selected.
                    let app_item: Retained<AnyObject> = msg_send![&*menu, itemAtIndex: 0isize];
                    let submenu: Option<Retained<AnyObject>> = msg_send![&*app_item, submenu];
                    let submenu = submenu.ok_or("application submenu is not installed yet")?;
                    let count: isize = msg_send![&*submenu, numberOfItems];
                    if count == 0 {
                        return Err("About item is not installed yet".into());
                    }
                    let item: Retained<AnyObject> = msg_send![&*submenu, itemAtIndex: 0isize];
                    let action: Option<Sel> = msg_send![&*item, action];
                    if action != Some(sel!(customAction:)) {
                        return Err("custom About item is not installed yet".into());
                    }
                    let enabled: bool = msg_send![&*item, isEnabled];
                    if !enabled {
                        return Err("About item is disabled".into());
                    }
                    let title: Retained<NSString> = msg_send![&*item, title];
                    let _: () = msg_send![&*submenu, performActionForItemAtIndex: 0isize];
                    Ok(title.to_string())
                }
            })();
            let _ = tx.send(result);
        }) {
            return error(err.to_string());
        }
        return match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(Ok(title))) => {
                ok(json!({"activated": "about", "title": title, "transport": "AppKit NSMenu"}))
            }
            Ok(Ok(Err(message))) => error(message),
            _ => error("native About activation timed out"),
        };
    }
    #[cfg(not(target_os = "macos"))]
    error("native About activation requires macOS")
}
