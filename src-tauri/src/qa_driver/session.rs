use super::evaluation::eval_js;
use super::model::DriverState;
use super::model::SESSION_ID;
use super::response::error;
use super::response::ok;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::response::Response;
use serde_json::Value;
use serde_json::json;
use std::time::Duration;
use tauri::Runtime;

pub(super) async fn status() -> Response {
    ok(json!({"ready": true, "message": "Taomni macOS WKWebView QA bridge"}))
}

pub(super) async fn create_session(Json(_payload): Json<Value>) -> Response {
    ok(json!({
        "sessionId": SESSION_ID,
        "capabilities": {"browserName": "taomni-wkwebview", "platformName": "macOS"}
    }))
}

pub(super) fn session_is_valid(session_id: &str) -> bool {
    session_id == SESSION_ID
}

pub(super) async fn delete_session<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    // Let the HTTP response flush before ending the QA process.  The Python
    // harness also terminates this exact child during final cleanup.
    let app = state.app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.exit(0);
    });
    ok(Value::Null)
}

pub(super) async fn refresh<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let window = match state.current_window() {
        Ok(window) => window,
        Err(message) => return error(message),
    };
    match window.eval("window.location.reload()") {
        Ok(()) => ok(Value::Null),
        Err(e) => error(format!("failed to reload WebView: {e}")),
    }
}

pub(super) async fn current_url<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    match eval_js(&state, "return window.location.href;".into()).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}
