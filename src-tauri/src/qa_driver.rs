//! QA-only WebDriver bridge for macOS WKWebView runs.
//!
//! `tauri-driver` has no macOS adapter.  The QA runner therefore starts the
//! packaged QA binary with `TAOMNI_QA_WEBDRIVER_PORT` and talks to this small
//! W3C-compatible server.  The bridge is deliberately opt-in and is never
//! started for normal application launches.

use std::{
    collections::HashMap,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::sync::Mutex as StdMutex;

use tauri::{AppHandle, Runtime, WebviewWindow};
use tokio::sync::{oneshot, Mutex};

const SESSION_ID: &str = "taomni-qa-macos";
static BRIDGE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Clone)]
struct ElementRef {
    using: String,
    selector: String,
}

struct DriverState<R: Runtime> {
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    elements: Arc<Mutex<HashMap<String, ElementRef>>>,
    next_element: Arc<AtomicU64>,
}

impl<R: Runtime> Clone for DriverState<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            window: self.window.clone(),
            elements: self.elements.clone(),
            next_element: self.next_element.clone(),
        }
    }
}

fn ok(value: Value) -> Response {
    (StatusCode::OK, Json(json!({"value": value}))).into_response()
}

fn error(message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "value": {
                "error": "unknown error",
                "message": message.into(),
            }
        })),
    )
        .into_response()
}

fn element_lookup(using: &str, selector: &str) -> String {
    let using = serde_json::to_string(using).unwrap_or_else(|_| "\"css selector\"".into());
    let selector = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"
        const __qaUsing = {using};
        const __qaSelector = {selector};
        const __qaText = (part) => {{
          let text = part.slice(5).trim();
          if ((text.startsWith('"') && text.endsWith('"')) ||
              (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
          return text;
        }};
        const __qaDescendants = (root, part) => {{
          const scope = root === document ? document : root;
          if (part.startsWith('text=')) {{
            const needle = __qaText(part);
            const nodes = Array.from(scope.querySelectorAll('*'));
            return nodes.filter((node) => (node.textContent || '').includes(needle));
          }}
          try {{ return Array.from(scope.querySelectorAll(part)); }} catch (_) {{ return []; }}
        }};
        const __qaFind = () => {{
          if (__qaUsing === 'xpath') {{
            const found = document.evaluate(
              __qaSelector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            return found.snapshotLength ? found.snapshotItem(0) : null;
          }}
          const parts = __qaSelector.split(/\s*>>\s*/);
          let roots = [document];
          for (const part of parts) {{
            roots = roots.flatMap((root) => __qaDescendants(root, part));
            if (!roots.length) return null;
          }}
          return roots[0] || null;
        }};
        const el = __qaFind();
        "#
    )
}

async fn eval_js<R: Runtime>(state: &DriverState<R>, body: String) -> Result<Value, String> {
    let script = format!(
        r#"(() => {{
          try {{
            {body}
          }} catch (error) {{
            return {{ __qaError: String(error), __qaStack: error && error.stack ? error.stack : null }};
          }}
        }})()"#
    );
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    let callback_sender = sender.clone();
    state
        .window
        .eval_with_callback(script, move |result| {
            if let Ok(mut sender) = callback_sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(result);
                }
            }
        })
        .map_err(|e| format!("failed to evaluate JavaScript: {e}"))?;
    let raw = tokio::time::timeout(Duration::from_secs(30), receiver)
        .await
        .map_err(|_| "WebView JavaScript evaluation timed out".to_string())?
        .map_err(|_| "WebView JavaScript callback was dropped".to_string())?;
    if raw.trim().is_empty() {
        return Ok(Value::Null);
    }
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("WebView returned invalid JSON {raw:?}: {e}"))?;
    if let Some(message) = value.get("__qaError").and_then(Value::as_str) {
        return Err(format!("JavaScript error: {message}"));
    }
    Ok(value)
}

