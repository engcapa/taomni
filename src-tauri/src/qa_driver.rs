//! QA-only WebDriver bridge for macOS WKWebView runs.
//!
//! `tauri-driver` has no macOS adapter.  The QA runner therefore starts the
//! packaged QA binary with `TAOMNI_QA_WEBDRIVER_PORT` and talks to this small
//! W3C-compatible server.  The bridge is deliberately opt-in and is never
//! started for normal application launches.

use std::{
    collections::{HashMap, HashSet},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use std::sync::LazyLock;
use std::sync::Mutex as StdMutex;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tokio::sync::{Mutex, oneshot};

const SESSION_ID: &str = "taomni-qa-macos";
static BRIDGE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LOADED_WINDOWS: LazyLock<StdMutex<HashSet<String>>> =
    LazyLock::new(|| StdMutex::new(HashSet::new()));

pub(crate) fn mark_page_load(label: &str, event: tauri::webview::PageLoadEvent) {
    if let Ok(mut loaded) = LOADED_WINDOWS.lock() {
        match event {
            tauri::webview::PageLoadEvent::Started => {
                loaded.remove(label);
            }
            tauri::webview::PageLoadEvent::Finished => {
                loaded.insert(label.to_string());
            }
        }
    }
}

pub(crate) fn forget_window(label: &str) {
    if let Ok(mut loaded) = LOADED_WINDOWS.lock() {
        loaded.remove(label);
    }
}

#[derive(Clone)]
struct ElementRef {
    using: String,
    selector: String,
    index: usize,
}

struct DriverState<R: Runtime> {
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    selected_window: Arc<StdMutex<String>>,
    elements: Arc<Mutex<HashMap<String, ElementRef>>>,
    next_element: Arc<AtomicU64>,
}

impl<R: Runtime> Clone for DriverState<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            window: self.window.clone(),
            selected_window: self.selected_window.clone(),
            elements: self.elements.clone(),
            next_element: self.next_element.clone(),
        }
    }
}

