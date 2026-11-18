use super::model::DriverState;
use super::response::{error, ok};
use super::session::session_is_valid;
use axum::Json;
use axum::extract::{Path, State};
use axum::response::Response;
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::{NSPoint, NSRect};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use tauri::Runtime;
use tokio::sync::oneshot;

#[derive(Deserialize)]
pub(super) struct Drag {
    points: Vec<[i32; 2]>,
}

/// The DOM action bridge cannot invoke WKWebView's default text selection.
/// Post AppKit events to this QA application's window so WebKit owns selection.
pub(super) async fn drag<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(drag): Json<Drag>,
) -> Response {
    if !session_is_valid(&session_id) || state.app.config().identifier != crate::QA_APP_ID {
        return error("AppKit drag requires the isolated QA session");
    }
    if !(2..=61).contains(&drag.points.len()) {
        return error("AppKit drag requires 2–61 viewport points");
    }
    let window = match state.current_window() {
        Ok(window) => window,
        Err(message) => return error(message),
    };
    let (sender, receiver) = oneshot::channel();
    if let Err(cause) = window.with_webview(move |webview| {
        let result = unsafe { post_drag(webview.inner().cast(), &drag.points) };
        let _ = sender.send(result);
    }) {
        return error(format!("AppKit drag could not start: {cause}"));
    }
    match tokio::time::timeout(Duration::from_secs(10), receiver).await {
        Ok(Ok(Ok(()))) => ok(json!({"transport": "appkit-window-events"})),
        Ok(Ok(Err(message))) => error(message),
        _ => error("AppKit drag did not finish queueing events; delivery is uncertain"),
    }
}

unsafe fn post_drag(view: *mut AnyObject, points: &[[i32; 2]]) -> Result<(), String> {
    let view = unsafe { view.as_ref() }.ok_or("WKWebView is unavailable")?;
    // The callback runs on the AppKit thread, and all coordinates stay inside
    // the verified WebView. Prepare the full gesture before queueing mouse-down.
    unsafe {
        let window: *mut AnyObject = msg_send![view, window];
        let window = window.as_ref().ok_or("WKWebView has no AppKit window")?;
        let visible: bool = msg_send![window, isVisible];
        if !visible {
            return Err("the AppKit window is hidden".into());
        }
        let number: isize = msg_send![window, windowNumber];
        let bounds: NSRect = msg_send![view, bounds];
        let flipped: bool = msg_send![view, isFlipped];
        let process: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
        let uptime: f64 = msg_send![&*process, systemUptime];
        let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
        let mut events = Vec::with_capacity(points.len() + 1);
        for (index, &[x, y]) in points.iter().chain(points.last()).enumerate() {
            let x = f64::from(x);
            let y = f64::from(y);
            if !(0.0..bounds.size.width).contains(&x) || !(0.0..bounds.size.height).contains(&y) {
                return Err("a drag point lies outside the WKWebView".into());
            }
            let local_y = if flipped { y } else { bounds.size.height - y };
            let local = NSPoint::new(bounds.origin.x + x, bounds.origin.y + local_y);
            let location: NSPoint =
                msg_send![view, convertPoint: local, toView: std::ptr::null::<AnyObject>()];
            // NSEventType::leftMouseDown, leftMouseDragged and leftMouseUp.
            let (event_type, pressure) = match index {
                0 => (1usize, 1f32),
                index if index == points.len() => (2, 0f32),
                _ => (6, 1f32),
            };
            let event: Option<Retained<AnyObject>> = msg_send![class!(NSEvent),
                mouseEventWithType: event_type, location: location, modifierFlags: 0usize,
                timestamp: uptime, windowNumber: number, context: std::ptr::null::<AnyObject>(),
                eventNumber: index as isize, clickCount: 1isize, pressure: pressure];
            events.push(event.ok_or("could not create an AppKit mouse event")?);
        }
        for event in events {
            let _: () = msg_send![&*app, postEvent: &*event, atStart: false];
        }
    }
    Ok(())
}
