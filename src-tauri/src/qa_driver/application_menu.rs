//! Inspect or activate the current AppKit menu without temporary Tauri handles.
use super::model::DriverState;
use super::response::error;
#[cfg(target_os = "macos")]
use super::response::ok;
use super::session::session_is_valid;
use axum::Json;
use axum::extract::{Path, State};
use axum::response::Response;
use serde::Deserialize;
use tauri::Runtime;

#[derive(Deserialize)]
pub(super) struct MenuRequest {
    path: Vec<usize>,
    #[serde(default)]
    activate: bool,
}

pub(super) async fn application_menu<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(request): Json<MenuRequest>,
) -> Response {
    if !session_is_valid(&session_id)
        || !cfg!(debug_assertions)
        || state.app.config().identifier != crate::QA_APP_ID
        || request.path.is_empty()
        || request.path.len() > 8
    {
        return error(
            "application menu access requires an isolated QA session and a valid menu path",
        );
    }
    #[cfg(target_os = "macos")]
    {
        use std::time::Duration;
        let window = match state.current_window() {
            Ok(window) => window,
            Err(message) => return error(message),
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Err(err) = state.app.run_on_main_thread(move || {
            let result = (|| -> Result<serde_json::Value, String> {
                use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
                use objc2_foundation::NSString;
                // SAFETY: AppKit access stays on its main thread. Retained
                // Cocoa objects preserve the installed JS action channels;
                // Tauri Menu::get/items wrappers would unregister on Drop.
                unsafe {
                    let application: Retained<AnyObject> =
                        msg_send![class!(NSApplication), sharedApplication];
                    let root: Option<Retained<AnyObject>> = msg_send![&*application, mainMenu];
                    let mut menu = root.ok_or("application menu is not installed")?;
                    for (depth, &index) in request.path.iter().enumerate() {
                        let count: isize = msg_send![&*menu, numberOfItems];
                        if index >= count as usize {
                            return Err(format!("menu path has no item at depth {depth}"));
                        }
                        let item: Retained<AnyObject> =
                            msg_send![&*menu, itemAtIndex: index as isize];
                        let submenu: Option<Retained<AnyObject>> = msg_send![&*item, submenu];
                        if depth + 1 < request.path.len() {
                            menu = submenu.ok_or("menu path crosses a leaf item")?;
                            continue;
                        }
                        let enabled: bool = msg_send![&*item, isEnabled];
                        let checked: isize = msg_send![&*item, state];
                        let title: Retained<NSString> = msg_send![&*item, title];
                        if request.activate {
                            if !enabled || submenu.is_some() {
                                return Err("activation requires an enabled leaf menu item".into());
                            }
                            let _: () = msg_send![&*application, activateIgnoringOtherApps: true];
                            window.show().map_err(|e| e.to_string())?;
                            window.set_focus().map_err(|e| e.to_string())?;
                            let _: () =
                                msg_send![&*menu, performActionForItemAtIndex: index as isize];
                        }
                        return Ok(serde_json::json!({
                            "path": request.path, "title": title.to_string(),
                            "enabled": enabled, "checked": checked == 1,
                            "activated": request.activate, "transport": "AppKit NSMenu",
                        }));
                    }
                    Err("menu path is empty".into())
                }
            })();
            let _ = tx.send(result);
        }) {
            return error(err.to_string());
        }
        return match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(Ok(value))) => ok(value),
            Ok(Ok(Err(message))) => error(message),
            _ => error("native application menu access timed out"),
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request.activate;
        error("native application menu access requires macOS")
    }
}