impl<R: Runtime> DriverState<R> {
    fn current_window(&self) -> Result<WebviewWindow<R>, String> {
        let label = self
            .selected_window
            .lock()
            .map_err(|_| "window selection lock poisoned")?
            .clone();
        self.app
            .get_webview_window(&label)
            .ok_or_else(|| format!("no such window: {label}"))
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

/// Shared DOM lookup helpers for every locator-consuming endpoint.
///
/// `__qaLookupAll` mirrors the CSS/xpath/text= `>>` chain used by the
/// element endpoints and returns every match; `__qaLookup` is the
/// single-element convenience used by the first-match endpoints.
fn lookup_helper() -> &'static str {
    r#"
        const __qaText = (part) => {
          let text = part.slice(5).trim();
          if ((text.startsWith('"') && text.endsWith('"')) ||
              (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
          return text;
        };
        const __qaDescendants = (root, part) => {
          const scope = root === document ? document : root;
          if (part.startsWith('text=')) {
            const needle = __qaText(part);
            const nodes = Array.from(scope.querySelectorAll('*'));
            return nodes.filter((node) => (node.textContent || '').includes(needle));
          }
          try { return Array.from(scope.querySelectorAll(part)); } catch (_) { return []; }
        };
        const __qaLookupAll = (using, selector) => {
          if (using === 'xpath') {
            const found = document.evaluate(
              selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            const nodes = [];
            for (let i = 0; i < found.snapshotLength; i++) nodes.push(found.snapshotItem(i));
            return nodes;
          }
          const parts = selector.split(/\s*>>\s*/);
          let roots = [document];
          for (const part of parts) {
            roots = roots.flatMap((root) => __qaDescendants(root, part));
            if (!roots.length) return [];
          }
          return roots;
        };
        const __qaLookup = (using, selector) => __qaLookupAll(using, selector)[0] || null;
        "#
}

/// Locator prelude that binds `el` to the referenced match (index-aware).
fn element_lookup(reference: &ElementRef) -> String {
    let using =
        serde_json::to_string(&reference.using).unwrap_or_else(|_| "\"css selector\"".into());
    let selector = serde_json::to_string(&reference.selector).unwrap_or_else(|_| "\"\"".into());
    let index = reference.index;
    format!(
        "{helper}\nconst el = __qaLookupAll({using}, {selector})[{index}] || null;\n",
        helper = lookup_helper()
    )
}

fn element_id_of(value: &Value) -> Option<&str> {
    value
        .get("element-6066-11e4-a52e-4f735466cecf")
        .or_else(|| value.get("ELEMENT"))
        .and_then(Value::as_str)
}

async fn eval_js<R: Runtime>(state: &DriverState<R>, body: String) -> Result<Value, String> {
    let window = state.current_window()?;
    // Wry queues scripts before WKWebView navigation commits, dropping their
    // callbacks. Wait for this view's load event before sending any script.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if LOADED_WINDOWS
            .lock()
            .map_err(|_| "page-load lock poisoned")?
            .contains(window.label())
        {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "window {} has not finished loading",
                window.label()
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
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
    window
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
    let mut script = element_lookup_from_parts(using, selector);
    script.push_str("return !!el;");
    match eval_js(&state, script).await {
        Ok(Value::Bool(true)) => {
            let id = format!(
                "qa-element-{}",
                state.next_element.fetch_add(1, Ordering::Relaxed)
            );
            state.elements.lock().await.insert(
                id.clone(),
                ElementRef {
                    using: using.into(),
                    selector: selector.into(),
                    index: 0,
                },
            );
            ok(json!({"element-6066-11e4-a52e-4f735466cecf": id}))
        }
        Ok(_) => error(format!("element not found: {selector}")),
        Err(message) => error(message),
    }
}

/// Locator prelude for a not-yet-registered locator (first match).
fn element_lookup_from_parts(using: &str, selector: &str) -> String {
    let using = serde_json::to_string(using).unwrap_or_else(|_| "\"css selector\"".into());
    let selector = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    format!(
        "{helper}\nconst el = __qaLookup({using}, {selector});\n",
        helper = lookup_helper()
    )
}

async fn find_elements<R: Runtime>(
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
    let script = format!(
        "{helper}\nreturn __qaLookupAll({using}, {selector}).length;\n",
        helper = lookup_helper(),
        using = serde_json::to_string(using).unwrap_or_else(|_| "\"css selector\"".into()),
        selector = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into()),
    );
    let count = match eval_js(&state, script).await {
        Ok(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Ok(_) => return error(format!("invalid element list: {selector}")),
        Err(message) => return error(message),
    };
    let mut elements = Vec::with_capacity(count as usize);
    for index in 0..count {
        let id = format!(
            "qa-element-{}",
            state.next_element.fetch_add(1, Ordering::Relaxed)
        );
        state.elements.lock().await.insert(
            id.clone(),
            ElementRef {
                using: using.into(),
                selector: selector.into(),
                index: index as usize,
            },
        );
        elements.push(json!({"element-6066-11e4-a52e-4f735466cecf": id}));
    }
    ok(Value::Array(elements))
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
    let mut script = element_lookup(&reference);
    // W3C Element Click presses the mouse at the element's in-view center,
    // so the page sees pointer events with coordinates before the mouse
    // events. Pointer-only surfaces (the VNC and RDP canvases) ignore mouse
    // events, and a cancelled pointerdown suppresses the compatibility
    // mousedown/mouseup like a real driver.
    script.push_str(include_str!("qa_driver_pointer.js"));
    script.push_str("return dispatchQaElementClick(el);");
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
    let mut script = element_lookup(&reference);
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
    let mut script = element_lookup(&reference);
    script.push_str(
        "if (!el) throw new Error('stale element'); return el.innerText ?? el.textContent ?? '';",
    );
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
            payload
                .get("value")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).collect::<String>())
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
    let mut script = element_lookup(&reference);
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

async fn actions_script<R: Runtime>(
    state: &DriverState<R>,
    payload: &Value,
) -> Result<String, String> {
    let actions = payload
        .get("actions")
        .ok_or_else(|| "actions payload is missing actions".to_string())?;
    // Replace element-reference origins with an internal selector descriptor
    // so the browser-side origin resolver can read the element's rect.
    let mut actions = actions.clone();
    if let Some(sources) = actions.as_array_mut() {
        for source in sources.iter_mut() {
            let Some(list) = source.get_mut("actions").and_then(Value::as_array_mut) else {
                continue;
            };
            for action in list.iter_mut() {
                let Some(origin) = action.get_mut("origin") else {
                    continue;
                };
                let Some(id) = element_id_of(origin).map(str::to_string) else {
                    continue;
                };
                let reference = state
                    .elements
                    .lock()
                    .await
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| format!("unknown WebDriver element: {id}"))?;
                *origin = json!({"__qaElement": {
                    "using": reference.using,
                    "selector": reference.selector,
                    "index": reference.index,
                }});
            }
        }
    }
    let encoded = serde_json::to_string(&actions).map_err(|e| e.to_string())?;
    Ok(format!(
        r#"const __qaActions = {encoded};
        {helper}
        const __qaActive = document.activeElement || document.body;
        const __qaModifiers = {{Control:false,Shift:false,Alt:false,Meta:false}};
        {keyboard_script}
        const __qaButtonKey = createQaButtonKeyboard();
        const __qaKey = (value) => ({{
          '\uE004':'Tab','\uE007':'Enter','\uE008':'Shift','\uE009':'Control',
          '\uE00A':'Alt','\uE00B':'Pause','\uE00C':'Escape','\uE00D':' ',
          '\uE00E':'PageUp','\uE00F':'PageDown','\uE010':'End','\uE011':'Home',
          '\uE012':'ArrowLeft','\uE013':'ArrowUp','\uE014':'ArrowRight','\uE015':'ArrowDown',
          '\uE016':'Insert','\uE017':'Delete',
          '\uE031':'F1','\uE032':'F2','\uE033':'F3','\uE034':'F4','\uE035':'F5','\uE036':'F6',
          '\uE037':'F7','\uE038':'F8','\uE039':'F9','\uE03A':'F10','\uE03B':'F11','\uE03C':'F12',
          '\uE03D':'Meta'
        }}[value] || value);
        // Legacy keyCode/which. Constructed KeyboardEvents always report 0
        // for both, but xterm.js v6 switches on ev.keyCode for every named
        // key (Escape 27, Tab 9, arrows 37-40, Home/End, F-keys) and drops
        // anything it cannot classify - Escape/:q!/:wq silently never
        // reached the remote shell. Mirror real US-layout key codes so the
        // packaged terminal classifies keys exactly like a physical
        // keyboard; printable punctuation uses its OEM virtual key (e.g.
        // '.' is 190, not the char code 46 which is the Delete key).
        const __qaCharKey = (ch) => {{
          const lower = ch.toLowerCase();
          if (lower >= 'a' && lower <= 'z') return ['Key' + lower.toUpperCase(), lower.toUpperCase().charCodeAt(0)];
          return {{
            '0':['Digit0',48],'1':['Digit1',49],'2':['Digit2',50],'3':['Digit3',51],'4':['Digit4',52],
            '5':['Digit5',53],'6':['Digit6',54],'7':['Digit7',55],'8':['Digit8',56],'9':['Digit9',57],
            ')':['Digit0',48],'!':['Digit1',49],'@':['Digit2',50],'#':['Digit3',51],'$':['Digit4',52],
            '%':['Digit5',53],'^':['Digit6',54],'&':['Digit7',55],'*':['Digit8',56],'(':['Digit9',57],
            ' ':['Space',32],
            '-':['Minus',189],'_':['Minus',189],'=':['Equal',187],'+':['Equal',187],
            '[':['BracketLeft',219],'{{':['BracketLeft',219],']':['BracketRight',221],'}}':['BracketRight',221],
            '\\':['Backslash',220],'|':['Backslash',220],
            ';':['Semicolon',186],':':['Semicolon',186],"'":['Quote',222],'"':['Quote',222],
            ',':['Comma',188],'<':['Comma',188],'.':['Period',190],'>':['Period',190],
            '/':['Slash',191],'?':['Slash',191],'`':['Backquote',192],'~':['Backquote',192]
          }}[ch] || null;
        }};
        const __qaNamedKeyCode = (key) => {{
          const named = {{
            'Backspace':8,'Tab':9,'Enter':13,'Shift':16,'Control':17,'Alt':18,
            'CapsLock':20,'Escape':27,'PageUp':33,'PageDown':34,'End':35,
            'Home':36,'ArrowLeft':37,'ArrowUp':38,'ArrowRight':39,'ArrowDown':40,
            'Insert':45,'Delete':46,'Meta':91
          }}[key];
          if (named !== undefined) return named;
          if (/^F([1-9]|1[0-2])$/.test(key)) return 111 + Number(key.slice(1));
          return 0;
        }};
        const __qaEmitKey = (type, raw) => {{
          const key = __qaKey(raw);
          const domType = type === 'keyDown' ? 'keydown' : 'keyup';
          const modifier = key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta';
          if (modifier) __qaModifiers[key] = domType === 'keydown';
          const charKey = key.length === 1 ? __qaCharKey(key) : null;
          const code = charKey ? charKey[0] : key;
          const event = new KeyboardEvent(domType, {{key, code,
            bubbles:true, cancelable:true, ctrlKey:__qaModifiers.Control, shiftKey:__qaModifiers.Shift,
            altKey:__qaModifiers.Alt, metaKey:__qaModifiers.Meta}});
          const keyCode = charKey ? charKey[1] : __qaNamedKeyCode(key);
          if (keyCode) {{
            try {{
              Object.defineProperty(event, 'keyCode', {{ get: () => keyCode }});
              Object.defineProperty(event, 'which', {{ get: () => keyCode }});
            }} catch (_) {{}}
          }}
          __qaActive.dispatchEvent(event);
          __qaButtonKey(__qaActive, domType, key, event, __qaModifiers);
          if (domType === 'keydown') {{
            dispatchQaKeyDefault(__qaActive, key, event, __qaModifiers);
          }}
        }};
        const __qaPoint = (x, y) => document.elementFromPoint(Number(x) || 0, Number(y) || 0) || document.body;
        // Pointer origins: viewport (default), the live pointer position, or
        // an element reference. Per W3C the element origin is its in-view
        // centre point, so x/y offset from the centre (not the top-left,
        // which can fall on a border/overlay and miss the target).
        let lastX = 0, lastY = 0;
        const __qaOrigin = (origin, ox, oy) => {{
          if (origin && origin.__qaElement) {{
            const ref = origin.__qaElement;
            const el = __qaLookupAll(ref.using, ref.selector)[ref.index] || null;
            if (!el) return [ox, oy];
            const rect = el.getBoundingClientRect();
            const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth);
            const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight);
            return [cx + ox, cy + oy];
          }}
          if (origin === 'pointer') return [lastX + ox, lastY + oy];
          return [ox, oy];
        }};
        {pointer_script}
        dispatchQaActions(__qaActions, __qaEmitKey, __qaModifiers, (origin, ox, oy) => {{
          [lastX, lastY] = __qaOrigin(origin, ox, oy);
          return [lastX, lastY];
        }}, __qaPoint);
        return true;"#,
        helper = lookup_helper(),
        pointer_script = include_str!("qa_driver_pointer.js"),
        keyboard_script = include_str!("qa_driver_keyboard.js")
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
    let script = match actions_script(&state, &payload).await {
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
    // W3C execute/sync accepts element references as arguments; the real
    // drivers substitute live nodes. Resolve each reference to the stored
    // locator so scripts like `arguments[0].focus()` see a DOM element.
    let args = payload.get("args").cloned().unwrap_or_else(|| json!([]));
    let mut resolved: Vec<String> = Vec::new();
    for arg in args.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if let Some(id) = element_id_of(arg) {
            let reference = match state.elements.lock().await.get(id).cloned() {
                Some(reference) => reference,
                None => return error(format!("unknown WebDriver element: {id}")),
            };
            let using = serde_json::to_string(&reference.using)
                .unwrap_or_else(|_| "\"css selector\"".into());
            let selector =
                serde_json::to_string(&reference.selector).unwrap_or_else(|_| "\"\"".into());
            resolved.push(format!(
                "__qaLookupAll({using}, {selector})[{}] || null",
                reference.index
            ));
        } else {
            resolved.push(arg.to_string());
        }
    }
    let args_json = format!("[{}]", resolved.join(", "));
    let body = format!(
        "{helper}\nconst arguments = {args_json};\n{script}",
        helper = lookup_helper()
    );
    match eval_js(&state, body).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

async fn refresh<R: Runtime>(
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

async fn window_handles<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let mut labels: Vec<String> = state.app.webview_windows().into_keys().collect();
    labels.sort();
    ok(json!(labels))
}

async fn selected_window<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    match state.current_window() {
        Ok(window) => ok(json!(window.label())),
        Err(message) => error(message),
    }
}

async fn switch_window<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let Some(handle) = payload.get("handle").and_then(Value::as_str) else {
        return error("window requires handle");
    };
    if state.app.get_webview_window(handle).is_none() {
        return error("no such window");
    }
    match state.selected_window.lock() {
        Ok(mut label) => *label = handle.to_string(),
        Err(_) => return error("window selection lock poisoned"),
    };
    state.elements.lock().await.clear();
    ok(Value::Null)
}

async fn close_window<R: Runtime>(
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
    match window.close() {
        Ok(()) => ok(Value::Null),
        Err(e) => error(e.to_string()),
    }
}

async fn current_url<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    // Navigation may not yet have an evaluable document in a newly created view.
    // Reading the native URL lets the runner select it before waiting for React.
    match state
        .current_window()
        .and_then(|window| window.url().map_err(|e| e.to_string()))
    {
        Ok(url) => ok(json!(url.as_str())),
        Err(message) => error(message),
    }
}

async fn window_rect<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let result = (|| -> Result<Value, String> {
        let window = state.current_window()?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let position = window
            .outer_position()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);
        let size = window
            .inner_size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);
        Ok(json!({"x":position.x,"y":position.y,"width":size.width,"height":size.height}))
    })();
    match result {
        Ok(rect) => ok(rect),
        Err(message) => error(message),
    }
}

