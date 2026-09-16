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
use std::sync::Mutex as StdMutex;

use tauri::{AppHandle, Runtime, WebviewWindow};
use tokio::sync::{Mutex, oneshot};

const SESSION_ID: &str = "taomni-qa-macos";
static BRIDGE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Clone)]
struct ElementRef {
    using: String,
    selector: String,
    index: usize,
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
        const __qaKey = (value) => ({{
          '\uE004':'Tab','\uE007':'Enter','\uE008':'Shift','\uE009':'Control',
          '\uE00A':'Alt','\uE00B':'Pause','\uE00C':'Escape','\uE00D':' ',
          '\uE00E':'PageUp','\uE00F':'PageDown','\uE010':'End','\uE011':'Home',
          '\uE012':'ArrowLeft','\uE013':'ArrowUp','\uE014':'ArrowRight','\uE015':'ArrowDown',
          '\uE016':'Insert','\uE017':'Delete','\uE03D':'Meta'
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
          if (domType === 'keydown' && !modifier && !event.defaultPrevented &&
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
        for (const source of __qaActions) {{
          if (source.type === 'key') {{
            for (const action of source.actions || []) if (action.type === 'keyDown' || action.type === 'keyUp') __qaEmitKey(action.type, action.value);
          }} else if (source.type === 'pointer') {{
            let x=0, y=0, clickCount=0;
            for (const action of source.actions || []) {{
              if (action.type === 'pointerMove') {{ [x, y] = __qaOrigin(action.origin, Number(action.x)||0, Number(action.y)||0); lastX = x; lastY = y; const target=__qaPoint(x,y); target.dispatchEvent(new PointerEvent('pointermove',{{bubbles:true,clientX:x,clientY:y,buttons:0}})); }}
              else if (action.type === 'pointerDown') {{ const target=__qaPoint(x,y); target.dispatchEvent(new PointerEvent('pointerdown',{{bubbles:true,button:action.button||0,buttons:1,clientX:x,clientY:y}})); }}
              else if (action.type === 'pointerUp') {{ const target=__qaPoint(x,y); const button = action.button||0; target.dispatchEvent(new PointerEvent('pointerup',{{bubbles:true,button,buttons:0,clientX:x,clientY:y}})); if (button === 2) {{ target.dispatchEvent(new MouseEvent('contextmenu',{{bubbles:true,cancelable:true,button:2,clientX:x,clientY:y}})); }} else {{ target.dispatchEvent(new MouseEvent('click',{{bubbles:true,button,clientX:x,clientY:y}})); clickCount++; if (clickCount === 2) target.dispatchEvent(new MouseEvent('dblclick',{{bubbles:true,button:0,clientX:x,clientY:y}})); }} }}
            }}
          }}
        }}
        return true;"#,
        helper = lookup_helper()
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
    match state.window.eval("window.location.reload()") {
        Ok(()) => ok(Value::Null),
        Err(e) => error(format!("failed to reload WebView: {e}")),
    }
}

async fn current_url<R: Runtime>(
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
    State(_state): State<DriverState<R>>,
    Path(_session_id): Path<String>,
) -> Response {
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
