//! W3C window contexts for real detached-window acceptance on WKWebView.
use super::{
    model::DriverState,
    response::{error, ok},
    session::session_is_valid,
};
use axum::{
    Json,
    extract::{Path, State},
    response::Response,
};
use serde_json::{Value, json};
use tauri::{Manager, Runtime};

pub(super) async fn handles<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(id): Path<String>,
) -> Response {
    if !session_is_valid(&id) {
        return error("unknown WebDriver session");
    }
    let mut labels: Vec<_> = state.app.webview_windows().into_keys().collect();
    labels.sort();
    ok(json!(labels))
}

pub(super) async fn current<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(id): Path<String>,
) -> Response {
    if !session_is_valid(&id) {
        return error("unknown WebDriver session");
    }
    match state.current_window() {
        Ok(window) => ok(json!(window.label())),
        Err(message) => error(message),
    }
}

pub(super) async fn switch<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&id) {
        return error("unknown WebDriver session");
    }
    let Some(label) = payload.get("handle").and_then(Value::as_str) else {
        return error("window handle is required");
    };
    let Some(window) = state.app.get_webview_window(label) else {
        return error("no such window");
    };
    if let Err(message) = window.set_focus() {
        return error(message.to_string());
    }
    // AppKit window activation does not make its WKWebView the first
    // responder. W3C context switching must also give that view input focus.
    let webview: &tauri::Webview<R> = window.as_ref();
    if let Err(message) = webview.set_focus() {
        return error(message.to_string());
    }
    match state.window.write() {
        Ok(mut active) => *active = window,
        Err(_) => return error("QA window lock poisoned"),
    }
    state.elements.lock().await.clear();
    ok(Value::Null)
}