async fn resize_window<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let (Some(width), Some(height)) = (
        payload.get("width").and_then(Value::as_f64),
        payload.get("height").and_then(Value::as_f64),
    ) else {
        return error("window rect requires width and height");
    };
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return error("invalid window size");
    }
    match state.current_window().and_then(|window| {
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())
    }) {
        Ok(()) => window_rect(State(state), Path(session_id)).await,
        Err(message) => error(message),
    }
}

fn screen_capture() -> Result<String, String> {
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

async fn screenshot<R: Runtime>(
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
        use block2::RcBlock;
        use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
        use objc2_foundation::NSData;

        let (tx, rx) = oneshot::channel::<Result<String, String>>();
        let sender = Arc::new(StdMutex::new(Some(tx)));
        let window = match state.current_window() {
            Ok(window) => window,
            Err(message) => return error(message),
        };
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
                    let properties: Retained<AnyObject> =
                        msg_send![class!(NSDictionary), dictionary];
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
            return error(format!("WKWebView snapshot could not start: {err}"));
        }
        return match tokio::time::timeout(Duration::from_secs(20), rx).await {
            Ok(Ok(Ok(encoded))) => ok(Value::String(encoded)),
            Ok(Ok(Err(message))) => error(message),
            _ => error("WKWebView snapshot timed out or callback was dropped"),
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        error("WKWebView snapshot is only available on macOS")
    }
}