async fn status() -> Response {
    ok(json!({"ready": true, "message": "Taomni macOS WKWebView QA bridge"}))
}

async fn create_session(Json(_payload): Json<Value>) -> Response {
    ok(json!({
        "sessionId": SESSION_ID,
        "capabilities": {"browserName": "taomni-wkwebview", "platformName": "macOS"}
    }))
}

fn session_is_valid(session_id: &str) -> bool {
    session_id == SESSION_ID
}

async fn delete_session<R: Runtime>(
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

async fn find_element<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let using = payload
        .get("using")
        .and_then(Value::as_str)
        .unwrap_or("css selector");
    let selector = match payload.get("value").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value,
        _ => return error("element selector must be a non-empty string"),
    };
    let mut script = element_lookup(using, selector);
    script.push_str("return !!el;");
    match eval_js(&state, script).await {
        Ok(Value::Bool(true)) => {
            let id = format!(
                "qa-element-{}",
                state.next_element.fetch_add(1, Ordering::Relaxed)
            );
            state
                .elements
                .lock()
                .await
                .insert(id.clone(), ElementRef { using: using.into(), selector: selector.into() });
            ok(json!({"element-6066-11e4-a52e-4f735466cecf": id}))
        }
        Ok(_) => error(format!("element not found: {selector}")),
        Err(message) => error(message),
    }
}

async fn element_ref<R: Runtime>(state: &DriverState<R>, id: &str) -> Result<ElementRef, String> {
    state
        .elements
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| format!("unknown WebDriver element: {id}"))
}

async fn element_click<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let reference = match element_ref(&state, &element_id).await {
        Ok(reference) => reference,
        Err(message) => return error(message),
    };
    let mut script = element_lookup(&reference.using, &reference.selector);
    script.push_str(concat!(
        "if (!el) throw new Error('stale element'); el.focus?.(); ",
        "el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); ",
        "el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0})); ",
        "el.click(); return true;",
    ));
    match eval_js(&state, script).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

async fn element_rect<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let reference = match element_ref(&state, &element_id).await {
        Ok(reference) => reference,
        Err(message) => return error(message),
    };
    let mut script = element_lookup(&reference.using, &reference.selector);
    script.push_str(concat!(
        "if (!el) throw new Error('stale element'); ",
        "const r=el.getBoundingClientRect(); ",
        "return {x:r.x,y:r.y,width:r.width,height:r.height};",
    ));
    match eval_js(&state, script).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

async fn element_text<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let reference = match element_ref(&state, &element_id).await {
        Ok(reference) => reference,
        Err(message) => return error(message),
    };
    let mut script = element_lookup(&reference.using, &reference.selector);
    script.push_str("if (!el) throw new Error('stale element'); return el.innerText ?? el.textContent ?? '';" );
    match eval_js(&state, script).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

fn json_text(payload: &Value) -> Result<String, String> {
    payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            payload.get("value").and_then(Value::as_array).map(|values| {
                values.iter().filter_map(Value::as_str).collect::<String>()
            })
        })
        .ok_or_else(|| "element value requires a text string".to_string())
}

async fn element_value<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let text = match json_text(&payload) {
        Ok(text) => text,
        Err(message) => return error(message),
    };
    let reference = match element_ref(&state, &element_id).await {
        Ok(reference) => reference,
        Err(message) => return error(message),
    };
    let mut script = element_lookup(&reference.using, &reference.selector);
    let text_json = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".into());
    script.push_str(&format!(
        r#"if (!el) throw new Error('stale element');
        el.focus?.();
        const value = {text_json};
        if (el.isContentEditable) {{
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, value);
        }} else {{
          const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set ||
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, value); else el.value = value;
          el.dispatchEvent(new InputEvent('input', {{bubbles:true, inputType:'insertText', data:value}}));
          el.dispatchEvent(new Event('change', {{bubbles:true}}));
        }}
        return true;"#
    ));
    match eval_js(&state, script).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

