use super::model::DriverState;
use super::response::error;
use super::response::ok;
use super::session::session_is_valid;
use super::session::status;
use axum::extract::Path;
use axum::extract::State;
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::Value;
use serde_json::json;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::Runtime;
use tauri::WebviewWindow;
use tokio::sync::oneshot;

pub(super) fn screen_capture() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let path =
            std::env::temp_dir().join(format!("taomni-qa-screen-{}.png", std::process::id()));
        let output = Command::new("/usr/sbin/screencapture")
            .args(["-x", "-t", "png"])
            .arg(&path)
            .output()
            .map_err(|e| format!("screencapture failed to start: {e}"))?;
        if !output.status.success() {
            return Err(format!("screencapture exited with {}", output.status));
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("screenshot missing: {e}"))?;
        let _ = std::fs::remove_file(path);
        return Ok(BASE64.encode(bytes));
    }
    #[allow(unreachable_code)]
    Err("screen capture is only available on macOS".into())
}

/// One WKWebView snapshot attempt. `takeSnapshotWithConfiguration` silently
/// drops its completion handler when the WebView is not painting (for example
/// while the app's window sits in a background console session), so the caller
/// retries before reporting a failure.
#[cfg(target_os = "macos")]
pub(super) async fn webview_snapshot<R: Runtime>(
    window: &WebviewWindow<R>,
    wait: Duration,
) -> Result<String, String> {
    use block2::RcBlock;
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::NSData;

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let sender = Arc::new(StdMutex::new(Some(tx)));
    let started = window.with_webview(move |webview| unsafe {
        let completion = RcBlock::new(move |image: *mut AnyObject, err: *mut AnyObject| {
            let result = (|| {
                if image.is_null() || !err.is_null() {
                    return Err("WKWebView snapshot did not return an image".to_string());
                }
                let tiff: Option<Retained<NSData>> = msg_send![&*image, TIFFRepresentation];
                let tiff = tiff.ok_or("snapshot TIFF conversion failed")?;
                let bitmap: Option<Retained<AnyObject>> =
                    msg_send![class!(NSBitmapImageRep), imageRepWithData: &*tiff];
                let bitmap = bitmap.ok_or("snapshot bitmap conversion failed")?;
                let properties: Retained<AnyObject> = msg_send![class!(NSDictionary), dictionary];
                let png: Option<Retained<NSData>> = msg_send![&*bitmap,
                    representationUsingType: 4usize, properties: &*properties];
                let png = png.ok_or("snapshot PNG conversion failed")?;
                let bytes = png.as_bytes_unchecked();
                if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
                    return Err("snapshot is not a PNG".to_string());
                }
                Ok(BASE64.encode(bytes))
            })();
            if let Some(tx) = sender.lock().expect("snapshot sender lock").take() {
                let _ = tx.send(result);
            }
        });
        let view = &*(webview.inner() as *mut AnyObject);
        let _: () = msg_send![view,
            takeSnapshotWithConfiguration: std::ptr::null::<AnyObject>(),
            completionHandler: &*completion];
    });
    if let Err(err) = started {
        return Err(format!("WKWebView snapshot could not start: {err}"));
    }
    match tokio::time::timeout(wait, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("WKWebView snapshot callback was dropped".into()),
        Err(_) => Err("WKWebView snapshot timed out".into()),
    }
}

pub(super) async fn screenshot<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    // Capture only this app's WKWebView. Unlike screencapture, this does not
    // require Screen Recording consent on an unattended hosted runner.
    #[cfg(target_os = "macos")]
    {
        // The hosted ARD case answered the bridge in 26-50s while the app's
        // window was in a background console session; the previous single 20s
        // attempt failed the whole case on evidence capture alone. Retry once
        // with a longer bound; product assertions still own the outcome.
        let window = match state.current_window() {
            Ok(window) => window,
            Err(message) => return error(message),
        };
        let mut last = "WKWebView snapshot failed".to_string();
        for attempt in 0..2 {
            match webview_snapshot(&window, Duration::from_secs(30)).await {
                Ok(encoded) => return ok(Value::String(encoded)),
                Err(message) => {
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    last = message;
                }
            }
        }
        return error(format!("{last} (2 attempts)"));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        error("WKWebView snapshot is only available on macOS")
    }
}

/// Explicit opt-in desktop evidence; never a fallback for a WebView snapshot.
pub(super) async fn desktop_screenshot(Path(session_id): Path<String>) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    match screen_capture() {
        Ok(encoded) => ok(json!({"captureKind": "desktop", "png": encoded})),
        Err(message) => error(message),
    }
}