/// Explicit opt-in desktop evidence; never a fallback for a WebView snapshot.
async fn desktop_screenshot(Path(session_id): Path<String>) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    match screen_capture() {
        Ok(encoded) => ok(json!({"captureKind": "desktop", "png": encoded})),
        Err(message) => error(message),
    }
}

/// Activate the installed AppKit About item, including its real menu event and
/// frontend callback. No renderer state or app command is synthesized.
async fn native_about<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
) -> Response {
    activate_native_menu_item(state, session_id, "app", "about").await
}

async fn native_view_menu<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    let Some(action @ ("split" | "multiexec")) = payload.get("action").and_then(Value::as_str)
    else {
        return error("unsupported native View menu action");
    };
    activate_native_menu_item(state, session_id, "view", action).await
}

async fn native_app_menu<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if payload.get("action").and_then(Value::as_str) != Some("exit") {
        return error("unsupported native application menu action");
    }
    activate_native_menu_item(state, session_id, "app", "quit").await
}

async fn activate_native_menu_item<R: Runtime>(
    state: DriverState<R>,
    session_id: String,
    submenu_id: &str,
    item_id: &str,
) -> Response {
    if !session_is_valid(&session_id)
        || !cfg!(debug_assertions)
        || state.app.config().identifier != crate::QA_APP_ID
    {
        return error("native menu activation requires the isolated QA session");
    }
    #[cfg(target_os = "macos")]
    {
        let app = state.app.clone();
        let submenu_id = submenu_id.to_string();
        let selected_item_id = item_id.to_string();
        let (tx, rx) = oneshot::channel();
        if let Err(err) = state.app.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
                use objc2_foundation::NSString;
                use tauri::menu::MenuItemKind;
                let menu = app.menu().ok_or("application menu is not installed yet")?;
                let Some(MenuItemKind::Submenu(submenu)) = menu.get(&submenu_id) else {
                    return Err("application submenu is not installed yet".into());
                };
                let Some(MenuItemKind::MenuItem(item)) = submenu.get(&selected_item_id) else {
                    return Err("requested native menu item is not installed yet".into());
                };
                if !item.is_enabled().map_err(|e| e.to_string())? {
                    return Err("requested native menu item is disabled".into());
                }
                let title = item.text().map_err(|e| e.to_string())?;
                // SAFETY: AppKit access occurs on the main thread. Objects
                // remain retained by the installed menu for the traversal.
                unsafe fn activate(menu: &AnyObject, title: &str) -> bool {
                    unsafe {
                        let count: isize = msg_send![menu, numberOfItems];
                        for index in 0..count {
                            let item: Retained<AnyObject> = msg_send![menu, itemAtIndex: index];
                            let text: Retained<NSString> = msg_send![&*item, title];
                            if text.to_string() == title {
                                let enabled: bool = msg_send![&*item, isEnabled];
                                if !enabled {
                                    return false;
                                }
                                let _: () = msg_send![menu, performActionForItemAtIndex: index];
                                return true;
                            }
                            let child: Option<Retained<AnyObject>> = msg_send![&*item, submenu];
                            if let Some(child) = child {
                                if activate(&child, title) {
                                    return true;
                                }
                            }
                        }
                        false
                    }
                }
                unsafe {
                    let application: Retained<AnyObject> =
                        msg_send![class!(NSApplication), sharedApplication];
                    let menu: Option<Retained<AnyObject>> = msg_send![&*application, mainMenu];
                    if !menu.is_some_and(|menu| activate(&menu, &title)) {
                        return Err("installed AppKit menu item was not found".into());
                    }
                }
                Ok(())
            })();
            let _ = tx.send(result);
        }) {
            return error(err.to_string());
        }
        return match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(Ok(()))) => ok(json!({"activated": item_id, "transport": "AppKit NSMenu"})),
            Ok(Ok(Err(message))) => error(message),
            _ => error("native menu activation timed out"),
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, submenu_id, item_id);
        error("native menu activation requires macOS")
    }
}