async fn element_clear<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
) -> Response {
    let payload = json!({"text": ""});
    element_value(State(state), Path((session_id, element_id)), Json(payload)).await
}

fn actions_script(payload: &Value) -> Result<String, String> {
    let actions = payload
        .get("actions")
        .ok_or_else(|| "actions payload is missing actions".to_string())?;
    let encoded = serde_json::to_string(actions).map_err(|e| e.to_string())?;
    Ok(format!(
        r#"const __qaActions = {encoded};
        const __qaActive = document.activeElement || document.body;
        const __qaModifiers = {{Control:false,Shift:false,Alt:false,Meta:false}};
        const __qaKey = (value) => ({{
          '\uE004':'Tab','\uE007':'Enter','\uE008':'Shift','\uE009':'Control',
          '\uE00A':'Alt','\uE00B':'Pause','\uE00C':'Escape','\uE00D':' ',
          '\uE00E':'PageUp','\uE00F':'PageDown','\uE010':'End','\uE011':'Home',
          '\uE012':'ArrowLeft','\uE013':'ArrowUp','\uE014':'ArrowRight','\uE015':'ArrowDown',
          '\uE016':'Insert','\uE017':'Delete','\uE03D':'Meta'
        }}[value] || value);
        const __qaEmitKey = (type, raw) => {{
          const key = __qaKey(raw);
          const modifier = key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta';
          if (modifier) __qaModifiers[key] = type === 'keyDown';
          const event = new KeyboardEvent(type, {{key, code:key.length === 1 ? ('Key' + key.toUpperCase()) : key,
            bubbles:true, cancelable:true, ctrlKey:__qaModifiers.Control, shiftKey:__qaModifiers.Shift,
            altKey:__qaModifiers.Alt, metaKey:__qaModifiers.Meta}});
          __qaActive.dispatchEvent(event);
          if (type === 'keyDown' && !modifier && !event.defaultPrevented &&
              !__qaModifiers.Control && !__qaModifiers.Meta && !__qaModifiers.Alt) {{
            if (__qaActive.isContentEditable) {{
              if (key === 'Enter') document.execCommand('insertParagraph', false, null);
              else if (key === 'Backspace') document.execCommand('delete', false, null);
              else if (key === 'Delete') document.execCommand('forwardDelete', false, null);
              else if (key.length === 1) document.execCommand('insertText', false, key);
            }} else if (__qaActive instanceof HTMLInputElement || __qaActive instanceof HTMLTextAreaElement) {{
              if (key.length === 1 || key === 'Enter') {{
                const start = __qaActive.selectionStart ?? __qaActive.value.length;
                const end = __qaActive.selectionEnd ?? start;
                const insert = key === 'Enter' ? '\\n' : key;
                __qaActive.setRangeText(insert, start, end, 'end');
                __qaActive.dispatchEvent(new InputEvent('input', {{bubbles:true, inputType:'insertText', data:insert}}));
              }}
            }}
          }}
        }};
        const __qaPoint = (x, y) => document.elementFromPoint(Number(x) || 0, Number(y) || 0) || document.body;
        for (const source of __qaActions) {{
          if (source.type === 'key') {{
            for (const action of source.actions || []) if (action.type === 'keyDown' || action.type === 'keyUp') __qaEmitKey(action.type, action.value);
          }} else if (source.type === 'pointer') {{
            let x=0, y=0, clickCount=0;
            for (const action of source.actions || []) {{
              if (action.type === 'pointerMove') {{ x=Number(action.x)||0; y=Number(action.y)||0; const target=__qaPoint(x,y); target.dispatchEvent(new PointerEvent('pointermove',{{bubbles:true,clientX:x,clientY:y,buttons:0}})); }}
              else if (action.type === 'pointerDown') {{ const target=__qaPoint(x,y); target.dispatchEvent(new PointerEvent('pointerdown',{{bubbles:true,button:action.button||0,buttons:1,clientX:x,clientY:y}})); }}
              else if (action.type === 'pointerUp') {{ const target=__qaPoint(x,y); target.dispatchEvent(new PointerEvent('pointerup',{{bubbles:true,button:action.button||0,buttons:0,clientX:x,clientY:y}})); target.dispatchEvent(new MouseEvent('click',{{bubbles:true,button:action.button||0,clientX:x,clientY:y}})); clickCount++; if (clickCount === 2) target.dispatchEvent(new MouseEvent('dblclick',{{bubbles:true,button:0,clientX:x,clientY:y}})); }}
            }}
          }}
        }}
        return true;"#
    ))
}

