use super::model::DriverState;
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::{NSPoint, NSString};
use std::time::Duration;
use tauri::Runtime;
use tokio::sync::oneshot;

/// Constructed DOM key events cannot invoke WebKit's default sequential focus
/// navigation. Send the stroke through the selected QA window's responder chain.
pub(super) async fn send<R: Runtime>(state: &DriverState<R>, reverse: bool) -> Result<(), String> {
    if state.app.config().identifier != crate::QA_APP_ID {
        return Err("AppKit Tab requires the isolated QA application".into());
    }
    let window = state.current_window()?;
    let (sender, receiver) = oneshot::channel();
    window
        .with_webview(move |webview| {
            let result = unsafe { send_to_window(webview.inner().cast(), reverse) };
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "AppKit Tab delivery timed out".to_string())?
        .map_err(|_| "AppKit Tab window closed".to_string())?
}

unsafe fn send_to_window(view: *mut AnyObject, reverse: bool) -> Result<(), String> {
    let view = unsafe { view.as_ref() }.ok_or("WKWebView is unavailable")?;
    unsafe {
        let window: *mut AnyObject = msg_send![view, window];
        let window = window.as_ref().ok_or("WKWebView has no AppKit window")?;
        let visible: bool = msg_send![window, isVisible];
        if !visible {
            return Err("The selected QA window is hidden".into());
        }
        let _: () = msg_send![window, makeKeyAndOrderFront: std::ptr::null::<AnyObject>()];
        let responder: *mut AnyObject = msg_send![window, firstResponder];
        let inside = responder.as_ref().is_some_and(|responder| {
            let is_view: bool = msg_send![responder, isKindOfClass: class!(NSView)];
            is_view && {
                let descendant: bool = msg_send![responder, isDescendantOf: view];
                descendant
            }
        });
        if !inside {
            let accepted: bool = msg_send![window, makeFirstResponder: view];
            if !accepted {
                return Err("WKWebView refused first responder".into());
            }
        }
        let number: isize = msg_send![window, windowNumber];
        let process: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
        let uptime: f64 = msg_send![&*process, systemUptime];
        let tab = NSString::from_str("\t");
        let characters = NSString::from_str(if reverse { "\u{19}" } else { "\t" });
        let flags = if reverse { 1usize << 17 } else { 0 };
        for kind in [10usize, 11usize] {
            let event: Option<Retained<AnyObject>> = msg_send![class!(NSEvent),
                keyEventWithType: kind, location: NSPoint::new(0.0, 0.0),
                modifierFlags: flags, timestamp: uptime, windowNumber: number,
                context: std::ptr::null::<AnyObject>(), characters: &*characters,
                charactersIgnoringModifiers: &*tab, isARepeat: false, keyCode: 48u16];
            let event = event.ok_or("Could not construct the AppKit Tab event")?;
            let _: () = msg_send![window, sendEvent: &*event];
        }
        Ok(())
    }
}