/// Start the opt-in bridge and return immediately so Tauri can finish setup.
pub fn start<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, host: String, port: u16) {
    if BRIDGE_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let state = DriverState {
        app,
        selected_window: Arc::new(StdMutex::new(window.label().to_string())),
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
            .route(
                "/session/{session_id}/window/handles",
                get(window_handles::<R>),
            )
            .route(
                "/session/{session_id}/window",
                get(selected_window::<R>)
                    .post(switch_window::<R>)
                    .delete(close_window::<R>),
            )
            .route("/session/{session_id}/element", post(find_element::<R>))
            .route("/session/{session_id}/elements", post(find_elements::<R>))
            .route(
                "/session/{session_id}/element/{element_id}/click",
                post(element_click::<R>),
            )
            .route(
                "/session/{session_id}/element/{element_id}/rect",
                get(element_rect::<R>),
            )
            .route(
                "/session/{session_id}/element/{element_id}/text",
                get(element_text::<R>),
            )
            .route(
                "/session/{session_id}/element/{element_id}/value",
                post(element_value::<R>),
            )
            .route(
                "/session/{session_id}/element/{element_id}/clear",
                post(element_clear::<R>),
            )
            .route(
                "/session/{session_id}/actions",
                post(actions::<R>).delete(release_actions),
            )
            .route(
                "/session/{session_id}/execute/sync",
                post(execute_sync::<R>),
            )
            .route(
                "/session/{session_id}/qa/native-about",
                post(native_about::<R>),
            )
            .route(
                "/session/{session_id}/qa/native-view-menu",
                post(native_view_menu::<R>),
            )
            .route(
                "/session/{session_id}/qa/native-app-menu",
                post(native_app_menu::<R>),
            )
            .route("/session/{session_id}/refresh", post(refresh::<R>))
            .route("/session/{session_id}/url", get(current_url::<R>))
            .route(
                "/session/{session_id}/window/rect",
                get(window_rect::<R>).post(resize_window::<R>),
            )
            .route("/session/{session_id}/screenshot", get(screenshot::<R>))
            .route(
                "/session/{session_id}/qa/desktop-screenshot",
                get(desktop_screenshot),
            )
            .with_state(state);
        log::info!("qa webdriver bridge listening on {address}");
        if let Err(error) = axum::serve(listener, router).await {
            log::error!("qa webdriver bridge stopped: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recreated_window_must_finish_its_own_navigation_before_scripts_are_sent() {
        let label = "qa-recreated-window-load-test";
        mark_page_load(label, tauri::webview::PageLoadEvent::Finished);
        assert!(LOADED_WINDOWS.lock().unwrap().contains(label));
        forget_window(label);
        assert!(!LOADED_WINDOWS.lock().unwrap().contains(label));
        mark_page_load(label, tauri::webview::PageLoadEvent::Started);
        assert!(!LOADED_WINDOWS.lock().unwrap().contains(label));
        mark_page_load(label, tauri::webview::PageLoadEvent::Finished);
        assert!(LOADED_WINDOWS.lock().unwrap().contains(label));
        forget_window(label);
    }
}