async fn actions<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let script = match actions_script(&payload) {
        Ok(script) => script,
        Err(message) => return error(message),
    };
    match eval_js(&state, script).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

async fn release_actions(Path(session_id): Path<String>) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    ok(Value::Null)
}

async fn execute_sync<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let script = match payload.get("script").and_then(Value::as_str) {
        Some(script) => script,
        None => return error("execute/sync requires script"),
    };
    let args = payload.get("args").cloned().unwrap_or_else(|| json!([]));
    let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "[]".into());
    let body = format!("const arguments = {args_json};\n{script}");
    match eval_js(&state, body).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

async fn refresh<R: Runtime>(State(state): State<DriverState<R>>, Path(session_id): Path<String>) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    match state.window.eval("window.location.reload()") {
        Ok(()) => ok(Value::Null),
        Err(e) => error(format!("failed to reload WebView: {e}")),
    }
}

async fn current_url<R: Runtime>(State(state): State<DriverState<R>>, Path(session_id): Path<String>) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    match eval_js(&state, "return window.location.href;".into()).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

fn screen_capture() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let path = std::env::temp_dir().join(format!("taomni-qa-screen-{}.png", std::process::id()));
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

async fn screenshot<R: Runtime>(State(_state): State<DriverState<R>>, Path(_session_id): Path<String>) -> Response {
    match screen_capture() {
        Ok(encoded) => ok(Value::String(encoded)),
        Err(message) => error(message),
    }
}

/// Start the opt-in bridge and return immediately so Tauri can finish setup.
pub fn start<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, host: String, port: u16) {
    if BRIDGE_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let state = DriverState {
        app,
        window,
        elements: Arc::new(Mutex::new(HashMap::new())),
        next_element: Arc::new(AtomicU64::new(1)),
    };
    tauri::async_runtime::spawn(async move {
        let address = format!("{host}:{port}");
        let listener = match tokio::net::TcpListener::bind(&address).await {
            Ok(listener) => listener,
            Err(error) => {
                log::error!("qa webdriver bridge failed to bind {address}: {error}");
                return;
            }
        };
        let router = Router::new()
            .route("/status", get(status))
            .route("/session", post(create_session))
            .route("/session/{session_id}", delete(delete_session::<R>))
            .route("/session/{session_id}/element", post(find_element::<R>))
            .route("/session/{session_id}/element/{element_id}/click", post(element_click::<R>))
            .route("/session/{session_id}/element/{element_id}/rect", get(element_rect::<R>))
            .route("/session/{session_id}/element/{element_id}/text", get(element_text::<R>))
            .route("/session/{session_id}/element/{element_id}/value", post(element_value::<R>))
            .route("/session/{session_id}/element/{element_id}/clear", post(element_clear::<R>))
            .route("/session/{session_id}/actions", post(actions::<R>).delete(release_actions))
            .route("/session/{session_id}/execute/sync", post(execute_sync::<R>))
            .route("/session/{session_id}/refresh", post(refresh::<R>))
            .route("/session/{session_id}/url", get(current_url::<R>))
            .route("/session/{session_id}/screenshot", get(screenshot::<R>))
            .with_state(state);
        log::info!("qa webdriver bridge listening on {address}");
        if let Err(error) = axum::serve(listener, router).await {
            log::error!("qa webdriver bridge stopped: {error}");
        }
    });
}
